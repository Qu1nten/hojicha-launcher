const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const instances = require('./instances');

// Synced items live once in synced/ and are shared by every instance that ticks them.
//  - Folders are directory junctions into synced/, so all instances see the same files live.
//  - Single files are copied in before launch and copied back when the game exits
//    (linking single files is unreliable on Windows and the game may replace them on save).
// Everything is synced unless the instance switched it off (instance.sync[item] === false).
const FOLDERS = ['saves', 'resourcepacks', 'shaderpacks', 'screenshots', 'config'];
const FILES = ['options.txt', 'servers.dat'];
// Schematics are one item for three mods' folders, all linked to synced\schematics (see schematics.js), so every
// mod sees every schematic (each skips the kinds it can't read): Litematica's in the game folder, WorldEdit's and
// Axiom's inside config. While config is synced, those two links sit in the shared config, so they're shared
// whatever this instance's schematics switch says.
const SCHEMATICS = 'schematics';
const SCHEMATIC_FOLDERS = ['schematics', path.join('config', 'worldedit', 'schematics'), path.join('config', 'axiom', 'blueprints')];
const ITEMS = [...FOLDERS, SCHEMATICS, ...FILES];
// Folders whose entries are whole units (a world is a folder): a name clash keeps both, renaming the newcomer,
// instead of merging two worlds' files into one.
const KEEP_BOTH = ['saves'];

function isSynced(instance, item) {
  return instance.sync?.[item] !== false;
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// True if the junction at p points at target (junction targets may carry a \\?\ prefix or trailing slash).
function linksTo(p, target) {
  const normalize = (s) => path.resolve(s.replace(/^\\\\\?\\/, '')).toLowerCase();
  try {
    return normalize(fs.readlinkSync(p)) === normalize(target);
  } catch {
    return false;
  }
}

// A copy that leaves out links (synced folders inside synced folders, like the schematics in config): copying one
// would make a symlink, which Windows only allows administrators.
const skipLinks = (src) => !isLink(src);

// Removes every link inside dir (without following them), so deleting dir can never reach into what they point at.
function removeLinksUnder(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (isLink(p)) fs.unlinkSync(p);
    else if (entry.isDirectory()) removeLinksUnder(p);
  }
}

function linkFolder(gameDir, name) {
  linkPath(path.join(gameDir, name), path.join(paths.synced, name), KEEP_BOTH.includes(name));
}

// Makes local a link to shared, moving what's already at local into shared first. keepBoth: entries are whole units
// (worlds, schematics), so a name clash keeps both, renaming the newcomer.
function linkPath(local, shared, keepBoth) {
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(path.dirname(local), { recursive: true });
  if (isLink(local)) {
    if (linksTo(local, shared)) return;
    fs.unlinkSync(local); // stale link (e.g. the launcher folder moved): relink below
  }
  if (fs.existsSync(local)) {
    // Move what the instance already had into the shared folder (without overwriting) before linking.
    if (keepBoth) {
      for (const entry of fs.readdirSync(local)) {
        const from = path.join(local, entry);
        if (isLink(from)) continue;
        // An identical world is already shared (e.g. the copy made when sync was switched off): don't duplicate it.
        if (sameTree(from, path.join(shared, entry))) continue;
        fs.cpSync(from, freeName(shared, entry, fs.statSync(from).isFile()), { recursive: true, filter: skipLinks });
      }
    } else {
      fs.cpSync(local, shared, { recursive: true, force: false, filter: skipLinks });
    }
    // Move the folder aside rather than deleting it in place: Windows can keep a deleted folder around for a
    // moment (e.g. while antivirus scans it), which makes the link below fail. If linking fails anyway, put it back.
    const old = `${local}.unsynced`;
    removeLinksUnder(old); // a leftover from an earlier try
    fs.rmSync(old, { recursive: true, force: true, maxRetries: 5 });
    fs.renameSync(local, old);
    try {
      fs.symlinkSync(shared, local, 'junction');
    } catch (err) {
      fs.renameSync(old, local);
      throw err;
    }
    try {
      removeLinksUnder(old);
      fs.rmSync(old, { recursive: true, force: true, maxRetries: 5 });
    } catch (err) {
      console.error(`Could not remove ${old}:`, err.message); // its contents are already in synced/
    }
    return;
  }
  fs.symlinkSync(shared, local, 'junction');
}

// "New World" -> "New World (2)" etc. when the name is already taken in dir. A file keeps its extension last:
// "house.litematic" -> "house (2).litematic".
function freeName(dir, entry, isFile = false) {
  const ext = isFile ? path.extname(entry) : '';
  const base = entry.slice(0, entry.length - ext.length);
  let target = path.join(dir, entry);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
  return target;
}

// True if a and b hold the same files with the same contents (b may not exist).
function sameTree(a, b) {
  let sa, sb;
  try {
    sa = fs.statSync(a);
    sb = fs.statSync(b);
  } catch {
    return false;
  }
  if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory()) return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  const entries = fs.readdirSync(a).sort();
  const others = fs.readdirSync(b).sort();
  if (entries.length !== others.length || entries.some((e, i) => e !== others[i])) return false;
  return entries.every((e) => sameTree(path.join(a, e), path.join(b, e)));
}

function unlinkFolder(gameDir, name, keepCopy) {
  unlinkPath(path.join(gameDir, name), path.join(paths.synced, name), keepCopy);
}

// Undoes linkPath: removes the link at local, leaving a copy of what's shared there when keepCopy.
function unlinkPath(local, shared, keepCopy) {
  if (!isLink(local)) return;
  if (!keepCopy) {
    fs.unlinkSync(local); // removes only the junction, never the shared contents
    return;
  }
  // Copy next to it first and swap the copy in only once it's complete. A copy that fails halfway (a file an open
  // game holds) would otherwise leave half the worlds here, which come back as "(2)" copies when sync is turned on.
  const copy = `${local}.copying`;
  fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5 });
  try {
    fs.cpSync(shared, copy, { recursive: true, filter: skipLinks });
  } catch (err) {
    fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5 });
    throw new Error(`Couldn't copy the shared ${path.basename(local)} (${err.message}). If a game is using them, close it and try again.`);
  }
  fs.unlinkSync(local);
  try {
    fs.renameSync(copy, local);
  } catch (err) {
    fs.symlinkSync(shared, local, 'junction'); // stay synced rather than without the folder
    fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5 });
    throw err;
  }
}

function seedFile(local, shared) {
  fs.mkdirSync(paths.synced, { recursive: true });
  fs.copyFileSync(local, shared);
}

// The schematic folders that belong to this instance alone: all three, except WorldEdit's and Axiom's while its
// config is shared (they're in the shared config then).
function ownSchematicFolders(gameDir) {
  const configShared = isLink(path.join(gameDir, 'config'));
  return SCHEMATIC_FOLDERS.filter((local) => !(configShared && local.startsWith(`config${path.sep}`)));
}

function linkSchematics(gameDir) {
  for (const local of SCHEMATIC_FOLDERS) linkPath(path.join(gameDir, local), paths.schematics, true);
}

// The first version kept each mod's schematics in a folder of its own in synced\schematics (litematic\, schematic\,
// blueprint\). Their files move up, once: a marker remembers it, so a group named like one of them is left alone.
// The links into those folders are pointed at synced\schematics again by linkSchematics.
function flattenOldSchematicFolders() {
  const marker = path.join(path.dirname(paths.settingsFile), 'schematics-flat');
  if (fs.existsSync(marker)) return;
  for (const name of ['litematic', 'schematic', 'blueprint']) {
    const dir = path.join(paths.schematics, name);
    if (isLink(dir) || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const from = path.join(dir, entry);
      fs.renameSync(from, freeName(paths.schematics, entry, fs.statSync(from).isFile()));
    }
    fs.rmdirSync(dir);
  }
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'Schematics are kept in synced\\schematics itself, not a folder per mod.\n');
}

function setSync(id, item, enabled) {
  if (!ITEMS.includes(item)) throw new Error(`Unknown sync item ${item}`);
  const instance = instances.get(id);
  const gameDir = instances.gameDir(id);
  if (item === SCHEMATICS) {
    if (enabled) linkSchematics(gameDir);
    else for (const local of ownSchematicFolders(gameDir)) unlinkPath(path.join(gameDir, local), paths.schematics, true);
  } else if (FOLDERS.includes(item)) {
    if (enabled) linkFolder(gameDir, item);
    else unlinkFolder(gameDir, item, true);
    // A config switched either way left its schematic folders behind (copies leave links out): link them again, or
    // when this instance keeps its own schematics, give its own config copies of the ones it was sharing.
    if (item === 'config' && isSynced(instance, SCHEMATICS)) {
      linkSchematics(gameDir);
    } else if (item === 'config' && !enabled) {
      for (const local of SCHEMATIC_FOLDERS.filter((l) => l.startsWith(`config${path.sep}`))) {
        if (fs.existsSync(paths.schematics)) fs.cpSync(paths.schematics, path.join(gameDir, local), { recursive: true, force: false });
      }
    }
  } else if (enabled) {
    // First instance to share a file seeds the shared copy.
    const shared = path.join(paths.synced, item);
    const local = path.join(gameDir, item);
    if (!fs.existsSync(shared) && fs.existsSync(local)) seedFile(local, shared);
  }
  instance.sync = { ...instance.sync, [item]: enabled };
  return instances.save(instance);
}

function beforeLaunch(instance) {
  const gameDir = instances.gameDir(instance.id);
  for (const item of ITEMS) {
    if (!isSynced(instance, item)) continue;
    if (item === SCHEMATICS) {
      linkSchematics(gameDir);
    } else if (FOLDERS.includes(item)) {
      linkFolder(gameDir, item);
    } else {
      const shared = path.join(paths.synced, item);
      const local = path.join(gameDir, item);
      if (fs.existsSync(shared)) fs.copyFileSync(shared, local);
      else if (fs.existsSync(local)) seedFile(local, shared); // first instance to share it
    }
  }
}

function afterExit(instance) {
  const gameDir = instances.gameDir(instance.id);
  for (const item of FILES) {
    const local = path.join(gameDir, item);
    if (isSynced(instance, item) && fs.existsSync(local)) seedFile(local, path.join(paths.synced, item));
  }
}

// Deletes an instance. Junctions are removed first so deleting can never reach into synced/.
function deleteInstance(id) {
  const gameDir = instances.gameDir(id);
  for (const item of FOLDERS) unlinkFolder(gameDir, item, false);
  removeLinksUnder(instances.dir(id)); // the schematic folders
  // Retries ride out Windows briefly holding files (e.g. antivirus scanning the game's last writes).
  fs.rmSync(instances.dir(id), { recursive: true, force: true, maxRetries: 10 });
}

// Re-points every synced folder at synced/. Junctions store absolute paths, so they go stale when the
// launcher folder is moved; run at startup (and for new instances) so instance folders always look right.
function relinkAll() {
  try {
    flattenOldSchematicFolders();
  } catch (err) {
    console.error('Could not move the schematics out of their old folders:', err.message);
  }
  for (const instance of instances.list()) linkFolders(instance);
}

function linkFolders(instance) {
  for (const item of FOLDERS) {
    if (!isSynced(instance, item)) continue;
    try {
      linkFolder(instances.gameDir(instance.id), item);
    } catch (err) {
      console.error(`Could not relink ${item} for ${instance.id}:`, err.message);
    }
  }
  if (!isSynced(instance, SCHEMATICS)) return;
  try {
    linkSchematics(instances.gameDir(instance.id)); // after config, which two of them are in
  } catch (err) {
    console.error(`Could not relink the schematics for ${instance.id}:`, err.message);
  }
}

module.exports = {
  FOLDERS, SCHEMATICS, isSynced, isLink, setSync, beforeLaunch, afterExit, deleteInstance, relinkAll,
  linkFolders, ownSchematicFolders,
};

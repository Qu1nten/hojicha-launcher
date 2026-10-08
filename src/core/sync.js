const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const instances = require('./instances');
const settingsMerge = require('./settingsMerge');

// Synced items live once in synced/ and are shared by every instance that ticks them.
//  - Content folders (worlds, packs, screenshots) are directory junctions into synced/, so all instances see the
//    same files live.
//  - Settings (options.txt, the server list and config, the mods' settings) are copied in before launch, and when
//    the game closes, what the player changed goes back (see Settings below).
// Everything is synced unless the instance switched it off (instance.sync[item] === false).
const FOLDERS = ['saves', 'resourcepacks', 'shaderpacks', 'screenshots'];
const CONFIG = 'config';
const FILES = ['options.txt', 'servers.dat'];
const SETTINGS = [CONFIG, ...FILES];
// Schematics are one item for three mods' folders, all linked to synced\schematics (see schematics.js), so every
// mod sees every schematic (each skips the kinds it can't read): Litematica's in the game folder, WorldEdit's and
// Axiom's inside the instance's config.
const SCHEMATICS = 'schematics';
const SCHEMATIC_FOLDERS = ['schematics', path.join('config', 'worldedit', 'schematics'), path.join('config', 'axiom', 'blueprints')];
// In this order: config is copied in before the schematic links inside it are made.
const ITEMS = [...FOLDERS, CONFIG, SCHEMATICS, ...FILES];
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
// config is a link into synced\config (before settings were merged, config was linked like the content folders).
function ownSchematicFolders(gameDir) {
  const configShared = isLink(path.join(gameDir, CONFIG));
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
  } else if (enabled) {
    shareSettings(instance, item); // switched off, the instance simply keeps the copy it has
  }
  instance.sync = { ...instance.sync, [item]: enabled };
  return instances.save(instance);
}

function beforeLaunch(instance) {
  const gameDir = instances.gameDir(instance.id);
  // A baseline still here means the last session's game outlived the launcher, so afterExit never saw it close:
  // save what the player changed then, before the shared settings are copied over it.
  writeBack(instance);
  for (const item of ITEMS) {
    if (!isSynced(instance, item)) continue;
    if (item === SCHEMATICS) linkSchematics(gameDir);
    else if (FOLDERS.includes(item)) linkFolder(gameDir, item);
    else copyIn(gameDir, item);
  }
}

// ---------- Settings ----------
// options.txt, servers.dat and config are copied into the instance at launch. Once the game has finished loading
// (markLoaded), a copy of them is kept: the baseline. It holds whatever the game and its mods did to them while
// starting up: the game dropping the keybinds of mods it doesn't have, an older mod resetting a file it can't read,
// a newer one converting an old file, borderless mode turning fullscreen off. When the game closes, only what changed
// since the baseline goes back into the shared copy, which is what the player changed, setting by setting where the
// format allows (settingsMerge.js). What the instance doesn't have or didn't change stays as the shared copy has it,
// so no instance undoes another's settings. A game that closed before it finished loading has no baseline, and
// nothing goes back. A shared settings file that changes keeps its earlier versions in sync-history\.
const OPTIONS = 'options.txt';
const HISTORY_KEPT = 20;
const baselineDir = (id) => path.join(instances.dir(id), 'sync-baseline');

// Copies a settings folder, leaving out links: the schematic folders inside config are links that belong to each
// instance, and a copy into one of them would land in synced\schematics.
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, force: true, filter: (src, dest) => !isLink(src) && !isLink(dest) });
}

// Every file under dir, relative to it, without going into links.
function filesUnder(dir, rel = '') {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const sub = path.join(rel, entry.name);
    if (isLink(path.join(dir, sub))) return [];
    if (entry.isDirectory()) return filesUnder(dir, sub);
    return entry.isFile() ? [sub] : [];
  });
}

function copyIn(gameDir, item) {
  const shared = path.join(paths.synced, item);
  const local = path.join(gameDir, item);
  if (item === CONFIG) {
    if (fs.existsSync(shared)) copyTree(shared, local);
    else if (fs.existsSync(local)) copyTree(local, shared); // first instance to share it
  } else if (fs.existsSync(shared)) {
    fs.copyFileSync(shared, local);
  } else if (fs.existsSync(local)) {
    seedFile(local, shared);
  }
}

// When the game has finished loading: keeps the baseline (see above).
function markLoaded(instance) {
  const gameDir = instances.gameDir(instance.id);
  const baseline = baselineDir(instance.id);
  fs.rmSync(baseline, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(baseline, { recursive: true });
  for (const item of SETTINGS) {
    const local = path.join(gameDir, item);
    if (!isSynced(instance, item) || !fs.existsSync(local)) continue;
    if (item === CONFIG) copyTree(local, path.join(baseline, item));
    else fs.copyFileSync(local, path.join(baseline, item));
  }
}

// Puts what the player changed into the shared settings. False if there was nothing to go by: the game closed before
// it finished loading.
function writeBack(instance) {
  const baseline = baselineDir(instance.id);
  if (!fs.existsSync(baseline)) return false;
  const gameDir = instances.gameDir(instance.id);
  for (const item of SETTINGS) {
    if (!isSynced(instance, item)) continue;
    const local = path.join(gameDir, item);
    const base = path.join(baseline, item);
    const shared = path.join(paths.synced, item);
    if (item === OPTIONS) {
      if (fs.existsSync(local)) mergeOptions(local, base);
    } else if (item === CONFIG) {
      for (const rel of filesUnder(local)) writeBackFile(path.join(local, rel), path.join(base, rel), path.join(shared, rel));
    } else if (fs.existsSync(local)) {
      writeBackFile(local, base, shared, false); // servers.dat is binary: it goes back whole
    }
  }
  fs.rmSync(baseline, { recursive: true, force: true, maxRetries: 5 });
  return true;
}

function writeBackFile(localFile, baseFile, sharedFile, mergeable = true) {
  const local = fs.readFileSync(localFile);
  if (!fs.existsSync(sharedFile)) return writeShared(sharedFile, local); // new to the shared settings
  const base = fs.existsSync(baseFile) ? fs.readFileSync(baseFile) : null;
  if (base && local.equals(base)) return; // unchanged since the game finished loading
  const shared = fs.readFileSync(sharedFile);
  // Nothing touched it but the player (loading didn't change it, no other instance has since): it goes back exactly
  // as the mod wrote it.
  if (base && shared.equals(base)) return writeShared(sharedFile, local);
  const merged = mergeable ? settingsMerge.merge(localFile, base?.toString('utf8') ?? '', local.toString('utf8'), shared.toString('utf8')) : null;
  writeShared(sharedFile, merged ?? local); // a format that can't be merged goes back whole: the player changed it
}

// Replaces a shared settings file, keeping the version it replaces in sync-history\. Written aside and swapped in,
// so a failed write can't leave it half there.
function writeShared(file, data) {
  const content = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file).equals(content)) return;
    keepHistory(file);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.writing`, content);
  fs.renameSync(`${file}.writing`, file);
}

// sync-history\<path in synced>\<when>.<ext>, the last HISTORY_KEPT versions of each file.
function keepHistory(file) {
  const dir = path.join(paths.syncHistory, path.relative(paths.synced, file));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}${path.extname(file)}`));
  const versions = fs.readdirSync(dir).sort();
  for (const old of versions.slice(0, -HISTORY_KEPT)) fs.rmSync(path.join(dir, old), { force: true });
}

// Switching sync on: what this instance has and the shared settings don't (the files and options of mods no other
// instance has) joins them. What both have keeps the shared value.
function shareSettings(instance, item) {
  const local = path.join(instances.gameDir(instance.id), item);
  const shared = path.join(paths.synced, item);
  if (!fs.existsSync(local)) return;
  if (item === CONFIG) {
    for (const rel of filesUnder(local)) {
      if (!fs.existsSync(path.join(shared, rel))) writeShared(path.join(shared, rel), fs.readFileSync(path.join(local, rel)));
    }
  } else if (!fs.existsSync(shared)) {
    seedFile(local, shared);
  } else if (item === OPTIONS) {
    mergeOptions(local, null);
  }
}

// "key:value" lines, in file order. Values may contain ':' themselves (resourcePacks, Forge's key modifiers).
function readOptions(file) {
  const options = new Map();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return options;
  }
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) options.set(line.slice(0, i), line.slice(i + 1));
  }
  return options;
}

// Each game writes its own data version, which tells a newer game which upgrades its options still need. The shared
// file keeps the newest: an older game's lower number would have a newer one upgrade options that are already
// upgraded.
function newestVersion(a, b) {
  return a !== undefined && Number(a) > Number(b) ? a : b;
}

// options.txt merges option by option. Options the shared file doesn't have yet join it (a newly added mod's
// keybinds), so it holds every option any instance has. With no baseline (switching sync on), only those join.
function mergeOptions(localFile, baseFile) {
  const sharedFile = path.join(paths.synced, OPTIONS);
  const base = baseFile ? readOptions(baseFile) : null;
  const shared = readOptions(sharedFile);
  let changed = false;
  for (const [key, value] of readOptions(localFile)) {
    let next;
    if (!shared.has(key)) next = value;
    else if (!base || base.get(key) === value) continue; // unchanged since the game finished loading
    else next = key === 'version' ? newestVersion(shared.get(key), value) : value;
    if (shared.get(key) === next) continue;
    shared.set(key, next);
    changed = true;
  }
  if (changed) writeShared(sharedFile, [...shared].map(([key, value]) => `${key}:${value}\n`).join(''));
}

// False when the session's settings weren't kept because the game closed before it finished loading.
function afterExit(instance) {
  return writeBack(instance) || !SETTINGS.some((item) => isSynced(instance, item));
}

// Deletes an instance. Junctions are removed first so deleting can never reach into synced/.
function deleteInstance(id) {
  const gameDir = instances.gameDir(id);
  for (const item of FOLDERS) unlinkFolder(gameDir, item, false);
  removeLinksUnder(instances.dir(id)); // the schematic folders
  // Retries ride out Windows briefly holding files (e.g. antivirus scanning the game's last writes).
  fs.rmSync(instances.dir(id), { recursive: true, force: true, maxRetries: 10 });
}

// Config used to be a junction into synced\config, like the content folders. Each instance gets its own copy now,
// and the schematic links that sat in the shared config move into each instance's own (linkFolders). An instance
// keeping its own schematics gets copies of the ones it saw through the shared config.
function unlinkOldConfig(instance) {
  const gameDir = instances.gameDir(instance.id);
  const local = path.join(gameDir, CONFIG);
  if (!isLink(local)) return;
  unlinkPath(local, path.join(paths.synced, CONFIG), true);
  if (isSynced(instance, SCHEMATICS) || !fs.existsSync(paths.schematics)) return;
  for (const folder of SCHEMATIC_FOLDERS.filter((f) => f.startsWith(`config${path.sep}`))) {
    fs.cpSync(paths.schematics, path.join(gameDir, folder), { recursive: true, force: false });
  }
}

// Re-points every synced folder at synced/. Junctions store absolute paths, so they go stale when the
// launcher folder is moved; run at startup (and for new instances) so instance folders always look right.
function relinkAll() {
  try {
    flattenOldSchematicFolders();
  } catch (err) {
    console.error('Could not move the schematics out of their old folders:', err.message);
  }
  let configUnlinked = true;
  for (const instance of instances.list()) {
    try {
      unlinkOldConfig(instance);
    } catch (err) {
      configUnlinked = false;
      console.error(`Could not give ${instance.id} its own config:`, err.message);
    }
  }
  // The schematic links in the shared config: nothing reaches them through it any more once every instance has its own.
  if (configUnlinked) removeLinksUnder(path.join(paths.synced, CONFIG));
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
    linkSchematics(instances.gameDir(instance.id));
  } catch (err) {
    console.error(`Could not relink the schematics for ${instance.id}:`, err.message);
  }
}

module.exports = {
  FOLDERS, SCHEMATICS, isSynced, isLink, setSync, beforeLaunch, markLoaded, afterExit, deleteInstance, relinkAll,
  linkFolders, ownSchematicFolders,
};

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
const ITEMS = [...FOLDERS, ...FILES];
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

function linkFolder(gameDir, name) {
  const shared = path.join(paths.synced, name);
  const local = path.join(gameDir, name);
  fs.mkdirSync(shared, { recursive: true });
  if (isLink(local)) {
    if (linksTo(local, shared)) return;
    fs.unlinkSync(local); // stale link (e.g. the launcher folder moved): relink below
  }
  if (fs.existsSync(local)) {
    // Move what the instance already had into the shared folder (without overwriting) before linking.
    if (KEEP_BOTH.includes(name)) {
      for (const entry of fs.readdirSync(local)) {
        // An identical world is already shared (e.g. the copy made when sync was switched off): don't duplicate it.
        if (sameTree(path.join(local, entry), path.join(shared, entry))) continue;
        fs.cpSync(path.join(local, entry), freeName(shared, entry), { recursive: true });
      }
    } else {
      fs.cpSync(local, shared, { recursive: true, force: false });
    }
    // Move the folder aside rather than deleting it in place: Windows can keep a deleted folder around for a
    // moment (e.g. while antivirus scans it), which makes the link below fail. If linking fails anyway, put it back.
    const old = `${local}.unsynced`;
    fs.rmSync(old, { recursive: true, force: true, maxRetries: 5 });
    fs.renameSync(local, old);
    try {
      fs.symlinkSync(shared, local, 'junction');
    } catch (err) {
      fs.renameSync(old, local);
      throw err;
    }
    try {
      fs.rmSync(old, { recursive: true, force: true, maxRetries: 5 });
    } catch (err) {
      console.error(`Could not remove ${old}:`, err.message); // its contents are already in synced/
    }
    return;
  }
  fs.symlinkSync(shared, local, 'junction');
}

// "New World" -> "New World (2)" etc. when the name is already taken in dir.
function freeName(dir, entry) {
  let target = path.join(dir, entry);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${entry} (${n})`);
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
  const local = path.join(gameDir, name);
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
    fs.cpSync(path.join(paths.synced, name), copy, { recursive: true });
  } catch (err) {
    fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5 });
    throw new Error(`Couldn't copy the shared ${name} (${err.message}). If a game is using them, close it and try again.`);
  }
  fs.unlinkSync(local);
  try {
    fs.renameSync(copy, local);
  } catch (err) {
    fs.symlinkSync(path.join(paths.synced, name), local, 'junction'); // stay synced rather than without the folder
    fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5 });
    throw err;
  }
}

function seedFile(local, shared) {
  fs.mkdirSync(paths.synced, { recursive: true });
  fs.copyFileSync(local, shared);
}

function setSync(id, item, enabled) {
  if (!ITEMS.includes(item)) throw new Error(`Unknown sync item ${item}`);
  const instance = instances.get(id);
  const gameDir = instances.gameDir(id);
  if (FOLDERS.includes(item)) {
    if (enabled) linkFolder(gameDir, item);
    else unlinkFolder(gameDir, item, true);
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
    if (FOLDERS.includes(item)) {
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
  // Retries ride out Windows briefly holding files (e.g. antivirus scanning the game's last writes).
  fs.rmSync(instances.dir(id), { recursive: true, force: true, maxRetries: 10 });
}

// Re-points every synced folder at synced/. Junctions store absolute paths, so they go stale when the
// launcher folder is moved; run at startup (and for new instances) so instance folders always look right.
function relinkAll() {
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
}

module.exports = { FOLDERS, isSynced, setSync, beforeLaunch, afterExit, deleteInstance, relinkAll, linkFolders };

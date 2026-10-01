const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const instances = require('./instances');

// Synced items live once in data/shared/ and are shared by every instance that ticks them.
//  - Folders are directory junctions into data/shared, so all instances see the same files live.
//  - Single files are copied in before launch and copied back when the game exits
//    (linking single files is unreliable on Windows and the game may replace them on save).
const FOLDERS = ['resourcepacks', 'shaderpacks', 'screenshots'];
const FILES = ['options.txt', 'servers.dat'];
const ITEMS = [...FOLDERS, ...FILES];

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
  const shared = path.join(paths.shared, name);
  const local = path.join(gameDir, name);
  fs.mkdirSync(shared, { recursive: true });
  if (isLink(local)) {
    if (linksTo(local, shared)) return;
    fs.unlinkSync(local); // stale link (e.g. the data folder moved): relink below
  }
  if (fs.existsSync(local)) {
    // Move what the instance already had into the shared folder (without overwriting) before linking.
    fs.cpSync(local, shared, { recursive: true, force: false });
    fs.rmSync(local, { recursive: true, force: true });
  }
  fs.symlinkSync(shared, local, 'junction');
}

function unlinkFolder(gameDir, name, keepCopy) {
  const local = path.join(gameDir, name);
  if (!isLink(local)) return;
  fs.unlinkSync(local); // removes only the junction, never the shared contents
  if (keepCopy) fs.cpSync(path.join(paths.shared, name), local, { recursive: true });
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
    const shared = path.join(paths.shared, item);
    const local = path.join(gameDir, item);
    if (!fs.existsSync(shared) && fs.existsSync(local)) {
      fs.mkdirSync(paths.shared, { recursive: true });
      fs.copyFileSync(local, shared);
    }
  }
  instance.sync[item] = enabled;
  return instances.save(instance);
}

function beforeLaunch(instance) {
  const gameDir = instances.gameDir(instance.id);
  for (const item of ITEMS) {
    if (!instance.sync[item]) continue;
    if (FOLDERS.includes(item)) {
      linkFolder(gameDir, item);
    } else {
      const shared = path.join(paths.shared, item);
      if (fs.existsSync(shared)) fs.copyFileSync(shared, path.join(gameDir, item));
    }
  }
}

function afterExit(instance) {
  const gameDir = instances.gameDir(instance.id);
  for (const item of FILES) {
    const local = path.join(gameDir, item);
    if (instance.sync[item] && fs.existsSync(local)) {
      fs.mkdirSync(paths.shared, { recursive: true });
      fs.copyFileSync(local, path.join(paths.shared, item));
    }
  }
}

// Deletes an instance. Junctions are removed first so deleting can never reach into data/shared.
function deleteInstance(id) {
  const gameDir = instances.gameDir(id);
  for (const item of FOLDERS) unlinkFolder(gameDir, item, false);
  fs.rmSync(instances.dir(id), { recursive: true, force: true });
}

module.exports = { ITEMS, setSync, beforeLaunch, afterExit, deleteInstance };

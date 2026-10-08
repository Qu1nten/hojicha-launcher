const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { readJson, writeJson } = require('./util');

// An instance is a folder under instances/<id>/ holding instance.json plus the game directory (.minecraft equivalent).

function dir(id) {
  return path.join(paths.instances, id);
}

function gameDir(id) {
  return path.join(dir(id), 'minecraft');
}

// Libraries a Prism Launcher pack brought along as files instead of downloads (see prismPacks.js).
function librariesDir(id) {
  return path.join(dir(id), 'libraries');
}

function get(id) {
  const file = path.join(dir(id), 'instance.json');
  if (!fs.existsSync(file)) throw new Error(`Instance "${id}" not found`);
  return readJson(file);
}

function save(instance) {
  writeJson(path.join(dir(instance.id), 'instance.json'), instance);
  return instance;
}

// Saves just these fields onto the instance as it is on disk now, so a long task (a download) can't undo changes
// made meanwhile, like a rename or the play time of a game that closed.
function patch(id, fields) {
  return save({ ...get(id), ...fields });
}

function list() {
  if (!fs.existsSync(paths.instances)) return [];
  return fs.readdirSync(paths.instances)
    .filter((id) => fs.existsSync(path.join(dir(id), 'instance.json')))
    .flatMap((id) => {
      try {
        return [get(id)];
      } catch (err) {
        // One damaged instance.json mustn't hide the others (or stop the launcher starting): skip it.
        console.error(`Skipping instance ${id}:`, err.message);
        return [];
      }
    })
    .sort((a, b) => a.created - b.created);
}

// The instance's folder (and id) is its name, minus what Windows doesn't allow in folder names.
function folderName(name) {
  let base = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = `${base} instance`;
  return base || 'Instance';
}

function uniqueId(name) {
  const base = folderName(name);
  let id = base;
  for (let n = 2; fs.existsSync(dir(id)); n++) id = `${base} (${n})`;
  return id;
}

function create({ name, gameVersion, loader, loaderVersion }) {
  const instance = {
    id: uniqueId(name),
    name,
    gameVersion,
    loader,
    loaderVersion: loader === 'fabric' ? loaderVersion : null,
    created: Date.now(),
    sync: {},     // item name -> false when not shared with other instances; everything else is (see sync.js)
    content: {},  // "mods/foo.jar" -> Modrinth metadata for files installed from Modrinth
    playtime: 0,      // milliseconds spent in the game, added when it closes
    lastPlayed: null, // when the game last started (ms since epoch)
  };
  fs.mkdirSync(gameDir(instance.id), { recursive: true });
  return save(instance);
}

module.exports = { dir, gameDir, librariesDir, get, save, patch, list, create, folderName };

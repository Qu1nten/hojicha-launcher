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

function get(id) {
  const file = path.join(dir(id), 'instance.json');
  if (!fs.existsSync(file)) throw new Error(`Instance "${id}" not found`);
  return readJson(file);
}

function save(instance) {
  writeJson(path.join(dir(instance.id), 'instance.json'), instance);
  return instance;
}

function list() {
  if (!fs.existsSync(paths.instances)) return [];
  return fs.readdirSync(paths.instances)
    .filter((id) => fs.existsSync(path.join(dir(id), 'instance.json')))
    .map(get)
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
    sync: {},     // item name -> true when shared with other instances (see sync.js)
    content: {},  // "mods/foo.jar" -> Modrinth metadata for files installed from Modrinth
    playtime: 0,      // milliseconds spent in the game, added when it closes
    lastPlayed: null, // when the game last started (ms since epoch)
  };
  fs.mkdirSync(gameDir(instance.id), { recursive: true });
  return save(instance);
}

module.exports = { dir, gameDir, get, save, list, create, folderName };

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const { newestJar } = require('./icons');

// What the schematics viewer draws blocks with: every block's states and models and the textures they use, from the
// newest client jar on disk, kept in meta\blocks\assets.json so it works offline. The page builds its texture atlas
// and deepslate's resources from it (renderer/schematics.js). Before any game version is downloaded there's none.

const BLOCKSTATES = 'assets/minecraft/blockstates/';
const MODELS = 'assets/minecraft/models/block/';
const TEXTURES = 'assets/minecraft/textures/';
// Blocks the game draws in code (chests, beds, signs, heads...) take their textures from these entity folders;
// deepslate draws them with these.
const ENTITY_TEXTURES = [
  'banner/', 'bed/', 'bell/', 'chest/', 'conduit/', 'copper_golem/', 'decorated_pot/', 'shield/', 'shulker/', 'signs/',
  'creeper/creeper.png', 'enderdragon/dragon.png', 'piglin/piglin.png', 'player/wide/steve.png', 'skeleton/',
  'zombie/zombie.png',
].map((p) => `${TEXTURES}entity/${p}`);
// Bump when the unpacking changes, so every jar is unpacked again.
const FORMAT = 1;

const file = () => path.join(paths.blocks, 'assets.json');
let cache = null; // { version, blockstates, models, textures }

function unpack(source) {
  const zip = new AdmZip(source.jar);
  const assets = { format: FORMAT, version: source.id, blockstates: {}, models: {}, textures: {} };
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (entry.isDirectory) continue;
    if (name.startsWith(BLOCKSTATES) && name.endsWith('.json')) {
      assets.blockstates[name.slice(BLOCKSTATES.length, -5)] = JSON.parse(entry.getData().toString('utf8'));
    } else if (name.startsWith(MODELS) && name.endsWith('.json')) {
      assets.models[`block/${name.slice(MODELS.length, -5)}`] = JSON.parse(entry.getData().toString('utf8'));
    } else if (name.endsWith('.png')
      && (name.startsWith(`${TEXTURES}block/`) || ENTITY_TEXTURES.some((p) => name.startsWith(p)))) {
      assets.textures[name.slice(TEXTURES.length, -4)] = entry.getData().toString('base64');
    }
  }
  return assets;
}

// The block assets, unpacked from the newest jar the first time they're asked for after it changed. Null without a
// downloaded game version.
function get() {
  const source = newestJar();
  if (!source) return null;
  if (cache?.version === source.id) return cache;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (saved.format === FORMAT && saved.version === source.id) return (cache = saved);
  } catch {
    // never unpacked, or unreadable: unpacked again below
  }
  const assets = unpack(source);
  if (!Object.keys(assets.blockstates).length) return cache; // not a vanilla jar: keep what we had
  fs.mkdirSync(paths.blocks, { recursive: true });
  fs.writeFileSync(`${file()}.saving`, JSON.stringify(assets));
  fs.renameSync(`${file()}.saving`, file());
  return (cache = assets);
}

module.exports = { get };

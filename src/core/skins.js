const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const { readJsonOr, writeJson } = require('./util');

// Saved skins: every skin added in the launcher, and each account's skin as it was found, shared by all accounts.
// skins\<sha1>.png are the files (the same skin twice is one file); skins\skins.json remembers each one's arms and
// when it was added.

const indexFile = () => path.join(paths.skins, 'skins.json');
const fileOf = (id) => path.join(paths.skins, `${id}.png`);

// A skin file the game takes: a PNG of 64x64, or 64x32 for the old single-layer layout.
function check(png) {
  const isPng = png.length > 24 && png.readUInt32BE(0) === 0x89504e47 && png.toString('ascii', 12, 16) === 'IHDR';
  if (!isPng) throw new Error("That file isn't a PNG image. Skins are PNG files.");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) {
    throw new Error(`A skin is 64x64 pixels (or 64x32 for old skins). This image is ${width}x${height}.`);
  }
}

// What a skin looks like, whatever its file: Mojang re-encodes a skin when it's uploaded, so the copy downloaded
// back has other bytes for the same picture. Two skins are the same skin when this matches. (Needs Electron's image
// decoder, so this module only runs in the main process.)
function pixelKey(png) {
  const { nativeImage } = require('electron');
  const image = nativeImage.createFromBuffer(png);
  const { width, height } = image.getSize();
  return crypto.createHash('sha1').update(`${width}x${height}:`).update(image.toBitmap()).digest('hex');
}

// The saved index, each entry with its pixel key (worked out once for skins saved before keys existed), and any
// skin saved twice under two files merged into the one added first.
function loadIndex() {
  let changed = false;
  const kept = [];
  for (const skin of readJsonOr(indexFile(), []).sort((a, b) => a.addedAt - b.addedAt)) {
    if (!fs.existsSync(fileOf(skin.id))) continue;
    if (!skin.pixels) {
      skin.pixels = pixelKey(read(skin.id));
      changed = true;
    }
    if (kept.some((s) => s.pixels === skin.pixels)) {
      fs.rmSync(fileOf(skin.id), { force: true }); // the same picture as an earlier one
      changed = true;
      continue;
    }
    kept.push(skin);
  }
  if (changed) writeJson(indexFile(), kept);
  return kept;
}

// Newest first, each with the image as a data: URL for the page (it shows them and draws them in 3D).
function list() {
  return loadIndex()
    .sort((a, b) => b.addedAt - a.addedAt)
    .map(({ pixels, ...s }) => ({ ...s, url: `data:image/png;base64,${read(s.id).toString('base64')}` }));
}

// Saves a skin (once: a skin that looks the same as a saved one is that one) and returns its id. variant: the arms
// it's for, 'classic' or 'slim'.
function add(png, variant) {
  check(png);
  const pixels = pixelKey(png);
  const index = loadIndex();
  const same = index.find((s) => s.pixels === pixels);
  if (same) return same.id;
  const id = crypto.createHash('sha1').update(png).digest('hex');
  fs.mkdirSync(paths.skins, { recursive: true });
  fs.writeFileSync(fileOf(id), png);
  index.push({ id, variant: variant === 'slim' ? 'slim' : 'classic', addedAt: Date.now(), pixels });
  writeJson(indexFile(), index);
  return id;
}

function read(id) {
  if (!/^[0-9a-f]{40}$/.test(id)) throw new Error('Unknown skin');
  return fs.readFileSync(fileOf(id));
}

// Remembers the arms a skin was last used with, so picking it again picks them too.
function setVariant(id, variant) {
  const index = readJsonOr(indexFile(), []);
  const skin = index.find((s) => s.id === id);
  if (skin && skin.variant !== variant) {
    skin.variant = variant;
    writeJson(indexFile(), index);
  }
}

function remove(id) {
  read(id); // checks the id
  writeJson(indexFile(), readJsonOr(indexFile(), []).filter((s) => s.id !== id));
  fs.rmSync(fileOf(id), { force: true });
}

module.exports = { check, list, add, read, setVariant, remove };

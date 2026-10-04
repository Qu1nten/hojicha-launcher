const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('./paths');

// Instance and server icons: every Minecraft item that shows as a flat picture in the inventory, built the way the
// game draws it, from a client jar the launcher already downloaded, into meta\icons (so they work offline).
// The jar lists every item (assets/minecraft/items) with its model; models that end in item/generated are flat
// pictures made of texture layers, which can be coloured (grass, potions, leather). Full blocks (stone, logs) are
// 3D models and items like beds and chests are drawn by game code, so neither has a picture to take.
// Composing the layers needs Electron's nativeImage, so this only runs in the main process.

const ITEMS = 'assets/minecraft/items/';
const MODELS = 'assets/minecraft/models/';
const TEXTURES = 'assets/minecraft/textures/';
const SKIP = /^(air|debug_stick)$|^test_/;
const NAME = /^[a-z0-9_]+$/;
// Bump when the unpacking changes, so every jar is unpacked again.
const FORMAT = 3;
// Colours the game works out from the world, as in a plains biome.
const BIOME_TINTS = { grass: 0x79c05a, foliage: 0x59ae30, dry_foliage: 0xa7703f };

// The picker groups items like the game's creative tabs. The game keeps its tabs in code, not in the jar, so items
// are sorted by name: the first category with a matching pattern wins (Ingredients takes the rest). Within a
// category, items follow the order of its patterns (all axes, then all pickaxes...), then material, then name.
const CATEGORIES = [
  ['Spawn eggs', ['_spawn_egg$']],
  ['Music discs', ['^music_disc_', '^disc_fragment']],
  ['Templates, sherds & patterns', ['_smithing_template$', '_pottery_sherd$', '_banner_pattern$']],
  ['Combat', [
    '_sword$', '_spear$', '^bow$', '^crossbow$', 'arrow$', '^trident$', '^mace$', '^shield$', '_helmet$', '_chestplate$',
    '_leggings$', '_boots$', '_horse_armor$', '_nautilus_armor$', '^wolf_armor$', '^totem_of_undying$', '^end_crystal$',
    '^snowball$', '^wind_charge$', '^(blue_|brown_)?egg$',
  ]],
  ['Tools & utilities', [
    '_shovel$', '_pickaxe$', '_axe$', '_hoe$', '^shears$', '^flint_and_steel$', '^brush$', '^fishing_rod$', '^spyglass$',
    'compass$', '^clock$', '^lead$', '^name_tag$', 'bucket$', '^bundle$', '_bundle$', '^map$', '_map$', '_on_a_stick$',
    '^goat_horn$', '^saddle$', '_harness$', '^elytra$', '_boat$', '_raft$', 'minecart$', '^fire_charge$',
    '^firework_rocket$', '^(writable|written|knowledge)_book$', '^trial_key$', '^ominous_trial_key$',
  ]],
  ['Food & drinks', [
    'apple$', '^melon_slice$', 'berries$', '^chorus_fruit$', 'carrot$', 'potato$', '^beetroot$', '^dried_kelp$',
    '^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|tropical_fish|pufferfish)$', '^cooked_', '^bread$', '^cookie$',
    '^cake$', '_pie$', '_stew$', '_soup$', '^rotten_flesh$', '^spider_eye$', '^honey_bottle$', 'potion$',
    '^ominous_bottle$',
  ]],
  ['Redstone', ['^redstone$', '^redstone_torch$', '^repeater$', '^comparator$', '^lever$', '^tripwire_hook$', 'rail$', '^hopper$']],
  ['Building & decoration', [
    '_door$', '_sign$', '_hanging_sign$', 'torch$', 'candle$', 'lantern$', 'chain$', '_bars$', 'glass_pane$', '^ladder$',
    '^cobweb$', 'campfire$', '^bell$', '^flower_pot$',
    'item_frame$', '^painting$', '^armor_stand$', '_cushion$', '^cauldron$', '^brewing_stand$', '^light$', '^barrier$',
    '^structure_void$',
  ]],
  ['Nature', [
    '_sapling$', '^mangrove_propagule$', 'tulip$', '^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower)$',
    '^(lily_of_the_valley|wither_rose|torchflower|sunflower|lilac|rose_bush|peony|cactus_flower)$', 'eyeblossom$',
    'mushroom$', '_fungus$', '_roots$', '^(short|tall)_(dry_)?grass$', '^(large_)?fern$', '^bush$', '^dead_bush$', 'vines?$',
    '^lily_pad$', '^glow_lichen$', '^hanging_roots$', '^pale_hanging_moss$', '^sculk_vein$', '_coral(_fan)?$',
    '_amethyst_bud$', '^amethyst_cluster$', '^frogspawn$',
    '_seeds$', '^wheat$', '^cocoa_beans$', '^nether_wart$', '^sugar_cane$', '^bamboo$', '^kelp$', '^seagrass$',
    '^sea_pickle$', '^pink_petals$', '^wildflowers$', '^leaf_litter$', '^firefly_bush$', '^mangrove_propagule$',
    '^nether_sprouts$', '^pitcher_', '^pointed_dripstone$', '^sulfur_spike$', '_egg$',
  ]],
  ['Ingredients', [
    '^(coal|charcoal)$', '^raw_', '_ingot$', '_nugget$', '^netherite_scrap$',
    '^(diamond|emerald|lapis_lazuli|quartz|amethyst_shard|echo_shard)$', '_dye$', '.',
  ]],
].map(([name, patterns]) => [name, patterns.map((p) => new RegExp(p))]);
const ORDER = ['Tools & utilities', 'Combat', 'Food & drinks', 'Ingredients', 'Templates, sherds & patterns',
  'Music discs', 'Building & decoration', 'Redstone', 'Nature', 'Spawn eggs'];
// Tools, armour and metals go from wood (or leather) up to netherite, as in the game.
const MATERIALS = ['wooden', 'leather', 'stone', 'chainmail', 'copper', 'iron', 'golden', 'gold', 'diamond', 'netherite'];
const BY_MATERIAL = ['Tools & utilities', 'Combat', 'Ingredients'];

function sortKey(name) {
  for (const [category, patterns] of CATEGORIES) {
    const group = patterns.findIndex((pattern) => pattern.test(name));
    if (group !== -1) {
      const material = BY_MATERIAL.includes(category) ? MATERIALS.indexOf(name.split('_')[0]) : -1;
      return { category, group, material: material === -1 ? MATERIALS.length : material };
    }
  }
}

let cache = null; // name -> data URL

function sourceFile() {
  return path.join(paths.icons, 'source.txt');
}

// The vanilla client jar of the newest game release on disk, or null before any version was downloaded. Goes by
// release date, not file date: launching an old version rewrites its jar, and versions before 1.21.4 have no
// assets/minecraft/items to build from.
function releaseTime(id) {
  try {
    const time = Date.parse(JSON.parse(fs.readFileSync(path.join(paths.versions, id, `${id}.json`), 'utf8')).releaseTime);
    return Number.isNaN(time) ? 0 : time;
  } catch {
    return 0;
  }
}

function newestJar() {
  if (!fs.existsSync(paths.versions)) return null;
  let best = null;
  for (const id of fs.readdirSync(paths.versions)) {
    const jar = path.join(paths.versions, id, `${id}.jar`);
    if (!fs.existsSync(jar)) continue;
    const time = releaseTime(id);
    if (!best || time > best.time) best = { id, jar, time };
  }
  return best;
}

const strip = (id) => id.replace(/^minecraft:/, '');

// Follows select/condition/range_dispatch item models to the one shown by default (their fallback, else the first
// case): the plain model plus its tints. Special models (beds, chests, heads) have none.
function plainModel(model) {
  if (!model) return null;
  switch (strip(model.type || '')) {
    case 'model': return model;
    case 'select': return plainModel(model.fallback) || plainModel(model.cases?.[0]?.model);
    case 'condition': return plainModel(model.on_false) || plainModel(model.on_true);
    case 'range_dispatch': return plainModel(model.fallback) || plainModel(model.entries?.[0]?.model);
    case 'composite': return plainModel(model.models?.[0]);
    default: return null;
  }
}

// The texture layers of a flat model (layer0, layer1...), or null for a 3D one.
function flatLayers(json, modelId) {
  const textures = {};
  let id = strip(modelId);
  for (let depth = 0; depth < 10 && id; depth++) {
    if (id === 'item/generated' || id === 'builtin/generated') {
      const layers = Object.keys(textures).filter((k) => /^layer\d+$/.test(k)).sort((a, b) => a.slice(5) - b.slice(5));
      return layers.length ? layers.map((k) => strip(textures[k])) : null;
    }
    const model = json(`${MODELS}${id}.json`);
    if (!model) return null;
    for (const [key, value] of Object.entries(model.textures || {})) if (!(key in textures)) textures[key] = value;
    id = model.parent ? strip(model.parent) : null;
  }
  return null;
}

// A tint as 0xRRGGBB, or null for none.
function tintColor(tint) {
  if (!tint) return null;
  const value = tint.value ?? tint.default;
  if (typeof value === 'number') return value & 0xffffff;
  return BIOME_TINTS[strip(tint.type || '')] ?? null;
}

// Stacks the layers (each coloured by its tint) into one square PNG. Animated textures are tall strips of frames:
// the first frame is used. Returns null when the layers can't be combined.
function compose(read, layers, tints) {
  const { nativeImage } = require('electron');
  let size = null;
  let out = null;
  for (const [i, texture] of layers.entries()) {
    const png = read(`${TEXTURES}${texture}.png`);
    if (!png) return null;
    const image = nativeImage.createFromBuffer(png);
    const { width, height } = image.getSize();
    if (!width || height < width) return null; // not square, and not a strip of square frames
    if (size === null) {
      size = width;
      out = Buffer.alloc(size * size * 4);
    } else if (width !== size) {
      return null;
    }
    const pixels = image.toBitmap(); // BGRA, premultiplied alpha
    const tint = tintColor(tints[i]);
    const [r, g, b] = tint === null ? [255, 255, 255] : [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
    for (let p = 0; p < size * size * 4; p += 4) {
      const alpha = pixels[p + 3];
      if (!alpha) continue;
      const keep = 255 - alpha; // what shows through from the layers below
      out[p] = Math.round((pixels[p] * b) / 255) + Math.round((out[p] * keep) / 255);
      out[p + 1] = Math.round((pixels[p + 1] * g) / 255) + Math.round((out[p + 1] * keep) / 255);
      out[p + 2] = Math.round((pixels[p + 2] * r) / 255) + Math.round((out[p + 2] * keep) / 255);
      out[p + 3] = alpha + Math.round((out[p + 3] * keep) / 255);
    }
  }
  return out && nativeImage.createFromBitmap(out, { width: size, height: size }).toPNG();
}

// Builds every flat item's picture from the newest jar, once per jar. Items whose picture matches one already made
// (waxed copper, the debug stick) are left out; shorter names go first, so the plain item keeps the picture.
// Returns true when the icons were rebuilt.
function ensure() {
  const source = newestJar();
  if (!source) return false;
  const stamp = `${FORMAT}:${source.id}`;
  try {
    if (fs.readFileSync(sourceFile(), 'utf8').trim() === stamp) return false;
  } catch {
    // never unpacked
  }
  const zip = new AdmZip(source.jar);
  const read = (name) => zip.getEntry(name)?.getData() || null;
  const json = (name) => {
    const data = read(name);
    return data ? JSON.parse(data.toString('utf8')) : null;
  };
  const names = zip.getEntries()
    .map((e) => e.entryName)
    .filter((n) => n.startsWith(ITEMS) && n.endsWith('.json') && !n.slice(ITEMS.length).includes('/'))
    .map((n) => n.slice(ITEMS.length, -5))
    .filter((name) => NAME.test(name) && !SKIP.test(name))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));

  const tmp = `${paths.icons}.new`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const seen = new Set();
  for (const name of names) {
    const model = plainModel(json(`${ITEMS}${name}.json`)?.model);
    const layers = model && flatLayers(json, model.model);
    const png = layers && compose(read, layers, model.tints || []);
    if (!png) continue;
    const key = png.toString('base64');
    if (seen.has(key)) continue;
    seen.add(key);
    fs.writeFileSync(path.join(tmp, `${name}.png`), png);
  }
  // A jar with no flat items (too old, or not a vanilla jar) never replaces a set that has pictures.
  if (!seen.size && fs.existsSync(paths.icons)) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return false;
  }
  fs.writeFileSync(path.join(tmp, 'source.txt'), stamp);
  // Swap in the new set whole, so a failed run never leaves half of one.
  fs.rmSync(paths.icons, { recursive: true, force: true });
  fs.renameSync(tmp, paths.icons);
  cache = null;
  return true;
}

function all() {
  if (!cache) {
    cache = new Map();
    if (fs.existsSync(paths.icons)) {
      for (const file of fs.readdirSync(paths.icons).sort()) {
        if (!file.endsWith('.png')) continue;
        const data = fs.readFileSync(path.join(paths.icons, file)).toString('base64');
        cache.set(file.slice(0, -4), `data:image/png;base64,${data}`);
      }
    }
  }
  return cache;
}

function has(name) {
  return typeof name === 'string' && all().has(name);
}

function url(name) {
  return all().get(name) || null;
}

function random() {
  const names = [...all().keys()];
  return names.length ? names[Math.floor(Math.random() * names.length)] : null;
}

// "diamond_sword" -> "Diamond sword"
function label(name) {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Every icon, grouped by category in ORDER (see sortKey for the order within each).
function list() {
  return [...all()]
    .map(([name, dataUrl]) => ({ name, label: label(name), url: dataUrl, key: sortKey(name) }))
    .sort((a, b) => ORDER.indexOf(a.key.category) - ORDER.indexOf(b.key.category)
      || a.key.group - b.key.group
      || a.key.material - b.key.material
      || a.label.localeCompare(b.label))
    .map(({ key, ...icon }) => ({ ...icon, category: key.category }));
}

module.exports = { ensure, has, url, random, list };

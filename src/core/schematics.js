const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const instances = require('./instances');
const sync = require('./sync');

// The schematics viewer's files: everything in synced\schematics (litematic\, schematic\ and blueprint\, which
// Litematica, WorldEdit and Axiom save to through sync.js), and the schematic folders of instances that keep their
// own. The page reads and draws them (renderer/schematics.js); each one's preview picture is kept in
// meta\schematic-previews, so it's drawn once.

const TYPES = { '.litematic': 'litematica', '.schem': 'worldedit', '.schematic': 'worldedit', '.bp': 'axiom' };
// Where each kind is kept in synced\schematics (the folders sync.js links the mods' folders to).
const FOLDERS = { litematica: 'litematic', worldedit: 'schematic', axiom: 'blueprint' };
const MAX_BYTES = 200 * 1024 * 1024; // bigger than any schematic the page could draw
// Bump when previews are drawn differently, so they're all drawn again.
const PREVIEW_FORMAT = 2;

const typeOf = (file) => TYPES[path.extname(file).toLowerCase()] || null;

// Every schematic under dir, in sub-folders too (Litematica sorts them into folders), without following links.
function walk(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, found);
    else if (entry.isFile() && typeOf(file)) found.push(file);
  }
  return found;
}

// Where schematics are listed from: the shared folder, and each instance's own schematic folders when it doesn't
// share them.
function roots() {
  const list = [{ dir: paths.schematics, instance: null }];
  for (const instance of instances.list()) {
    if (sync.isSynced(instance, sync.SCHEMATICS)) continue;
    const gameDir = instances.gameDir(instance.id);
    for (const [local] of sync.ownSchematicFolders(gameDir)) {
      const dir = path.join(gameDir, local);
      if (!sync.isLink(dir)) list.push({ dir, instance: { id: instance.id, name: instance.name } });
    }
  }
  return list;
}

const isInside = (file, dir) => {
  const relative = path.relative(dir, file);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

// A schematic path from the page, checked to be one the viewer lists.
function check(file) {
  const resolved = path.resolve(String(file));
  if (!typeOf(resolved) || !roots().some(({ dir }) => isInside(resolved, dir))) throw new Error('Unknown schematic');
  return resolved;
}

// A preview belongs to one version of one file: a changed file gets a new one.
function previewKey(file, stat) {
  return crypto.createHash('sha1').update(`${PREVIEW_FORMAT}|${file}|${stat.size}|${stat.mtimeMs}`).digest('hex');
}
const previewFile = (key, ext) => path.join(paths.schematicPreviews, `${key}.${ext}`);

// Every schematic, newest first: { path, name, type, folder, instance, bytes, modified, preview }. preview is the
// saved picture and what it showed ({ url, size, blocks }), or null until the page has drawn one. Previews of files
// that are gone or changed are deleted.
function list() {
  const items = [];
  for (const { dir, instance } of roots()) {
    for (const file of walk(dir)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const key = previewKey(file, stat);
      let preview = null;
      try {
        const info = JSON.parse(fs.readFileSync(previewFile(key, 'json'), 'utf8'));
        const png = fs.readFileSync(previewFile(key, 'png'));
        preview = { ...info, url: `data:image/png;base64,${png.toString('base64')}` };
      } catch {
        // not drawn yet
      }
      // The folder it's in, inside its root: "" at the top, else e.g. "litematic\farms".
      const folder = path.relative(instance ? dir : paths.schematics, path.dirname(file));
      items.push({
        path: file,
        name: path.basename(file, path.extname(file)),
        type: typeOf(file),
        folder,
        instance,
        bytes: stat.size,
        modified: stat.mtimeMs,
        preview,
        key,
      });
    }
  }
  const keep = new Set(items.map((item) => item.key));
  try {
    for (const name of fs.readdirSync(paths.schematicPreviews)) {
      if (!keep.has(name.replace(/\.(png|json)$/, ''))) fs.rmSync(path.join(paths.schematicPreviews, name), { force: true });
    }
  } catch {
    // no previews yet
  }
  return items.sort((a, b) => b.modified - a.modified).map(({ key, ...item }) => item);
}

function read(file) {
  const checked = check(file);
  if (fs.statSync(checked).size > MAX_BYTES) throw new Error("This schematic is too big to show.");
  return fs.readFileSync(checked);
}

// Saves the picture the page drew of a schematic, with what it showed: { size: [x, y, z], blocks }.
function savePreview(file, dataUrl, info) {
  const checked = check(file);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!match) throw new Error('Not a PNG');
  const size = Array.isArray(info?.size) ? info.size.slice(0, 3).map((n) => Math.max(0, Math.round(Number(n)) || 0)) : [0, 0, 0];
  const blocks = Math.max(0, Math.round(Number(info?.blocks)) || 0);
  const key = previewKey(checked, fs.statSync(checked));
  fs.mkdirSync(paths.schematicPreviews, { recursive: true });
  fs.writeFileSync(previewFile(key, 'png'), Buffer.from(match[1], 'base64'));
  fs.writeFileSync(previewFile(key, 'json'), JSON.stringify({ size, blocks }));
}

// "house.litematic" -> "house (2).litematic" when the name is taken in dir.
function freeName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
  return target;
}

// Files dropped on the launcher ({ name, data }): each schematic goes into its kind's shared folder, so every
// instance's mod finds it. Returns the paths they were saved to and the names of the files that aren't schematics.
function importFiles(files) {
  const added = [];
  const skipped = [];
  for (const file of files) {
    const name = path.basename(String(file.name));
    const type = typeOf(name);
    if (!type || !file.data?.length || file.data.length > MAX_BYTES) {
      skipped.push(name);
      continue;
    }
    const dir = path.join(paths.schematics, FOLDERS[type]);
    fs.mkdirSync(dir, { recursive: true });
    const target = freeName(dir, name);
    fs.writeFileSync(target, Buffer.from(file.data));
    added.push(target);
  }
  return { added, skipped };
}

module.exports = { list, read, check, savePreview, importFiles };

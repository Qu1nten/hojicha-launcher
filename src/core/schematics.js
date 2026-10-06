const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const paths = require('./paths');
const instances = require('./instances');
const sync = require('./sync');

// The schematics viewer's files: everything in synced\schematics (where Litematica, WorldEdit and Axiom save, through
// sync.js), its folders being groups, and the schematic folders of instances that keep their own. The page reads and
// draws them (renderer/schematics.js); each one's preview picture is kept in meta\schematic-previews, so it's drawn
// once.

const TYPES = { '.litematic': 'litematica', '.schem': 'worldedit', '.schematic': 'worldedit', '.bp': 'axiom' };
const MAX_BYTES = 200 * 1024 * 1024; // the most a dropped file can be (it comes in through the page)
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
    for (const local of sync.ownSchematicFolders(gameDir)) {
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

// Reads a schematic into a compact block list (schematicFile.js), in a thread of its own: a file too big for the
// memory it's allowed only stops that thread. cells: how much detail at most (see schematicFile.js). onProgress(fraction)
// as it reads.
function load(file, cells, onProgress) {
  const checked = check(file);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'schematicFile.js'), {
      workerData: { file: checked, kind: typeOf(checked), cells: Number(cells) || undefined },
      resourceLimits: { maxOldGenerationSizeMb: 3072 },
    });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn(value);
    };
    worker.on('message', (message) => {
      if (message.progress !== undefined) onProgress?.(message.progress);
      else if (message.error) finish(reject, new Error(message.error));
      else finish(resolve, message.model);
    });
    worker.on('error', (err) => finish(reject, err.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? new Error('This schematic needs more memory than the launcher can give it.')
      : err));
    worker.on('exit', () => finish(reject, new Error('Reading the schematic stopped.')));
  });
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

// "house.litematic" -> "house (2).litematic" when the name is taken in dir ("trees" -> "trees (2)" for a folder).
function freeName(dir, name, isFile = true) {
  const ext = isFile ? path.extname(name) : '';
  const base = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
  return target;
}

// A dropped file's path, split into names safe to make on Windows ("../x" and "C:" can't reach outside).
function safeParts(name) {
  const parts = String(name).split(/[\\/]+/)
    .map((part) => part.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, ''))
    .filter((part) => part && part !== '.' && part !== '..');
  return parts.length ? parts : null;
}

// Files and folders dropped on the launcher: [{ name, data }], name being a path for what's inside a dropped folder
// ("dragon_tree/dragon_tree_1.bp"). A schematic goes into the shared folder, and a folder becomes a group there, kept
// whole (mods' own files in it too, like Axiom's ordering). Everything is written to meta\schematic-imports first and
// moved in once it's all there, in one step: the game's mods watch the folder and read what turns up straight away,
// and one that finds a file still being written can crash the game (Axiom does). A name that's taken keeps both.
// Returns how many schematics were added, and the names of the loose files that aren't schematics.
function importFiles(files) {
  const staging = path.join(paths.schematicImports, crypto.randomBytes(6).toString('hex'));
  const entries = new Map(); // what's put in synced\schematics: name -> { folder }
  const skipped = [];
  let added = 0;
  try {
    for (const file of files) {
      const parts = safeParts(file.name);
      if (!parts) continue;
      const loose = parts.length === 1;
      if (loose && !typeOf(parts[0])) {
        skipped.push(parts[0]);
        continue;
      }
      if (!file.data || file.data.length > MAX_BYTES) {
        skipped.push(parts.join('/'));
        continue;
      }
      const target = path.join(staging, ...parts);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(file.data));
      entries.set(parts[0], { folder: !loose });
      if (typeOf(parts[parts.length - 1])) added++;
    }
    fs.mkdirSync(paths.schematics, { recursive: true });
    for (const [name, { folder }] of entries) {
      fs.renameSync(path.join(staging, name), freeName(paths.schematics, name, !folder));
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
  }
  return { added, skipped };
}

// A group's folder name: what was typed, without the characters Windows doesn't allow in names.
function groupName(name) {
  const clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '').slice(0, 64);
  if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) throw new Error('Give the group a name.');
  return clean;
}

// Moves shared schematics into a group: a folder in synced\schematics, made if it isn't there yet (an existing group
// gets them added). A name that's taken there keeps both. Their pictures move with them. Returns the new list.
function group(files, name) {
  const dir = path.join(paths.schematics, groupName(name));
  const moving = files.map(check);
  if (moving.some((file) => !isInside(file, paths.schematics))) throw new Error('Only shared schematics can be put in a group.');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of moving) {
    if (path.dirname(file) === dir) continue;
    const stat = fs.statSync(file);
    const target = freeName(dir, path.basename(file));
    fs.renameSync(file, target);
    const from = previewKey(file, stat);
    const to = previewKey(target, fs.statSync(target));
    for (const ext of ['png', 'json']) {
      try {
        fs.renameSync(previewFile(from, ext), previewFile(to, ext));
      } catch {
        // no picture yet
      }
    }
  }
  return list();
}

// The shared groups' names, to add to one that's there.
function groups() {
  try {
    return fs.readdirSync(paths.schematics, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !sync.isLink(path.join(paths.schematics, entry.name)))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

module.exports = { list, load, check, savePreview, importFiles, group, groups };

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const paths = require('./paths');
const instances = require('./instances');
const sync = require('./sync');
const { versionName } = require('./dataVersions');

// The schematics viewer's files: everything in synced\schematics (where Litematica, WorldEdit and Axiom save, through
// sync.js), its folders being groups, and the schematic folders of instances that keep their own. The page reads and
// draws them (renderer/schematics.js); each one's preview picture is kept in meta\schematic-previews, so it's drawn
// once.

const TYPES = { '.litematic': 'litematica', '.schem': 'worldedit', '.schematic': 'worldedit', '.bp': 'axiom' };
const MAX_BYTES = 200 * 1024 * 1024; // the most a dropped file can be (it comes in through the page)
// Bump when previews are drawn differently, so they're all drawn again.
const PREVIEW_FORMAT = 7;

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

// What a schematic says about itself, from its preview's info or the model read from it: the game version it was
// saved in ("1.20.1", or null) and its data version (to sort by: 0 for one from before 1.13, null when unknown), who
// made it (or null), and when: { time, recorded } (recorded: the file says so; else it's the file's own date, the older
// of when it was made and last changed, which a copy or move keeps one of).
function details(info, stat) {
  const version = info?.legacy ? '1.12 or older' : versionName(info?.dataVersion);
  const dataVersion = info?.legacy ? 0 : info?.dataVersion || null;
  const author = typeof info?.author === 'string' && info.author ? info.author : null;
  if (info?.created) return { version, dataVersion, author, created: { time: info.created, recorded: true } };
  const times = [stat.birthtimeMs, stat.mtimeMs].filter((t) => t > 0);
  return { version, dataVersion, author, created: times.length ? { time: Math.min(...times), recorded: false } : null };
}

// Every folder in synced\schematics, empty ones too, as their names from the top (["Assets", "trees"]), without
// following links.
function sharedFolders(dir = paths.schematics, parts = [], found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    found.push([...parts, entry.name]);
    sharedFolders(path.join(dir, entry.name), [...parts, entry.name], found);
  }
  return found;
}

// Every schematic and shared folder: { items, folders }. items, newest first: { path, name, type, folder, instance,
// bytes, modified, preview, version, dataVersion, author, created }. preview is the saved picture and what it showed
// ({ url, size, blocks }), or null until the page has drawn one; the rest: see details() (all but created only once
// there's a preview). folders: see sharedFolders(). Previews of files that are gone or changed are deleted.
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
        if (fs.existsSync(previewFile(key, 'png'))) preview = { ...info, url: `hojicha://preview/${key}.png` }; // served by main.js
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
        ...details(preview, stat),
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
  return {
    items: items.sort((a, b) => b.modified - a.modified).map(({ key, ...item }) => item),
    folders: sharedFolders(),
  };
}

// Reads a schematic into a compact block list (schematicFile.js), in a thread of its own: a file too big for the
// memory it's allowed only stops that thread. cells: how much detail at most; budget: shrunk to what the 3D view shows
// smoothly (both: see schematicFile.js). onProgress(fraction) as it reads. The model comes with its details() too.
function load(file, cells, budget, onProgress) {
  const checked = check(file);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'schematicFile.js'), {
      workerData: { file: checked, kind: typeOf(checked), cells: Number(cells) || undefined, budget: Boolean(budget) },
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
      else finish(resolve, { ...message.model, details: details(message.model, fs.statSync(checked)) });
    });
    worker.on('error', (err) => finish(reject, err.code === 'ERR_WORKER_OUT_OF_MEMORY'
      ? new Error('This schematic needs more memory than the launcher can give it.')
      : err));
    worker.on('exit', () => finish(reject, new Error('Reading the schematic stopped.')));
  });
}

// Saves the picture the page drew of a schematic, with what it showed and what the file says about itself (as read:
// see schematicFile.js): { size: [x, y, z], blocks, created, dataVersion, legacy }. Returns its details().
function savePreview(file, dataUrl, info) {
  const checked = check(file);
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!match) throw new Error('Not a PNG');
  const size = Array.isArray(info?.size) ? info.size.slice(0, 3).map((n) => Math.max(0, Math.round(Number(n)) || 0)) : [0, 0, 0];
  const blocks = Math.max(0, Math.round(Number(info?.blocks)) || 0);
  const created = Number(info?.created) > 0 ? Number(info.created) : null;
  const dataVersion = Number.isInteger(info?.dataVersion) && info.dataVersion > 0 ? info.dataVersion : null;
  const legacy = info?.legacy === true;
  const author = typeof info?.author === 'string' ? info.author.slice(0, 100) : null;
  const stat = fs.statSync(checked);
  const key = previewKey(checked, stat);
  fs.mkdirSync(paths.schematicPreviews, { recursive: true });
  fs.writeFileSync(previewFile(key, 'png'), Buffer.from(match[1], 'base64'));
  fs.writeFileSync(previewFile(key, 'json'), JSON.stringify({ size, blocks, created, dataVersion, legacy, author }));
  return details({ created, dataVersion, legacy, author }, stat);
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
// ("dragon_tree/dragon_tree_1.bp"), into the shared folder parent (its names from the top: the one the page shows;
// the top when it's gone). A schematic goes in as it is, and a folder becomes a group there, kept
// whole (mods' own files in it too, like Axiom's ordering). Everything is written to meta\schematic-imports first and
// moved in once it's all there, in one step: the game's mods watch the folder and read what turns up straight away,
// and one that finds a file still being written can crash the game (Axiom does). A name that's taken keeps both.
// Returns how many schematics were added, and the names of the loose files that aren't schematics.
function importFiles(files, parent = []) {
  let into = paths.schematics;
  try {
    into = groupsDir(parent);
  } catch {
    // moved or deleted since: the top
  }
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
    fs.mkdirSync(into, { recursive: true });
    for (const [name, { folder }] of entries) {
      fs.renameSync(path.join(staging, name), freeName(into, name, !folder));
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
  }
  return { added, skipped };
}

// A name for a file or folder: what was typed, without the characters Windows doesn't allow in names. what: what's
// being named, for the error when nothing's left.
function cleanName(name, what) {
  const clean = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, '').slice(0, 64);
  if (!clean || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) throw new Error(`Give the ${what} a name.`);
  return clean;
}

// Moves a schematic's picture along with it, from where it was (stat: from before) to target.
function movePreview(file, stat, target) {
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

// The shared folder groups are made in: parent, the folder names from synced\schematics down (the one the page shows),
// or the top.
function groupsDir(parent = []) {
  const parts = Array.isArray(parent) ? parent.map(String) : [];
  // Only names of folders that are there: nothing that reaches outside, and no instance's own folder.
  if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(part))) {
    throw new Error('That folder is gone.');
  }
  const dir = path.join(paths.schematics, ...parts);
  if (parts.length && (!isInside(dir, paths.schematics) || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())) {
    throw new Error('That folder is gone.');
  }
  return dir;
}

// Moves shared schematics into a group: a folder in parent (see groupsDir), made if it isn't there yet (an existing
// group gets them added). A name that's taken there keeps both. Their pictures move with them. Returns the new list.
function group(files, name, parent) {
  const dir = path.join(groupsDir(parent), cleanName(name, 'group'));
  const moving = files.map(check);
  if (moving.some((file) => !isInside(file, paths.schematics))) throw new Error('Only shared schematics can be put in a group.');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of moving) {
    if (path.dirname(file) === dir) continue;
    const stat = fs.statSync(file);
    const target = freeName(dir, path.basename(file));
    fs.renameSync(file, target);
    movePreview(file, stat, target);
  }
  return list();
}

// Renames a schematic's file (in its folder, keeping its extension, so the game's mods see the new name too).
// Returns its new path and the new list.
function rename(file, name) {
  const checked = check(file);
  const ext = path.extname(checked);
  const target = path.join(path.dirname(checked), `${cleanName(name, 'schematic')}${ext}`);
  if (target === checked) return { path: checked, ...list() };
  // Windows names ignore case: "House" can become "house", but not take another schematic's name, of any format
  // (the page shows them without the extension, so two would look the same).
  const base = path.basename(target, ext).toLowerCase();
  const taken = fs.readdirSync(path.dirname(checked)).some((name) => typeOf(name)
    && path.basename(name, path.extname(name)).toLowerCase() === base
    && path.join(path.dirname(checked), name).toLowerCase() !== checked.toLowerCase());
  if (taken) throw new Error(`There's already a schematic called "${path.basename(target, ext)}" here.`);
  const stat = fs.statSync(checked);
  moveOrSay(checked, target, 'renamed');
  movePreview(checked, stat, target);
  return { path: target, ...list() };
}

// fs.renameSync, saying why when a file in the way is open somewhere (Windows won't move it then). done: "renamed",
// "moved".
function moveOrSay(from, to, done) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
      throw new Error(`It can't be ${done} while something has it open (the game, maybe). Close it and try again.`);
    }
    throw err;
  }
}

// Moves a shared folder (with everything in it) to target, the pictures of the schematics in it with it.
function moveFolder(dir, target, done) {
  const inside = walk(dir).map((file) => ({ file, stat: fs.statSync(file) }));
  moveOrSay(dir, target, done);
  for (const { file, stat } of inside) movePreview(file, stat, path.join(target, path.relative(dir, file)));
}

// Moves shared schematics (paths) and folders (each its names from the top) into the folder target (its names from
// the top; [] for the top). A name that's taken there keeps both. Returns the new list.
function move(files = [], folders = [], target = []) {
  const into = groupsDir(target);
  const moving = files.map(check);
  if (moving.some((file) => !isInside(file, paths.schematics))) throw new Error("Schematics an instance keeps to itself can't be moved.");
  const dirs = folders.map((parts) => {
    if (!Array.isArray(parts) || !parts.length) throw new Error('That folder is gone.');
    const dir = groupsDir(parts);
    if (into === dir || isInside(into, dir)) throw new Error(`"${parts[parts.length - 1]}" can't go inside itself.`);
    return dir;
  });
  for (const file of moving) {
    if (path.dirname(file) === into) continue;
    const stat = fs.statSync(file);
    const to = freeName(into, path.basename(file));
    moveOrSay(file, to, 'moved');
    movePreview(file, stat, to);
  }
  for (const dir of dirs) {
    if (path.dirname(dir) === into) continue;
    moveFolder(dir, freeName(into, path.basename(dir), false), 'moved');
  }
  return list();
}

// Renames a shared folder (its names from the top). Returns its new names and the new list.
function renameFolder(parts, name) {
  const dir = groupsDir(parts);
  if (!parts.length) throw new Error('That folder is gone.');
  const target = path.join(path.dirname(dir), cleanName(name, 'folder'));
  const named = [...parts.slice(0, -1), path.basename(target)];
  if (target === dir) return { parts: named, ...list() };
  if (fs.existsSync(target) && target.toLowerCase() !== dir.toLowerCase()) {
    throw new Error(`There's already a folder called "${path.basename(target)}" here.`);
  }
  moveFolder(dir, target, 'renamed');
  return { parts: named, ...list() };
}

// Makes an empty folder in parent (its names from the top). Returns its names and the new list.
function newFolder(parent, name) {
  const dir = path.join(groupsDir(parent), cleanName(name, 'folder'));
  if (fs.existsSync(dir)) throw new Error(`There's already a folder called "${path.basename(dir)}" here.`);
  fs.mkdirSync(dir);
  return { parts: [...parent, path.basename(dir)], ...list() };
}

// The names of the groups in parent (see groupsDir), to add to one that's there.
function groups(parent) {
  try {
    const dir = groupsDir(parent);
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !sync.isLink(path.join(dir, entry.name)))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

module.exports = {
  list, load, check, savePreview, importFiles, group, groups, rename, move, renameFolder, newFolder, folderDir: groupsDir,
};

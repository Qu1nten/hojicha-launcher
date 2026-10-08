const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { downloadFile, hashFile } = require('./http');

// Instances often have the same mods, resource packs and shaders as each other: every pack with Sodium, say. Each
// such file is kept once, in meta/files under its SHA-1, and an instance's copy is a hard link to it, so it takes no
// space of its own. To the game and Explorer a link is an ordinary file. Removing it from an instance removes just
// that link; prune() deletes stored files no instance links to any more.
//
// Only files the game reads and never writes go here: a settings file edited through one link would change for
// every instance. And Windows locks a file a running game has open under all its names, so a mod can't be removed
// from one instance while another instance with the same mod is playing (see inUse()).

// The folders whose files are stored. Mods are .jar files and packs .zip files, all written once and only read.
const FOLDERS = ['mods/', 'resourcepacks/', 'shaderpacks/'];

const storedPath = (sha1) => path.join(paths.files, sha1.slice(0, 2), sha1);

// rel: the file's path in the game folder, with forward slashes.
// A switched-off mod (.jar.disabled) counts too.
const isStorable = (rel) => FOLDERS.some((folder) => rel.startsWith(folder)) && /\.(jar|zip)(\.disabled)?$/i.test(rel);

// Puts the stored file at dest: a hard link, or a copy where a link can't be made (dest on another drive, or a
// drive without links, like FAT32).
function place(stored, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });
  try {
    fs.linkSync(stored, dest);
  } catch {
    fs.copyFileSync(stored, dest);
  }
}

const downloading = new Map(); // SHA-1 -> its download into the store, while it runs

// Like http.downloadFile, but the download goes to the store (or is already there from another instance) and dest
// links to it. Without a SHA-1 to store it under, the file downloads straight to dest.
async function download(url, dest, { sha1, size } = {}) {
  if (!sha1) return downloadFile(url, dest, { size });
  if (fs.existsSync(dest) && (size == null || fs.statSync(dest).size === size)) return false;
  const key = sha1.toLowerCase();
  const stored = storedPath(key);
  // Two installs wanting the same file at once share one download (they'd write the same .part file).
  if (!downloading.has(key)) {
    const done = () => downloading.delete(key);
    downloading.set(key, downloadFile(url, stored, { sha1, size }).finally(done));
  }
  await downloading.get(key);
  place(stored, dest);
  return true;
}

// Writes data (a file from a modpack) to dest through the store. Returns its SHA-1.
function write(data, dest) {
  const sha1 = crypto.createHash('sha1').update(data).digest('hex');
  const stored = storedPath(sha1);
  if (!fs.existsSync(stored)) {
    fs.mkdirSync(path.dirname(stored), { recursive: true });
    const tmp = `${stored}.part`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, stored);
  }
  place(stored, dest);
  return sha1;
}

// Deletes the stored files no instance links to: the store's own name is the only one left. Run at startup, before
// anything downloads, so a file stored a moment ago and about to be linked can't go.
function prune() {
  if (!fs.existsSync(paths.files)) return;
  let freed = 0;
  for (const sub of fs.readdirSync(paths.files)) {
    const dir = path.join(paths.files, sub);
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.nlink > 1 && !name.endsWith('.part')) continue;
        fs.rmSync(file);
        freed += stat.size;
      } catch (err) {
        console.error(`Could not tidy ${file}:`, err.message);
      }
    }
  }
  if (freed) console.log(`Freed ${Math.round(freed / 1024 / 1024)} MB of mods and packs no instance uses`);
}

// ---------- Merging older copies ----------
// Mods and packs installed before the store existed are each instance's own copy. merge() turns them into links to
// one stored copy as well: the first copy of a file becomes the stored one (a second name for the same file, so
// nothing is copied), and every other copy is swapped for a link to it. Files that already have more than one name
// are links already and are skipped, so a pass that stopped part way picks up where it was.

// Swaps one file for a link to the stored copy. Returns the bytes it frees.
async function adopt(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.nlink > 1) return 0;
  const stored = storedPath(await hashFile(file, 'sha1'));
  if (!fs.existsSync(stored)) {
    fs.mkdirSync(path.dirname(stored), { recursive: true });
    fs.linkSync(file, stored);
    return 0;
  }
  // The link is made next to the file and renamed over it, so the mod is never missing, even for a moment.
  const tmp = `${file}.linking`;
  fs.rmSync(tmp, { force: true });
  fs.linkSync(stored, tmp);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return stat.size;
}

// Merges the mods and packs in one instance's game folder. stop() is asked before each file: true when the instance
// starts playing or changing its mods, so the pass leaves it alone. Returns { freed, stopped }.
async function merge(gameDir, stop) {
  let freed = 0;
  for (const folder of FOLDERS) {
    let names;
    try {
      names = fs.readdirSync(path.join(gameDir, folder));
    } catch {
      continue; // no such folder
    }
    for (const name of names) {
      if (!isStorable(folder + name)) continue;
      if (stop()) return { freed, stopped: true };
      const file = path.join(gameDir, folder, name);
      try {
        freed += await adopt(file);
      } catch (err) {
        // Locked, or a drive without links: it stays a copy of its own.
        console.error(`Could not merge ${file}:`, err.message);
      }
    }
  }
  return { freed, stopped: false };
}

// True when err is Windows refusing to remove or rename a file because a program has it open.
const inUse = (err) => ['EBUSY', 'EPERM', 'EACCES'].includes(err?.code);

module.exports = { isStorable, download, write, prune, merge, inUse };

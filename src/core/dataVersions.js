const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const paths = require('./paths');

// Which game version a schematic was saved in. Files record the game's data version (a number that goes up with
// every release and snapshot), not its name: this turns one into the other, with the releases' numbers below and
// whatever versions are downloaded (each client jar's version.json says its own).

// Every release from 1.9 (the first with a data version) to 1.21.11. Between two of these, a number is a snapshot of
// the later one.
const RELEASES = [
  [169, '1.9'], [175, '1.9.1'], [176, '1.9.2'], [183, '1.9.3'], [184, '1.9.4'],
  [510, '1.10'], [511, '1.10.1'], [512, '1.10.2'],
  [819, '1.11'], [921, '1.11.1'], [922, '1.11.2'],
  [1139, '1.12'], [1241, '1.12.1'], [1343, '1.12.2'],
  [1519, '1.13'], [1628, '1.13.1'], [1631, '1.13.2'],
  [1952, '1.14'], [1957, '1.14.1'], [1963, '1.14.2'], [1968, '1.14.3'], [1976, '1.14.4'],
  [2225, '1.15'], [2227, '1.15.1'], [2230, '1.15.2'],
  [2566, '1.16'], [2567, '1.16.1'], [2578, '1.16.2'], [2580, '1.16.3'], [2584, '1.16.4'], [2586, '1.16.5'],
  [2724, '1.17'], [2730, '1.17.1'],
  [2860, '1.18'], [2865, '1.18.1'], [2975, '1.18.2'],
  [3105, '1.19'], [3117, '1.19.1'], [3120, '1.19.2'], [3218, '1.19.3'], [3337, '1.19.4'],
  [3463, '1.20'], [3465, '1.20.1'], [3578, '1.20.2'], [3698, '1.20.3'], [3700, '1.20.4'], [3837, '1.20.5'],
  [3839, '1.20.6'],
  [3953, '1.21'], [3955, '1.21.1'], [4080, '1.21.2'], [4082, '1.21.3'], [4189, '1.21.4'], [4325, '1.21.5'],
  [4435, '1.21.6'], [4438, '1.21.7'], [4440, '1.21.8'], [4554, '1.21.9'], [4556, '1.21.10'], [4671, '1.21.11'],
];
const LAST_KNOWN = RELEASES[RELEASES.length - 1][0];

// One file out of a zip (a client jar is 30 MB or so; this reads only its directory and that file), or null.
function readZipEntry(file, wanted) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const read = (at, length) => {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, at);
      return buf;
    };
    // The end record (directory size and where it starts) is in the last 22 bytes, or before a comment.
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = read(size - tailLength, tailLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) return null;
    const directory = read(tail.readUInt32LE(end + 16), tail.readUInt32LE(end + 12));
    for (let at = 0; at + 46 <= directory.length && directory.readUInt32LE(at) === 0x02014b50;) {
      const method = directory.readUInt16LE(at + 10);
      const compressed = directory.readUInt32LE(at + 20);
      const nameLength = directory.readUInt16LE(at + 28);
      const skip = nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
      if (directory.toString('utf8', at + 46, at + 46 + nameLength) === wanted) {
        const local = directory.readUInt32LE(at + 42);
        const header = read(local, 30);
        const data = read(local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28), compressed);
        if (method === 0) return data;
        return method === 8 ? zlib.inflateRawSync(data) : null;
      }
      at += 46 + skip;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// The downloaded versions' data versions: number -> name. Each jar is read once (again if it changes).
const jarCache = new Map(); // jar path -> { mtimeMs, number, name }
function downloaded() {
  const found = new Map();
  let ids = [];
  try {
    ids = fs.readdirSync(paths.versions);
  } catch {
    return found;
  }
  for (const id of ids) {
    const jar = path.join(paths.versions, id, `${id}.jar`);
    try {
      const { mtimeMs } = fs.statSync(jar);
      let known = jarCache.get(jar);
      if (known?.mtimeMs !== mtimeMs) {
        const json = JSON.parse(readZipEntry(jar, 'version.json')?.toString('utf8') || 'null');
        known = { mtimeMs, number: Number(json?.world_version) || 0, name: String(json?.name || json?.id || id) };
        jarCache.set(jar, known);
      }
      if (known.number) found.set(known.number, known.name);
    } catch {
      // no jar here (a mod loader's version), or not one we can read
    }
  }
  return found;
}

// The game version for a data version: "1.20.1", "1.21.4 snapshot" (between two releases), "newer than 26.3" (past
// every version known here), or null for none.
function versionName(number) {
  if (!Number.isInteger(number) || number <= 0) return null;
  const jars = downloaded();
  if (jars.has(number)) return jars.get(number);
  const release = RELEASES.find(([n]) => n === number);
  if (release) return release[1];
  if (number < LAST_KNOWN) {
    const next = RELEASES.find(([n]) => n > number);
    return number < RELEASES[0][0] ? `${RELEASES[0][1]} or older` : `${next[1]} snapshot`;
  }
  // Past the releases listed above: the newest version known to be older.
  let below = [LAST_KNOWN, RELEASES[RELEASES.length - 1][1]];
  for (const [n, name] of jars) if (n < number && n > below[0]) below = [n, name];
  return `newer than ${below[1]}`;
}

module.exports = { versionName };

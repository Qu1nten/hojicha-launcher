const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const { version: LAUNCHER_VERSION } = require('../../package.json');

// Modrinth asks every client to send an identifying User-Agent.
const USER_AGENT = `HojichaLauncher/${LAUNCHER_VERSION}`;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function hashFile(file, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Downloads url to dest unless a file of the expected size is already there.
// Writes to a .part file first so an interrupted download never looks complete.
// Checks whichever checksum is given (sha1, sha256 or md5, as hex).
async function downloadFile(url, dest, { sha1, sha256, md5, size } = {}, attempts = 3) {
  const [algorithm, expected] = sha1 ? ['sha1', sha1] : sha256 ? ['sha256', sha256] : md5 ? ['md5', md5] : [];
  if (fs.existsSync(dest) && (size == null || fs.statSync(dest).size === size)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      if (algorithm && (await hashFile(tmp, algorithm)) !== expected.toLowerCase()) throw new Error(`Checksum mismatch for ${url}`);
      fs.renameSync(tmp, dest);
      return true;
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      if (attempt >= attempts) throw err;
    }
  }
}

// Runs worker over items with at most `limit` in flight.
async function runPool(items, limit, worker, onProgress) {
  let next = 0;
  let done = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

module.exports = { LAUNCHER_VERSION, USER_AGENT, fetchJson, downloadFile, runPool };

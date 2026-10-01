const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// Modrinth asks every client to send an identifying User-Agent.
const USER_AGENT = 'HojichaLauncher/0.1.0';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Downloads url to dest unless a file of the expected size is already there.
// Writes to a .part file first so an interrupted download never looks complete.
async function downloadFile(url, dest, { sha1, size } = {}, attempts = 3) {
  if (fs.existsSync(dest) && (size == null || fs.statSync(dest).size === size)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      if (sha1 && (await sha1File(tmp)) !== sha1) throw new Error(`Checksum mismatch for ${url}`);
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

module.exports = { USER_AGENT, fetchJson, downloadFile, runPool };

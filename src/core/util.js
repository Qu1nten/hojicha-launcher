const fs = require('fs');
const path = require('path');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// For files the launcher can do without (it starts over with fallback): a missing file gives fallback, and so does
// an unreadable one, which is first renamed to <name>.broken-<time> so whatever it held isn't overwritten by the
// next save and can still be recovered by hand.
function readJsonOr(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const aside = `${file}.broken-${Date.now()}`;
    console.error(`${file} is damaged (${err.message}); keeping it as ${aside}`);
    try {
      fs.renameSync(file, aside);
    } catch {
      // Leave it; the next save replaces it.
    }
    return fallback;
  }
}

// Writes a temporary file next to it and swaps it in, so a crash or power cut mid-write never leaves half a file.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.saving`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  // Windows refuses the swap while something (usually antivirus) briefly has the file open: try a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        fs.rmSync(temp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

module.exports = { readJson, readJsonOr, writeJson };

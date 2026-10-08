const fs = require('fs');
const path = require('path');

// While a game runs, every screenshot it takes (F2) goes to the clipboard too. The game writes the file in one go,
// but the folder hears about it before it's finished, so a new file is copied once its size stops changing.
// The folder may be a junction into synced\ (sync.js); the watch goes to the folder it points at.
function watch(gameDir, onError) {
  const { clipboard, ClipboardItem, nativeImage } = require('electron');
  const local = path.join(gameDir, 'screenshots');
  let dir;
  let watcher;
  try {
    fs.mkdirSync(local, { recursive: true });
    dir = fs.realpathSync(local);
    const existing = new Set(fs.readdirSync(dir));
    const pending = new Map();
    const copyWhenWritten = (file, lastSize = -1) => {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        pending.delete(file); // removed again
        return;
      }
      if (size === 0 || size !== lastSize) {
        pending.set(file, setTimeout(() => copyWhenWritten(file, size), 250));
        return;
      }
      pending.delete(file);
      if (nativeImage.createFromPath(file).isEmpty()) return; // not a whole PNG after all
      try {
        const png = new Blob([fs.readFileSync(file)], { type: 'image/png' });
        clipboard.write([new ClipboardItem({ 'image/png': png })]).catch((err) => onError(err.message));
      } catch (err) {
        onError(err.message);
      }
    };
    watcher = fs.watch(dir, (event, name) => {
      if (!name || !/\.png$/i.test(name) || existing.has(name)) return;
      existing.add(name);
      const file = path.join(dir, name);
      if (!pending.has(file)) copyWhenWritten(file);
    });
    watcher.on('error', (err) => onError(err.message));
    return {
      close() {
        watcher.close();
        for (const timer of pending.values()) clearTimeout(timer);
      },
    };
  } catch (err) {
    watcher?.close();
    onError(err.message);
    return null;
  }
}

module.exports = { watch };

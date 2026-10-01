// Builds the app icons from the 16x16 pixel-art logo (build/logo.png):
//   build/icon.png  512x512 (window icon on non-Windows, README)
//   build/icon.ico  16-256px for Windows (window, taskbar, installer, shortcuts)
// Every size is a whole-number enlargement with nearest-neighbour scaling, so the pixels stay crisp.
// 24px is not a multiple of 16, so there the 16px art is centred on a 24px canvas instead of being stretched.
// Run with: npm run icon
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, 'logo.png');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Nearest-neighbour scale of a BGRA bitmap by a whole factor, centred on a size x size canvas.
function scale(src, srcSize, factor, size) {
  const out = Buffer.alloc(size * size * 4);
  const offset = Math.floor((size - srcSize * factor) / 2);
  for (let y = 0; y < srcSize * factor; y++) {
    for (let x = 0; x < srcSize * factor; x++) {
      const from = (Math.floor(y / factor) * srcSize + Math.floor(x / factor)) * 4;
      const to = ((y + offset) * size + (x + offset)) * 4;
      src.copy(out, to, from, from + 4);
    }
  }
  return out;
}

// Classic 32-bit DIB icon frame (most compatible for small sizes).
function toDib(size, bgra) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height covers colour data + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    bgra.copy(pixels, (size - 1 - y) * size * 4, y * size * 4, (y + 1) * size * 4); // DIB rows are bottom-up
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all zero: transparency comes from alpha
  return Buffer.concat([header, pixels, mask]);
}

// 256px is stored as PNG (supported since Windows Vista), smaller sizes as DIBs.
function buildIco(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);  // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.data)]);
}

app.whenReady().then(() => {
  const logo = nativeImage.createFromPath(SOURCE);
  const { width, height } = logo.getSize();
  if (width !== height) throw new Error(`logo.png must be square (got ${width}x${height})`);
  const src = logo.toBitmap();
  const toImage = (bgra, size) => nativeImage.createFromBitmap(bgra, { width: size, height: size });

  fs.writeFileSync(path.join(__dirname, 'icon.png'), toImage(scale(src, width, Math.floor(512 / width), 512), 512).toPNG());

  const frames = ICO_SIZES.map((size) => {
    const bgra = scale(src, width, Math.max(1, Math.floor(size / width)), size);
    return { size, data: size >= 256 ? toImage(bgra, size).toPNG() : toDib(size, bgra) };
  });
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), buildIco(frames));
  app.quit();
});

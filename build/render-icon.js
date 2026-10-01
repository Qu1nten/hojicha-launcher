// Renders build/icon.svg to build/icon.png (512x512) and build/icon.ico (16-256px, each size drawn from the vector).
// Run with: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Classic 32-bit DIB icon frame (most compatible for small sizes). bgra is Electron's premultiplied BGRA bitmap.
function toDib(size, bgra) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // height covers colour data + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4; // DIB rows are bottom-up
      const a = bgra[src + 3];
      for (let c = 0; c < 3; c++) {
        pixels[dst + c] = a === 0 ? 0 : Math.min(255, Math.round((bgra[src + c] * 255) / a));
      }
      pixels[dst + 3] = a;
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all zero: transparency comes from alpha
  return Buffer.concat([header, pixels, mask]);
}

// 256px is stored as PNG (supported since Windows Vista), smaller sizes as DIBs.
function buildIco(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);  // color planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true },
  });
  let pending = null;
  win.webContents.on('paint', (_event, _dirty, image) => {
    if (pending && image.getSize().width >= 512) {
      const resolve = pending;
      pending = null;
      resolve(image);
    }
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const render = async (size) => {
    await win.webContents.executeJavaScript(`(() => {
      const svg = document.querySelector('svg');
      svg.setAttribute('width', ${size});
      svg.setAttribute('height', ${size});
    })()`);
    // Repaint until the frame contains the icon at this size: a pixel near the right edge must be opaque
    // (a stale frame from a smaller size, or an empty first frame, is transparent there).
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 150));
      const image = await new Promise((resolve) => {
        pending = resolve;
        win.webContents.invalidate();
      });
      const cropped = image.crop({ x: 0, y: 0, width: size, height: size });
      const probe = (Math.floor(size / 2) * size + Math.floor(size * 0.9)) * 4;
      if (cropped.getSize().width === size && cropped.toBitmap()[probe + 3] === 255) return cropped;
    }
    throw new Error(`Icon did not render at ${size}px`);
  };

  fs.writeFileSync(path.join(__dirname, 'icon.png'), (await render(512)).toPNG());
  const pngs = [];
  for (const size of ICO_SIZES) {
    const image = await render(size);
    pngs.push({ size, data: size >= 256 ? image.toPNG() : toDib(size, image.toBitmap()) });
  }
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), buildIco(pngs));
  app.quit();
});

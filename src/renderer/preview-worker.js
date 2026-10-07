// Draws the pictures for the Schematics view's tiles, away from the page so it stays smooth while they're made
// (app.js sends the schematics, read by main.js). Drawing is the same as for the big view (schematics.js), on a canvas
// of its own here.
importScripts('vendor/deepslate.js', 'schematics.js');

let resources = null; // Promise of the block resources, from the assets main.js unpacked
let view = null;
let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  if (data.type === 'assets') {
    resources = schematicKit.loadResources(data.assets);
    resources.catch(() => {}); // reported by the first picture that needs them
    return;
  }
  if (data.type === 'draw') queue = queue.then(() => draw(data));
};

// One picture: { id, model } in; progress messages while it's built, then the picture (a PNG data: URL), or why
// there's none.
async function draw({ id, model }) {
  try {
    schematicKit.prepare(model);
    if (!view) view = new schematicKit.View(new OffscreenCanvas(480, 360), await resources, { keepPicture: true, fixedCamera: true });
    await view.show(model, (fraction) => self.postMessage({ id, fraction }));
    view.reset();
    view.drawFitted(); // filling the picture, however it's shaped
    const blob = await view.canvas.convertToBlob({ type: 'image/png' });
    const url = new FileReaderSync().readAsDataURL(blob);
    view.clear(); // lets go of the blocks until the next one
    self.postMessage({ id, url });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
}

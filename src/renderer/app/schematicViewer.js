import { $, api, askConfirm, el, errorText, state } from './core.js';
import { here, nav, remember } from './nav.js';
import {
  blockResources,
  loadSchematic,
  renderSchematics,
  schem,
  SCHEM_ICONS,
  SCHEM_TYPES,
  schematicRenamed,
  schematicsShown,
  schemBlocks,
  schemCreated,
  schemSize,
  schemVersion,
  takeSchematicList,
} from './schematics.js';

// ---- The big view ----

export const schemOpen = { item: null, view: null, frame: 0 };

function drawSchematicSoon() {
  if (schemOpen.frame) return;
  schemOpen.frame = requestAnimationFrame(() => {
    schemOpen.frame = 0;
    const { view } = schemOpen;
    if (!view || !$('#schem-dialog').open) return;
    // Sharp on high-DPI screens: as many pixels as the screen shows.
    const canvas = view.canvas;
    const width = Math.round(canvas.clientWidth * devicePixelRatio);
    const height = Math.round(canvas.clientHeight * devicePixelRatio);
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    view.draw();
  });
}

// The bar under the schematic while it's being built: fraction done, or null to hide it.
function showSchematicProgress(fraction) {
  const bar = $('#schem-progress');
  bar.hidden = fraction === null;
  if (fraction === null) return;
  const percent = Math.round(fraction * 100);
  bar.firstElementChild.style.width = `${percent}%`;
  bar.setAttribute('aria-valuenow', String(percent));
}

// Opens a schematic in the 3D view: shrunk to what it can show smoothly, or every block (full: asked for with the
// Full detail button, which only shows when that's within what it can take).
export async function openSchematic(item, { full = false } = {}) {
  schemOpen.item = item;
  showSchematicSteps();
  $('#schem-full').hidden = true;
  $('#schem-size').textContent = '';
  const where = item.instance ? `in ${item.instance.name}` : null;
  finishSchematicRename(false);
  $('#schem-name').textContent = item.name;
  // Its kind, as the file's extension with the format's mark (the format named on hovering it).
  const ext = $('#schem-ext');
  ext.innerHTML = SCHEM_ICONS[item.type];
  ext.append(item.path.slice(item.path.lastIndexOf('.')).toLowerCase());
  ext.title = SCHEM_TYPES[item.type];
  showSchematicMeta([where]);
  $('#schem-stage-text').textContent = '';
  showSchematicProgress(null);
  schemOpen.view?.clear();
  if (!$('#schem-dialog').open) $('#schem-dialog').showModal(); // open already when back or forward goes to another
  remember();
  drawSchematicSoon(); // clears what was shown before
  // The bar fills for reading the file (main.js does, in a thread of its own), then for building it. It only shows
  // up when that takes a moment, so small ones don't flash it.
  let fraction = 0;
  const progress = (f) => {
    fraction = f;
    if (!$('#schem-progress').hidden && schemOpen.item === item) showSchematicProgress(f);
  };
  const barTimer = setTimeout(() => {
    if (schemOpen.item === item) showSchematicProgress(fraction);
  }, 150);
  let model;
  let resources;
  try {
    [resources, model] = await Promise.all([
      blockResources(),
      // As much detail as is quick to show (a big build is shrunk), or all of it.
      loadSchematic(item.path, 64 * 1024 * 1024, (f) => progress(f / 2), !full),
    ]);
  } catch (err) {
    clearTimeout(barTimer);
    if (schemOpen.item !== item) return;
    showSchematicProgress(null);
    $('#schem-stage-text').textContent = /memory/i.test(errorText(err))
      ? "This schematic is too much for this computer to read."
      : `Couldn't read this file. ${errorText(err)}`;
    return;
  }
  if (schemOpen.item !== item || !$('#schem-dialog').open) {
    clearTimeout(barTimer);
    return;
  }
  schematicKit.prepare(model);
  // A huge build comes shrunk: one block for each cube of scale x scale x scale.
  const shrunk = model.scale > 1 ? ` · shown at 1 in ${model.scale}` : '';
  const created = schemCreated(model.details?.created);
  showSchematicMeta([
    model.author && `by ${model.author}`,
    schemBlocks(model.realCount),
    schemVersion(model.details?.version),
    created && { text: created.text, title: created.title },
    where,
  ]);
  $('#schem-size').textContent = `${schemSize(model.realSize)}${shrunk}`;
  if (model.canShowFull) {
    $('#schem-full').hidden = false;
    $('#schem-full').title = 'Show every block';
    schemOpen.fullCost = model.fullCost;
  }
  const stop = (text) => {
    clearTimeout(barTimer);
    showSchematicProgress(null);
    $('#schem-stage-text').textContent = text;
  };
  if (!resources) {
    stop('The 3D view needs a downloaded game version: play any instance once.');
    return;
  }
  if (!model.count) {
    stop('This schematic is empty.');
    return;
  }
  try {
    if (!schemOpen.view) schemOpen.view = new schematicKit.View($('#schem-canvas'), resources);
  } catch (err) {
    stop(errorText(err));
    return;
  }
  // It's built a few chunks at a time, from the bottom up, and shown as it grows.
  const view = schemOpen.view;
  view.reset();
  const done = await view.show(model, (f) => {
    progress(0.5 + f / 2);
    drawSchematicSoon();
  });
  clearTimeout(barTimer);
  if (!done) return; // another schematic was opened, or the window closed
  showSchematicProgress(null);
  drawSchematicSoon();
}

// Renaming the open schematic happens on its name, as for an instance: it turns into a text box; Enter or clicking
// away saves, Escape cancels. The file itself is renamed, so the game's mods see the new name.
function startSchematicRename() {
  const { item } = schemOpen;
  if (!item) return;
  const input = $('#schem-rename');
  input.value = item.name;
  $('#schem-name').hidden = true;
  input.hidden = false;
  $('#schem-rename-error').textContent = '';
  input.focus();
  input.select();
}

async function finishSchematicRename(save) {
  const input = $('#schem-rename');
  if (input.hidden || input.disabled) return; // disabled: already saving (disabling it blurs it)
  const { item } = schemOpen;
  const name = input.value.trim();
  const close = (error = '') => {
    input.hidden = true;
    $('#schem-name').hidden = false;
    $('#schem-rename-error').textContent = error;
  };
  if (!save || !item || !name || name === item.name) {
    close();
    return;
  }
  input.disabled = true;
  try {
    const renamed = schematicRenamed(item, await api.renameSchematic(item.path, name));
    if (renamed && schemOpen.item === item) {
      schemOpen.item = renamed;
      $('#schem-name').textContent = renamed.name;
    }
    close();
    renderSchematics();
  } catch (err) {
    close(errorText(err));
  } finally {
    input.disabled = false;
  }
}

// What the open schematic says about itself, over its picture: each part (text, or { text, title }) on its own.
function showSchematicMeta(parts) {
  $('#schem-meta').replaceChildren(...parts.filter(Boolean).map((part) => (typeof part === 'string'
    ? el('span', { textContent: part })
    : el('span', { textContent: part.text, title: part.title }))));
}

// Every block of a big build, after saying what that costs: estimated from what reading it found (core/
// schematicFile.js): drawing takes about 7 microseconds for each chunk with something to show, and building about
// 430 bytes for each face and 16 for each block.
async function showFullDetail() {
  const { item, fullCost: cost } = schemOpen;
  if (!item || !cost) return;
  const fps = Math.max(1, Math.min(60, Math.round(1000 / (cost.chunks * 0.007))));
  const gb = (cost.faces * 430 + cost.cells * 16) / 1e9;
  const memory = gb < 1 ? `about ${Math.round(gb * 10) * 100} MB` : `about ${gb.toFixed(1)} GB`;
  const yes = await askConfirm({
    title: 'Show every block?',
    text: `Turning it gets choppier (about ${fps} frames a second), it uses ${memory} of memory while it's open, and it takes longer to load.`,
    confirm: 'Show every block',
    cancel: 'Keep it shrunk',
  });
  if (yes && schemOpen.item === item) openSchematic(item, { full: true });
}

// The schematics either side of the open one, as they're listed behind it (in the folder, or found by the filter).
function schematicNeighbours() {
  const shown = schematicsShown();
  const at = shown.indexOf(schemOpen.item?.path);
  const find = (path) => (path ? schem.items.find((one) => one.path === path) : null);
  return at < 0 ? {} : { previous: find(shown[at - 1]), next: find(shown[at + 1]) };
}

function showSchematicSteps() {
  const { previous, next } = schematicNeighbours();
  $('#schem-prev').hidden = !previous;
  $('#schem-next').hidden = !next;
  $('#schem-prev').title = previous ? `${previous.name} (←)` : '';
  $('#schem-next').title = next ? `${next.name} (→)` : '';
}

// Opens the schematic before (-1) or after (1) the open one. It takes the open one's place in the history, so Back
// leaves the view rather than stepping through every one looked at.
function stepSchematic(direction) {
  const { previous, next } = schematicNeighbours();
  const to = direction < 0 ? previous : next;
  if (!to) return;
  nav.moving = true;
  try {
    openSchematic(to);
  } finally {
    nav.moving = false;
  }
  if (nav.stack[nav.index]?.view === 'schematics') nav.stack[nav.index] = here();
}

export async function deleteSchematic() {
  const { item } = schemOpen;
  if (!item) return;
  const yes = await askConfirm({
    title: `Delete ${item.name}?`,
    text: item.instance ? `It's moved to the Recycle Bin, from ${item.instance.name}.` : "It's moved to the Recycle Bin, and it's gone from every instance.",
    confirm: 'Delete',
    cancel: 'Keep it',
  });
  if (!yes) return;
  try {
    takeSchematicList(await api.trashSchematics([item.path]));
  } catch (err) {
    $('#schem-stage-text').textContent = errorText(err);
    return;
  }
  $('#schem-dialog').close();
  renderSchematics();
}

// Drag to turn, right-drag (or Shift-drag) to move, scroll to zoom, double-click to look from the start again.
{
  const canvas = $('#schem-canvas');
  let drag = null;
  canvas.addEventListener('pointerdown', (event) => {
    if (!schemOpen.view?.model || event.button > 2) return; // the back and forward buttons go through history
    const { yaw, pitch, pan } = schemOpen.view;
    drag = { x: event.clientX, y: event.clientY, yaw, pitch, pan: [...pan], move: event.button === 2 || event.shiftKey };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const view = schemOpen.view;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.move) {
      const scale = 2 / canvas.clientHeight / view.zoom;
      view.pan = [drag.pan[0] + dx * scale, drag.pan[1] - dy * scale];
    } else {
      view.yaw = drag.yaw + dx * 0.01;
      view.pitch = Math.max(-1.5, Math.min(1.5, drag.pitch + dy * 0.01));
    }
    drawSchematicSoon();
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    if (!schemOpen.view?.model) return;
    event.preventDefault();
    const view = schemOpen.view;
    view.zoom = Math.max(0.3, Math.min(view.maxZoom(), view.zoom * Math.exp(-event.deltaY * 0.0015)));
    drawSchematicSoon();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    if (!schemOpen.view?.model) return;
    schemOpen.view.reset();
    drawSchematicSoon();
  });
  new ResizeObserver(drawSchematicSoon).observe(canvas);
}

$('#schem-dialog').addEventListener('close', () => {
  schemOpen.item = null;
  schemOpen.view?.clear(); // stops building, and lets go of the blocks
  if (state.view === 'schematics') remember(); // back opens it again
});
$('#schem-reveal').onclick = () => schemOpen.item && api.revealSchematic(schemOpen.item.path);
$('#schem-rename-button').onclick = startSchematicRename;
$('#schem-full').onclick = showFullDetail;
$('#schem-prev').onclick = () => stepSchematic(-1);
$('#schem-next').onclick = () => stepSchematic(1);
// ← and → step through them while the 3D view is open (not while renaming, nor with another popup over it).
document.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !$('#schem-dialog').open) return;
  if ([...document.querySelectorAll('dialog[open]')].some((dialog) => dialog.id !== 'schem-dialog')) return;
  if (event.target.closest?.('input, textarea, select')) return;
  event.preventDefault();
  stepSchematic(event.key === 'ArrowLeft' ? -1 : 1);
});
$('#schem-name').ondblclick = startSchematicRename;
$('#schem-rename').onkeydown = (event) => {
  if (event.key === 'Enter') finishSchematicRename(true);
  if (event.key === 'Escape') {
    event.preventDefault(); // cancels the rename, not the whole window
    finishSchematicRename(false);
  }
};
$('#schem-rename').onblur = () => finishSchematicRename(true);
$('#schem-done').onclick = () => $('#schem-dialog').close();

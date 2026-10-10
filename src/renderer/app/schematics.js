import { $, api, askConfirm, dateFormat, el, errorText, state } from './core.js';
import { remember, renderMain } from './nav.js';
import { deleteSchematic, openSchematic } from './schematicViewer.js';
import { confirmDiscard } from './serverFiles.js';
import { renderSidebar } from './sidebar.js';

// The Schematics view (the row above Instances): every schematic Litematica, WorldEdit and Axiom saved, shared ones
// first, then those of instances that keep their own (core/schematics.js). Each tile is a picture of it in 3D,
// drawn once and kept (renderer/schematics.js draws it, with the block models core/blocks.js unpacks from a
// downloaded game). Clicking one opens it big, to turn and zoom. The circle on each picks it, to put several in a
// group (a folder) or delete them. Schematic files dropped on the launcher are added.
// Folders are shown one at a time, as in File Explorer: a folder is a tile (a stack, with four of what's in it), and
// clicking it goes in, with the way back up over the tiles. Instances that keep their own schematics are folders too.
// Typing in the filter looks in every folder at once.
export const SCHEM_TYPES = { litematica: 'Litematica', worldedit: 'WorldEdit', axiom: 'Axiom' };
// Each format's mark, in one colour, for the corner of its tiles.
export const SCHEM_ICONS = {
  // Litematica: a cube, its three faces in three shades.
  litematica: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5 14 4.8 8 8.1 2 4.8Z" opacity=".55"/><path d="M2 5.9 7.4 8.9V15L2 12Z" opacity=".85"/><path d="M14 5.9 8.6 8.9V15L14 12Z"/></svg>',
  // Axiom: two walls and a floor around a corner, with arrows out along the three axes.
  axiom: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 .5 10.2 3.6H5.8Z"/><path d="M7.3 3.4h1.4v5.2H7.3Z"/><path d="M.6 14.6 1.5 10.8 4.6 13.3Z"/><path d="M15.4 14.6 14.5 10.8 11.4 13.3Z"/><path d="M3.6 6.6 6.6 5.2V9.3L3.6 10.7Z"/><path d="M12.4 6.6 9.4 5.2V9.3L12.4 10.7Z"/><path d="M8 10.4 11.6 12.2 8 14 4.4 12.2Z"/></svg>',
  // WorldEdit: its wooden axe, as the game's pixel art (the outline on a 13 x 13 grid).
  worldedit: '<svg viewBox="0 0 13 13" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path d="M7 0h2v1h-2zM6 1h1v1h-1zM9 1h1v1h-1zM5 2h1v1h-1zM9 2h1v1h-1zM4 3h1v1h-1zM9 3h2v1h-2zM4 4h1v1h-1zM10 4h1v1h-1zM5 5h3v1h-3zM11 5h1v1h-1zM6 6h1v1h-1zM8 6h1v1h-1zM11 6h1v1h-1zM5 7h1v1h-1zM7 7h1v1h-1zM9 7h2v1h-2zM4 8h1v1h-1zM6 8h1v1h-1zM3 9h1v1h-1zM5 9h1v1h-1zM2 10h1v1h-1zM4 10h1v1h-1zM1 11h1v1h-1zM3 11h1v1h-1zM1 12h2v1h-2z"/></svg>',
};
// Schematics are shown newest first, by when they were made (ones that don't say yet go last); equal ones by name.
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const byNewest = (a, b) => (b.created?.time ?? -1) - (a.created?.time ?? -1);
const inSchematicOrder = (items) => items.slice().sort((a, b) => byNewest(a, b) || byName(a, b));
// How big their tiles are.
const SCHEM_VIEWS = [['large', 'Large tiles'], ['tiles', 'Tiles'], ['small', 'Small tiles']];

// The tile size picked last time (a convenience: kept in this computer's browser storage, if it's there).
function savedSchematic(key, allowed, otherwise) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : otherwise;
  } catch {
    return otherwise;
  }
}

function saveSchematic(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not kept: back to the usual next time
  }
}

const FOLDER_ICON = '<svg class="schem-folder-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5A1 1 0 0 1 2.5 2.5H6l1.6 1.6H13.5a1 1 0 0 1 1 1V12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z"/></svg>';
export const schem = {
  items: null, // from api.listSchematics(), or null until loaded
  folders: [], // every shared folder, empty ones too: its names from the top
  dragging: null, // what's being dragged to another folder: { files, folders }
  kind: 'all', // the filter: all, litematica, worldedit or axiom
  view: savedSchematic('schematicView', SCHEM_VIEWS.map(([view]) => view), 'tiles'), // the tiles' size (SCHEM_VIEWS)
  anchor: null, // the path picked last, where Shift-click picks from
  filter: '',
  at: [], // the folder shown: its keys from the top (see schematicTree)
  failed: new Map(), // path -> why its picture couldn't be drawn: { text, reason }
  tiles: new Map(), // path -> its tile, so a finished picture can be put in
  folderTiles: new Map(), // folder key -> its tile, to put in the pictures that are drawn while it's shown
  onScreen: new Set(), // the keys of the tiles on screen (see watchOnScreen)
  observer: null,
  selected: new Set(), // paths picked with the circle
  resources: null, // Promise of the block resources, or of null without a downloaded game
  previewRun: 0,
  drawing: null, // the one whose picture is being drawn: { path, fraction }
  seen: null, // the list as loadSchematics() last got it, as JSON
};

export function openSchematics() {
  if (state.view === 'server' && !confirmDiscard(openSchematics)) return;
  state.view = 'schematics';
  renderSidebar();
  renderMain();
  loadSchematics();
}

// whenChanged: only redraw if the files are different from the last look (the window getting focus looks again).
export async function loadSchematics({ whenChanged = false } = {}) {
  try {
    const list = await api.listSchematics();
    const seen = JSON.stringify(list);
    if (whenChanged && schem.items && seen === schem.seen) return; // keeps the tiles, and the pictures being drawn
    showSchemNote('');
    takeSchematicList(list);
    schem.seen = seen;
  } catch (err) {
    schem.items = schem.items || [];
    showSchemNote(errorText(err));
  }
  if (state.view === 'schematics') {
    renderSchematics();
    drawMissingPreviews();
  }
}

// A new list from main.js ({ items, folders }, see core/schematics.js): picked ones that are gone (deleted, moved)
// aren't picked any more.
export function takeSchematicList(list) {
  schem.seen = null; // what loadSchematics() last saw is out of date
  schem.items = list.items;
  schem.folders = list.folders;
  const paths = new Set(schem.items.map((item) => item.path));
  for (const path of schem.selected) if (!paths.has(path)) schem.selected.delete(path);
  renderSchematicsCount();
}

function renderSchematicsCount() {
  const n = schem.items?.length;
  $('#schematics-count').textContent = n === undefined ? 'Litematica, WorldEdit, Axiom' : `${n} ${n === 1 ? 'file' : 'files'}`;
}

export function showSchemNote(text) {
  $('#schem-note').textContent = text;
  $('#schem-note').hidden = !text;
}

// The block models, unpacked by main.js and turned into deepslate's resources once. Null before a game version is
// downloaded (there's nothing to draw blocks with).
// The block models and textures main.js unpacks (core/blocks.js), fetched once. Null without a downloaded game.
function blockAssets() {
  if (!schem.assets) {
    schem.assets = api.blockAssets().catch((err) => {
      schem.assets = null; // try again next time
      throw err;
    });
  }
  return schem.assets;
}

export function blockResources() {
  if (!schem.resources) {
    schem.resources = blockAssets()
      .then((assets) => (assets ? schematicKit.loadResources(assets) : null))
      .catch((err) => {
        schem.resources = null; // try again next time
        throw err;
      });
  }
  return schem.resources;
}

export const schemSize = (size) => size.join(' × ');
export const schemBlocks = (n) => `${n.toLocaleString()} ${n === 1 ? 'block' : 'blocks'}`;
// The game version it was saved in, said as such ("Minecraft 1.20.1"; "Minecraft 1.21.4 snapshot").
export const schemVersion = (version) => (version ? `Minecraft ${version}` : '');
// When it was made: the date the file records, else the file's own date, which says so (a file copied from elsewhere
// may be younger than what's in it). With what it means, for a tooltip.
export function schemCreated(created) {
  if (!created) return null;
  const date = dateFormat.format(new Date(created.time));
  return created.recorded
    ? { text: `Created ${date}`, title: 'When it was saved in the game' }
    : { text: `File from ${date}`, title: "This schematic doesn't say when it was made: this is the file's own date" };
}

const CIRCLE_CHECK = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.3l2.6 2.6L12 5.4"/></svg>';

// A tile: the picture (opens it big), with its format's mark in the corner and, in the other, the circle that picks
// it. While anything is picked, a click anywhere on a tile picks or unpicks it. In the filter's results, the folder
// it's in is on it too.
function schematicTile(item, { showFolder = false } = {}) {
  const picked = schem.selected.has(item.path);
  const picture = el('div', { className: 'schem-pic' }, [
    el('span', { className: 'schem-format', title: SCHEM_TYPES[item.type], innerHTML: SCHEM_ICONS[item.type] }),
  ]);
  const folders = item.folder ? item.folder.split(/[\\/]/) : [];
  if (showFolder && (folders.length || item.instance)) {
    const where = [item.instance && `Only in ${item.instance.name}`, ...folders].filter(Boolean);
    const chip = el('span', { className: 'schem-where', title: where.join(' › '), innerHTML: FOLDER_ICON });
    chip.append(where[where.length - 1]);
    picture.append(chip);
  }
  const failed = schem.failed.get(item.path);
  if (item.preview) picture.prepend(el('img', { src: item.preview.url, alt: '', draggable: false }));
  else if (failed) picture.prepend(el('span', { className: 'schem-pic-text', textContent: failed.text, title: failed.reason }));
  else picture.prepend(schematicWaiting(item));
  // How many blocks and which game version, then when it was made: known once it's been read for its picture. Only a
  // date the file records: the file's own is mostly when it was copied (the big view says it, and what it is).
  const sub = item.preview ? [schemBlocks(item.preview.blocks), item.version].filter(Boolean).join(' · ') : SCHEM_TYPES[item.type];
  const created = item.preview && item.created?.recorded ? schemCreated(item.created) : null;
  const open = el('button', { type: 'button', className: 'schem-tile', title: [item.name, created?.title].filter(Boolean).join('\n') }, [
    picture,
    el('span', { className: 'schem-text' }, [
      el('span', { className: 'schem-name', textContent: item.name }),
      el('span', { className: 'schem-sub', textContent: sub }),
      created ? el('span', { className: 'schem-sub', textContent: created.text }) : null,
    ]),
  ]);
  open.onclick = (event) => clickSchematic(event, item);
  const check = el('button', {
    type: 'button',
    className: 'schem-check',
    innerHTML: CIRCLE_CHECK,
    title: picked ? 'Unpick' : 'Pick',
    ariaLabel: `Pick ${item.name}`,
  });
  check.setAttribute('aria-pressed', String(picked));
  check.onclick = (event) => (event.shiftKey ? pickSchematicsTo(item) : toggleSchematic(item));
  const tile = el('div', { className: `schem-tile-wrap schem-entry${picked ? ' picked' : ''}` }, [open, check, failed ? retryButton(item) : null]);
  return wireSchematicEntry(tile, item);
}

// What a schematic's tile does besides opening: right-click for its menu, dragged onto a folder to move it
// there (a picked one takes the others picked with it), and kept track of to put its picture in when it's drawn.
function wireSchematicEntry(tile, item) {
  tile.oncontextmenu = (event) => schematicMenu(event, item);
  // Dragged onto a folder, it moves there; a picked one takes the others picked with it.
  if (!item.instance) {
    draggableSchematics(tile, () => (schem.selected.has(item.path)
      ? { files: schematicsPicked().filter((one) => !one.instance).map((one) => one.path), folders: [] }
      : { files: [item.path], folders: [] }));
  }
  schem.tiles.set(item.path, tile);
  watchOnScreen(tile, item.path);
  return tile;
}

// A schematic whose picture couldn't be drawn can be tried again (the tile's picture says why on hovering it).
function retryButton(item) {
  const button = el('button', { type: 'button', className: 'schem-retry', textContent: 'Try again' });
  button.onclick = () => {
    schem.failed.delete(item.path);
    showSchematicPicture(item);
    drawMissingPreviews();
  };
  return button;
}

// What opens or picks a schematic: a click opens it (or, while some are picked, picks it); Shift-click picks every one
// from the last picked to it.
function clickSchematic(event, item) {
  if (event.shiftKey) pickSchematicsTo(item);
  else if (schem.selected.size) toggleSchematic(item);
  else openSchematic(item);
}

// A menu of choices under its button, the one picked ticked: choices [value, name], picked the value, pick(value).
function showSchematicChoices(button, choices, picked, pick) {
  const box = button.getBoundingClientRect();
  showSchematicMenu({ preventDefault() {}, stopPropagation() {}, clientX: box.left, clientY: box.bottom + 6, currentTarget: button },
    choices.map(([value, name]) => ({
      label: `${value === picked ? '✓' : '\u2003'}  ${name}`, // an em space where there's no tick, to line them up
      run: () => pick(value),
    })));
}

const schematicsPicked = () => (schem.items || []).filter((item) => schem.selected.has(item.path));

// The schematics shown (those of the format picked) as folders: { key, name, keys, instance, folders: Map, items }.
// A folder's key is its path from the top ("/Assets/trees"); an instance that keeps its own schematics is a folder at
// the top ("/instance:<id>", which no real folder can be called), its own folders under it. keys: the names on the
// way to it from the top, as in schem.at.
function schematicTree() {
  const top = { key: '', name: 'Schematics', keys: [], instance: null, folders: new Map(), items: [], byKey: new Map() };
  const child = (parent, id, name, instance) => {
    if (!parent.folders.has(id)) {
      const node = { key: `${parent.key}/${id}`, name, keys: [...parent.keys, id], instance, folders: new Map(), items: [] };
      parent.folders.set(id, node);
      top.byKey.set(node.key, node);
    }
    return parent.folders.get(id);
  };
  for (const item of schem.items || []) {
    if (schem.kind !== 'all' && item.type !== schem.kind) continue;
    let at = item.instance ? child(top, `instance:${item.instance.id}`, item.instance.name, item.instance) : top;
    for (const part of schematicFolderOf(item)) at = child(at, part, part, at.instance);
    at.items.push(item);
  }
  // Shared folders with nothing in them yet (just made, say), when nothing's filtered out.
  if (schem.kind === 'all') {
    for (const parts of schem.folders) parts.reduce((at, part) => child(at, part, part, null), top);
  }
  return top;
}

// The names of the folders a schematic is in, inside its root.
const schematicFolderOf = (item) => (item.folder ? item.folder.split(/[\\/]/) : []);

// Whether the folder at keys is (or is in) the shared folder: where schematics can be moved, made and renamed.
export const isSharedFolder = (keys) => !keys[0]?.startsWith('instance:');

// Every schematic in a folder and the folders in it, newest made first.
const schematicsIn = (node) => [...node.items, ...[...node.folders.values()].flatMap(schematicsIn)]
  .sort(byNewest);

// Every schematic in a folder, taking turns between its own and each folder in it (each of those the same way, newest
// made first in each), so the first few show the range of what's in it rather than four of one kind. picture: only
// ones with a picture.
function variedSchematicsIn(node, picture = false) {
  const lines = [
    node.items.filter((item) => !picture || item.preview).sort(byNewest),
    ...schematicFolders(node).map((folder) => variedSchematicsIn(folder, picture)),
  ].filter((line) => line.length);
  const out = [];
  for (let i = 0; out.length < lines.reduce((n, line) => n + line.length, 0); i++) {
    for (const line of lines) if (i < line.length) out.push(line[i]);
  }
  return out;
}

// The folder at keys, or the nearest one above it that's still there (it may have been renamed or emptied).
function schematicFolderAt(top, keys) {
  let node = top;
  for (const key of keys) {
    const next = node.folders.get(key);
    if (!next) break;
    node = next;
  }
  return node;
}

// Under the title, as under an instance's name: how many schematics and folders there are here, and where they're
// kept (shared by every instance, or only in one).
const META_ICONS = {
  schematics: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/><path d="M1.5 6h13M1.5 10h13M6 1.5v13M10 1.5v13"/></svg>',
  folders: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 4.2a1 1 0 0 1 1-1h3.3l1.5 1.5h5.6a1 1 0 0 1 1 1v6.6a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1Z"/></svg>',
  shared: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.8 7.1 10.2 4.9M5.8 8.9l4.4 2.2"/></svg>',
};
function showSchematicFacts(node) {
  const n = schematicsIn(node).length;
  const f = node.folders.size;
  const instance = node.instance;
  const facts = [
    ['schematics', `${n.toLocaleString()} ${n === 1 ? 'schematic' : 'schematics'}`],
    f ? ['folders', `${f} ${f === 1 ? 'folder' : 'folders'}`] : null,
    ['shared', instance ? `Only in ${instance.name}` : 'Shared by every instance'],
  ].filter(Boolean);
  $('#schem-meta-row').replaceChildren(...facts.map(([icon, text]) => {
    const item = el('span', { className: 'meta-item', innerHTML: META_ICONS[icon] });
    item.append(text);
    return item;
  }));
}

// What's in a folder: "60 schematics · 6 folders".
function schematicCounts(node) {
  const n = schematicsIn(node).length;
  const f = node.folders.size;
  return [`${n.toLocaleString()} ${n === 1 ? 'schematic' : 'schematics'}`, f ? `${f} ${f === 1 ? 'folder' : 'folders'}` : null]
    .filter(Boolean).join(' · ');
}

// Folders in the order they're shown: shared ones by name (numbers counted as numbers), then instances' own.
const schematicFolders = (node) => [...node.folders.values()].sort((a, b) => Boolean(a.instance && !node.instance) - Boolean(b.instance && !node.instance)
  || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

// A folder's tile: a stack of cards, the newest four pictures in it on top, its name and what's in it under them.
function schematicFolderTile(node) {
  const inside = schematicsIn(node);
  const pictures = variedSchematicsIn(node, true).slice(0, 4);
  const mosaic = el('div', { className: `schem-mosaic n${Math.max(1, pictures.length)}` },
    pictures.length ? pictures.map((item) => el('div', {}, [el('img', { src: item.preview.url, alt: '', draggable: false })])) : [el('div')]);
  const counts = [schematicCounts(node)];
  if (node.instance && node.keys.length === 1) counts.push('not shared');
  const name = el('span', { className: 'schem-name', innerHTML: FOLDER_ICON });
  name.append(el('span', { textContent: node.name }));
  const tile = el('button', {
    type: 'button',
    className: 'schem-tile',
    title: node.instance && node.keys.length === 1 ? `${node.name} keeps these schematics to itself` : node.name,
  }, [
    el('div', { className: 'schem-pic' }, [mosaic]),
    el('span', { className: 'schem-text' }, [name, el('span', { className: 'schem-sub', textContent: counts.filter(Boolean).join(' · ') })]),
  ]);
  tile.onclick = () => openSchematicFolder(node.keys);
  return wireSchematicFolder(el('div', { className: 'schem-folder' }, [tile]), node, inside);
}

// What a folder's tile does besides opening: right-click for its menu, dragged into another folder, things dropped on it
// moved into it, and its picture brought up to date as they're drawn.
function wireSchematicFolder(wrap, node, inside) {
  wrap.oncontextmenu = (event) => schematicFolderMenu(event, node, inside.length);
  if (isSharedFolder(node.keys)) {
    draggableSchematics(wrap, () => ({ files: [], folders: [node.keys] }));
    schematicDropTarget(wrap, node.keys);
  }
  schem.folderTiles.set(node.key, wrap);
  watchOnScreen(wrap, node.key);
  return wrap;
}

export function openSchematicFolder(keys) {
  schem.at = keys;
  if (schem.filter) {
    schem.filter = '';
    $('#schem-filter').value = '';
  }
  renderSchematics();
  $('.schem-scroll').scrollTop = 0;
  remember();
}

// One folder up, from inside one. False at the top.
function schematicFolderUp() {
  if (!schem.at.length || schem.filter.trim()) return false;
  openSchematicFolder(schem.at.slice(0, -1));
  return true;
}

// Inside a folder, the way back up from it in place of the title: a back button, then each folder from the top (each
// one a place to drop things into), the one shown last.
function renderSchematicCrumbs(top, node) {
  const crumbs = $('#schem-crumbs');
  crumbs.hidden = !node.keys.length;
  $('#schem-title').hidden = Boolean(node.keys.length);
  showSchematicFacts(node);
  if (!node.keys.length) {
    crumbs.replaceChildren();
    return;
  }
  const back = el('button', { type: 'button', className: 'schem-back', title: 'Back', ariaLabel: 'Back', textContent: '←' });
  back.onclick = schematicFolderUp;
  const steps = [top];
  for (const key of node.keys) steps.push(steps[steps.length - 1].folders.get(key));
  crumbs.replaceChildren(back, ...steps.flatMap((step, i) => {
    if (i === steps.length - 1) return [el('span', { className: 'schem-here', textContent: step.name, ariaCurrent: 'page' })];
    const button = el('button', { type: 'button', textContent: step.name });
    button.onclick = () => openSchematicFolder(step.keys);
    if (isSharedFolder(step.keys)) schematicDropTarget(button, step.keys);
    return [button, el('span', { className: 'schem-crumb-sep', textContent: '›', ariaHidden: 'true' })];
  }));
}

// A tile still without its picture: waiting in line, or being drawn, with a bar that fills as it's built.
function schematicWaiting(item) {
  const drawing = schem.drawing?.path === item.path;
  const fill = el('span');
  if (drawing) fill.style.width = `${Math.round(schem.drawing.fraction * 100)}%`;
  return el('span', { className: `schem-pic-wait${drawing ? ' drawing' : ''}` }, [
    el('span', { className: 'schem-pic-text', textContent: drawing ? 'Drawing...' : 'Waiting...' }),
    drawing ? el('span', { className: 'schem-mini-bar' }, [fill]) : null,
  ]);
}

function toggleSchematic(item) {
  if (schem.selected.has(item.path)) schem.selected.delete(item.path);
  else schem.selected.add(item.path);
  schem.anchor = item.path;
  renderSchematics();
}

// The schematics shown, in the order they're shown.
export const schematicsShown = () => [...document.querySelectorAll('#schem-list .schem-entry')].map((tile) => tile.dataset.seen);

// Shift-click: picks every schematic shown from the one picked last to this one.
function pickSchematicsTo(item) {
  const shown = schematicsShown();
  const from = shown.indexOf(schem.anchor);
  const to = shown.indexOf(item.path);
  if (from < 0 || to < 0) schem.selected.add(item.path);
  else for (const path of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) schem.selected.add(path);
  schem.anchor = item.path;
  renderSchematics();
}

// Ctrl+A: picks every schematic shown (in the folder, or found by the filter).
function pickAllSchematics() {
  for (const path of schematicsShown()) schem.selected.add(path);
  renderSchematics();
}

// The bar over the tiles while schematics are picked.
function renderSchematicSelection() {
  const n = schem.selected.size;
  $('#schem-selection').hidden = !n;
  $('#schem-list').classList.toggle('picking', n > 0);
  if (!n) return;
  $('#schem-selected-count').textContent = `${n} picked`;
  const own = schematicsPicked().some((item) => item.instance);
  $('#schem-group').disabled = own;
  $('#schem-group').title = own ? "Schematics an instance keeps to itself can't go in a group" : 'Put them in a new folder together';
  $('#schem-move-selected').disabled = own;
  $('#schem-move-selected').title = own ? "Schematics an instance keeps to itself can't be moved" : 'Put them in another folder';
}

function clearSchematicSelection() {
  schem.selected.clear();
  renderSchematics();
}

async function deleteSelectedSchematics() {
  const files = [...schem.selected];
  if (!files.length) return;
  const yes = await askConfirm({
    title: files.length === 1 ? 'Delete 1 schematic?' : `Delete ${files.length} schematics?`,
    text: "They're moved to the Recycle Bin.",
    confirm: 'Delete',
    cancel: 'Keep them',
  });
  if (!yes) return;
  try {
    takeSchematicList(await api.trashSchematics(files));
  } catch (err) {
    showSchemNote(errorText(err));
    await loadSchematics();
    return;
  }
  schem.selected.clear();
  renderSchematics();
}

// Where a new group goes: the shared folder that's shown (an instance's own folder isn't one), its names from the top.
const groupParent = () => (schem.at[0]?.startsWith('instance:') ? [] : schem.at);

async function openGroupDialog() {
  if (!schem.selected.size) return;
  const parent = groupParent();
  $('#group-where').textContent = parent.length
    ? `A folder in ${parent[parent.length - 1]}. Type the name of a group that's there to add to it.`
    : "A folder in your schematics. Type the name of a group that's there to add to it.";
  $('#group-name').value = '';
  $('#group-error').textContent = '';
  $('#group-create').disabled = false;
  const names = await api.schematicGroups(parent).catch(() => []);
  $('#group-names').replaceChildren(...names.map((name) => el('option', { value: name })));
  $('#group-dialog').showModal();
}

async function createGroup(event) {
  event.preventDefault();
  const name = $('#group-name').value.trim();
  if (!name) return;
  $('#group-create').disabled = true;
  try {
    takeSchematicList(await api.groupSchematics([...schem.selected], name, groupParent()));
  } catch (err) {
    $('#group-error').textContent = errorText(err);
    $('#group-create').disabled = false;
    return;
  }
  $('#group-dialog').close();
  schem.selected.clear();
  renderSchematicsCount();
  renderSchematics();
}

// ---- Right-click menus ----

// Opens the menu of what can be done, where the right-click was (or by the tile, from the keyboard). entries:
// { label, run, danger, disabled, title }, or '-' for a line between them.
function showSchematicMenu(event, entries) {
  event.preventDefault();
  event.stopPropagation();
  const menu = $('#schem-menu');
  menu.replaceChildren(...entries.filter(Boolean).map((entry) => {
    if (entry === '-') return el('hr');
    const button = el('button', { type: 'button', role: 'menuitem', textContent: entry.label, className: entry.danger ? 'danger' : '' });
    button.disabled = Boolean(entry.disabled);
    if (entry.title) button.title = entry.title;
    button.onclick = () => {
      closeSchematicMenu();
      entry.run();
    };
    return button;
  }));
  menu.hidden = false;
  const from = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : event.currentTarget.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(from.x, innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(from.y, innerHeight - height - 8))}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}

export function closeSchematicMenu() {
  $('#schem-menu').hidden = true;
}

const SHARED_ONLY = "Schematics an instance keeps to itself stay in it";

// A schematic's menu, or the picked ones' when it's one of several picked.
function schematicMenu(event, item) {
  const picked = schematicsPicked();
  if (schem.selected.has(item.path) && picked.length > 1) {
    const own = picked.some((one) => one.instance);
    showSchematicMenu(event, [
      { label: `Move ${picked.length} picked to...`, disabled: own, title: own ? SHARED_ONLY : '', run: () => openMoveDialog({ files: picked.map((one) => one.path), folders: [] }) },
      '-',
      { label: `Delete ${picked.length} picked`, danger: true, run: deleteSelectedSchematics },
    ]);
    return;
  }
  showSchematicMenu(event, [
    { label: 'Open', run: () => openSchematic(item) },
    { label: 'Rename...', run: () => renameSchematicByName(item) },
    { label: 'Move to...', disabled: Boolean(item.instance), title: item.instance ? SHARED_ONLY : '', run: () => openMoveDialog({ files: [item.path], folders: [] }) },
    { label: 'Show in folder', run: () => api.revealSchematic(item.path) },
    '-',
    { label: 'Delete', danger: true, run: () => trashSchematic(item) },
  ]);
}

// A folder's menu. An instance's own schematics (the folder at the top) can only be opened.
function schematicFolderMenu(event, node, count) {
  if (!isSharedFolder(node.keys)) {
    showSchematicMenu(event, [{ label: 'Open', run: () => openSchematicFolder(node.keys) }]);
    return;
  }
  showSchematicMenu(event, [
    { label: 'Open', run: () => openSchematicFolder(node.keys) },
    { label: 'Rename...', run: () => renameSchematicFolder(node) },
    { label: 'Move to...', run: () => openMoveDialog({ files: [], folders: [node.keys] }) },
    { label: 'Show in File Explorer', run: () => api.openSchematicsFolder(node.keys) },
    '-',
    { label: 'Delete', danger: true, run: () => trashSchematicFolder(node, count) },
  ]);
}

// Right-click on the space between tiles: what can be done in the folder shown.
function schematicListMenu(event) {
  if (event.target.closest('.schem-entry, .schem-folder') || !schem.items) return;
  const parent = schem.filter.trim() ? null : groupParent();
  showSchematicMenu(event, [
    parent && isSharedFolder(schem.at) ? { label: 'New folder...', run: newSchematicFolder } : null,
    { label: 'Open in File Explorer', run: () => api.openSchematicsFolder(groupParent()) },
  ]);
}

// ---- Names: renaming, and new folders ----

// Asks for a name in a small window. save(name) does it; what it throws is shown, and the window stays.
function askSchematicName({ title, label, value = '', confirm, save }) {
  const dialog = $('#name-dialog');
  const input = $('#name-input');
  $('#name-title').textContent = title;
  $('#name-label').textContent = label;
  $('#name-ok').textContent = confirm;
  $('#name-error').textContent = '';
  $('#name-ok').disabled = false;
  input.value = value;
  $('#name-form').onsubmit = async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    $('#name-ok').disabled = true;
    try {
      await save(name);
      dialog.close();
    } catch (err) {
      $('#name-error').textContent = errorText(err);
      input.focus();
    } finally {
      $('#name-ok').disabled = false;
    }
  };
  dialog.showModal();
  input.select();
}

// What's kept by a schematic's path follows it to its new one.
export function schematicRenamed(item, result) {
  if (schem.failed.has(item.path)) schem.failed.set(result.path, schem.failed.get(item.path));
  if (schem.selected.delete(item.path)) schem.selected.add(result.path);
  takeSchematicList(result);
  return schem.items.find((one) => one.path === result.path);
}

function renameSchematicByName(item) {
  askSchematicName({
    title: `Rename ${item.name}`,
    label: 'The file is renamed too, so the game sees the new name.',
    value: item.name,
    confirm: 'Rename',
    save: async (name) => {
      if (name === item.name) return;
      schematicRenamed(item, await api.renameSchematic(item.path, name));
      renderSchematics();
    },
  });
}

// keys -> where it went, when the folder shown is (or is in) the one at from that's now at to.
const movedKeys = (keys, from, to) => (from.every((key, i) => keys[i] === key) ? [...to, ...keys.slice(from.length)] : keys);

function renameSchematicFolder(node) {
  askSchematicName({
    title: `Rename ${node.name}`,
    label: 'The folder is renamed on disk too.',
    value: node.name,
    confirm: 'Rename',
    save: async (name) => {
      if (name === node.name) return;
      const result = await api.renameSchematicFolder(node.keys, name);
      takeSchematicList(result);
      schem.at = movedKeys(schem.at, node.keys, result.parts);
      renderSchematics();
    },
  });
}

function newSchematicFolder() {
  const parent = groupParent();
  askSchematicName({
    title: 'New folder',
    label: parent.length ? `A folder in ${parent[parent.length - 1]}.` : 'A folder in your schematics.',
    confirm: 'Make folder',
    save: async (name) => {
      takeSchematicList(await api.newSchematicFolder(parent, name));
      renderSchematics();
    },
  });
}

// ---- Deleting ----

// Deletes one schematic, after asking. True when it's gone.
async function trashSchematic(item) {
  const yes = await askConfirm({
    title: `Delete ${item.name}?`,
    text: item.instance ? `It's moved to the Recycle Bin, from ${item.instance.name}.` : "It's moved to the Recycle Bin, and it's gone from every instance.",
    confirm: 'Delete',
    cancel: 'Keep it',
  });
  if (!yes) return false;
  try {
    takeSchematicList(await api.trashSchematics([item.path]));
  } catch (err) {
    showSchemNote(errorText(err));
    return false;
  }
  renderSchematics();
  return true;
}

async function trashSchematicFolder(node, count) {
  const yes = await askConfirm({
    title: `Delete ${node.name}?`,
    text: count
      ? `The folder and the ${count === 1 ? 'schematic' : `${count.toLocaleString()} schematics`} in it are moved to the Recycle Bin, and they're gone from every instance.`
      : "The folder is moved to the Recycle Bin.",
    confirm: 'Delete',
    cancel: 'Keep it',
  });
  if (!yes) return;
  try {
    takeSchematicList(await api.trashSchematics([], [node.keys]));
  } catch (err) {
    showSchemNote(errorText(err));
    return;
  }
  renderSchematics();
}

// ---- Moving: to a folder picked in a window, or dragged onto one ----

// Whether moving can go to the folder at keys: not into a folder that's moving (or one in it), and not where all of
// it already is.
function canMoveTo(moving, keys) {
  if (!isSharedFolder(keys)) return false;
  if (moving.folders.some((parts) => parts.every((key, i) => keys[i] === key))) return false;
  const same = (parts) => parts.length === keys.length && parts.every((key, i) => keys[i] === key);
  const items = moving.files.map((path) => schem.items.find((item) => item.path === path)).filter(Boolean);
  return !(items.every((item) => same(schematicFolderOf(item))) && moving.folders.every((parts) => same(parts.slice(0, -1))));
}

// "baobab_1", "3 schematics", "Assets and 2 schematics"...
function movingName(moving) {
  const { files, folders } = moving;
  if (files.length + folders.length === 1) {
    return folders.length ? folders[0][folders[0].length - 1] : schem.items.find((item) => item.path === files[0])?.name || 'it';
  }
  const parts = [];
  if (folders.length) parts.push(folders.length === 1 ? folders[0][folders[0].length - 1] : `${folders.length} folders`);
  if (files.length) parts.push(`${files.length} ${files.length === 1 ? 'schematic' : 'schematics'}`);
  return parts.join(' and ');
}

// Moves them; returns why not when it can't (what did move is shown either way).
async function moveSchematicsTo(moving, keys) {
  try {
    takeSchematicList(await api.moveSchematics(moving.files, moving.folders, keys));
  } catch (err) {
    await loadSchematics(); // some may have moved before it stopped
    return errorText(err);
  }
  for (const path of moving.files) schem.selected.delete(path);
  // The folder shown moved: follow it.
  for (const parts of moving.folders) schem.at = movedKeys(schem.at, parts, [...keys, parts[parts.length - 1]]);
  renderSchematics();
  return null;
}

// The window to pick where to move to: every shared folder, as a tree; where it can't go is greyed out.
function openMoveDialog(moving) {
  const rows = [[], ...schem.folders].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const order = a[i].localeCompare(b[i], undefined, { numeric: true, sensitivity: 'base' });
      if (order) return order;
    }
    return a.length - b.length;
  });
  let chosen = null;
  const ok = $('#move-ok');
  ok.disabled = true;
  $('#move-error').textContent = '';
  $('#move-title').textContent = `Move ${movingName(moving)}`;
  $('#move-tree').replaceChildren(...rows.map((keys) => {
    const row = el('button', { type: 'button', className: 'move-row', role: 'option', innerHTML: FOLDER_ICON });
    row.append(el('span', { textContent: keys.length ? keys[keys.length - 1] : 'Schematics' }));
    row.style.paddingLeft = `${10 + keys.length * 18}px`;
    row.disabled = !canMoveTo(moving, keys);
    row.setAttribute('aria-selected', 'false');
    row.onclick = () => {
      for (const other of $('#move-tree').children) other.setAttribute('aria-selected', String(other === row));
      chosen = keys;
      ok.disabled = false;
    };
    row.ondblclick = () => $('#move-form').requestSubmit();
    return row;
  }));
  $('#move-form').onsubmit = async (event) => {
    event.preventDefault();
    if (!chosen) return;
    ok.disabled = true;
    const error = await moveSchematicsTo(moving, chosen);
    if (!error) $('#move-dialog').close();
    else {
      $('#move-error').textContent = error;
      ok.disabled = false;
    }
  };
  $('#move-dialog').showModal();
}

// Makes a tile draggable onto folders: what() says what it carries ({ files, folders }).
function draggableSchematics(element, what) {
  element.draggable = true;
  element.addEventListener('dragstart', (event) => {
    schem.dragging = what();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-hojicha-schematics', JSON.stringify(schem.dragging));
    closeSchematicMenu();
  });
  element.addEventListener('dragend', () => {
    schem.dragging = null;
    for (const target of document.querySelectorAll('.schem-drop')) target.classList.remove('schem-drop');
  });
}

// Makes a folder's tile (or its step in the way back up) a place to drop dragged schematics and folders into.
function schematicDropTarget(element, keys) {
  element.addEventListener('dragover', (event) => {
    if (!schem.dragging || !canMoveTo(schem.dragging, keys)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    element.classList.add('schem-drop');
  });
  element.addEventListener('dragleave', (event) => {
    if (!element.contains(event.relatedTarget)) element.classList.remove('schem-drop');
  });
  element.addEventListener('drop', (event) => {
    if (!schem.dragging || !canMoveTo(schem.dragging, keys)) return;
    event.preventDefault();
    event.stopPropagation();
    element.classList.remove('schem-drop');
    const moving = schem.dragging;
    schem.dragging = null;
    moveSchematicsTo(moving, keys).then((error) => error && showSchemNote(error));
  });
}

// A click only counts when the button is pressed and let go on the same element, so while it's held down on a tile
// nothing replaces the tiles: a picture finished meanwhile, or the list read again (on coming back to the window),
// waits until it's let go and the click has happened.
const schemHeld = { down: false, render: false, pictures: [] };
document.addEventListener('pointerdown', (event) => {
  if (event.target.closest?.('#schem-list')) schemHeld.down = true;
}, true);
const letGo = () => {
  if (!schemHeld.down) return;
  schemHeld.down = false;
  setTimeout(() => { // after the click
    if (schemHeld.down) return;
    const { render, pictures } = schemHeld;
    schemHeld.render = false;
    schemHeld.pictures = [];
    if (render) renderSchematics();
    else for (const item of pictures) showSchematicPicture(item);
  });
};
for (const type of ['pointerup', 'pointercancel', 'dragend']) document.addEventListener(type, letGo, true);
window.addEventListener('blur', letGo);

export function renderSchematics() {
  if (schemHeld.down) {
    schemHeld.render = true;
    return;
  }
  for (const button of document.querySelectorAll('#schem-kinds [data-kind]')) {
    button.classList.toggle('active', button.dataset.kind === schem.kind);
  }
  $('#schem-view').textContent = SCHEM_VIEWS.find(([view]) => view === schem.view)[1];
  schem.tiles.clear();
  schem.observer?.disconnect(); // the tiles shown now are watched as they're made
  schem.onScreen.clear();
  schem.folderTiles.clear();
  const list = $('#schem-list');
  const top = schematicTree();
  const words = schem.filter.trim().toLowerCase();
  const node = words ? top : schematicFolderAt(top, schem.at);
  if (!words) schem.at = node.keys; // a folder that's gone: the nearest one above it (kept while filtering)
  renderSchematicCrumbs(top, node);
  renderSchematicSelection();
  if (!schem.items) {
    list.replaceChildren(el('p', { className: 'hint', textContent: 'Looking for schematics...' }));
    return;
  }
  if (!schem.items.length) {
    list.replaceChildren(el('p', { className: 'hint schem-empty', textContent: 'No schematics yet. Save one with Litematica, WorldEdit or Axiom and it shows up here. You can also put files in the folder.' }));
    return;
  }
  // Filtering, everywhere: the folders whose name has every word in it, and the schematics that have each word in
  // their name, a folder they're in, their author or the instance keeping them ("verart" finds Verart trees and all
  // the trees in it; "baobab qu1nten" Qu1nten's baobabs).
  if (words) {
    const terms = words.split(/\s+/);
    const has = (text) => terms.every((term) => text.includes(term));
    const folders = [...top.byKey.values()].filter((folder) => has(folder.name.toLowerCase()))
      .sort((a, b) => byName(a, b) || a.key.localeCompare(b.key));
    const matching = inSchematicOrder(schematicsIn(top).filter((item) => has([
      item.name, item.folder, item.author || '', item.instance?.name || '',
    ].join('\n').toLowerCase())));
    // Those with every word in their name first ("maple 1": maple_1, maple_10... before maples by Qu1nten).
    const named = (item) => has(item.name.toLowerCase());
    const found = [...matching.filter(named), ...matching.filter((item) => !named(item))];
    if (!folders.length && !found.length) {
      list.replaceChildren(el('p', { className: 'hint', textContent: `Nothing matches "${schem.filter.trim()}".` }));
      return;
    }
    showSchematicEntries(folders, found, true);
    return;
  }
  const folders = schematicFolders(node);
  if (!folders.length && !node.items.length) {
    list.replaceChildren(el('p', { className: 'hint', textContent: schem.kind === 'all' ? 'Nothing here.' : `No ${SCHEM_TYPES[schem.kind]} schematics${node.keys.length ? ' here' : ''}.` }));
    return;
  }
  showSchematicEntries(folders, inSchematicOrder(node.items), false);
}

// Folders first, then schematics, as tiles (each lot under a heading when there are both). showFolder: say where each
// schematic is (the filter's results, from all over).
function showSchematicEntries(folders, items, showFolder) {
  const list = $('#schem-list');
  for (const [view] of SCHEM_VIEWS) list.classList.toggle(`schem-view-${view}`, schem.view === view);
  const both = folders.length && items.length;
  list.replaceChildren(...[
    both ? el('h3', { className: 'schem-group' }, ['Folders']) : null,
    folders.length ? el('div', { className: 'schem-grid schem-folders' }, folders.map(schematicFolderTile)) : null,
    both ? el('h3', { className: 'schem-group' }, ['Schematics']) : null,
    items.length ? el('div', { className: 'schem-grid' }, items.map((item) => schematicTile(item, { showFolder }))) : null,
  ].filter(Boolean));
}

// The picture of item was just drawn: put it in its tile, or in the tile of the folder it's in, if either is shown.
function showSchematicPicture(item) {
  if (schemHeld.down) {
    schemHeld.pictures.push(item);
    return;
  }
  const old = schem.tiles.get(item.path);
  // The old tile stops being watched first, or its leaving would count its place as off screen.
  if (old?.isConnected) {
    schem.observer?.unobserve(old);
    old.replaceWith(schematicTile(item, { showFolder: Boolean(schem.filter.trim()) }));
    return;
  }
  if (!schem.folderTiles.size) return;
  const keys = [...(item.instance ? [`instance:${item.instance.id}`] : []), ...(item.folder ? item.folder.split(/[\\/]/) : [])];
  const top = schematicTree();
  for (let n = 1; n <= keys.length; n++) {
    const node = schematicFolderAt(top, keys.slice(0, n));
    const tile = schem.folderTiles.get(node.key);
    if (!tile?.isConnected) continue;
    schem.observer?.unobserve(tile);
    tile.replaceWith(schematicFolderTile(node));
  }
}

// Which tiles are on screen (or nearly): their keys, a schematic's path or a folder's key. Watched as they're made.
function watchOnScreen(element, key) {
  if (!schem.observer) {
    schem.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) schem.onScreen.add(entry.target.dataset.seen);
        else schem.onScreen.delete(entry.target.dataset.seen);
      }
    }, { root: $('.schem-scroll'), rootMargin: '300px 0px' });
  }
  element.dataset.seen = key;
  schem.observer.observe(element);
}

const needsPicture = (item) => !item.preview && !schem.failed.has(item.path);

// The schematic whose picture to draw next: the ones on screen first, then the four that will be on each folder on
// screen, then the rest of the folder shown, then everything else; smallest files first within each (most show up
// straight away, and a big one doesn't hold up the rest). Asked again after every picture, so it follows scrolling.
function nextSchematicToDraw() {
  const waiting = (schem.items || []).filter(needsPicture);
  if (!waiting.length) return null;
  const rank = new Map(waiting.map((item) => [item, 3]));
  const top = schematicTree();
  for (const item of schematicFolderAt(top, schem.at).items) if (rank.has(item)) rank.set(item, 2);
  for (const key of schem.onScreen) {
    const folder = top.byKey.get(key);
    if (folder) for (const item of variedSchematicsIn(folder).slice(0, 4)) if (rank.has(item)) rank.set(item, 1);
  }
  for (const item of waiting) if (schem.onScreen.has(item.path)) rank.set(item, 0);
  return waiting.reduce((best, item) => (rank.get(item) < rank.get(best)
    || (rank.get(item) === rank.get(best) && item.bytes < best.bytes) ? item : best));
}

// Resolves once the schematic 3D view is closed: pictures wait while it's open, so they don't slow building it.
function whileViewing() {
  if (!$('#schem-dialog').open) return Promise.resolve();
  return new Promise((resolve) => $('#schem-dialog').addEventListener('close', resolve, { once: true }));
}

// Draws the pictures of schematics that don't have one yet, one at a time (see nextSchematicToDraw), and keeps them
// (main.js saves them). Opening the view again starts a new run; the old one stops.
async function drawMissingPreviews() {
  const run = ++schem.previewRun;
  schem.drawing = null;
  if (!(schem.items || []).some(needsPicture)) return;
  let assets;
  try {
    assets = await blockAssets();
  } catch (err) {
    showSchemNote(`The blocks couldn't be loaded, so there are no pictures. ${errorText(err)}`);
    return;
  }
  if (!assets) {
    showSchemNote('Pictures of your schematics show up once a game version is downloaded: play any instance once.');
    return;
  }
  // The tile being drawn says so, its bar filling as it's built.
  const showDrawing = (item, fraction) => {
    schem.drawing = { path: item.path, fraction };
    const bar = schem.tiles.get(item.path)?.querySelector('.schem-mini-bar span');
    if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
    else schem.tiles.get(item.path)?.querySelector('.schem-pic-wait')?.replaceWith(schematicWaiting(item));
  };
  // The tiles just shown say whether they're on screen in a frame or two. A timer rather than waiting for a frame:
  // a window that's minimized or covered draws no frames, and the pictures would wait for it to be looked at.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (;;) {
    await whileViewing();
    if (run !== schem.previewRun) return;
    const item = nextSchematicToDraw();
    if (!item) return;
    showDrawing(item, 0);
    await new Promise((resolve) => setTimeout(resolve)); // shows it before reading starts
    try {
      const result = await previewOf(item, assets, (fraction) => showDrawing(item, fraction));
      if (result.error) {
        throw new Error(result.error);
      } else {
        const info = { size: result.realSize, blocks: result.realCount, created: result.created, dataVersion: result.dataVersion, legacy: result.legacy, author: result.author };
        Object.assign(item, await api.saveSchematicPreview(item.path, result.url, info)); // its version and date
        item.preview = { ...info, url: result.url };
      }
    } catch (err) {
      console.error(`Could not draw ${item.path}:`, err);
      const reason = errorText(err);
      schem.failed.set(item.path, { text: /memory/i.test(reason) ? 'Too much for this computer to read' : "Couldn't read this file", reason });
    }
    if (run !== schem.previewRun) return; // a newer run took over (and shows this one's tile itself)
    schem.drawing = null;
    showSchematicPicture(item);
  }
}

// How far main.js got reading a file (it reads them in a thread of its own): path -> what to tell.
const schematicReading = new Map();
api.onSchematicProgress((path, fraction) => schematicReading.get(path)?.(fraction));

// Reads a schematic (main.js does, into a block list), with at most cells places of detail (a huge one is shrunk to
// fit); onProgress(fraction) as it goes. budget: shrunk further to what the 3D view shows smoothly (see
// core/schematicFile.js).
export async function loadSchematic(path, cells, onProgress, budget = false) {
  schematicReading.set(path, onProgress);
  try {
    return await api.loadSchematic(path, cells, budget);
  } finally {
    if (schematicReading.get(path) === onProgress) schematicReading.delete(path);
  }
}

// Tile pictures are drawn in a worker (preview-worker.js), so the launcher stays smooth meanwhile: main.js reads the
// file, the worker builds and draws it and sends back the picture. Its bar fills for reading, then for building. The
// worker is started with the block assets the first time.
const previewJobs = new Map(); // path -> Promise of the worker's answer, so a file is never drawn twice at once
let previewWorker = null;
let previewIds = 0;
const previewWaiting = new Map(); // job id -> { resolve, onProgress }

function previewOf(item, assets, onProgress) {
  if (previewJobs.has(item.path)) {
    previewJobs.get(item.path).onProgress = onProgress;
    return previewJobs.get(item.path).promise;
  }
  if (!previewWorker) {
    previewWorker = new Worker('preview-worker.js');
    previewWorker.onmessage = ({ data }) => {
      const job = previewWaiting.get(data.id);
      if (!job) return;
      if ('fraction' in data) {
        job.onProgress?.(data.fraction);
        return;
      }
      previewWaiting.delete(data.id);
      job.resolve(data);
    };
    previewWorker.postMessage({ type: 'assets', assets });
  }
  const job = { onProgress };
  job.promise = (async () => {
    try {
      // A tile's picture is small: 4 million places of detail are plenty, and much quicker to build.
      const model = await loadSchematic(item.path, 4 * 1024 * 1024, (fraction) => job.onProgress?.(fraction / 2));
      const { realSize, realCount, created, dataVersion, legacy, author } = model;
      const id = ++previewIds;
      const answer = await new Promise((resolve) => {
        previewWaiting.set(id, { resolve, onProgress: (fraction) => job.onProgress?.(0.5 + fraction / 2) });
        previewWorker.postMessage({ type: 'draw', id, model }, [model.x.buffer, model.y.buffer, model.z.buffer, model.state.buffer]);
      });
      return { ...answer, realSize, realCount, created, dataVersion, legacy, author };
    } catch (err) {
      return { error: errorText(err) };
    } finally {
      previewJobs.delete(item.path);
    }
  })();
  previewJobs.set(item.path, job);
  return job.promise;
}

// A single modpack file (.mrpack or .zip) dropped anywhere on the launcher opens Create instance with it.
// Schematic files and folders of them dropped anywhere on the launcher go to the shared schematics folder (main.js
// puts them there, a folder as a group): into the folder open in the Schematics view when that's showing, else at
// the top; and the Schematics view opens with them. While a popup is open, it handles drops itself (the skin
// window takes skins) or they're ignored. dragenter and dragleave fire for every element passed over, so they're
// counted to know when the files have really left.
const SCHEMATIC_FILE = /\.(litematic|schem|schematic|bp)$/i;

// What was dropped, as [{ name, file }]: files by their name, and everything inside a dropped folder by its path
// ("dragon_tree/dragon_tree_1.bp"), so the folder comes along as a group. entries: from the drop event's items.
export async function droppedFiles(entries) {
  const found = [];
  const visit = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      found.push({ name: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) { // a folder's entries come a batch at a time
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of entries) await visit(entry, '');
  return found;
}

export async function importSchematics(dropped) {
  // Loose files only when they're schematics; a folder whole (it becomes a group).
  const wanted = dropped.filter(({ name }) => name.includes('/') || SCHEMATIC_FILE.test(name));
  const others = dropped.filter(({ name }) => !name.includes('/') && !SCHEMATIC_FILE.test(name)).map(({ name }) => name);
  // Into the shared folder open in the Schematics view (from elsewhere, or an instance's own folder: the top).
  if (state.view !== 'schematics' || schem.filter.trim() || !isSharedFolder(schem.at)) schem.at = [];
  const parent = groupParent();
  openSchematics();
  let result = { added: 0, skipped: [] };
  try {
    if (wanted.length) {
      result = await api.importSchematics(await Promise.all(wanted.map(async ({ name, file }) => ({
        name,
        data: new Uint8Array(await file.arrayBuffer()),
      }))), parent);
    }
  } catch (err) {
    showSchemNote(errorText(err));
    return;
  }
  await loadSchematics();
  const skipped = [...others, ...result.skipped];
  const n = result.added;
  showSchemNote([
    n ? `Added ${n} ${n === 1 ? 'schematic' : 'schematics'}.` : '',
    skipped.length ? `${skipped.join(', ')} ${skipped.length === 1 ? "isn't a schematic" : "aren't schematics"} (.litematic, .schem, .schematic or .bp).` : '',
  ].filter(Boolean).join(' '));
}

$('#open-schematics').onclick = openSchematics;
// Opens the shared folder shown in File Explorer (the top one from an instance's own).
$('#schematics-folder').onclick = () => api.openSchematicsFolder(groupParent());
$('#schem-new-folder').onclick = newSchematicFolder;
$('#schem-move-selected').onclick = () => {
  const picked = schematicsPicked();
  if (picked.length && !picked.some((item) => item.instance)) openMoveDialog({ files: picked.map((item) => item.path), folders: [] });
};
$('#schem-list').oncontextmenu = schematicListMenu;
$('#name-cancel').onclick = () => $('#name-dialog').close();
$('#move-cancel').onclick = () => $('#move-dialog').close();
// The right-click menu goes away when clicking elsewhere, scrolling or leaving the window; arrows move through it.
document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('#schem-menu')) closeSchematicMenu();
});
document.addEventListener('scroll', closeSchematicMenu, true);
window.addEventListener('blur', closeSchematicMenu);
window.addEventListener('resize', closeSchematicMenu);
$('#schem-menu').addEventListener('keydown', (event) => {
  const items = [...$('#schem-menu').querySelectorAll('button:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  } else if (event.key === 'Tab') {
    closeSchematicMenu();
  }
});
for (const button of document.querySelectorAll('#schem-kinds [data-kind]')) {
  button.onclick = () => {
    schem.kind = button.dataset.kind;
    renderSchematics();
  };
}
// The tiles' size, picked from a menu under the button.
$('#schem-view').onclick = () => showSchematicChoices($('#schem-view'), SCHEM_VIEWS, schem.view, (view) => {
  schem.view = view;
  saveSchematic('schematicView', view);
  renderSchematics();
});
// Ctrl+A picks every schematic shown (but not while typing).
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a' || event.shiftKey || event.altKey) return;
  if (state.view !== 'schematics' || document.querySelector('dialog[open]')) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  event.preventDefault();
  pickAllSchematics();
});
$('#schem-filter').oninput = () => {
  schem.filter = $('#schem-filter').value;
  renderSchematics();
};
$('#schem-delete').onclick = deleteSchematic;
$('#schem-group').onclick = openGroupDialog;
$('#schem-delete-selected').onclick = deleteSelectedSchematics;
$('#schem-select-cancel').onclick = clearSchematicSelection;
$('#group-form').onsubmit = createGroup;
$('#group-cancel').onclick = () => $('#group-dialog').close();
// Escape lets go of the picked schematics, or else goes up out of a folder (a popup takes Escape itself; in the
// filter box it clears the box). The mouse's back and forward buttons go through the folders as they were visited.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || state.view !== 'schematics' || document.querySelector('dialog[open]')) return;
  if (!$('#schem-menu').hidden) closeSchematicMenu(); // the right-click menu first
  else if (schem.selected.size) clearSchematicSelection();
  else if (document.activeElement !== $('#schem-filter')) schematicFolderUp();
});
// Back from the game (or a file browser) with new schematics: look again.
window.addEventListener('focus', () => {
  if (state.view === 'schematics' && !document.querySelector('dialog[open]')) loadSchematics({ whenChanged: true });
});

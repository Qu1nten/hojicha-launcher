import { refreshAccounts, renderAccounts } from './accounts.js';
import { $, api, el, errorText } from './core.js';
import { closeMenus } from './menus.js';

// The skin window (the face in the sidebar or under Accounts): the skin in 3D with the player's name tag, drag to
// turn it; saved skins to wear (core/skins.js); and the capes the account owns, as a cape or an elytra.
// Nothing changes at Mojang until Save.
const skinWindow = {
  account: null,
  skins: [], // saved skins, newest first: { id, variant, url }
  capes: null, // the account's capes, or null when Mojang couldn't be reached
  current: { skin: null, variant: 'classic', cape: null }, // what the account wears now
  chosen: { skin: null, variant: 'classic', cape: null }, // what Save would make it wear
  back: 'cape', // the chosen cape shown as a cape or an elytra (only a preview: the game picks by what you wear)
  viewer: null,
};

const loadImage = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('Could not read the image'));
  img.src = url;
});

// Slim (Alex) skins leave the outer edge of each arm see-through; classic (Steve) skins fill it.
async function guessArms(url) {
  const img = await loadImage(url);
  if (img.height !== 64) return 'classic'; // old 64x32 skins predate slim arms
  const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const clear = (x, y, w, h) => ctx.getImageData(x, y, w, h).data.every((v, i) => i % 4 !== 3 || v === 0);
  return clear(50, 16, 2, 4) && clear(54, 20, 2, 12) ? 'slim' : 'classic';
}

// The outside of a cape, on a 10x16 canvas.
async function drawCape(canvas, url) {
  const img = await loadImage(url);
  canvas.width = 10;
  canvas.height = 16;
  const scale = img.width / 64; // HD capes are bigger multiples of 64x32
  canvas.getContext('2d').drawImage(img, scale, scale, 10 * scale, 16 * scale, 0, 0, 10, 16);
}

// ---- Name tag ----

// The game's font sheet (main.js takes it from a downloaded game), with each letter's width. Null without one.
let fontSheet;
async function loadFont() {
  if (fontSheet !== undefined) return fontSheet;
  fontSheet = null;
  try {
    const url = await api.fontSheet();
    if (!url) return null;
    const img = await loadImage(url);
    const cell = img.width / 16; // 8 pixels a letter, more in HD packs
    const ctx = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height })
      .getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const widths = [];
    for (let code = 0; code < 256; code++) {
      const data = ctx.getImageData((code % 16) * cell, Math.floor(code / 16) * cell, cell, cell).data;
      let width = 0;
      for (let x = cell - 1; x >= 0 && !width; x--) {
        for (let y = 0; y < cell; y++) if (data[(y * cell + x) * 4 + 3]) { width = x + 1; break; }
      }
      widths.push(width / (cell / 8)); // in game pixels
    }
    widths[32] = 3; // space: the game spaces words by 4, like a 3-wide letter
    fontSheet = { img, cell, widths };
  } catch {
    fontSheet = null;
  }
  return fontSheet;
}

// The name over the head as the game draws it: white letters, a pixel apart, on a see-through dark box one pixel
// bigger all round. 0.4 model units a game pixel, the size the game uses next to a player.
async function nameTag(name) {
  const tag = new skinview3d.NameTagObject(name, { font: '32px sans-serif', repaintAfterLoaded: false, height: 3.6 });
  const font = await loadFont();
  if (!font) return tag; // no game downloaded yet: plain lettering
  const scale = 8; // texture pixels a game pixel, so it stays sharp
  const letters = [...name].map((c) => c.charCodeAt(0) & 255);
  const textWidth = letters.reduce((sum, code) => sum + font.widths[code] + 1, -1);
  const canvas = Object.assign(document.createElement('canvas'), { width: (textWidth + 2) * scale, height: 9 * scale });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let x = 1;
  for (const code of letters) {
    const { cell, img, widths } = font;
    ctx.drawImage(img, (code % 16) * cell, Math.floor(code / 16) * cell, cell, cell, x * scale, scale, 8 * scale, 8 * scale);
    x += widths[code] + 1;
  }
  tag.textMaterial.map.image = canvas;
  tag.textMaterial.map.needsUpdate = true;
  tag.scale.x = (canvas.width / canvas.height) * tag.height;
  return tag;
}

// ---- The big model ----

// The model walks on the spot, as in the game, but slowly: an unhurried stroll suits a still window.
const walkAnimation = () => Object.assign(new skinview3d.WalkingAnimation(), { speed: 0.4 });

// Remembered in this browser only: whether the model moves (off at first).
function animationWanted() {
  try {
    return localStorage.getItem('skinAnimation') === 'on';
  } catch {
    return false;
  }
}

function setAnimation(on) {
  try {
    localStorage.setItem('skinAnimation', on ? 'on' : 'off');
  } catch {
    // private storage: it just isn't remembered
  }
  if (skinWindow.viewer) skinWindow.viewer.animation = on ? walkAnimation() : null;
  const button = $('#skin-play');
  button.setAttribute('aria-pressed', String(on));
  button.title = button.ariaLabel = on ? 'Stop moving' : 'Move';
}

function startViewer() {
  if (skinWindow.viewer) return;
  const viewer = new skinview3d.SkinViewer({ canvas: $('#skin-canvas'), width: 300, height: 400 });
  viewer.controls.enableZoom = false;
  viewer.controls.enablePan = false;
  viewer.zoom = 0.78; // room for the name tag
  viewer.playerWrapper.rotation.y = 0.45; // a little turned, so it looks 3D straight away
  viewer.playerWrapper.position.y = -2;
  skinWindow.viewer = viewer;
  setAnimation(animationWanted());
}

function stopViewer() {
  skinWindow.viewer?.dispose();
  skinWindow.viewer = null;
  skinWindow.tag = null; // went with the viewer
  thumbViewer?.dispose();
  thumbViewer = null;
}

// ---- Saved skin pictures ----

// Each saved skin as a still 3D picture, head to knees and a little turned. One hidden viewer draws them in turn
// (a WebGL context per tile would run out); pictures are kept for as long as the launcher runs.
const thumbs = new Map(); // `${id}:${variant}` -> Promise of a data: URL
let thumbViewer = null;
let thumbQueue = Promise.resolve();

function skinPicture(skin) {
  const key = `${skin.id}:${skin.variant}`;
  if (!thumbs.has(key)) {
    const picture = thumbQueue.then(() => drawSkinPicture(skin));
    thumbQueue = picture.catch(() => thumbs.delete(key)); // e.g. the window closed mid-way: drawn again next time
    thumbs.set(key, picture);
  }
  return thumbs.get(key);
}

async function drawSkinPicture(skin) {
  if (!thumbViewer) {
    thumbViewer = new skinview3d.SkinViewer({ width: 240, height: 300, preserveDrawingBuffer: true });
    thumbViewer.renderPaused = true;
    thumbViewer.zoom = 1.45;
    thumbViewer.playerWrapper.rotation.y = 0.5;
    thumbViewer.playerWrapper.position.y = -7;
  }
  await thumbViewer.loadSkin(skin.url, { model: skin.variant === 'slim' ? 'slim' : 'default' });
  thumbViewer.render();
  return thumbViewer.canvas.toDataURL();
}

// ---- The window ----

const savedSkin = (id) => skinWindow.skins.find((s) => s.id === id);

let shownTagFor = null;
async function showChosenOnModel() {
  const { viewer, chosen, capes, account, back } = skinWindow;
  if (!viewer) return;
  const skin = savedSkin(chosen.skin);
  if (skin) viewer.loadSkin(skin.url, { model: chosen.variant === 'slim' ? 'slim' : 'default' });
  else viewer.loadSkin(null);
  const cape = capes?.find((c) => c.id === chosen.cape);
  if (cape?.url) viewer.loadCape(cape.url, { backEquipment: back });
  else viewer.loadCape(null);
  if (shownTagFor !== account.name) {
    shownTagFor = account.name;
    const tag = await nameTag(account.name);
    if (skinWindow.viewer === viewer && shownTagFor === account.name) {
      // Hung on the model ourselves rather than as viewer.nameTag: skinview3d moves its own name tag back to its
      // height whenever the animation starts or stops or a skin loads, so the tag would jump. It sits just over
      // the head.
      if (skinWindow.tag) viewer.playerWrapper.remove(skinWindow.tag);
      skinWindow.tag = tag;
      tag.position.y = 21.5;
      viewer.playerWrapper.add(tag);
    }
  }
}

function skinChanged() {
  const { current, chosen } = skinWindow;
  return Boolean(chosen.skin) && (chosen.skin !== current.skin || chosen.variant !== current.variant);
}
const capeChanged = () => skinWindow.capes !== null && skinWindow.chosen.cape !== skinWindow.current.cape;

const CHECK = '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.4"/></svg>';

function renderSkinWindow() {
  const { skins, capes, current, chosen } = skinWindow;

  const add = el('button', { type: 'button', className: 'add-skin', title: 'Add skins (PNG files). You can also drop them on this window.' }, [
    el('span', { className: 'add-plus', textContent: '+' }),
    el('span', { className: 'add-label', textContent: 'Add skin' }),
  ]);
  add.onclick = () => addSkins();
  $('#skin-grid').replaceChildren(el('div', { className: 'skin-tile' }, [add]), ...skins.map((skin) => {
    const picture = el('img', { alt: '', draggable: false });
    skinPicture(skin).then((url) => { picture.src = url; }, () => {});
    const inUse = skin.id === current.skin;
    const pick = el('button', {
      type: 'button',
      className: `skin-pick${skin.id === chosen.skin ? ' selected' : ''}`,
      title: inUse ? 'The skin you wear now' : 'Wear this skin',
      ariaLabel: inUse ? 'Skin in use' : 'Saved skin',
    }, [picture]);
    if (inUse) pick.append(el('span', { className: 'in-use', innerHTML: CHECK, title: 'In use' }));
    pick.onclick = () => {
      chosen.skin = skin.id;
      chosen.variant = skin.variant;
      renderSkinWindow();
    };
    let remove = null;
    if (!inUse) {
      remove = el('button', { type: 'button', className: 'skin-remove', textContent: '×', title: 'Remove from saved skins', ariaLabel: 'Remove from saved skins' });
      remove.onclick = () => removeSkin(skin.id);
    }
    return el('div', { className: 'skin-tile' }, [pick, remove]);
  }));

  // The cape row: the chosen cape, or why there's nothing to choose. Change cape opens the menu (fillCapeMenu).
  const chosenCape = capes?.find((c) => c.id === chosen.cape) || null;
  const art = $('#cape-current-art');
  art.getContext('2d').clearRect(0, 0, art.width, art.height);
  art.hidden = !chosenCape?.url;
  if (chosenCape?.url) drawCape(art, chosenCape.url).catch(() => {});
  $('#cape-current-name').textContent = capes === null ? 'Shows up when Mojang can be reached'
    : !capes.length ? "This account doesn't have any" : chosenCape ? chosenCape.name : 'None';
  $('#cape-change').hidden = !capes?.length;

  for (const button of document.querySelectorAll('[data-arms]')) {
    button.setAttribute('aria-checked', String(button.dataset.arms === chosen.variant));
    button.disabled = !chosen.skin;
  }
  const elytra = $('#skin-elytra');
  const onElytra = skinWindow.back === 'elytra';
  elytra.hidden = !chosen.cape;
  elytra.setAttribute('aria-pressed', String(onElytra));
  elytra.title = onElytra ? 'Show as a cape' : 'Show on an elytra';
  // capes is null until Mojang answers, and changes need Mojang.
  $('#skins-save').disabled = capes === null || (!skinChanged() && !capeChanged());
  showChosenOnModel();
}

// The cape menu: None and each cape the account owns, with its outside; the chosen one ticked, the one worn now
// marked. Picking one only changes what Save would do.
export function fillCapeMenu() {
  const { capes, current, chosen } = skinWindow;
  const item = (cape) => {
    const id = cape ? cape.id : null;
    const art = el('canvas', { className: 'cape-art', width: 10, height: 16, ariaHidden: 'true' });
    if (cape?.url) drawCape(art, cape.url).catch(() => {});
    const button = el('button', { type: 'button', role: 'menuitemradio', ariaChecked: String(id === chosen.cape) }, [
      cape ? art : el('span', { className: 'cape-art cape-art-none', ariaHidden: 'true' }),
      el('span', { className: 'cape-text' }, [
        el('span', { textContent: cape ? cape.name : 'None' }),
        id === current.cape ? el('span', { className: 'cape-label', textContent: 'Wearing now' }) : null,
      ]),
      id === chosen.cape ? el('span', { className: 'cape-tick', innerHTML: CHECK }) : null,
    ]);
    button.onclick = () => {
      chosen.cape = id;
      renderSkinWindow();
    };
    return button;
  };
  $('#cape-menu').replaceChildren(item(null), ...(capes || []).map(item));
}

export async function openSkins(account) {
  Object.assign(skinWindow, {
    account,
    skins: [],
    capes: null,
    current: { skin: null, variant: account.skinVariant, cape: null },
    chosen: { skin: null, variant: account.skinVariant, cape: null },
  });
  shownTagFor = null;
  $('#skins-dialog').ariaLabel = `${account.name}'s skin`;
  $('#skins-error').textContent = '';
  $('#skin-grid').replaceChildren(el('p', { className: 'hint', textContent: 'Loading skins...' }));
  $('#cape-current-art').hidden = true;
  $('#cape-current-name').textContent = 'Loading…';
  $('#cape-change').hidden = true;
  $('#skins-save').disabled = true;
  $('#skins-dialog').showModal();
  startViewer();
  showChosenOnModel(); // the name tag, while the skins load
  let data;
  try {
    data = await api.openSkins(account.id);
  } catch (err) {
    $('#skins-error').textContent = errorText(err);
    return;
  }
  if (skinWindow.account !== account || !$('#skins-dialog').open) return; // closed, or opened for someone else
  const cape = data.error ? null : data.capes.find((c) => c.active)?.id || null;
  Object.assign(skinWindow, {
    skins: data.skins,
    capes: data.error ? null : data.capes,
    current: { skin: data.current, variant: data.variant, cape },
    chosen: { skin: data.current, variant: data.variant, cape },
  });
  $('#skins-error').textContent = data.error || '';
  renderSkinWindow();
  refreshAccounts(); // the face may have changed since the launcher started
}

// Adds skins from the file picker (no files) or dropped on the window (files), and picks the last one added.
async function addSkins(files) {
  $('#skins-error').textContent = '';
  let result;
  try {
    result = files
      ? await api.addDroppedSkins(await Promise.all(files.map(async (file) => ({
        name: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
      }))))
      : await api.addSkins();
  } catch (err) {
    $('#skins-error').textContent = errorText(err);
    return;
  }
  if (!result) return;
  skinWindow.skins = result.skins;
  if (result.added) {
    // Saved as classic; the image itself says better.
    const skin = savedSkin(result.added);
    skin.variant = await guessArms(skin.url).catch(() => 'classic');
    skinWindow.chosen.skin = skin.id;
    skinWindow.chosen.variant = skin.variant;
  }
  $('#skins-error').textContent = result.error || '';
  renderSkinWindow();
}

async function removeSkin(id) {
  try {
    skinWindow.skins = await api.removeSkin(id);
  } catch (err) {
    $('#skins-error').textContent = errorText(err);
    return;
  }
  if (skinWindow.chosen.skin === id) {
    skinWindow.chosen.skin = skinWindow.current.skin;
    skinWindow.chosen.variant = skinWindow.current.variant;
  }
  renderSkinWindow();
}

async function saveSkinWindow() {
  const { account, chosen } = skinWindow;
  const button = $('#skins-save');
  button.disabled = true;
  button.textContent = 'Saving';
  $('#skins-error').textContent = '';
  const choice = { skinId: skinChanged() ? chosen.skin : null, variant: chosen.variant };
  if (capeChanged()) choice.capeId = chosen.cape;
  try {
    renderAccounts(await api.applySkin(account.id, choice));
    $('#skins-dialog').close();
  } catch (err) {
    $('#skins-error').textContent = errorText(err);
    button.disabled = false;
  } finally {
    button.textContent = 'Save';
  }
}

for (const button of document.querySelectorAll('[data-arms]')) {
  button.onclick = () => {
    skinWindow.chosen.variant = button.dataset.arms;
    renderSkinWindow();
  };
}
$('#skin-elytra').onclick = () => {
  skinWindow.back = skinWindow.back === 'elytra' ? 'cape' : 'elytra';
  renderSkinWindow();
};
$('#skin-play').onclick = () => setAnimation($('#skin-play').getAttribute('aria-pressed') !== 'true');
$('#skins-cancel').onclick = () => $('#skins-dialog').close();
$('#skins-save').onclick = saveSkinWindow;
$('#skins-dialog').addEventListener('close', () => {
  closeMenus();
  stopViewer();
  endSkinDrag();
});

// Skin files dragged onto the skin window (its backdrop counts too, so anywhere in the launcher) are added to the
// saved skins. While they're over it, the window says so. dragenter and dragleave fire for every element passed
// over, so the window counts them to know when the files have really left.
let skinDragDepth = 0;
const draggingFiles = (event) => event.dataTransfer?.types.includes('Files');
function endSkinDrag() {
  skinDragDepth = 0;
  $('#skins-dialog').classList.remove('dropping');
}
$('#skins-dialog').addEventListener('dragenter', (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  skinDragDepth++;
  $('#skins-dialog').classList.add('dropping');
});
$('#skins-dialog').addEventListener('dragover', (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
$('#skins-dialog').addEventListener('dragleave', (event) => {
  if (!draggingFiles(event)) return;
  if (--skinDragDepth <= 0) endSkinDrag();
});
$('#skins-dialog').addEventListener('drop', (event) => {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  endSkinDrag();
  const files = [...event.dataTransfer.files];
  if (files.length) addSkins(files);
});

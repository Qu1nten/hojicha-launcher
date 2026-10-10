export const api = window.launcher;
export const $ = (selector) => document.querySelector(selector);

// macOS runs from source only (see the README): its window buttons sit where the logo is, and the playit.gg
// agent the launcher downloads is a Windows program, so online play is Windows-only.
const IS_MAC = api.platform === 'darwin';
export const ONLINE_PLAY = api.platform === 'win32';
document.body.classList.toggle('mac', IS_MAC);

export const SYNC_ITEMS = [
  ['saves', 'Worlds', 'Every world shows up in every instance. Opening one in a newer version upgrades it.'],
  ['config', 'Mod settings', 'Copied in when the game starts. The settings you change are saved when it closes.'],
  ['schematics', 'Schematics', 'Litematica, WorldEdit and Axiom save to one shared folder.'],
  ['resourcepacks', 'Resource packs', 'One shared resource pack folder.'],
  ['shaderpacks', 'Shader packs', 'One shared shader pack folder.'],
  ['screenshots', 'Screenshots', 'All screenshots end up in one folder.'],
  ['options.txt', 'Options and keybinds', 'Copied in when the game starts. The options you change are saved when it closes.'],
  ['servers.dat', 'Server list', 'Copied in when the game starts and saved when it closes.'],
];
// A game's log is kept whole: the start of it often says why a modded game crashed. A server console can run for days,
// so it keeps only its newest lines.
export const MAX_SERVER_LOG_LINES = 3000;
export const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export const state = {
  instances: [],
  selected: null,
  view: 'instance', // or 'server', 'settings', 'schematics'
  servers: [],
  selectedServer: null,
  serverStatus: {}, // id -> { state, text }
  serverLogs: {},   // id -> string[]
  tab: 'mods',
  serverTab: 'console',
  status: {}, // id -> { state, text, progress }
  logs: {},   // id -> string[]
  search: { query: '', type: 'mod', offset: 0, total: 0, done: false },
  versions: null,
  // The Installed tab, for the instance it was loaded for; view is All or one kind (mod, resourcepack, shader).
  mods: { id: null, content: { mod: [], resourcepack: [], shader: [] }, filter: '', view: 'all', busy: false },
  modUpdates: {}, // instance id -> { at, updates: file -> { versionId, versionNumber } }, or { pending: true }
};

export function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...[].concat(children).filter((c) => c != null));
  return node;
}

// Electron wraps errors from the main process; show only the useful part.
export function errorText(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function current() {
  return state.instances.find((i) => i.id === state.selected) || null;
}

export function isBusy(id) {
  const s = state.status[id]?.state;
  return s === 'installing' || s === 'running' || s === 'busy'; // busy: mods are being installed or switched
}

// "Fabric 1.21.11" / "Vanilla 1.21.11"
export function loaderLabel(inst) {
  return `${inst.loader === 'fabric' ? 'Fabric' : 'Vanilla'} ${inst.gameVersion}`;
}

// Small line icons (see .icon in style.css). Static markup only, so innerHTML is safe here.
const ICONS = {
  block: '<path d="M8 1.8l5.5 3.1v6.2L8 14.2l-5.5-3.1V4.9z"/><path d="M2.5 4.9L8 8l5.5-3.1M8 8v6.2"/>',
  hourglass: '<path d="M4 2h8M4 14h8"/><path d="M5 2c0 3.4 6 3.2 6 6s-6 2.6-6 6M11 2c0 3.4-6 3.2-6 6s6 2.6 6 6"/>',
  clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.6"/>',
  // Two chain links, each open where it hooks into the other, on the diagonal.
  linked: '<g transform="rotate(-45 8 8)"><path d="M5.6 5.8H3.2a2.2 2.2 0 0 0 0 4.4h4.2a2.2 2.2 0 0 0 1.9-3.3"/><path d="M10.4 10.2h2.4a2.2 2.2 0 0 0 0-4.4H8.6a2.2 2.2 0 0 0-1.9 3.3"/></g>',
};

export function icon(name) {
  const span = el('span');
  span.innerHTML = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

export function formatPlaytime(ms) {
  const minutes = Math.floor((ms || 0) / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 6) / 10; // one decimal below 10 hours
  const shown = hours < 10 ? hours : Math.round(hours);
  return `${shown} hour${shown === 1 ? '' : 's'}`;
}

export const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function formatLastPlayed(time) {
  if (!time) return 'Never played';
  const seconds = (time - Date.now()) / 1000;
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) < size) continue;
    const text = relativeFormat.format(Math.round(seconds / size), unit); // "12 hours ago", "yesterday"
    return text[0].toUpperCase() + text.slice(1);
  }
  return 'Just now';
}

export function thumb(url) {
  return url ? el('img', { className: 'thumb', src: url, alt: '' }) : el('div', { className: 'thumb' });
}

export function emptyRow(text, action) {
  const row = el('li', { className: 'empty-row' }, [el('p', { textContent: text })]);
  if (action) row.append(action);
  return row;
}

export function formatDownloads(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M downloads`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K downloads`;
  return `${n} downloads`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Asks in the launcher's own dialog. Resolves true for the confirm button, false for the other or Escape.
export function askConfirm({ title, text, note = '', confirm, cancel = 'Cancel' }) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-note').textContent = note;
  $('#confirm-note').hidden = !note;
  $('#confirm-ok').textContent = confirm;
  $('#confirm-cancel').textContent = cancel;
  return new Promise((resolve) => {
    const answer = (yes) => {
      dialog.close();
      resolve(yes);
    };
    $('#confirm-ok').onclick = () => answer(true);
    $('#confirm-cancel').onclick = () => answer(false);
    dialog.oncancel = (event) => {
      event.preventDefault();
      answer(false);
    };
    dialog.showModal();
  });
}

// "A", "A and B", "A, B and C".
export function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

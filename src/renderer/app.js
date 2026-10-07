const api = window.launcher;
const $ = (selector) => document.querySelector(selector);

// macOS runs from source only (see the README): its window buttons sit where the logo is, and the playit.gg
// agent the launcher downloads is a Windows program, so online play is Windows-only.
const IS_MAC = api.platform === 'darwin';
const ONLINE_PLAY = api.platform === 'win32';
document.body.classList.toggle('mac', IS_MAC);

const SYNC_ITEMS = [
  ['saves', 'Worlds', 'Every world shows up in every instance. Opening one in a newer version upgrades it.'],
  ['config', 'Mod settings', 'One shared config folder, so mod settings carry over.'],
  ['schematics', 'Schematics', 'Litematica, WorldEdit and Axiom save to one shared folder.'],
  ['resourcepacks', 'Resource packs', 'One shared resource pack folder.'],
  ['shaderpacks', 'Shader packs', 'One shared shader pack folder.'],
  ['screenshots', 'Screenshots', 'All screenshots end up in one folder.'],
  ['options.txt', 'Options and keybinds', 'Copied in when the game starts and saved when it closes.'],
  ['servers.dat', 'Server list', 'Copied in when the game starts and saved when it closes.'],
];
const MAX_LOG_LINES = 3000;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
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

// ---------- Helpers ----------

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...[].concat(children).filter((c) => c != null));
  return node;
}

// Electron wraps errors from the main process; show only the useful part.
function errorText(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function current() {
  return state.instances.find((i) => i.id === state.selected) || null;
}

function isBusy(id) {
  const s = state.status[id]?.state;
  return s === 'installing' || s === 'running' || s === 'busy'; // busy: mods are being installed or switched
}

// "Fabric 1.21.11" / "Vanilla 1.21.11"
function loaderLabel(inst) {
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

function icon(name) {
  const span = el('span');
  span.innerHTML = `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

function formatPlaytime(ms) {
  const minutes = Math.floor((ms || 0) / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 6) / 10; // one decimal below 10 hours
  const shown = hours < 10 ? hours : Math.round(hours);
  return `${shown} hour${shown === 1 ? '' : 's'}`;
}

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function formatLastPlayed(time) {
  if (!time) return 'Never played';
  const seconds = (time - Date.now()) / 1000;
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(seconds) < size) continue;
    const text = relativeFormat.format(Math.round(seconds / size), unit); // "12 hours ago", "yesterday"
    return text[0].toUpperCase() + text.slice(1);
  }
  return 'Just now';
}

function thumb(url) {
  return url ? el('img', { className: 'thumb', src: url, alt: '' }) : el('div', { className: 'thumb' });
}

function emptyRow(text, action) {
  const row = el('li', { className: 'empty-row' }, [el('p', { textContent: text })]);
  if (action) row.append(action);
  return row;
}

function formatDownloads(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M downloads`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K downloads`;
  return `${n} downloads`;
}

// ---------- Instances ----------

async function refreshInstances(selectId) {
  const before = state.selected;
  state.instances = await api.listInstances();
  for (const inst of state.instances) {
    if (inst.running && !state.status[inst.id]) state.status[inst.id] = { state: 'running', text: 'Playing' };
  }
  if (selectId) {
    state.selected = selectId;
    state.view = 'instance';
  }
  if (!current()) state.selected = state.instances[0]?.id ?? null;
  if (state.selected !== before) resetSearch(); // e.g. a new instance, or the selected one was deleted
  renderSidebar();
  renderMain();
}

// The item icon in front of an instance or server. Hovering shows a + and clicking opens the icon picker,
// without selecting the row.
function itemIcon(kind, thing) {
  const button = el('button', {
    type: 'button',
    className: 'item-icon',
    title: 'Change icon',
    ariaLabel: `Change the icon of ${thing.name}`,
  }, [thing.iconUrl ? el('img', { src: thing.iconUrl, alt: '' }) : icon('block')]);
  button.onclick = () => {
    // A mouse click (detail > 0) lets go of focus first, so closing the picker doesn't hand focus back and ring
    // the icon. From the keyboard, focus comes back as usual.
    if (event.detail > 0) button.blur();
    openIconPicker(kind, thing);
  };
  return button;
}

// A sidebar row: the item icon (its own button, for the icon picker) and the name, a button that covers the whole
// row, so a click anywhere opens it and the keyboard reaches it with Tab, Enter and Space.
function sideRow(kind, thing, active, sub, running, open) {
  const select = el('button', { type: 'button', className: 'side-select' }, [
    el('span', { className: 'name', textContent: thing.name }),
    el('span', { className: 'sub' }, [sub, running ? el('span', { className: 'running-dot', title: running }) : null]),
  ]);
  if (active) select.setAttribute('aria-current', 'page');
  select.onclick = open;
  const row = el('li', { className: active ? 'active' : '' }, [itemIcon(kind, thing), select]);
  row.dataset.key = `${kind}:${thing.id}`;
  return row;
}

function renderSidebar() {
  // The rows are rebuilt; keep keyboard focus on the same row and button (opening a row redraws the list).
  const focused = document.activeElement?.closest?.('#sidebar li[data-key]');
  const focusKey = focused?.dataset.key;
  const focusClass = document.activeElement?.classList.contains('item-icon') ? 'item-icon' : 'side-select';
  $('#instance-list').replaceChildren(...state.instances.map((inst) => sideRow(
    'instance', inst,
    state.view === 'instance' && inst.id === state.selected,
    loaderLabel(inst),
    state.status[inst.id]?.state === 'running' ? 'Playing' : '',
    () => selectInstance(inst.id),
  )));
  $('#server-list').replaceChildren(...state.servers.map((server) => sideRow(
    'server', server,
    state.view === 'server' && server.id === state.selectedServer,
    `${serverFlavor(server)} ${server.mcVersion}`,
    ['starting', 'running', 'stopping'].includes(state.serverStatus[server.id]?.state) ? 'Running' : '',
    () => selectServer(server.id),
  )));
  if (focusKey) {
    [...document.querySelectorAll('#sidebar li[data-key]')].find((li) => li.dataset.key === focusKey)?.querySelector(`.${focusClass}`)?.focus();
  }
  $('#open-settings').classList.toggle('active', state.view === 'settings');
  $('#schematics-row').classList.toggle('active', state.view === 'schematics');
  if (state.view === 'schematics') $('#open-schematics').setAttribute('aria-current', 'page');
  else $('#open-schematics').removeAttribute('aria-current');
  renderActivity();
}

// The pill in the title bar: what's running, or being prepared, across all instances and servers.
function renderActivity() {
  const active = [
    ...state.instances.flatMap((inst) => {
      const s = state.status[inst.id]?.state;
      if (s === 'running') return [{ name: inst.name, label: 'Playing', go: () => selectInstance(inst.id) }];
      if (s === 'installing') return [{ name: inst.name, label: 'Preparing', preparing: true, go: () => selectInstance(inst.id) }];
      return [];
    }),
    ...state.servers.flatMap((server) => {
      const s = state.serverStatus[server.id]?.state;
      if (!['starting', 'running', 'stopping'].includes(s)) return [];
      const label = { starting: 'Starting', running: 'Running', stopping: 'Stopping' }[s];
      return [{ name: server.name, label, preparing: s !== 'running', go: () => selectServer(server.id) }];
    }),
  ];
  const pill = $('#activity');
  pill.classList.toggle('running', active.length > 0 && !active.every((a) => a.preparing));
  pill.classList.toggle('preparing', active.length > 0 && active.every((a) => a.preparing));
  pill.disabled = active.length === 0;
  if (active.length === 0) $('#activity-text').textContent = 'Nothing running';
  else if (active.length === 1) $('#activity-text').textContent = `${active[0].name} · ${active[0].label}`;
  else $('#activity-text').textContent = `${active.length} running`;
  renderUpdate();
  pill.title = active.map((a) => `${a.name}: ${a.label}`).join('\n');
  pill.onclick = () => active[0]?.go();
}

// ---------- Closing with something running ----------

// Closing the launcher while a server, a game, or an instance getting ready is running: say what happens to each.
// Servers save and stop first; a game can only end with the launcher, without saving; getting ready just stops.
let stoppingToClose = false;
let closeStopsServers = false;

api.onCloseRequested(({ servers, games }) => {
  if (stoppingToClose) return; // already stopping; the window closes when that's done
  const playing = games.filter((g) => !g.preparing).map((g) => g.name);
  const preparing = games.filter((g) => g.preparing).map((g) => g.name);
  const isAre = (names) => (names.length > 1 ? 'are' : 'is');
  const itThem = (names) => (names.length > 1 ? 'them' : 'it');
  closeStopsServers = servers.length > 0;

  const sentences = [];
  if (playing.length) {
    sentences.push(`${listNames(playing)} ${isAre(playing)} still running. Closing Hojicha closes ${itThem(playing)} too, `
      + 'and anything since the last autosave is lost.');
  }
  if (preparing.length) sentences.push(`${listNames(preparing)} ${isAre(preparing)} still getting ready to play. Closing stops that.`);
  if (servers.length) {
    sentences.push(`${listNames(servers)} ${servers.length > 1 ? 'are' : 'is'} still running. Hojicha saves and stops `
      + `${itThem(servers)} before closing, which can take up to a minute.`);
  }

  const onlyServers = !games.length;
  $('#close-title').textContent = onlyServers ? (servers.length > 1 ? 'Stop the servers first?' : 'Stop the server first?')
    : playing.length && !preparing.length && !servers.length ? (playing.length > 1 ? 'Close the games too?' : 'Close the game too?')
      : 'Close Hojicha?';
  $('#close-text').textContent = sentences.join('\n'); // one line per thing still going (white-space: pre-line)
  $('#close-note').textContent = playing.length ? 'To keep everything, quit from the game\'s own menu first, then close Hojicha.' : '';
  $('#close-note').hidden = !playing.length;
  $('#close-error').textContent = '';
  $('#close-confirm').disabled = false;
  $('#close-confirm').textContent = onlyServers ? (servers.length > 1 ? 'Stop servers and close' : 'Stop server and close') : 'Close anyway';
  $('#close-cancel').disabled = false;
  $('#close-cancel').textContent = onlyServers ? 'Keep running' : 'Keep Hojicha open';
  if (!$('#close-dialog').open) $('#close-dialog').showModal();
});

$('#close-cancel').onclick = () => $('#close-dialog').close();
$('#close-confirm').onclick = async () => {
  stoppingToClose = true;
  $('#close-confirm').disabled = true;
  $('#close-cancel').disabled = true;
  $('#close-confirm').textContent = closeStopsServers ? 'Saving and stopping…' : 'Closing…';
  try {
    await api.stopServersAndClose();
  } catch (err) {
    stoppingToClose = false;
    $('#close-error').textContent = errorText(err);
    $('#close-cancel').disabled = false;
    $('#close-confirm').disabled = false;
    $('#close-confirm').textContent = 'Try again';
  }
};
// While servers are stopping, Escape mustn't hide the dialog: the window is about to close.
$('#close-dialog').addEventListener('cancel', (event) => {
  if (stoppingToClose) event.preventDefault();
});

// ---------- Updates ----------

let update = { state: 'none' };

function renderUpdate() {
  const progress = $('#update-progress');
  const install = $('#update-install');
  progress.hidden = update.state !== 'downloading';
  progress.textContent = `Downloading ${update.version ?? 'update'} · ${Math.round((update.progress ?? 0) * 100)}%`;
  install.hidden = update.state !== 'ready';
  // Installing closes the launcher, which would skip the game's sync-on-exit.
  const playing = state.instances.some((inst) => isBusy(inst.id));
  install.disabled = playing;
  install.title = playing ? 'Close the game first' : `Restart to install Hojicha ${update.version}`;

  // The same, in Settings > About.
  const check = $('#update-check');
  check.disabled = !appInfo.packaged || update.state !== 'none' || check.textContent === 'Checking';
  $('#update-restart').hidden = update.state !== 'ready';
  $('#update-restart').disabled = playing;
  $('#update-restart').title = install.title;
  $('#update-help').textContent = !appInfo.packaged ? 'Updates are off while Hojicha runs from source.'
    : update.state === 'downloading' ? `Downloading ${update.version ?? 'an update'}: ${Math.round((update.progress ?? 0) * 100)}%`
      : update.state === 'ready' ? `${update.version} is ready. It installs when you restart, or when you close Hojicha.`
        : updateMessage || 'Hojicha looks for updates when it starts and every 4 hours.';
}

function renderMain() {
  const showSchematics = state.view === 'schematics';
  const showSettings = state.view === 'settings';
  const showServer = !showSettings && !showSchematics && state.view === 'server' && currentServer();
  const showInstance = !showSettings && !showSchematics && !showServer && current();
  $('#empty').hidden = Boolean(showSchematics || showSettings || showServer || showInstance);
  $('#schematics-view').hidden = !showSchematics;
  $('#settings-view').hidden = !showSettings;
  $('#server-view').hidden = !showServer;
  $('#instance-view').hidden = !showInstance;
  if (showSchematics) renderSchematics();
  if (showSettings) renderAppSettings();
  if (showServer) renderServer();
  if (showInstance) renderInstance();
  remember();
}

// ---------- Back and forward ----------

// Where you've been: an instance or server, and its tab; in Schematics, the folder and the schematic open in the 3D
// view (id: the folder's keys as JSON, tab: the open one's path). The mouse's back and forward buttons (and Alt+Left
// and Alt+Right) step through it like a browser. Places deleted since are skipped.
const nav = { stack: [], index: -1, moving: false, lastStep: 0 };
const MAX_HISTORY = 50;

function here() {
  if (state.view === 'settings') return { view: 'settings', id: '', tab: '' };
  if (state.view === 'schematics') return { view: 'schematics', id: JSON.stringify(schem.at), tab: schemOpen.item?.path || '' };
  if (state.view === 'server' && currentServer()) return { view: 'server', id: state.selectedServer, tab: state.serverTab };
  if (current()) return { view: 'instance', id: state.selected, tab: state.tab };
  return null;
}

function samePlace(a, b) {
  return Boolean(a && b) && a.view === b.view && a.id === b.id && a.tab === b.tab;
}

function remember() {
  if (nav.moving) return;
  const place = here();
  if (!place || samePlace(place, nav.stack[nav.index])) return;
  nav.stack.splice(nav.index + 1, Infinity, place); // a new place drops the forward history, as in a browser
  if (nav.stack.length > MAX_HISTORY) nav.stack.shift();
  nav.index = nav.stack.length - 1;
}

// Goes to a remembered place. Returns false if unsaved changes kept us where we were.
function goTo(place) {
  nav.moving = true;
  try {
    if (place.view !== 'schematics' && $('#schem-dialog').open) {
      $('#schem-dialog').close(); // stepping away from a schematic open in 3D
      schemOpen.item = null;
    }
    if (place.view === 'settings') {
      openSettings();
    } else if (place.view === 'schematics') {
      goToSchematics(place);
    } else if (place.view === 'server') {
      selectServer(place.id);
      if (state.view === 'server' && state.selectedServer === place.id) showServerTab(place.tab);
    } else {
      const switching = !(state.view === 'instance' && state.selected === place.id);
      const tab = state.tab;
      if (switching) state.tab = place.tab; // the instance opens straight on its tab
      selectInstance(place.id);
      if (state.view !== 'instance' || state.selected !== place.id) state.tab = tab;
      else if (state.tab !== place.tab) showTab(place.tab);
    }
  } finally {
    nav.moving = false;
  }
  return samePlace(here(), place);
}

// A Schematics place: its folder (or the nearest one above it still there), with the schematic open in the 3D view or
// the view closed.
function goToSchematics(place) {
  if (state.view !== 'schematics') openSchematics();
  closeSchematicMenu();
  if (schem.filter) {
    schem.filter = '';
    $('#schem-filter').value = '';
  }
  const keys = JSON.parse(place.id || '[]');
  if (JSON.stringify(keys) !== JSON.stringify(schem.at)) openSchematicFolder(keys);
  const item = place.tab && schem.items?.find((one) => one.path === place.tab);
  if (item) {
    if (schemOpen.item?.path !== item.path) openSchematic(item);
  } else if ($('#schem-dialog').open) {
    $('#schem-dialog').close();
    schemOpen.item = null; // now, not when the close event comes: here() asks straight after
  }
}

// Whether a remembered place is still there to go back to.
function placeExists(place) {
  if (place.view === 'settings') return true;
  if (place.view === 'schematics') return !place.tab || !schem.items || schem.items.some((item) => item.path === place.tab);
  if (place.view === 'server') return state.servers.some((s) => s.id === place.id);
  return state.instances.some((inst) => inst.id === place.id);
}

function stepHistory(direction) {
  // One press can arrive twice (a mouse event and a Windows app command): take the first.
  if (Date.now() - nav.lastStep < 80) return;
  nav.lastStep = Date.now();
  // A popup keeps you where you are, except the schematic 3D view, which back and forward go in and out of.
  if ([...document.querySelectorAll('dialog[open]')].some((dialog) => dialog.id !== 'schem-dialog')) return;
  // Stepping away from unsaved server edits: ask first, then take the same step.
  if (state.view === 'server' && hasUnsaved()) {
    askDiscard().then((discard) => {
      if (!discard) return;
      dropEdits();
      nav.lastStep = 0;
      stepHistory(direction);
    });
    return;
  }
  for (let i = nav.index + direction; i >= 0 && i < nav.stack.length; i += direction) {
    const place = nav.stack[i];
    if (!placeExists(place)) continue;
    if (goTo(place)) nav.index = i;
    return;
  }
}

// Mouse buttons 4 (back) and 5 (forward).
document.addEventListener('mouseup', (event) => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  stepHistory(event.button === 3 ? -1 : 1);
});
document.addEventListener('keydown', (event) => {
  if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  stepHistory(event.key === 'ArrowLeft' ? -1 : 1);
});
api.onNavigate((direction) => stepHistory(direction === 'back' ? -1 : 1));

// The installed mods changed: Browse reloads (keeping the search text) the next time it is shown,
// so its "Installed" labels are never stale.
function invalidateSearch() {
  state.search.done = false;
}

// The instance's mods changed (installed, removed, another version): Browse's "Installed" labels and the update
// check are out of date.
function modsChanged(id) {
  invalidateSearch();
  delete state.modUpdates[id];
}

// Forget the previous instance's results; the Browse tab loads fresh ones the next time it is shown.
function resetSearch() {
  state.search = { query: '', type: $('#search-type').value, offset: 0, total: 0, done: false };
  $('#search-query').value = '';
  $('#search-results').replaceChildren();
  $('#load-more').hidden = true;
}

function selectInstance(id) {
  if (state.view === 'server' && !confirmDiscard(() => selectInstance(id))) return;
  if (state.view === 'instance' && id === state.selected) return;
  const changed = id !== state.selected;
  state.selected = id;
  state.view = 'instance';
  if (changed) resetSearch();
  renderSidebar();
  renderMain();
}

function renderInstance() {
  const inst = current();
  if (!inst) return;

  $('#inst-name').textContent = inst.name;
  renderMeta();
  renderStatus();
  showTab(state.tab);
}

function renderMeta() {
  const inst = current();
  if (!inst) return;
  const playing = state.status[inst.id]?.state === 'running';
  const item = (glyph, text, title) => el('span', { className: 'meta-item', title: title || '' }, [glyph, text]);
  const version = inst.loader === 'fabric'
    ? item(el('img', { className: 'pixel-icon', src: 'icons/fabric.png', alt: '' }), loaderLabel(inst), `Fabric loader ${inst.loaderVersion}`)
    : item(icon('block'), loaderLabel(inst));
  $('#inst-meta').replaceChildren(...[
    version,
    inst.playtime >= 60000 ? item(icon('hourglass'), formatPlaytime(inst.playtime), 'Time played') : null,
    item(icon('clock'), playing ? 'Playing now' : formatLastPlayed(inst.lastPlayed),
      inst.lastPlayed ? `Last played ${new Date(inst.lastPlayed).toLocaleString()}` : ''),
  ].filter(Boolean));
}

// As the launch progresses, hojicha roasts from leaf green to tea liquor to roasted brown; matcha is whisked from
// fresh to deep green. Both start well apart from the empty cup (--clay), so the first few percent already show.
const ROAST_STOPS = {
  hojicha: [[156, 178, 106], [217, 148, 74], [176, 100, 56]],
  matcha: [[141, 178, 85], [94, 138, 46], [79, 125, 38]],
};
function roastColor(fraction) {
  const stops = ROAST_STOPS[document.documentElement.dataset.theme] || ROAST_STOPS.hojicha;
  const f = Math.min(1, Math.max(0, fraction)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const t = f - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return a.map((v, k) => Math.round(v + (b[k] - v) * t));
}

// WCAG relative luminance of an [r, g, b] or a #rrggbb colour.
function luminance(color) {
  const rgb = Array.isArray(color) ? color : [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The label over the tea: whichever of the theme's text and background colours reads better on the fill.
const themeText = {};
function textOn(rgb) {
  const theme = document.documentElement.dataset.theme || 'hojicha';
  if (!themeText[theme]) {
    const css = getComputedStyle(document.documentElement);
    themeText[theme] = [css.getPropertyValue('--steam').trim(), css.getPropertyValue('--roast').trim()];
  }
  const fill = luminance(rgb);
  const contrast = (hex) => {
    const l = luminance(hex);
    return (Math.max(l, fill) + 0.05) / (Math.min(l, fill) + 0.05);
  };
  return themeText[theme].reduce((best, hex) => (contrast(hex) > contrast(best) ? hex : best));
}

// Play as a cup: fills once from empty to full while the instance is prepared, and stays full while the game runs.
// The tea follows the launch progress but never faster than a full cup in CUP_MIN_FILL seconds, so a launch where
// everything is already downloaded still pours in one smooth go instead of a flicker. The launch steps show under
// Play only once preparing takes longer than DETAIL_DELAY, so quick launches stay calm.
const CUP_MIN_FILL = 0.9;
const DETAIL_DELAY = 700;
const cup = { id: null, state: 'idle', text: '', shown: 0, target: 0, since: 0, last: 0, frame: 0, detailTimer: null };

function renderPlay(id, s) {
  const busy = s.state === 'installing' || s.state === 'running';
  const progress = s.state === 'running' ? 1 : s.state === 'installing' ? (s.progress ?? 0) : 0;
  if (cup.id !== id) {
    // Another instance: show where its launch is, without pouring.
    cup.id = id;
    cup.target = cup.shown = busy ? progress : 0;
    cup.since = performance.now() - DETAIL_DELAY;
  } else if (s.state === 'installing' && cup.state !== 'installing') {
    cup.target = cup.shown = 0; // a new launch starts with an empty cup
    cup.since = performance.now();
  }
  cup.state = s.state;
  cup.text = s.text;
  cup.target = busy ? Math.max(cup.target, progress) : 0; // progress only ever rises within one launch
  if (!busy || reduceMotion.matches) cup.shown = cup.target;

  clearTimeout(cup.detailTimer);
  const untilDetail = cup.since + DETAIL_DELAY - performance.now();
  if (s.state === 'installing' && untilDetail > 0) cup.detailTimer = setTimeout(drawCup, untilDetail);

  drawCup();
  if (cup.shown < cup.target && !cup.frame) {
    cup.last = performance.now();
    cup.frame = requestAnimationFrame(pourCup);
  }
}

function pourCup(now) {
  const dt = Math.min(0.05, (now - cup.last) / 1000);
  cup.last = now;
  const gap = cup.target - cup.shown;
  // Ease towards the target, at least a little each frame so it always arrives, and never faster than the cap.
  const step = Math.min(gap, dt / CUP_MIN_FILL, Math.max(gap * (1 - Math.exp(-dt / 0.12)), 0.3 * dt));
  cup.shown += step;
  if (cup.target - cup.shown < 0.0005) cup.shown = cup.target;
  drawCup();
  cup.frame = cup.shown < cup.target ? requestAnimationFrame(pourCup) : 0;
}

function drawCup() {
  const play = $('#play');
  // "Playing" waits for the cup to be full, so the pour always finishes.
  const label = cup.state === 'installing' || (cup.state === 'running' && cup.shown < 1) ? 'Preparing'
    : cup.state === 'running' ? 'Playing' : 'Play';
  $('#play-label').textContent = label;
  $('#play-fill-label').textContent = label;
  play.style.setProperty('--play-progress', `${(cup.shown * 100).toFixed(2)}%`);
  if (reduceMotion.matches) {
    play.style.removeProperty('--play-fill');
    play.style.removeProperty('--play-fill-text');
  } else {
    const rgb = roastColor(cup.shown);
    play.style.setProperty('--play-fill', `rgb(${rgb.join(', ')})`);
    play.style.setProperty('--play-fill-text', textOn(rgb));
  }
  const showDetail = cup.state === 'installing' && performance.now() - cup.since >= DETAIL_DELAY;
  $('#play-detail').textContent = showDetail ? cup.text : '';
}

function renderStatus() {
  const inst = current();
  if (!inst) return;
  const s = state.status[inst.id] || { state: 'idle', text: '' };
  const statusEl = $('#status');
  // Launch steps go under Play, and Play itself says when the game is running.
  statusEl.textContent = s.state === 'installing' || s.state === 'running' ? '' : s.text;
  statusEl.className = `status${s.state === 'error' ? ' error' : ''}`;
  renderPlay(inst.id, s);

  const play = $('#play');
  play.disabled = isBusy(inst.id);
  $('#delete-instance').disabled = isBusy(inst.id);
  if (state.tab === 'sync') renderSync();
  // The mod switches and update buttons lock while the game is prepared or running.
  if (state.tab === 'mods' && state.mods.id === inst.id && state.mods.busy !== isBusy(inst.id)) renderMods();
}

// ---------- Tabs ----------

function showTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('#instance-view .tabs button')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  for (const panel of document.querySelectorAll('#instance-view .tab')) {
    panel.hidden = panel.id !== `tab-${tab}`;
  }
  if (tab === 'mods') loadMods();
  if (tab === 'browse' && !state.search.done && !state.search.loading) runSearch(false); // show popular projects straight away
  if (tab === 'sync') renderSync();
  if (tab === 'log') renderLog();
  remember();
}

// Mod versions repeat what the instance already says ("mc1.21.11-0.21.4-fabric", "0.141.6+1.21.11"): keep the
// mod's own part ("0.21.4", "0.141.6"). The full version stays in the tooltip and the version picker.
const LOADER_WORDS = /^(fabric|quilt|forge|neoforge)$/i;
function shortVersion(version, inst) {
  const game = inst.gameVersion.toLowerCase();
  const parts = version.split(/([-+])/); // parts and the - or + before each, so what's kept keeps its own separators
  let short = '';
  for (let i = 0; i < parts.length; i += 2) {
    const p = parts[i].toLowerCase();
    if (!p || LOADER_WORDS.test(p) || p === game || p === `mc${game}`) continue;
    short += (short ? parts[i - 1] : '') + parts[i];
  }
  return short || version;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// The Installed tab: mods, resource packs and shaders. All shows them one kind after the other, in this order.
const KINDS = [
  { type: 'mod', folder: 'mods', one: 'mod', many: 'mods', heading: 'Mods' },
  { type: 'resourcepack', folder: 'resourcepacks', one: 'resource pack', many: 'resource packs', heading: 'Resource packs' },
  { type: 'shader', folder: 'shaderpacks', one: 'shader', many: 'shaders', heading: 'Shaders' },
];

async function loadMods() {
  const inst = current();
  if (state.mods.id !== inst.id) {
    state.mods = { ...state.mods, id: inst.id, content: { mod: [], resourcepack: [], shader: [] }, filter: '', busy: isBusy(inst.id) };
    $('#mod-filter').value = '';
  }
  const content = await api.listContent(inst.id);
  if (current()?.id !== inst.id) return; // another instance was picked meanwhile
  state.mods.content = content;
  checkModUpdates(inst);
  renderMods();
}

// Looks for newer versions at most every ten minutes per instance, or after its mods change.
function checkModUpdates(inst) {
  const known = state.modUpdates[inst.id];
  if (known?.pending || (known && Date.now() - known.at < 10 * 60 * 1000)) return;
  if (!state.mods.content.mod.some((m) => m.fromModrinth)) return;
  state.modUpdates[inst.id] = { pending: true };
  api.checkModUpdates(inst.id)
    .then((updates) => { state.modUpdates[inst.id] = { at: Date.now(), updates }; })
    .catch(() => { state.modUpdates[inst.id] = { at: Date.now(), updates: {} }; }) // offline: just no update marks
    .then(() => { if (state.tab === 'mods' && current()?.id === inst.id) renderMods(); });
}

// Opens Browse on the given kind, for the "nothing here yet" rows.
function browseFor(type) {
  const button = el('button', { className: 'primary', textContent: 'Browse Modrinth' });
  button.onclick = () => {
    if ($('#search-type').value !== type) {
      $('#search-type').value = type;
      invalidateSearch();
    }
    showTab('browse');
  };
  return button;
}

function renderMods() {
  const inst = current();
  const list = $('#mod-list');
  const view = state.mods.view;
  const content = state.mods.content;
  state.mods.busy = isBusy(inst.id);

  const total = KINDS.reduce((n, kind) => n + content[kind.type].length, 0);
  $('#mods-bar').hidden = $('#content-kinds').hidden = !total;
  for (const button of document.querySelectorAll('#content-kinds button')) {
    const on = button.dataset.kind === view;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  }
  if (!total) {
    list.replaceChildren(emptyRow('Nothing installed yet.', browseFor('mod')));
    return;
  }

  const updates = state.modUpdates[inst.id]?.updates || {};
  const query = state.mods.filter.trim().toLowerCase();
  const matches = (item) => !query || `${item.title} ${item.file}`.toLowerCase().includes(query);
  const kinds = view === 'all' ? KINDS : KINDS.filter((kind) => kind.type === view);
  const shown = Object.fromEntries(kinds.map((kind) => [kind.type, content[kind.type].filter(matches)]));
  const shownCount = kinds.reduce((n, kind) => n + shown[kind.type].length, 0);

  // "12 mods, 3 resource packs", "12 mods, 1 switched off", or "3 of 16" while filtering.
  const off = content.mod.filter((m) => !m.enabled).length;
  const counts = kinds.filter((kind) => content[kind.type].length)
    .map((kind) => plural(content[kind.type].length, kind.one, kind.many));
  if (view === 'mod' && off) counts.push(`${off} switched off`);
  const all = kinds.reduce((n, kind) => n + content[kind.type].length, 0);
  $('#mod-count').textContent = query ? `${shownCount} of ${all}` : counts.join(', ');

  const updatable = view === 'all' || view === 'mod' ? content.mod.filter((m) => updates[m.file]) : [];
  const updateAll = $('#mods-update-all');
  updateAll.hidden = updatable.length < 2;
  updateAll.textContent = `Update all ${updatable.length}`;
  updateAll.disabled = state.mods.busy;

  const rows = [];
  for (const kind of kinds) {
    const items = shown[kind.type];
    if (view === 'all') {
      if (!items.length) continue;
      // A thin line, with the kind's name, between one kind and the next.
      if (rows.length) rows.push(el('li', { className: 'kind-divider', role: 'presentation' }, [el('span', { textContent: kind.heading })]));
    } else if (!items.length) {
      if (query) break;
      if (kind.type === 'mod' && inst.loader === 'vanilla') rows.push(emptyRow("This instance has no mod loader, so it can't use mods. Create a Fabric instance to add mods."));
      else rows.push(emptyRow(`No ${kind.many} yet.`, browseFor(kind.type)));
      continue;
    }
    for (const item of items) rows.push(kind.type === 'mod' ? modRow(inst, item, updates[item.file]) : installedPackRow(inst, kind, item));
  }
  if (!rows.length) rows.push(emptyRow(`Nothing matches "${state.mods.filter.trim()}".`));
  list.replaceChildren(...rows);
}

// Asks in the launcher's own dialog. Resolves true for the confirm button, false for the other or Escape.
function askConfirm({ title, text, note = '', confirm, cancel = 'Cancel' }) {
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

// Removes a mod or pack. A shared pack is also in other instances: say which before it goes from all of them.
async function removeItem(inst, kind, item) {
  if (item.shared) {
    const others = state.instances.filter((other) => other.id !== inst.id && other.sync?.[kind.folder] !== false).map((other) => other.name);
    if (others.length) {
      const remove = await askConfirm({
        title: `Remove ${item.title} from every instance?`,
        text: `This ${kind.one} is shared with ${listNames(others)}, so removing it here removes it there too.`,
        // Named as the switch in the Sync tab is: "Resource packs", "Shader packs".
        note: `To keep it in the others, first switch off ${SYNC_ITEMS.find(([item]) => item === kind.folder)[1]} in this instance's Sync tab.`,
        confirm: 'Remove everywhere',
        cancel: 'Keep it',
      });
      if (!remove) return;
    }
  }
  try {
    await api.removeContent(inst.id, kind.type, item.file);
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: errorText(err) };
    renderStatus();
  }
  modsChanged(inst.id);
  loadMods();
}

// "A", "A and B", "A, B and C".
function listNames(names) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function removeButton(inst, kind, item) {
  const remove = el('button', { className: 'quiet danger mod-remove', textContent: 'Remove', ariaLabel: `Remove ${item.title}` });
  remove.onclick = () => removeItem(inst, kind, item);
  return remove;
}

function modRow(inst, mod, update) {
  const busy = state.mods.busy;

  let version;
  if (mod.fromModrinth) {
    version = el('button', {
      className: 'version-button',
      textContent: mod.versionNumber ? shortVersion(mod.versionNumber, inst) : 'Unknown',
      title: `Version ${mod.versionNumber || 'unknown'}. Click to change it.`,
      ariaLabel: `Change version of ${mod.title}, now ${mod.versionNumber}`,
    });
    version.onclick = () => openVersionPicker(inst, mod);
  } else {
    version = el('span', { className: 'version', textContent: 'Added by hand' });
  }

  let updateButton = null;
  if (update) {
    updateButton = el('button', {
      className: 'mod-update',
      textContent: `Update to ${shortVersion(update.versionNumber, inst)}`,
      title: `Update to ${update.versionNumber}`,
      disabled: busy,
    });
    updateButton.onclick = () => updateMods(inst, [mod]);
  }

  const toggle = el('input', {
    type: 'checkbox',
    className: 'switch',
    checked: mod.enabled,
    disabled: busy,
    title: mod.enabled ? 'On: the game loads this mod' : 'Off: the game skips this mod',
    ariaLabel: `Load ${mod.title}`,
  });
  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      mod.file = await api.setModEnabled(inst.id, mod.file, toggle.checked);
      mod.enabled = toggle.checked;
    } catch (err) {
      state.status[inst.id] = { state: 'error', text: errorText(err) };
      renderStatus();
    }
    renderMods();
  };

  return el('li', { className: `mod-row${mod.enabled ? '' : ' off'}`, title: mod.file }, [
    thumb(mod.iconUrl),
    el('div', { className: 'info' }, [el('div', { className: 'title', textContent: mod.title })]),
    updateButton,
    version,
    toggle,
    removeButton(inst, KINDS[0], mod),
  ]);
}

// A resource pack or shader. Which ones are on is chosen in the game, so there's no switch; an empty space of the
// same size keeps the versions lined up with the mods'.
function installedPackRow(inst, kind, pack) {
  const title = el('div', { className: 'title' }, [pack.title]);
  if (pack.shared) {
    const others = state.instances.filter((other) => other.id !== inst.id && other.sync?.[kind.folder] !== false).map((other) => other.name);
    title.append(el('span', {
      className: 'shared-mark',
      title: others.length ? `Shared with ${listNames(others)}` : `Shared: every instance that syncs ${kind.many} has it`,
      ariaLabel: 'Shared with other instances',
    }, [icon('linked')]));
  }
  return el('li', { className: 'mod-row', title: pack.file }, [
    thumb(pack.iconUrl),
    el('div', { className: 'info' }, [title]),
    el('span', { className: 'version', textContent: pack.fromModrinth ? shortVersion(pack.versionNumber, inst) : 'Added by hand', title: pack.versionNumber }),
    el('span', { className: 'switch-space', ariaHidden: 'true' }),
    removeButton(inst, kind, pack),
  ]);
}

// Updates the given mods one by one to the versions the update check found.
async function updateMods(inst, mods) {
  const updates = state.modUpdates[inst.id]?.updates || {};
  const buttons = [...document.querySelectorAll('#mod-list .mod-update, #mods-update-all')];
  for (const button of buttons) button.disabled = true;
  let done = 0;
  try {
    for (const mod of mods) {
      if (mods.length > 1) $('#mods-update-all').textContent = `Updating ${done + 1} of ${mods.length}`;
      await api.setModVersion(inst.id, mod.file, updates[mod.file].versionId);
      done++;
    }
    state.status[inst.id] = {
      state: 'idle',
      text: mods.length === 1 ? `${mods[0].title} is now on version ${updates[mods[0].file].versionNumber}.` : `Updated ${mods.length} mods.`,
    };
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: done ? `Updated ${done} of ${mods.length} mods, then: ${errorText(err)}` : errorText(err) };
  }
  modsChanged(inst.id);
  renderStatus();
  await loadMods();
}

// ---------- Version picker ----------

const CHANNELS = { release: 'Release', beta: 'Beta', alpha: 'Alpha' };
const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

async function openVersionPicker(inst, mod) {
  const list = $('#versions-list');
  const errorEl = $('#versions-error');
  errorEl.textContent = '';
  $('#versions-title').textContent = `Versions of ${mod.title}`;
  $('#versions-hint').textContent = `Every version that works with ${loaderLabel(inst)}, newest first.`;
  list.replaceChildren(emptyRow('Loading versions…'));
  $('#versions-dialog').showModal();

  let versions;
  try {
    versions = await api.listModVersions(inst.id, mod.file);
  } catch (err) {
    list.replaceChildren();
    errorEl.textContent = errorText(err);
    return;
  }
  if (!versions.length) {
    list.replaceChildren(emptyRow(`Modrinth has no versions of ${mod.title} for ${loaderLabel(inst)}.`));
    return;
  }

  list.replaceChildren(...versions.map((v) => {
    let action;
    if (v.current) {
      action = el('span', { className: 'installed', textContent: 'Installed' });
    } else {
      action = el('button', { textContent: 'Use this version', type: 'button' });
      action.onclick = async () => {
        for (const button of list.querySelectorAll('button')) button.disabled = true;
        action.textContent = 'Switching';
        errorEl.textContent = '';
        try {
          const result = await api.setModVersion(inst.id, mod.file, v.id);
          modsChanged(inst.id); // a new version can pull in extra dependencies
          $('#versions-dialog').close();
          await loadMods();
          state.status[inst.id] = { state: 'idle', text: `${result.title} is now on version ${result.versionNumber}.` };
          renderStatus();
        } catch (err) {
          errorEl.textContent = errorText(err);
          for (const button of list.querySelectorAll('button')) button.disabled = false;
          action.textContent = 'Use this version';
        }
      };
    }
    return el('li', {}, [
      el('div', { className: 'info' }, [
        el('div', { className: 'title', textContent: v.versionNumber }),
        el('div', { className: 'channel', textContent: `${CHANNELS[v.type] || v.type}, ${dateFormat.format(new Date(v.published))}` }),
      ]),
      action,
    ]);
  }));
}

function renderSync() {
  const inst = current();
  $('#sync-options').replaceChildren(...SYNC_ITEMS.map(([item, title, description]) => {
    const box = el('input', { type: 'checkbox', className: 'switch', checked: inst.sync?.[item] !== false, disabled: isBusy(inst.id) });
    box.onchange = async () => {
      $('#sync-error').textContent = '';
      try {
        Object.assign(inst, await api.setSync(inst.id, item, box.checked));
      } catch (err) {
        box.checked = !box.checked;
        $('#sync-error').textContent = errorText(err);
      }
    };
    // The label wraps the whole row so clicking anywhere on it flips the switch.
    return el('li', {}, [
      el('label', { className: 'sync-row' }, [
        el('div', { className: 'info' }, [
          el('div', { className: 'title', textContent: title }),
          el('div', { className: 'desc', textContent: description }),
        ]),
        box,
      ]),
    ]);
  }));
}

function renderLog() {
  const logEl = $('#log');
  logEl.textContent = (state.logs[state.selected] || []).join('\n');
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

// ---------- Modrinth browsing ----------

const SEARCH_NOUNS = { mod: 'mods', resourcepack: 'resource packs', shader: 'shaders' };
let searchRequest = 0; // only the newest search may update the list
let searchTimer = null;

async function runSearch(append) {
  const inst = current();
  const results = $('#search-results');
  const s = state.search;
  if (!append) {
    s.query = $('#search-query').value.trim();
    s.type = $('#search-type').value;
    s.offset = 0;
  }
  if (s.type === 'mod' && inst.loader === 'vanilla') {
    results.replaceChildren(emptyRow("This instance has no mod loader, so it can't use mods. Create a Fabric instance to add mods."));
    $('#load-more').hidden = true;
    s.done = true;
    return;
  }

  const request = ++searchRequest;
  // First load for this instance: say what's coming. Later searches keep the old results until new ones arrive.
  if (!append && !s.done) {
    results.replaceChildren(emptyRow(s.query ? `Searching for "${s.query}"…` : `Loading popular ${SEARCH_NOUNS[s.type]}…`));
  }
  let page;
  s.loading = true;
  try {
    page = await api.search(inst.id, s.query, s.type, s.offset);
  } catch (err) {
    if (request === searchRequest) results.replaceChildren(emptyRow(`Modrinth couldn't be reached. Check your internet connection. (${errorText(err)})`));
    return;
  } finally {
    if (request === searchRequest) s.loading = false;
  }
  if (request !== searchRequest || inst.id !== state.selected) return;
  const rows = page.hits.map((hit) => searchRow(inst, hit, s.type));
  if (append) results.append(...rows);
  else {
    results.replaceChildren(...(rows.length
      ? rows
      : [emptyRow(s.query ? `Nothing found for "${s.query}". Try a different word.` : 'Nothing found.')]));
    results.parentElement.scrollTop = 0;
  }
  s.offset += page.hits.length;
  s.total = page.total;
  s.done = true;
  $('#load-more').hidden = s.offset >= s.total;
}

function searchRow(inst, hit, type) {
  let action;
  if (hit.installed) {
    action = el('span', { className: 'installed', textContent: 'Installed' });
  } else {
    action = el('button', { textContent: 'Install' });
    action.onclick = async () => {
      action.disabled = true;
      action.textContent = 'Installing';
      try {
        Object.assign(inst, await api.install(inst.id, hit.projectId, type));
        action.replaceWith(el('span', { className: 'installed', textContent: 'Installed' }));
        modsChanged(inst.id); // dependencies may have come along: their rows update when Browse is next shown
      } catch (err) {
        action.disabled = false;
        action.textContent = 'Install';
        state.status[inst.id] = { state: 'error', text: errorText(err) };
        renderStatus();
      }
    };
  }
  return projectRow(hit, type, action);
}

function projectRow(hit, type, action) {
  const title = el('a', { className: 'title', textContent: hit.title, tabIndex: 0 });
  title.onclick = () => api.openExternal(`https://modrinth.com/${type}/${hit.slug}`);
  return el('li', {}, [
    thumb(hit.iconUrl),
    el('div', { className: 'info' }, [
      el('div', {}, [title, el('span', { className: 'by', textContent: ` by ${hit.author}` })]),
      el('div', { className: 'desc', textContent: hit.description }),
    ]),
    el('span', { className: 'version', textContent: formatDownloads(hit.downloads) }),
    action,
  ]);
}

// ---------- Local servers ----------

function currentServer() {
  return state.servers.find((s) => s.id === state.selectedServer) || null;
}

// "paper-1.21.11-132.jar" -> "Paper"
function serverFlavor(server) {
  const name = server.jar.split(/[-_.]/)[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function serverState(id) {
  return state.serverStatus[id]?.state || 'idle';
}

async function refreshServers(selectId) {
  state.servers = await api.listServers();
  for (const server of state.servers) {
    if (server.running && !state.serverStatus[server.id]) state.serverStatus[server.id] = { state: 'running', text: 'Running' };
  }
  if (selectId) {
    state.selectedServer = selectId;
    state.view = 'server';
  }
  if (!currentServer()) {
    state.selectedServer = state.servers[0]?.id ?? null;
    if (state.view === 'server' && !state.selectedServer) state.view = 'instance';
  }
  renderSidebar();
  renderMain();
}

function selectServer(id) {
  if (id !== state.selectedServer && !confirmDiscard(() => selectServer(id))) return;
  state.selectedServer = id;
  if (state.serverTab === 'settings') loadSettings();
  if (state.serverTab === 'files') loadFiles();
  state.view = 'server';
  renderSidebar();
  renderMain();
  renderServerLog(true);
}

function renderServer() {
  const server = currentServer();
  const s = state.serverStatus[server.id] || { state: 'idle', text: '' };
  $('#srv-name').textContent = server.name;
  $('#srv-meta').textContent = `${serverFlavor(server)} ${server.mcVersion} in ${server.dir}`;
  $('#srv-meta').title = server.dir;
  const statusEl = $('#srv-status');
  statusEl.textContent = s.text;
  statusEl.className = `status${s.state === 'error' ? ' error' : ''}`;

  const toggle = $('#srv-toggle');
  toggle.textContent = { idle: 'Start server', error: 'Start server', starting: 'Starting', running: 'Stop server', stopping: 'Stopping' }[s.state];
  toggle.disabled = s.state === 'starting' || s.state === 'stopping';
  $('#srv-remove').disabled = s.state !== 'idle' && s.state !== 'error';
  $('#srv-remove').title = $('#srv-remove').disabled ? 'Stop the server first' : '';

  // Start and join: the instance is picked when it's clicked (see the join menu), from those that can join.
  const matching = joinable(server);
  const allPlaying = matching.length > 0 && matching.every((i) => isBusy(i.id));
  const join = $('#srv-join');
  $('#srv-join-label').textContent = s.state === 'running' ? 'Join' : 'Start and join';
  join.disabled = !matching.length || allPlaying || s.state === 'stopping';
  join.title = !matching.length ? `No ${server.mcVersion} instance yet`
    : allPlaying ? `Your ${server.mcVersion} instances are already playing` : '';

  renderOnline();
  renderServerLog(false);
}

// ---------- Online play ----------

let playitState = { linked: false };
let linking = false;
const serverOnline = {}; // server id -> { state: off | connecting | online | error, address, srv, text }

function selectedAccount() {
  return accountState.accounts.find((a) => a.id === accountState.selected) || null;
}

function renderOnline() {
  const server = currentServer();
  if (!server) return;
  const running = serverState(server.id) !== 'idle' && serverState(server.id) !== 'error';
  const live = serverOnline[server.id] || { state: 'off' };
  const isPublic = playitState.linked && server.public;

  $('#srv-intro').textContent = isPublic
    ? 'Online play is on: friends on the whitelist can join with Microsoft accounts. Your server.properties settings are put back when it stops. The selected account is made operator.'
    : 'The server only accepts players on this PC. Your server.properties settings are put back when it stops, so your own start script keeps working. The selected account is made operator.';

  $('#playit-link').hidden = playitState.linked || !ONLINE_PLAY;
  $('#playit-link').disabled = linking;
  $('#playit-link').textContent = linking ? 'Waiting for you in the browser…' : 'Set up online play';
  $('#playit-cancel').hidden = !linking;
  $('#public-toggle').hidden = !playitState.linked;
  const switching = ['starting', 'stopping'].includes(serverState(server.id));
  $('#srv-public').checked = Boolean(server.public);
  $('#srv-public').disabled = switching;
  $('#public-toggle').title = running ? 'Changing this restarts the server' : '';

  const account = selectedAccount();
  let hint;
  if (!ONLINE_PLAY) hint = 'Online play through playit.gg only works on Windows for now, so only this computer can join.';
  else if (!playitState.linked) hint = linking
    ? 'Sign in on playit.gg (a free account is fine) and approve Hojicha Launcher. This only happens once.'
    : 'Let friends join over the internet through playit.gg, without port forwarding.';
  else if (!server.public) hint = 'Off: only this PC can join.';
  else if (account?.type === 'offline') hint = 'Your selected account is offline. Switch to a Microsoft account to join while online play is on.';
  else hint = running ? '' : 'Starts with the server. Players need Microsoft accounts and a spot on the whitelist.';
  $('#online-hint').textContent = hint;
  $('#online-hint').hidden = !hint;

  $('#online-dot').hidden = live.state !== 'online';
  $('#online-body').hidden = !isPublic;
  $('#online-error').textContent = live.state === 'error' ? live.text : '';
  if (!isPublic) return;

  const address = $('#online-address');
  address.className = live.state === 'online' ? '' : 'waiting';
  $('#online-manual').hidden = live.state !== 'manual';
  if (live.state === 'manual') $('#manual-target').textContent = `127.0.0.1:${live.port}`;
  address.textContent = {
    online: live.address,
    connecting: 'Connecting to playit.gg…',
    manual: 'Waiting for the tunnel on playit.gg…',
    error: 'Not connected',
    off: 'Appears when the server starts',
  }[live.state];
  $('#copy-address').hidden = live.state !== 'online';

  const you = account?.type === 'microsoft' ? account.name : null;
  $('#whitelist').replaceChildren(
    ...(you ? [el('li', { className: 'you', textContent: `${you} (you)`, title: 'Your selected account is always allowed' })] : []),
    ...(server.whitelist || []).filter((name) => name !== you).map((name) => {
      const remove = el('button', { type: 'button', textContent: '×', title: `Remove ${name}`, ariaLabel: `Remove ${name}` });
      remove.onclick = () => updateServer(api.whitelistRemove(server.id, name));
      return el('li', {}, [name, remove]);
    }),
  );
}

// Applies a server change from the main process (whitelist, public switch) and redraws.
async function updateServer(request) {
  $('#online-error').textContent = '';
  try {
    const updated = await request;
    state.servers = state.servers.map((s) => (s.id === updated.id ? updated : s));
    renderOnline();
  } catch (err) {
    $('#online-error').textContent = errorText(err);
  }
}

async function linkPlayit() {
  linking = true;
  renderOnline();
  try {
    await api.playitLinkStart();
    await api.playitLinkFinish();
    playitState = await api.playitStatus();
  } catch (err) {
    if (errorText(err) !== 'Cancelled') $('#online-error').textContent = errorText(err);
  } finally {
    linking = false;
    renderOnline();
  }
}

function copyText(text, button) {
  navigator.clipboard.writeText(text);
  const label = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = label; }, 1200);
}

$('#playit-link').onclick = linkPlayit;
$('#open-tunnels').onclick = () => api.openExternal('https://playit.gg/account/tunnels');
$('#playit-cancel').onclick = () => api.playitLinkCancel();
// The mode is set when the server starts, so switching it on a running server restarts the server.
$('#srv-public').onchange = async (event) => {
  const server = currentServer();
  const on = event.target.checked;
  if (serverState(server.id) !== 'running') {
    await updateServer(api.setServerPublic(server.id, on));
    return;
  }
  const restart = await askConfirm({
    title: `Restart ${server.name}?`,
    text: `Turning online play ${on ? 'on' : 'off'} needs a restart. Anyone playing on it is disconnected for a moment.`,
    confirm: 'Restart server',
    cancel: 'Not now',
  });
  if (!restart) {
    event.target.checked = !on;
    return;
  }
  try {
    await api.stopServer(server.id);
    await updateServer(api.setServerPublic(server.id, on));
    state.serverLogs[server.id] = [];
    await api.startServer(server.id);
  } catch (err) {
    showServerError(server.id, err);
  }
};
$('#whitelist-form').onsubmit = async (event) => {
  event.preventDefault();
  const input = $('#whitelist-name');
  if (!input.value.trim()) return;
  await updateServer(api.whitelistAdd(state.selectedServer, input.value));
  if (!$('#online-error').textContent) input.value = '';
};
$('#copy-address').onclick = (event) => copyText($('#online-address').textContent, event.target);
$('#playit-unlink').onclick = async () => {
  const disconnect = await askConfirm({
    title: 'Disconnect playit.gg?',
    text: 'Online play stops working until you set it up again.',
    note: 'Your tunnel stays in your playit.gg account.',
    confirm: 'Disconnect',
    cancel: 'Stay connected',
  });
  if (!disconnect) return;
  try {
    await api.playitUnlink();
    playitState = await api.playitStatus();
  } catch (err) {
    $('#online-error').textContent = errorText(err);
  }
  renderOnline();
};

// Console | Online play tabs on the server page.
// Console | Online play | Settings | Files tabs on the server page.
const SERVER_TABS = ['console', 'online', 'settings', 'files'];
function showServerTab(tab) {
  if (tab !== state.serverTab && !confirmDiscard(() => showServerTab(tab))) return;
  state.serverTab = tab;
  for (const button of document.querySelectorAll('[data-srv-tab]')) button.classList.toggle('active', button.dataset.srvTab === tab);
  for (const name of SERVER_TABS) $(`#srv-tab-${name}`).hidden = name !== tab;
  // The note about who can join belongs with the console and online play, not the settings editors.
  $('#srv-intro').hidden = tab === 'settings' || tab === 'files';
  if (tab === 'console') renderServerLog(true);
  if (tab === 'settings') loadSettings();
  if (tab === 'files') loadFiles();
  remember();
}
for (const button of document.querySelectorAll('[data-srv-tab]')) button.onclick = () => showServerTab(button.dataset.srvTab);

// ---------- Server settings (server.properties as a form) ----------

// [key, label, type, options, help]. Only keys present in the server's own server.properties are shown, so each
// Minecraft version gets exactly the settings it has.
const SETTINGS = [
  ['General', [
    ['motd', 'Welcome message', 'text', null, 'Shown under the server name in the server list.'],
    ['max-players', 'Max players', 'number', [1, 500]],
    ['gamemode', 'Game mode', 'select', ['survival', 'creative', 'adventure', 'spectator']],
    ['force-gamemode', 'Always use this game mode', 'switch', null, 'Players are put back in it every time they join.'],
    ['difficulty', 'Difficulty', 'select', ['peaceful', 'easy', 'normal', 'hard']],
    ['hardcore', 'Hardcore', 'switch', null, 'One life: players who die can only watch.'],
    ['pvp', 'PvP', 'switch', null, 'Players can hurt each other.'],
  ]],
  ['World', [
    ['view-distance', 'View distance', 'number', [3, 32], 'In chunks.'],
    ['simulation-distance', 'Simulation distance', 'number', [3, 32], 'How far away crops grow and mobs move, in chunks.'],
    ['spawn-protection', 'Spawn protection', 'number', [0, 256], 'Blocks around spawn that only operators can change. 0 turns it off.'],
    ['allow-flight', 'Allow flying', 'switch', null, "Players who fly with mods or plugins aren't kicked."],
    ['allow-nether', 'Nether', 'switch'],
    ['generate-structures', 'Structures', 'switch', null, 'Villages, temples and other structures in new chunks.'],
    ['spawn-monsters', 'Monsters', 'switch'],
    ['level-seed', 'Seed', 'text', null, 'Only used when a new world is created.'],
    ['level-name', 'World folder', 'text', null, 'Change it to start a new world. The old one stays in its folder.'],
  ]],
  ['Players', [
    ['player-idle-timeout', 'Kick idle players after', 'number', [0, 1440], 'In minutes. 0 never kicks anyone.'],
    ['enable-command-block', 'Command blocks', 'switch'],
  ]],
  ['Network', [
    ['server-port', 'Port', 'number', [1024, 65535], 'Online play sets up its own tunnel for each port.'],
  ]],
];

let settingsState = { serverId: null, values: null, edits: {} };

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const serverIsUp = (id) => ['starting', 'running'].includes(serverState(id));

function setMessage(node, text, kind = '') {
  node.textContent = text;
  node.className = `save-message${kind ? ` ${kind}` : ''}`;
}

async function loadSettings() {
  const server = currentServer();
  settingsState = { serverId: server.id, values: null, edits: {} };
  setMessage($('#settings-message'), '');
  $('#settings-restart').hidden = true;
  try {
    const { values } = await api.serverProperties(server.id);
    if (settingsState.serverId !== server.id) return;
    settingsState.values = values;
  } catch (err) {
    setMessage($('#settings-message'), errorText(err), 'error');
  }
  renderSettings();
}

function renderSettings() {
  const { values, edits } = settingsState;
  $('#settings-empty').hidden = Boolean(values);
  $('#settings-empty').textContent = 'Start the server once: it creates its settings file the first time it runs. Then its settings show up here.';
  $('#settings-form').hidden = !values;
  $('#settings-save').disabled = !Object.keys(edits).length;
  $('#settings-revert').disabled = !Object.keys(edits).length;
  if (!values) return;

  const row = ([key, label, type, options, help]) => {
    const value = key in edits ? edits[key] : values[key];
    const id = `setting-${key}`;
    let control;
    if (type === 'switch') {
      control = el('input', { type: 'checkbox', className: 'switch', id, checked: value === 'true' });
      control.onchange = () => editSetting(key, String(control.checked));
    } else if (type === 'select') {
      control = el('select', { id }, options.map((o) => el('option', { value: o, textContent: capitalize(o) })));
      if (!options.includes(value)) control.append(el('option', { value, textContent: value }));
      control.value = value;
      control.onchange = () => editSetting(key, control.value);
    } else {
      control = el('input', { type: type === 'number' ? 'number' : 'text', id, value, spellcheck: false });
      if (options) Object.assign(control, { min: options[0], max: options[1] });
      control.oninput = () => editSetting(key, control.value, false);
    }
    return el('div', { className: `setting${key in edits ? ' changed' : ''}` }, [
      el('label', { className: 'setting-text', htmlFor: id }, [
        el('span', { className: 'setting-label', textContent: label }),
        help ? el('span', { className: 'setting-help', textContent: help }) : null,
      ]),
      control,
    ]);
  };
  $('#settings-form').replaceChildren(...SETTINGS.map(([group, fields]) => {
    const present = fields.filter(([key]) => key in values);
    if (!present.length) return null;
    return el('section', { className: 'settings-group' }, [el('h3', { textContent: group }), ...present.map(row)]);
  }).filter(Boolean));
}

// redraw: false while typing, so the text field keeps its cursor; the row's changed dot updates on its own.
function editSetting(key, value, redraw = true) {
  if (value === settingsState.values[key]) delete settingsState.edits[key];
  else settingsState.edits[key] = value;
  setMessage($('#settings-message'), '');
  $('#settings-restart').hidden = true;
  if (redraw) {
    renderSettings();
  } else {
    $(`#setting-${CSS.escape(key)}`).closest('.setting').classList.toggle('changed', key in settingsState.edits);
    $('#settings-save').disabled = $('#settings-revert').disabled = !Object.keys(settingsState.edits).length;
  }
}

function validateSettings() {
  for (const [, fields] of SETTINGS) {
    for (const [key, label, type, options] of fields) {
      if (!(key in settingsState.edits) || type !== 'number') continue;
      const n = Number(settingsState.edits[key]);
      if (!Number.isInteger(n) || n < options[0] || n > options[1]) return `${label} must be a whole number from ${options[0]} to ${options[1]}.`;
    }
  }
  return null;
}

$('#settings-save').onclick = async () => {
  const server = currentServer();
  const problem = validateSettings();
  if (problem) return setMessage($('#settings-message'), problem, 'error');
  try {
    settingsState.values = await api.setServerProperties(server.id, settingsState.edits);
    settingsState.edits = {};
    renderSettings();
    savedMessage($('#settings-message'), $('#settings-restart'), server.id);
  } catch (err) {
    setMessage($('#settings-message'), errorText(err), 'error');
  }
};
$('#settings-revert').onclick = () => {
  settingsState.edits = {};
  setMessage($('#settings-message'), '');
  renderSettings();
};

// After saving: a running server only reads its settings when it starts, so offer the restart right there.
function savedMessage(messageNode, restartButton, serverId) {
  const up = serverIsUp(serverId);
  setMessage(messageNode, up ? 'Saved. The server uses the new settings after a restart.' : 'Saved.', 'ok');
  restartButton.hidden = !up;
}

async function restartServer(button, messageNode) {
  const id = state.selectedServer;
  button.disabled = true;
  setMessage(messageNode, 'Restarting…');
  try {
    state.serverLogs[id] = [];
    await api.restartServer(id);
    setMessage(messageNode, 'Restarted with the new settings.', 'ok');
    button.hidden = true;
  } catch (err) {
    setMessage(messageNode, errorText(err), 'error');
  } finally {
    button.disabled = false;
  }
}
$('#settings-restart').onclick = () => restartServer($('#settings-restart'), $('#settings-message'));

// ---------- Server files (config files as text) ----------

let fileState = { serverId: null, files: [], path: null, saved: '', modified: null };
const fileDirty = () => fileState.path !== null && $('#file-text').value !== fileState.saved;

// Unsaved edits in a server's Settings form or open file.
function hasUnsaved() {
  return Boolean((state.serverTab === 'settings' && Object.keys(settingsState.edits).length) || (state.serverTab === 'files' && fileDirty()));
}

function askDiscard(options = {}) {
  return askConfirm({
    title: 'Discard your changes?',
    text: state.serverTab === 'files' ? `Your changes to ${fileState.path} aren't saved yet.` : "Your changes to this server's settings aren't saved yet.",
    confirm: 'Discard changes',
    cancel: 'Keep editing',
    ...options,
  });
}

function dropEdits() {
  settingsState.edits = {};
  if (fileState.path !== null) $('#file-text').value = fileState.saved;
}

// Leaving a server's Settings or Files tab loses unsaved edits. With none, returns true and the caller carries on.
// Otherwise it asks, returns false, and if the edits may go, drops them and runs retry (the same step again).
function confirmDiscard(retry) {
  if (!hasUnsaved()) return true;
  askDiscard().then((discard) => {
    if (!discard) return;
    dropEdits();
    retry();
  });
  return false;
}

async function loadFiles() {
  const server = currentServer();
  const keep = fileState.serverId === server.id ? fileState.path : null;
  fileState = { serverId: server.id, files: [], path: null, saved: '', modified: null };
  try {
    fileState.files = await api.serverFiles(server.id);
  } catch (err) {
    setMessage($('#file-message'), errorText(err), 'error');
  }
  renderFileList();
  const first = fileState.files.find((f) => f.path === keep) || fileState.files[0];
  if (first) await openFile(first.path);
  else showFile(null);
}

function renderFileList() {
  const groups = new Map();
  for (const file of fileState.files) {
    if (!groups.has(file.group)) groups.set(file.group, []);
    groups.get(file.group).push(file);
  }
  $('#file-list').replaceChildren(...[...groups].flatMap(([group, files]) => [
    el('h3', { textContent: group }),
    ...files.map((file) => {
      const name = file.group === 'Server' ? file.path : file.path.split('/').slice(1).join('/');
      const button = el('button', { type: 'button', textContent: name, title: file.path, className: file.path === fileState.path ? 'active' : '' });
      button.onclick = async () => {
        if (file.path === fileState.path) return;
        if (fileDirty() && !(await askDiscard())) return;
        openFile(file.path);
      };
      return button;
    }),
  ]));
  if (!fileState.files.length) $('#file-list').append(el('p', { className: 'hint', textContent: 'No settings files yet. Start the server once to create them.' }));
}

async function openFile(file) {
  setMessage($('#file-message'), '');
  $('#file-restart').hidden = true;
  try {
    const { text, modified } = await api.readServerFile(fileState.serverId, file);
    showFile(text);
    // The textarea turns \r\n into \n, so compare against what it holds and put CRLF back on save.
    Object.assign(fileState, { path: file, saved: $('#file-text').value, modified, crlf: text.includes('\r\n') });
    $('#file-name').textContent = file;
  } catch (err) {
    setMessage($('#file-message'), errorText(err), 'error');
  }
  renderFileList();
}

function showFile(text) {
  $('#file-name').textContent = fileState.path || '';
  $('#file-text').value = text ?? '';
  $('#file-text').disabled = text === null;
  $('#file-save').disabled = true;
  $('#file-reload').disabled = text === null;
}

$('#file-text').oninput = () => {
  $('#file-save').disabled = !fileDirty();
  setMessage($('#file-message'), fileDirty() ? 'Unsaved changes' : '');
  $('#file-restart').hidden = true;
};
// Tab indents instead of leaving the editor (YAML is indentation-based).
$('#file-text').onkeydown = (event) => {
  if (event.key !== 'Tab' || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  document.execCommand('insertText', false, '  ');
};
$('#file-save').onclick = async () => {
  const id = fileState.serverId;
  try {
    const text = $('#file-text').value;
    const { modified } = await api.writeServerFile(id, fileState.path, fileState.crlf ? text.replace(/\n/g, '\r\n') : text, fileState.modified);
    Object.assign(fileState, { saved: text, modified });
    $('#file-save').disabled = true;
    savedMessage($('#file-message'), $('#file-restart'), id);
    if (fileState.path === 'server.properties') settingsState.serverId = null; // the Settings tab reloads it
  } catch (err) {
    setMessage($('#file-message'), errorText(err), 'error');
  }
};
$('#file-reload').onclick = async () => {
  if (fileDirty() && !(await askDiscard({
    title: `Reload ${fileState.path}?`,
    text: 'It opens as it is on disk, and your unsaved changes are lost.',
    confirm: 'Reload',
  }))) return;
  openFile(fileState.path);
};
$('#file-restart').onclick = () => restartServer($('#file-restart'), $('#file-message'));

api.onServerOnline(({ id, ...live }) => {
  serverOnline[id] = live;
  if (state.view === 'server' && id === state.selectedServer) renderOnline();
});

function renderServerLog(forceBottom) {
  const logEl = $('#srv-log');
  const scroller = logEl.parentElement;
  const atBottom = forceBottom || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 20;
  logEl.textContent = (state.serverLogs[state.selectedServer] || []).join('\n');
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

function showServerError(id, err) {
  state.serverStatus[id] = { state: serverState(id) === 'running' ? 'running' : 'error', text: errorText(err) };
  if (id === state.selectedServer) renderServer();
}

// ---------- New instance dialog ----------
// A start page with three choices (custom setup, a Modrinth modpack, an .mrpack file), then the setup page for it.

const NEW_STEPS = {
  home: { title: 'Create instance' },
  custom: { title: 'Custom setup', placeholder: () => 'My instance' },
  modpack: { title: 'Start from a modpack', placeholder: () => packSearch.chosen?.title || 'Name of the modpack' },
  upload: { title: 'Upload a modpack', placeholder: () => newDialog.upload?.title || 'Name of the modpack' },
};
const newDialog = { step: 'home', upload: null, creating: false };
const packSearch = { query: '', offset: 0, total: 0, done: false, request: 0, timer: null, chosen: null };

async function fillVersions() {
  const select = $('#new-version');
  const showSnapshots = $('#new-snapshots').checked;
  state.versions ??= await api.listVersions();
  const versions = state.versions.filter((v) => v.type === 'release' || (showSnapshots && v.type === 'snapshot'));
  select.replaceChildren(...versions.map((v) => el('option', { value: v.id, textContent: v.id })));
}

function openNewDialog() {
  $('#new-name').value = '';
  newDialog.upload = null;
  newDialog.creating = false;
  $('#upload-info').textContent = 'No file chosen yet.';
  $('#upload-info').classList.remove('chosen');
  $('#upload-pick').textContent = 'Choose .mrpack file';
  choosePack(null, null);
  showNewStep('home');
  $('#new-dialog').showModal();
}

function showNewStep(step) {
  newDialog.step = step;
  const home = step === 'home';
  $('#new-title').textContent = NEW_STEPS[step].title;
  $('#new-home').hidden = !home;
  $('#new-setup').hidden = home;
  $('#new-custom').hidden = step !== 'custom';
  $('#new-modpack').hidden = step !== 'modpack';
  $('#new-upload').hidden = step !== 'upload';
  $('#new-cancel').textContent = home ? 'Cancel' : 'Back';
  $('#new-create').hidden = home; // the start page's choices are its buttons
  $('#new-error').textContent = '';
  updateNewCreate();
  if (home) {
    document.querySelector('#new-home .choice').focus();
    return;
  }
  $('#new-name').focus(); // type a name straight away
  if (step === 'custom') {
    fillVersions().catch((err) => {
      $('#new-error').textContent = `Couldn't load the version list. Check your internet connection. (${errorText(err)})`;
    });
  }
  if (step === 'modpack' && !packSearch.done) runPackSearch(false); // show popular packs straight away
}

// Create needs whatever the page asks for; an empty name means the pack's own name.
function updateNewCreate() {
  const { step } = newDialog;
  const ready = step === 'custom'
    || (step === 'modpack' && Boolean(packSearch.chosen) && !$('#pack-version').disabled)
    || (step === 'upload' && Boolean(newDialog.upload));
  $('#new-create').disabled = newDialog.creating || !ready;
  if (step !== 'home') $('#new-name').placeholder = NEW_STEPS[step].placeholder();
}

// Picking a pack lists the Minecraft versions it can be played on, newest first.
async function choosePack(hit, row) {
  packSearch.chosen = hit;
  for (const li of $('#pack-results').children) li.setAttribute('aria-selected', String(li === row));
  const select = $('#pack-version');
  select.disabled = true;
  select.replaceChildren(el('option', { textContent: hit ? 'Loading versions…' : 'Pick a modpack first' }));
  updateNewCreate();
  if (!hit) return;
  let versions;
  try {
    versions = await api.modpackGameVersions(hit.projectId);
  } catch (err) {
    if (packSearch.chosen !== hit) return;
    select.replaceChildren(el('option', { textContent: 'No versions found' }));
    $('#new-error').textContent = errorText(err);
    return;
  }
  if (packSearch.chosen !== hit) return; // another pack was picked meanwhile
  $('#new-error').textContent = '';
  select.replaceChildren(...versions.map((v) => el('option', {
    value: v.versionId,
    textContent: `${v.gameVersion}  ·  ${hit.title} ${v.versionNumber}${v.type === 'release' ? '' : ` (${v.type})`}`,
  })));
  // Start on the newest full release; alphas and betas stay one click away.
  select.selectedIndex = Math.max(0, versions.findIndex((v) => v.type === 'release'));
  select.disabled = false;
  updateNewCreate();
}

async function runPackSearch(append) {
  const results = $('#pack-results');
  const s = packSearch;
  if (!append) {
    s.query = $('#pack-query').value.trim();
    s.offset = 0;
  }
  const request = ++s.request;
  if (!append && !s.done) results.replaceChildren(emptyRow(s.query ? `Searching for "${s.query}"…` : 'Loading popular modpacks…'));
  let page;
  try {
    page = await api.searchModpacks(s.query, s.offset);
  } catch (err) {
    if (request === s.request) results.replaceChildren(emptyRow(`Modrinth couldn't be reached. Check your internet connection. (${errorText(err)})`));
    return;
  }
  if (request !== s.request) return;
  const rows = page.hits.map(packRow);
  if (append) results.append(...rows);
  else {
    results.replaceChildren(...(rows.length
      ? rows
      : [emptyRow(s.query ? `Nothing found for "${s.query}". Try a different word.` : 'Nothing found.')]));
    $('#pack-scroll').scrollTop = 0;
  }
  s.offset += page.hits.length;
  s.total = page.total;
  s.done = true;
  $('#pack-more').hidden = s.offset >= s.total;
}

// A modpack row: click (or Enter/Space) picks it; the title still opens its Modrinth page.
function packRow(hit) {
  const row = projectRow(hit, 'modpack', null);
  row.tabIndex = 0;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(packSearch.chosen?.projectId === hit.projectId));
  row.onclick = (event) => {
    if (!event.target.closest('a')) choosePack(hit, row);
  };
  row.onkeydown = (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    choosePack(hit, row);
  };
  return row;
}

async function pickModpackFile() {
  $('#new-error').textContent = '';
  try {
    const info = await api.pickModpackFile();
    if (!info) return; // cancelled
    newDialog.upload = info;
    const version = info.versionNumber ? ` ${info.versionNumber}` : '';
    $('#upload-info').textContent = `${info.title}${version}\nMinecraft ${info.gameVersion} with Fabric, ${info.mods} mods`;
    $('#upload-info').classList.add('chosen');
    $('#upload-pick').textContent = 'Choose another file';
  } catch (err) {
    $('#new-error').textContent = errorText(err);
  } finally {
    updateNewCreate();
  }
}

// Makes the instance at once and switches to it; a modpack's files then download in the background.
async function createInstance(event) {
  event.preventDefault();
  const { step } = newDialog;
  if (step === 'modpack' && document.activeElement === $('#pack-query')) { // Enter in the search box searches
    clearTimeout(packSearch.timer);
    runPackSearch(false);
    return;
  }
  if ($('#new-create').disabled || $('#new-create').hidden) return;
  const name = $('#new-name').value;
  newDialog.creating = true;
  updateNewCreate();
  $('#new-error').textContent = '';
  try {
    let created;
    if (step === 'custom') {
      created = await api.createInstance({ name, gameVersion: $('#new-version').value, loader: $('#new-loader').value });
    } else {
      created = step === 'modpack'
        ? await api.installModpack(packSearch.chosen.projectId, name, $('#pack-version').value)
        : await api.installModpackFile(name);
      state.tab = 'mods'; // watch the mods arrive
    }
    $('#new-dialog').close();
    await refreshInstances(created.id);
  } catch (err) {
    $('#new-error').textContent = errorText(err);
  } finally {
    newDialog.creating = false;
    updateNewCreate();
  }
}

// ---------- Icon picker ----------
// Every Minecraft item (core/icons.js); picking one sets the icon of an instance or server.

const iconPicker = { kind: null, id: null, icons: null };

async function openIconPicker(kind, thing) {
  Object.assign(iconPicker, { kind, id: thing.id });
  $('#icon-title').textContent = `Icon for ${thing.name}`;
  $('#icon-search').value = '';
  $('#icon-error').textContent = '';
  $('#icon-dialog').showModal();
  $('#icon-search').focus();
  if (!iconPicker.icons) {
    $('#icon-grid').replaceChildren(el('p', { className: 'hint', textContent: 'Loading items…' }));
    try {
      iconPicker.icons = await api.listIcons();
    } catch (err) {
      $('#icon-error').textContent = errorText(err);
      return;
    }
  }
  renderIconGrid(thing.icon);
}

function renderIconGrid(selected) {
  const query = $('#icon-search').value.trim().toLowerCase();
  const icons = iconPicker.icons || [];
  if (!icons.length) {
    $('#icon-grid').replaceChildren(el('p', {
      className: 'hint',
      textContent: 'Item icons come from the game itself, so they show up once a Minecraft version has been downloaded. Play any instance once.',
    }));
    $('#icon-random').disabled = true;
    return;
  }
  $('#icon-random').disabled = false;
  const shown = icons.filter((i) => !query || i.label.toLowerCase().includes(query) || i.name.includes(query));
  if (!shown.length) {
    $('#icon-grid').replaceChildren(el('p', { className: 'hint', textContent: `No item called "${query}".` }));
    return;
  }
  // The list arrives grouped by category (core/icons.js): a heading starts each group.
  const nodes = [];
  for (const i of shown) {
    if (i.category !== nodes.category) {
      nodes.push(el('h3', { className: 'icon-heading', textContent: i.category }));
      nodes.category = i.category;
    }
    const button = el('button', { type: 'button', className: 'icon-choice', title: i.label, ariaLabel: i.label }, [
      el('img', { src: i.url, alt: '' }),
    ]);
    if (i.name === selected) button.classList.add('selected');
    button.onclick = () => setIcon(i.name);
    nodes.push(button);
  }
  $('#icon-grid').replaceChildren(...nodes);
}

async function setIcon(name) {
  try {
    if (iconPicker.kind === 'instance') {
      await api.setInstanceIcon(iconPicker.id, name);
      await refreshInstances();
    } else {
      await api.setServerIcon(iconPicker.id, name);
      await refreshServers();
    }
    $('#icon-dialog').close();
  } catch (err) {
    $('#icon-error').textContent = errorText(err);
  }
}

// ---------- Settings ----------

// The Settings page (gear in the sidebar) and each instance's Settings tab.
let appInfo = { version: '', packaged: false, totalMemoryMb: 0 };
let appSettings = { memoryMb: 4096, javaPath: '', theme: 'hojicha', borderless: false };
let updateMessage = ''; // the answer to the last "Check for updates"

function openSettings() {
  if (state.view === 'server' && !confirmDiscard(openSettings)) return;
  state.view = 'settings';
  renderSidebar();
  renderMain();
}

function showAppMessage(text, isError = false) {
  const message = $('#app-settings-message');
  message.textContent = text;
  message.className = `save-message${isError ? ' error' : ''}`;
}

const gb = (mb) => `${Number((mb / 1024).toFixed(1))} GB`;

// Memory choices in whole steps up to what the PC has, plus the saved value if it's an odd one.
function memoryOptions(select, currentMb, defaultLabel) {
  const steps = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32].map((n) => n * 1024)
    .filter((mb) => !appInfo.totalMemoryMb || mb <= appInfo.totalMemoryMb);
  if (currentMb && !steps.includes(currentMb)) steps.push(currentMb);
  steps.sort((a, b) => a - b);
  select.replaceChildren(
    ...(defaultLabel ? [el('option', { value: '', textContent: defaultLabel })] : []),
    ...steps.map((mb) => el('option', { value: String(mb), textContent: gb(mb) })),
  );
  select.value = currentMb ? String(currentMb) : '';
}

function renderAppSettings() {
  memoryOptions($('#memory'), appSettings.memoryMb);
  $('#memory-help').textContent = '4 GB is enough for most games. Big modpacks may need more.';

  const custom = Boolean(appSettings.javaPath);
  $('#java-help').textContent = custom
    ? `Using ${appSettings.javaPath}, for every game and server.`
    : 'Automatic: Hojicha downloads the Java version each Minecraft version needs.';
  $('#java-auto').hidden = !custom;
  $('#java-pick').textContent = custom ? 'Choose another' : 'Choose java.exe';
  $('#borderless').checked = appSettings.borderless;

  $('#about-version').textContent = `Hojicha ${appInfo.version}`;
  renderUpdate();
}

async function saveAppSettings(patch) {
  showAppMessage('');
  try {
    appSettings = await api.saveSettings(patch);
  } catch (err) {
    showAppMessage(errorText(err), true);
  }
  renderAppSettings();
}

// Hojicha (dark) or matcha (light), in the title bar. Switches at once; main.js saves it and recolours the window
// buttons.
function showTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-checked', String(button.dataset.themeChoice === theme));
  }
}

async function chooseTheme(theme) {
  const before = document.documentElement.dataset.theme;
  if (theme === before) return;
  showTheme(theme);
  try {
    appSettings = await api.saveSettings({ theme });
  } catch {
    showTheme(before);
  }
}

// ---------- The ⋯ menus (instance and server) ----------

// What you do to an instance or server itself (rename, icon, folder, delete), kept out of the way of playing it.
// Both menus behave the same: they open under their ⋯ button, and close on a click outside, on Escape, and after
// any item except a choice in a select (the instance's memory).
const MENUS = [
  { button: '#inst-more', menu: '#inst-menu', fill: () => memoryOptions($('#inst-memory'), current().memoryMb || null, `Default (${gb(appSettings.memoryMb)})`) },
  { button: '#srv-more', menu: '#srv-menu', fill: () => {} },
  { button: '#srv-join', menu: '#join-menu', fill: () => fillJoinMenu() }, // opened by Start and join's own click
  { button: '#cape-change', menu: '#cape-menu', fill: () => fillCapeMenu() }, // in the skin window
  // New folders go in the shared folder shown: not in an instance's own, nor in the filter's results.
  { button: '#schem-more', menu: '#schem-more-menu', fill: () => { $('#schem-new-folder').disabled = !isSharedFolder(schem.at) || Boolean(schem.filter.trim()); } },
];

function openMenu({ button, menu, fill }) {
  closeMenus();
  fill();
  $(menu).hidden = false;
  $(button).setAttribute('aria-expanded', 'true');
  $(`${menu} [role^="menuitem"]:not(:disabled)`)?.focus();
}

function closeMenu({ button, menu }, returnFocus = false) {
  if ($(menu).hidden) return;
  $(menu).hidden = true;
  $(button).setAttribute('aria-expanded', 'false');
  if (returnFocus) $(button).focus();
}

function closeMenus() {
  for (const entry of MENUS) closeMenu(entry);
}

const closeInstanceMenu = () => closeMenu(MENUS[0]);

async function updateInstance(patch) {
  const inst = current();
  try {
    Object.assign(inst, await api.updateInstance(inst.id, patch));
    $('#inst-name').textContent = inst.name;
    renderSidebar();
  } catch (err) {
    if (!isBusy(inst.id)) {
      state.status[inst.id] = { state: 'error', text: errorText(err) };
      renderStatus();
    }
  }
}

// Renaming happens on the name itself: it turns into a text box. Enter or clicking away saves, Escape cancels.
function startRename() {
  closeInstanceMenu();
  const input = $('#inst-rename');
  input.value = current().name;
  $('#inst-name').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

async function finishRename(save) {
  const input = $('#inst-rename');
  if (input.hidden) return;
  input.hidden = true;
  $('#inst-name').hidden = false;
  const name = input.value.trim();
  if (save && name && name !== current().name) await updateInstance({ name });
}

// ---------- Accounts ----------

let accountState = { selected: null, canUseOffline: false, accounts: [] };

// Shows the face (plus hat layer) from a Minecraft skin, or the account's initial.
function setAvatar(node, account, size) {
  node.style.width = node.style.height = `${size}px`;
  if (account?.skinUrl) {
    const scale = size / 8;
    const sheet = `${64 * scale}px auto`; // auto keeps old 64x32 skins from stretching
    node.textContent = '';
    node.style.background = `url("${account.skinUrl}") ${-40 * scale}px ${-8 * scale}px / ${sheet} no-repeat, `
      + `url("${account.skinUrl}") ${-8 * scale}px ${-8 * scale}px / ${sheet} no-repeat`;
  } else {
    node.style.background = '';
    node.textContent = account ? account.name.charAt(0).toUpperCase() : '+';
  }
}

function kindLabel(account) {
  if (account.type === 'microsoft') return 'Microsoft account';
  return account.locked ? 'Offline, locked' : 'Offline account';
}

function renderAccounts(next) {
  if (next) accountState = next;
  const { accounts, selected, canUseOffline } = accountState;
  const active = accounts.find((a) => a.id === selected) || null;

  const chip = $('#account-chip');
  chip.classList.toggle('needs-account', !active);
  setAvatar($('#account-avatar'), active, 32);
  $('#account-face').hidden = active?.type !== 'microsoft';
  $('#account-face').ariaLabel = active ? `Change ${active.name}'s skin` : 'Change skin';
  $('#account-name').textContent = active ? active.name : 'Add an account';
  $('#account-kind').textContent = active ? kindLabel(active) : 'Needed to play';

  $('#account-list').replaceChildren(...(accounts.length
    ? accounts.map((a) => {
      // Only Microsoft accounts have a skin at Mojang to change.
      const avatar = a.type === 'microsoft'
        ? el('button', { type: 'button', className: 'avatar skin-button', title: 'Change skin', ariaLabel: `Change ${a.name}'s skin` })
        : el('span', { className: 'avatar' });
      if (a.type === 'microsoft') avatar.onclick = () => openSkins(a);
      setAvatar(avatar, a, 30);
      let use;
      if (a.id === selected) {
        use = el('span', { className: 'selected-note', textContent: 'In use' });
      } else {
        use = el('button', { textContent: 'Use', type: 'button' });
        use.onclick = async () => renderAccounts(await api.selectAccount(a.id));
      }
      const remove = el('button', { className: 'quiet danger', textContent: 'Remove', type: 'button' });
      remove.onclick = async () => renderAccounts(await api.removeAccount(a.id));
      return el('li', {}, [
        avatar,
        el('div', { className: 'info' }, [
          el('div', { className: 'title', textContent: a.name }),
          el('div', { className: 'kind', textContent: kindLabel(a) }),
        ]),
        use,
        remove,
      ]);
    })
    : [emptyRow('No accounts yet. Add your Microsoft account to play.')]));

  $('#offline-name').disabled = !canUseOffline;
  $('#add-offline').disabled = !canUseOffline;
  $('#offline-hint').textContent = canUseOffline
    ? 'Offline accounts are for local and offline-mode servers. They work while your Microsoft account is signed in.'
    : 'Offline accounts unlock after you add a Microsoft account that owns Minecraft: Java Edition.';
}

// ---------- Skins ----------

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
function fillCapeMenu() {
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

async function openSkins(account) {
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

async function refreshAccounts() {
  renderAccounts(await api.listAccounts());
}

let loginActive = false;
let loginAttempt = 0; // a cancelled attempt that finishes late must not touch a newer one

async function startMicrosoftLogin() {
  const attempt = ++loginAttempt;
  const errorEl = $('#accounts-error');
  errorEl.textContent = '';
  $('#add-microsoft').disabled = true;
  let code;
  try {
    code = await api.loginStart();
  } catch (err) {
    errorEl.textContent = errorText(err);
    $('#add-microsoft').disabled = false;
    return;
  }
  if (attempt !== loginAttempt) return;
  loginActive = true;
  $('#login-url').textContent = code.verificationUri.replace(/^https:\/\//, '');
  $('#login-code').textContent = code.userCode;
  $('#login-copy-open').onclick = () => api.copyCodeAndOpen(code.userCode, code.verificationUri);
  $('#login-panel').hidden = false;
  try {
    const result = await api.loginFinish();
    if (attempt === loginAttempt) renderAccounts(result);
  } catch (err) {
    if (attempt === loginAttempt) errorEl.textContent = errorText(err);
  } finally {
    if (attempt === loginAttempt) {
      loginActive = false;
      $('#login-panel').hidden = true;
      $('#add-microsoft').disabled = false;
    }
  }
}

function cancelMicrosoftLogin() {
  loginAttempt++;
  loginActive = false;
  api.loginCancel();
  $('#login-panel').hidden = true;
  $('#add-microsoft').disabled = false;
}

// ---------- Schematics ----------

// The Schematics view (the row above Instances): every schematic Litematica, WorldEdit and Axiom saved, shared ones
// first, then those of instances that keep their own (core/schematics.js). Each tile is a picture of it in 3D,
// drawn once and kept (renderer/schematics.js draws it, with the block models core/blocks.js unpacks from a
// downloaded game). Clicking one opens it big, to turn and zoom. The circle on each picks it, to put several in a
// group (a folder) or delete them. Schematic files dropped on the launcher are added.
// Folders are shown one at a time, as in File Explorer: a folder is a tile (a stack, with four of what's in it), and
// clicking it goes in, with the way back up over the tiles. Instances that keep their own schematics are folders too.
// Typing in the filter looks in every folder at once.
const SCHEM_TYPES = { litematica: 'Litematica', worldedit: 'WorldEdit', axiom: 'Axiom' };
// Each format's mark, in one colour, for the corner of its tiles.
const SCHEM_ICONS = {
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
const schem = {
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
};

function openSchematics() {
  if (state.view === 'server' && !confirmDiscard(openSchematics)) return;
  state.view = 'schematics';
  renderSidebar();
  renderMain();
  loadSchematics();
}

async function loadSchematics() {
  showSchemNote('');
  try {
    takeSchematicList(await api.listSchematics());
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
function takeSchematicList(list) {
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

function showSchemNote(text) {
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

function blockResources() {
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

const schemSize = (size) => size.join(' × ');
const schemBlocks = (n) => `${n.toLocaleString()} ${n === 1 ? 'block' : 'blocks'}`;
// The game version it was saved in, said as such ("Minecraft 1.20.1"; "Minecraft 1.21.4 snapshot").
const schemVersion = (version) => (version ? `Minecraft ${version}` : '');
// When it was made: the date the file records, else the file's own date, which says so (a file copied from elsewhere
// may be younger than what's in it). With what it means, for a tooltip.
function schemCreated(created) {
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
const isSharedFolder = (keys) => !keys[0]?.startsWith('instance:');

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

function openSchematicFolder(keys) {
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
const schematicsShown = () => [...document.querySelectorAll('#schem-list .schem-entry')].map((tile) => tile.dataset.seen);

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

function closeSchematicMenu() {
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
function schematicRenamed(item, result) {
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

function renderSchematics() {
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
async function loadSchematic(path, cells, onProgress, budget = false) {
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

// ---- The big view ----

const schemOpen = { item: null, view: null, frame: 0 };

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
async function openSchematic(item, { full = false } = {}) {
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

async function deleteSchematic() {
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

// Schematic files and folders of them dropped anywhere on the launcher go to the shared schematics folder (main.js
// puts them there, a folder as a group): into the folder open in the Schematics view when that's showing, else at
// the top; and the Schematics view opens with them. While a popup is open, it handles drops itself (the skin
// window takes skins) or they're ignored. dragenter and dragleave fire for every element passed over, so they're
// counted to know when the files have really left.
const SCHEMATIC_FILE = /\.(litematic|schem|schematic|bp)$/i;

// What was dropped, as [{ name, file }]: files by their name, and everything inside a dropped folder by its path
// ("dragon_tree/dragon_tree_1.bp"), so the folder comes along as a group. entries: from the drop event's items.
async function droppedFiles(entries) {
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

async function importSchematics(dropped) {
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

{
  let depth = 0;
  const draggingFiles = (event) => event.dataTransfer?.types.includes('Files') && !document.querySelector('dialog[open]');
  const end = () => {
    depth = 0;
    document.body.classList.remove('dropping-files');
  };
  window.addEventListener('dragenter', (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    depth++;
    document.body.classList.add('dropping-files');
  });
  window.addEventListener('dragover', (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!draggingFiles(event)) return;
    if (--depth <= 0) end();
  });
  window.addEventListener('drop', (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    end();
    // Folders can only be looked into while the drop is being handled: take hold of them now.
    const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    droppedFiles(entries).then((dropped) => {
      if (dropped.length) importSchematics(dropped);
    }, (err) => showSchemNote(errorText(err)));
  });
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

// ---------- Wiring ----------

// A popup's backdrop dims the page, but not the Windows title bar buttons drawn over it: tell main.js when one is
// open so it dims those too.
{
  const dialogs = [...document.querySelectorAll('dialog')];
  let open = false;
  const watcher = new MutationObserver(() => {
    const now = dialogs.some((d) => d.open);
    if (now !== open) api.setPopupOpen((open = now));
  });
  for (const dialog of dialogs) watcher.observe(dialog, { attributes: true, attributeFilter: ['open'] });
}

// A click outside a popup (on its backdrop) closes it, as Escape does: through its cancel event, so a popup that
// refuses Escape refuses this too. The press must start outside as well, so a drag that ends there (turning the
// skin, selecting text) doesn't count. With a menu open in the popup, that click only closes the menu.
for (const dialog of document.querySelectorAll('dialog')) {
  const outside = (event) => {
    if (event.target !== dialog) return false; // the backdrop counts as the dialog itself; its padding does too
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (event) => {
    pressedOutside = outside(event) && !dialog.querySelector('.menu:not([hidden])');
  });
  dialog.addEventListener('click', (event) => {
    if (!pressedOutside || !outside(event)) return;
    pressedOutside = false;
    if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
  });
}

api.onStatus(({ id, state: s, text, progress }) => {
  const previous = state.status[id];
  // Starting and closing the game update last played and play time: fetch them.
  if ((s === 'running') !== (previous?.state === 'running')) {
    api.listInstances().then((list) => {
      state.instances = list;
      if (state.view === 'instance' && id === state.selected) renderMeta();
    });
  }
  state.status[id] = { state: s, text, progress: progress ?? previous?.progress ?? null };
  renderSidebar();
  if (id === state.selected) {
    renderStatus();
    // Refresh the mods list after an install finishes (dependencies may have been added).
    if (s === 'idle' && state.tab === 'mods') loadMods();
  }
  if (state.view === 'server' && currentServer()) renderServer(); // join button depends on instance state
});

api.onUpdate((next) => {
  update = next;
  renderUpdate();
});

$('#update-install').onclick = () => api.installUpdate().catch(() => renderUpdate());

api.onServerStatus(({ id, state: s, text }) => {
  state.serverStatus[id] = { state: s, text };
  renderSidebar();
  if (state.view === 'server' && id === state.selectedServer) renderServer();
});

api.onServerLog(({ id, line }) => {
  const lines = (state.serverLogs[id] ??= []);
  lines.push(line.replace(/\x1b\[[0-9;]*m/g, '')); // strip console colour codes
  if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
  if (state.view === 'server' && id === state.selectedServer) renderServerLog(false);
});

api.onLog(({ id, line }) => {
  const lines = (state.logs[id] ??= []);
  lines.push(line);
  if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
  if (id === state.selected && state.tab === 'log') {
    const logEl = $('#log');
    const scroller = logEl.parentElement;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 20;
    logEl.textContent = lines.join('\n');
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }
});

for (const button of document.querySelectorAll('#instance-view .tabs button')) {
  button.onclick = () => showTab(button.dataset.tab);
}

$('#play').onclick = async () => {
  const inst = current();
  state.logs[inst.id] = [];
  state.status[inst.id] = { state: 'installing', text: 'Getting ready', progress: 0 };
  renderStatus();
  try {
    await api.launch(inst.id);
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: errorText(err) };
    renderStatus();
  }
};

$('#open-folder').onclick = () => api.openFolder(state.selected);

$('#delete-instance').onclick = async () => {
  const inst = current();
  const remove = await askConfirm({
    title: `Delete ${inst.name}?`,
    text: "Its mods, and any worlds or packs it doesn't share with other instances, are deleted. This can't be undone.",
    note: 'Shared worlds, resource packs and shaders stay for the other instances.',
    confirm: 'Delete instance',
    cancel: 'Keep it',
  });
  if (!remove) return;
  try {
    await api.deleteInstance(inst.id);
    state.selected = null;
    await refreshInstances();
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: errorText(err) };
    await refreshInstances(); // a half-finished delete may have removed the instance already
  }
};

// The Mods and Browse lists fade under their bar only once scrolled, so the first row stays crisp at the top.
for (const scroller of document.querySelectorAll('.tab-scroll')) {
  scroller.addEventListener('scroll', () => scroller.classList.toggle('scrolled', scroller.scrollTop > 0), { passive: true });
}

$('#mod-filter').oninput = () => {
  state.mods.filter = $('#mod-filter').value;
  renderMods();
};

$('#mods-update-all').onclick = () => {
  const inst = current();
  const updates = state.modUpdates[inst.id]?.updates || {};
  updateMods(inst, state.mods.content.mod.filter((m) => updates[m.file]));
};

for (const button of document.querySelectorAll('#content-kinds button')) {
  button.onclick = () => {
    state.mods.view = button.dataset.kind;
    renderMods();
  };
};

$('#search-form').onsubmit = (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  runSearch(false);
};
// Search as you type, once typing pauses.
$('#search-query').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(false), 350);
};
$('#search-type').onchange = () => runSearch(false);
$('#load-more').onclick = () => runSearch(true);

$('#new-instance').onclick = openNewDialog;
$('#empty-new-instance').onclick = openNewDialog;
$('#new-snapshots').onchange = fillVersions;
$('#new-cancel').onclick = () => (newDialog.step === 'home' ? $('#new-dialog').close() : showNewStep('home'));
$('#new-form').onsubmit = createInstance;
for (const choice of document.querySelectorAll('#new-home .choice')) choice.onclick = () => showNewStep(choice.dataset.step);
$('#upload-pick').onclick = pickModpackFile;
$('#icon-search').oninput = () => renderIconGrid();
$('#icon-close').onclick = () => $('#icon-dialog').close();
$('#icon-random').onclick = () => {
  const icons = iconPicker.icons || [];
  if (icons.length) setIcon(icons[Math.floor(Math.random() * icons.length)].name);
};
// Search as you type, once typing pauses.
$('#pack-query').oninput = () => {
  clearTimeout(packSearch.timer);
  packSearch.timer = setTimeout(() => runPackSearch(false), 350);
};
$('#pack-more').onclick = () => runPackSearch(true);

$('#open-settings').onclick = openSettings;
for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.onclick = () => chooseTheme(button.dataset.themeChoice);
}
showTheme(document.documentElement.dataset.theme); // set by theme.js; marks the right button straight away
$('#memory').onchange = () => saveAppSettings({ memoryMb: Number($('#memory').value) });
$('#java-auto').onclick = () => saveAppSettings({ javaPath: '' });
$('#borderless').onchange = () => saveAppSettings({ borderless: $('#borderless').checked });
$('#java-pick').onclick = async () => {
  showAppMessage('');
  try {
    appSettings = (await api.pickJava()) || appSettings;
  } catch (err) {
    showAppMessage(errorText(err), true);
  }
  renderAppSettings();
};
$('#update-check').onclick = async () => {
  const button = $('#update-check');
  button.disabled = true;
  button.textContent = 'Checking';
  try {
    update = await api.checkForUpdate();
    updateMessage = update.state === 'none' ? `You have the newest version (checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).` : '';
  } catch {
    updateMessage = "Couldn't reach GitHub to check. Try again later.";
  }
  button.textContent = 'Check for updates';
  renderUpdate();
};
$('#update-restart').onclick = () => $('#update-install').click();
$('#open-launcher-folder').onclick = () => api.openLauncherFolder();
$('#open-github').onclick = () => api.openExternal('https://github.com/Qu1nten/hojicha-launcher');
$('#menu-rename').onclick = startRename;
$('#inst-name').ondblclick = startRename;
$('#menu-icon').onclick = () => {
  closeInstanceMenu();
  openIconPicker('instance', current());
};
$('#inst-memory').onchange = () => updateInstance({ memoryMb: $('#inst-memory').value ? Number($('#inst-memory').value) : null });
$('#inst-rename').onkeydown = (event) => {
  if (event.key === 'Enter') finishRename(true);
  if (event.key === 'Escape') finishRename(false);
};
$('#inst-rename').onblur = () => finishRename(true);
$('#srv-menu-icon').onclick = () => openIconPicker('server', currentServer());

for (const entry of MENUS) {
  const menu = $(entry.menu);
  $(entry.button).onclick = () => (menu.hidden ? openMenu(entry) : closeMenu(entry));
  menu.addEventListener('click', (event) => {
    if (event.target.closest('[role^="menuitem"]')) closeMenu(entry);
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled), select')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault(); // in a dialog (the cape menu), Escape closes only the menu, not the dialog too
      closeMenu(entry, true);
    }
    if (event.target.tagName === 'SELECT') return; // arrow keys pick the memory there
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
}
document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.more-wrap')) closeMenus();
});

$('#versions-close').onclick = () => $('#versions-dialog').close();

$('#account-chip').onclick = () => {
  $('#accounts-error').textContent = '';
  $('#accounts-dialog').showModal();
};
$('#account-face').onclick = () => {
  const active = accountState.accounts.find((a) => a.id === accountState.selected);
  if (active) openSkins(active);
};
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
$('#schem-dialog').addEventListener('close', () => {
  schemOpen.item = null;
  schemOpen.view?.clear(); // stops building, and lets go of the blocks
  if (state.view === 'schematics') remember(); // back opens it again
});
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
$('#accounts-close').onclick = () => {
  if (loginActive) cancelMicrosoftLogin();
  $('#accounts-dialog').close();
};
$('#accounts-dialog').addEventListener('close', () => {
  if (loginActive) cancelMicrosoftLogin();
});
$('#add-microsoft').onclick = startMicrosoftLogin;
$('#login-cancel').onclick = cancelMicrosoftLogin;
$('#offline-form').onsubmit = async (event) => {
  event.preventDefault();
  $('#accounts-error').textContent = '';
  try {
    renderAccounts(await api.addOfflineAccount($('#offline-name').value.trim()));
    $('#offline-name').value = '';
  } catch (err) {
    $('#accounts-error').textContent = errorText(err);
  }
};

// ---------- New server ----------

const serverVersions = {}; // type -> versions, newest first
const serverType = () => document.querySelector('input[name="server-type"]:checked').value;

// Lists the chosen software's versions, keeping the picked version when it's still there; otherwise the selected
// instance's version (so Start and join works straight away), otherwise the newest.
async function fillServerVersions() {
  const select = $('#server-version');
  const type = serverType();
  const keep = select.value || current()?.gameVersion;
  $('#server-error').textContent = '';
  select.disabled = true;
  try {
    serverVersions[type] ??= await api.listServerVersions(type);
  } catch (err) {
    $('#server-error').textContent = `Couldn't load the version list. Check your internet connection. (${errorText(err)})`;
    return;
  } finally {
    select.disabled = false;
  }
  if (type !== serverType()) return; // switched again while loading
  const versions = serverVersions[type];
  select.replaceChildren(...versions.map((v) => el('option', { value: v, textContent: v })));
  select.value = versions.includes(keep) ? keep : versions[0];
}

// New server opens on its start page (create one, or add a folder you have), like New instance.
let serverStep = 'home';

function openServerDialog() {
  $('#server-name').value = '';
  $('#server-eula').checked = false;
  $('#server-create').disabled = false;
  $('#server-create').textContent = 'Create server';
  $('#server-version').value = '';
  showServerStep('home');
  $('#server-dialog').showModal();
  fillServerVersions(); // ready by the time the setup page opens
}

function showServerStep(step) {
  serverStep = step;
  const home = step === 'home';
  $('#server-home').hidden = !home;
  $('#server-setup').hidden = home;
  $('#server-cancel').textContent = home ? 'Cancel' : 'Back';
  $('#server-create').hidden = home; // the start page's choices are its buttons
  $('#server-error').textContent = '';
  if (home) $('#server-choose-create').focus();
  else $('#server-name').focus(); // type a name straight away
}

async function createServer(event) {
  event.preventDefault();
  if (serverStep !== 'create') return;
  const version = $('#server-version').value;
  if (!version) return;
  if (!$('#server-eula').checked) {
    $('#server-error').textContent = 'A Minecraft server can only run once you agree to the EULA.';
    return;
  }
  const create = $('#server-create');
  create.disabled = true;
  create.textContent = 'Downloading…';
  $('#server-error').textContent = '';
  try {
    const server = await api.createServer({ name: $('#server-name').value, type: serverType(), version, eula: true });
    $('#server-dialog').close();
    await refreshServers(server.id);
  } catch (err) {
    $('#server-error').textContent = errorText(err);
    create.disabled = false;
    create.textContent = 'Create server';
  }
}

$('#new-server').onclick = openServerDialog;
$('#server-cancel').onclick = () => (serverStep === 'home' ? $('#server-dialog').close() : showServerStep('home'));
$('#server-choose-create').onclick = () => showServerStep('create');
$('#server-form').onsubmit = createServer;
$('#server-eula').onchange = () => { $('#server-error').textContent = ''; };
$('#eula-link').onclick = (event) => {
  event.preventDefault();
  api.openExternal('https://aka.ms/MinecraftEULA');
};
for (const radio of document.querySelectorAll('input[name="server-type"]')) radio.onchange = fillServerVersions;

// New server's second choice: use a server folder that already exists instead of making one. It goes straight
// to the folder picker; cancelling it leaves the start page open.
$('#add-server').onclick = async () => {
  $('#server-error').textContent = '';
  try {
    const server = await api.addServer();
    if (!server) return; // folder picker cancelled
    $('#server-dialog').close();
    await refreshServers(server.id);
  } catch (err) {
    $('#server-error').textContent = errorText(err);
  }
};

$('#srv-open-folder').onclick = () => api.openServerFolder(state.selectedServer);

$('#srv-remove').onclick = async () => {
  const server = currentServer();
  const remove = await askConfirm({
    title: `Remove ${server.name} from Hojicha?`,
    text: 'It leaves the list. The server folder stays where it is, with its worlds, so you can add it again later.',
    confirm: 'Remove from list',
    cancel: 'Keep it',
  });
  if (!remove) return;
  try {
    await api.removeServer(server.id);
    await refreshServers();
  } catch (err) {
    showServerError(server.id, err);
  }
};

$('#srv-toggle').onclick = async () => {
  const id = state.selectedServer;
  try {
    if (serverState(id) === 'running') await api.stopServer(id);
    else {
      state.serverLogs[id] = [];
      await api.startServer(id);
    }
  } catch (err) {
    showServerError(id, err);
  }
};

// Only instances on the server's own Minecraft version can join it.
function joinable(server) {
  return state.instances.filter((i) => i.gameVersion === server.mcVersion);
}

// Starts the server if needed and launches the instance straight into it.
async function joinWith(instanceId) {
  const id = state.selectedServer;
  if (serverState(id) !== 'running') state.serverLogs[id] = [];
  state.logs[instanceId] = [];
  try {
    await api.joinServer(id, instanceId);
  } catch (err) {
    showServerError(id, err);
  }
}

// The join menu: each instance that can join, with its icon and version; one that's already playing can't.
function fillJoinMenu() {
  const menu = $('#join-menu');
  menu.replaceChildren(
    el('div', { className: 'menu-label', textContent: 'Join with', ariaHidden: 'true' }),
    ...joinable(currentServer()).map((inst) => {
      const playing = isBusy(inst.id);
      const item = el('button', { type: 'button', role: 'menuitem', disabled: playing }, [
        inst.iconUrl ? el('img', { className: 'join-icon', src: inst.iconUrl, alt: '' }) : icon('block'),
        el('span', { className: 'join-text' }, [
          el('span', { textContent: inst.name }),
          el('span', { className: 'join-sub', textContent: playing ? 'Playing' : loaderLabel(inst) }),
        ]),
      ]);
      item.onclick = () => joinWith(inst.id);
      return item;
    }),
  );
}

// With one instance that can join, there's nothing to choose: join with it. With several, ask in the menu.
$('#srv-join').onclick = () => {
  const options = joinable(currentServer());
  if (options.length === 1) {
    joinWith(options[0].id);
    return;
  }
  const entry = MENUS.find((m) => m.menu === '#join-menu');
  if ($('#join-menu').hidden) openMenu(entry);
  else closeMenu(entry);
};

$('#srv-command-form').onsubmit = async (event) => {
  event.preventDefault();
  const input = $('#srv-command');
  const text = input.value.trim().replace(/^\//, '');
  if (!text) return;
  try {
    await api.serverCommand(state.selectedServer, text);
    input.value = '';
  } catch (err) {
    showServerError(state.selectedServer, err);
  }
};

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
// Back from the game (or a file browser) with new schematics: look again.
window.addEventListener('focus', () => {
  if (state.view === 'schematics' && !document.querySelector('dialog[open]')) loadSchematics();
});

(async () => {
  [appSettings, appInfo] = await Promise.all([api.getSettings(), api.getAppInfo()]);
  $('#app-version').textContent = `v${appInfo.version}`;
  await refreshAccounts();
  api.refreshProfiles().then(renderAccounts, () => {}); // new skins show up once Mojang answers
  await refreshInstances();
  await refreshServers();
  playitState = await api.playitStatus();
  for (const server of state.servers) serverOnline[server.id] = await api.serverOnline(server.id);
  if (state.view === 'server') renderMain();
  update = await api.getUpdate();
  renderUpdate();
  loadSchematics(); // the count in the sidebar
})();

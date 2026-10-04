const api = window.launcher;
const $ = (selector) => document.querySelector(selector);

const SYNC_ITEMS = [
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
  view: 'instance', // or 'server'
  servers: [],
  selectedServer: null,
  serverStatus: {}, // id -> { state, text }
  serverLogs: {},   // id -> string[]
  tab: 'mods',
  status: {}, // id -> { state, text, progress }
  logs: {},   // id -> string[]
  search: { query: '', type: 'mod', offset: 0, total: 0, done: false },
  versions: null,
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
  return s === 'installing' || s === 'running';
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
  state.instances = await api.listInstances();
  for (const inst of state.instances) {
    if (inst.running && !state.status[inst.id]) state.status[inst.id] = { state: 'running', text: 'Playing' };
  }
  if (selectId) {
    state.selected = selectId;
    state.view = 'instance';
  }
  if (!current()) state.selected = state.instances[0]?.id ?? null;
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  $('#instance-list').replaceChildren(...state.instances.map((inst) => {
    const active = state.view === 'instance' && inst.id === state.selected;
    const item = el('li', { className: active ? 'active' : '' }, [
      el('span', { className: 'name', textContent: inst.name }),
      el('span', { className: 'sub' }, [
        loaderLabel(inst),
        state.status[inst.id]?.state === 'running' ? el('span', { className: 'running-dot', title: 'Playing' }) : null,
      ]),
    ]);
    item.onclick = () => selectInstance(inst.id);
    return item;
  }));
  $('#server-list').replaceChildren(...state.servers.map((server) => {
    const active = state.view === 'server' && server.id === state.selectedServer;
    const running = ['starting', 'running', 'stopping'].includes(state.serverStatus[server.id]?.state);
    const item = el('li', { className: active ? 'active' : '' }, [
      el('span', { className: 'name', textContent: server.name }),
      el('span', { className: 'sub' }, [
        `${serverFlavor(server)} ${server.mcVersion}`,
        running ? el('span', { className: 'running-dot', title: 'Running' }) : null,
      ]),
    ]);
    item.onclick = () => selectServer(server.id);
    return item;
  }));
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

// ---------- Closing with servers running ----------

let stoppingToClose = false;

api.onCloseRequested((names) => {
  if (stoppingToClose) return; // already stopping; the window closes when that's done
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const plural = names.length > 1;
  $('#close-title').textContent = plural ? 'Stop the servers first?' : 'Stop the server first?';
  $('#close-text').textContent = `${list} ${plural ? 'are' : 'is'} still running. Hojicha saves the world and stops `
    + `${plural ? 'them' : 'it'} before closing, which can take up to a minute.`;
  $('#close-error').textContent = '';
  $('#close-confirm').disabled = false;
  $('#close-confirm').textContent = plural ? 'Stop servers and close' : 'Stop server and close';
  $('#close-cancel').disabled = false;
  if (!$('#close-dialog').open) $('#close-dialog').showModal();
});

$('#close-cancel').onclick = () => $('#close-dialog').close();
$('#close-confirm').onclick = async () => {
  stoppingToClose = true;
  $('#close-confirm').disabled = true;
  $('#close-cancel').disabled = true;
  $('#close-confirm').textContent = 'Saving and stopping…';
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
}

function renderMain() {
  const showServer = state.view === 'server' && currentServer();
  const showInstance = !showServer && current();
  $('#empty').hidden = Boolean(showServer || showInstance);
  $('#server-view').hidden = !showServer;
  $('#instance-view').hidden = !showInstance;
  if (showServer) renderServer();
  if (showInstance) renderInstance();
}

// The installed mods changed: Browse reloads (keeping the search text) the next time it is shown,
// so its "Installed" labels are never stale.
function invalidateSearch() {
  state.search.done = false;
}

// Forget the previous instance's results; the Browse tab loads fresh ones the next time it is shown.
function resetSearch() {
  state.search = { query: '', type: $('#search-type').value, offset: 0, total: 0, done: false };
  $('#search-query').value = '';
  $('#search-results').replaceChildren();
  $('#load-more').hidden = true;
}

function selectInstance(id) {
  if (state.view === 'server' && !confirmDiscard()) return;
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
// pale to fresh to deep green.
const ROAST_STOPS = {
  hojicha: [[156, 178, 106], [217, 148, 74], [176, 100, 56]],
  matcha: [[196, 205, 140], [137, 150, 67], [108, 118, 44]],
};
function roastColor(fraction) {
  const stops = ROAST_STOPS[document.documentElement.dataset.theme] || ROAST_STOPS.hojicha;
  const f = Math.min(1, Math.max(0, fraction)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const t = f - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(', ')})`;
}

let roastHideTimer = null;
function renderRoast(s) {
  const bar = $('#roast');
  const fill = $('#roast-fill');
  clearTimeout(roastHideTimer);
  if (s.state === 'installing' || s.state === 'running') {
    const progress = s.state === 'running' ? 1 : (s.progress ?? 0);
    bar.classList.add('active');
    fill.style.width = `${Math.round(progress * 100)}%`;
    fill.style.backgroundColor = reduceMotion.matches ? 'var(--liquor)' : roastColor(progress);
    // Once the game is running the bar has done its job: let it fade.
    if (s.state === 'running') roastHideTimer = setTimeout(() => bar.classList.remove('active'), 1200);
  } else {
    bar.classList.remove('active');
    fill.style.width = '0';
  }
}

function renderStatus() {
  const inst = current();
  if (!inst) return;
  const s = state.status[inst.id] || { state: 'idle', text: '' };
  const statusEl = $('#status');
  statusEl.textContent = s.text;
  statusEl.className = `status${s.state === 'error' ? ' error' : ''}`;
  renderRoast(s);

  const play = $('#play');
  play.disabled = isBusy(inst.id);
  $('#play-label').textContent = s.state === 'running' ? 'Playing' : s.state === 'installing' ? 'Preparing' : 'Play';
  $('#delete-instance').disabled = isBusy(inst.id);
  if (state.tab === 'sync') renderSync();
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
}

async function loadMods() {
  const inst = current();
  const list = $('#mod-list');
  if (inst.loader === 'vanilla') {
    list.replaceChildren(emptyRow("This instance has no mod loader, so it can't use mods. Create a Fabric instance to add mods."));
    return;
  }
  const mods = await api.listMods(inst.id);
  if (!mods.length) {
    const browse = el('button', { className: 'primary', textContent: 'Browse Modrinth' });
    browse.onclick = () => showTab('browse');
    list.replaceChildren(emptyRow('No mods yet.', browse));
    return;
  }
  list.replaceChildren(...mods.map((mod) => {
    const remove = el('button', { className: 'quiet danger', textContent: 'Remove' });
    remove.onclick = async () => {
      await api.removeMod(inst.id, mod.file);
      invalidateSearch();
      loadMods();
    };
    let version;
    if (mod.fromModrinth) {
      version = el('button', {
        className: 'version-button',
        textContent: mod.versionNumber || 'Unknown version',
        title: 'Change version',
        ariaLabel: `Change version of ${mod.title}, now ${mod.versionNumber}`,
      });
      version.onclick = () => openVersionPicker(inst, mod);
    } else {
      version = el('span', { className: 'version', textContent: 'Added by hand' });
    }
    return el('li', { title: mod.file }, [
      thumb(mod.iconUrl),
      el('div', { className: 'info' }, [el('div', { className: 'title', textContent: mod.title })]),
      version,
      remove,
    ]);
  }));
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
          invalidateSearch(); // a new version can pull in extra dependencies
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
    const box = el('input', { type: 'checkbox', className: 'switch', checked: Boolean(inst.sync[item]), disabled: isBusy(inst.id) });
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
      } catch (err) {
        action.disabled = false;
        action.textContent = 'Install';
        state.status[inst.id] = { state: 'error', text: errorText(err) };
        renderStatus();
      }
    };
  }
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
  if (id !== state.selectedServer && !confirmDiscard()) return;
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
  const statusEl = $('#srv-status');
  statusEl.textContent = s.text;
  statusEl.className = `status${s.state === 'error' ? ' error' : ''}`;

  const toggle = $('#srv-toggle');
  toggle.textContent = { idle: 'Start server', error: 'Start server', starting: 'Starting', running: 'Stop server', stopping: 'Stopping' }[s.state];
  toggle.disabled = s.state === 'starting' || s.state === 'stopping';
  $('#srv-remove').disabled = s.state !== 'idle' && s.state !== 'error';

  // Only instances on the same Minecraft version can join.
  const select = $('#srv-instance');
  const previous = select.value;
  const matching = state.instances.filter((i) => i.gameVersion === server.mcVersion);
  select.replaceChildren(...(matching.length
    ? matching.map((i) => el('option', { value: i.id, textContent: `${i.name} (${loaderLabel(i)})` }))
    : [el('option', { value: '', textContent: `No ${server.mcVersion} instances yet` })]));
  if (matching.some((i) => i.id === previous)) select.value = previous;
  const join = $('#srv-join');
  join.textContent = s.state === 'running' ? 'Join' : 'Start and join';
  join.disabled = !matching.length || s.state === 'stopping' || isBusy(select.value);

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

  $('#playit-link').hidden = playitState.linked;
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
  if (!playitState.linked) hint = linking
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
  const what = on ? 'on' : 'off';
  if (!confirm(`Restart ${server.name} to turn online play ${what}? Anyone playing on it is disconnected.`)) {
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
  if (!confirm('Disconnect playit.gg? Online play stops working until you set it up again. Your tunnel stays in your playit.gg account.')) return;
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
  if (tab !== state.serverTab && !confirmDiscard()) return;
  state.serverTab = tab;
  for (const button of document.querySelectorAll('[data-srv-tab]')) button.classList.toggle('active', button.dataset.srvTab === tab);
  for (const name of SERVER_TABS) $(`#srv-tab-${name}`).hidden = name !== tab;
  // The note about who can join belongs with the console and online play, not the settings editors.
  $('#srv-intro').hidden = tab === 'settings' || tab === 'files';
  if (tab === 'console') renderServerLog(true);
  if (tab === 'settings') loadSettings();
  if (tab === 'files') loadFiles();
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

// Unsaved edits in the Settings form or an open file: ask before they're thrown away.
function confirmDiscard() {
  const unsaved = (state.serverTab === 'settings' && Object.keys(settingsState.edits).length) || (state.serverTab === 'files' && fileDirty());
  return !unsaved || confirm('You have unsaved changes. Discard them?');
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
      button.onclick = () => {
        if (file.path !== fileState.path && (!fileDirty() || confirm('You have unsaved changes. Discard them?'))) openFile(file.path);
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
    Object.assign(fileState, { path: file, saved: text, modified });
    showFile(text);
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
    const { modified } = await api.writeServerFile(id, fileState.path, text, fileState.modified);
    Object.assign(fileState, { saved: text, modified });
    $('#file-save').disabled = true;
    savedMessage($('#file-message'), $('#file-restart'), id);
    if (fileState.path === 'server.properties') settingsState.serverId = null; // the Settings tab reloads it
  } catch (err) {
    setMessage($('#file-message'), errorText(err), 'error');
  }
};
$('#file-reload').onclick = () => {
  if (!fileDirty() || confirm('You have unsaved changes. Discard them?')) openFile(fileState.path);
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

async function fillVersions() {
  const select = $('#new-version');
  const showSnapshots = $('#new-snapshots').checked;
  state.versions ??= await api.listVersions();
  const versions = state.versions.filter((v) => v.type === 'release' || (showSnapshots && v.type === 'snapshot'));
  select.replaceChildren(...versions.map((v) => el('option', { value: v.id, textContent: v.id })));
}

async function openNewDialog() {
  $('#new-error').textContent = '';
  $('#new-name').value = '';
  $('#new-create').disabled = false;
  $('#new-dialog').showModal();
  try {
    await fillVersions();
  } catch (err) {
    $('#new-error').textContent = `Couldn't load the version list. Check your internet connection. (${errorText(err)})`;
  }
}

async function createInstance(event) {
  event.preventDefault();
  const create = $('#new-create');
  create.disabled = true;
  $('#new-error').textContent = '';
  try {
    const inst = await api.createInstance({
      name: $('#new-name').value,
      gameVersion: $('#new-version').value,
      loader: $('#new-loader').value,
    });
    $('#new-dialog').close();
    await refreshInstances(inst.id);
  } catch (err) {
    $('#new-error').textContent = errorText(err);
    create.disabled = false;
  }
}

// ---------- Settings ----------

// Hojicha (dark) or matcha (light). Switches at once; main.js saves it and recolours the window buttons.
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
  $('#settings-error').textContent = '';
  try {
    await api.saveSettings({ theme });
  } catch (err) {
    showTheme(before);
    $('#settings-error').textContent = errorText(err);
  }
}

async function saveSettings() {
  $('#settings-error').textContent = '';
  try {
    await api.saveSettings({ memoryMb: Number($('#memory').value) });
  } catch (err) {
    $('#settings-error').textContent = errorText(err);
  }
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
  $('#account-name').textContent = active ? active.name : 'Add an account';
  $('#account-kind').textContent = active ? kindLabel(active) : 'Needed to play';

  $('#account-list').replaceChildren(...(accounts.length
    ? accounts.map((a) => {
      const avatar = el('span', { className: 'avatar' });
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

// ---------- Wiring ----------

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
  if (!confirm(`Delete "${inst.name}" with all its worlds and mods? Anything in shared sync folders is kept.`)) return;
  try {
    await api.deleteInstance(inst.id);
    state.selected = null;
    await refreshInstances();
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: errorText(err) };
    renderStatus();
  }
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
$('#new-cancel').onclick = () => $('#new-dialog').close();
$('#new-form').onsubmit = createInstance;

$('#memory').onchange = saveSettings;
for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.onclick = () => chooseTheme(button.dataset.themeChoice);
}
showTheme(document.documentElement.dataset.theme); // set by theme.js; marks the right button straight away

$('#versions-close').onclick = () => $('#versions-dialog').close();

$('#account-chip').onclick = () => {
  $('#accounts-error').textContent = '';
  $('#accounts-dialog').showModal();
};
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

function openServerDialog() {
  $('#server-name').value = '';
  $('#server-eula').checked = false;
  $('#server-error').textContent = '';
  $('#server-create').disabled = false;
  $('#server-create').textContent = 'Create server';
  $('#server-version').value = '';
  $('#server-dialog').showModal();
  fillServerVersions();
}

async function createServer(event) {
  event.preventDefault();
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
$('#server-cancel').onclick = () => $('#server-dialog').close();
$('#server-form').onsubmit = createServer;
$('#server-eula').onchange = () => { $('#server-error').textContent = ''; };
$('#eula-link').onclick = (event) => {
  event.preventDefault();
  api.openExternal('https://aka.ms/MinecraftEULA');
};
for (const radio of document.querySelectorAll('input[name="server-type"]')) radio.onchange = fillServerVersions;

// From the New server dialog: use a server folder that already exists instead of making one.
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
  if (!confirm(`Remove "${server.name}" from Hojicha? The server folder itself stays where it is.`)) return;
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

$('#srv-join').onclick = async () => {
  const id = state.selectedServer;
  const instanceId = $('#srv-instance').value;
  if (serverState(id) !== 'running') state.serverLogs[id] = [];
  state.logs[instanceId] = [];
  try {
    await api.joinServer(id, instanceId);
  } catch (err) {
    showServerError(id, err);
  }
};

$('#srv-instance').onchange = () => renderServer();

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

(async () => {
  const settings = await api.getSettings();
  $('#memory').value = settings.memoryMb;
  await refreshAccounts();
  api.refreshProfiles().then(renderAccounts, () => {}); // new skins show up once Mojang answers
  await refreshInstances();
  await refreshServers();
  $('#app-version').textContent = `v${await api.getVersion()}`;
  playitState = await api.playitStatus();
  for (const server of state.servers) serverOnline[server.id] = await api.serverOnline(server.id);
  if (state.view === 'server') renderMain();
  update = await api.getUpdate();
  renderUpdate();
})();

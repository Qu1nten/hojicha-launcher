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
  $('#inst-meta').textContent = inst.loader === 'fabric'
    ? `Fabric ${inst.loaderVersion} for ${inst.gameVersion}`
    : `Vanilla ${inst.gameVersion}`;
  renderStatus();
  showTab(state.tab);
}

// Leaf green -> tea liquor -> roasted brown as the launch progresses.
const ROAST_STOPS = [[156, 178, 106], [217, 148, 74], [176, 100, 56]];
function roastColor(fraction) {
  const f = Math.min(1, Math.max(0, fraction)) * (ROAST_STOPS.length - 1);
  const i = Math.min(ROAST_STOPS.length - 2, Math.floor(f));
  const t = f - i;
  const [a, b] = [ROAST_STOPS[i], ROAST_STOPS[i + 1]];
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
  play.textContent = s.state === 'running' ? 'Playing' : s.state === 'installing' ? 'Preparing' : 'Play';
  $('#delete-instance').disabled = isBusy(inst.id);
  if (state.tab === 'sync') renderSync();
}

// ---------- Tabs ----------

function showTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('.tabs button')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  for (const panel of document.querySelectorAll('.tab')) {
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
  state.selectedServer = id;
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

  renderServerLog(false);
}

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
    const sheet = `${64 * scale}px ${64 * scale}px`;
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

for (const button of document.querySelectorAll('.tabs button')) {
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

$('#add-server').onclick = async () => {
  try {
    const server = await api.addServer();
    if (server) await refreshServers(server.id);
  } catch (err) {
    alert(errorText(err));
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
  await refreshInstances();
  await refreshServers();
  update = await api.getUpdate();
  renderUpdate();
})();

const api = window.launcher;
const $ = (selector) => document.querySelector(selector);

const SYNC_LABELS = {
  resourcepacks: 'Resource packs',
  shaderpacks: 'Shader packs',
  screenshots: 'Screenshots',
  'options.txt': 'Options & keybinds (options.txt)',
  'servers.dat': 'Server list (servers.dat)',
};
const MAX_LOG_LINES = 3000;

const state = {
  instances: [],
  selected: null,
  view: 'instance', // or 'server'
  servers: [],
  selectedServer: null,
  serverStatus: {}, // id -> { state, text }
  serverLogs: {},   // id -> string[]
  tab: 'mods',
  status: {}, // id -> { state, text }
  logs: {},   // id -> string[]
  search: { query: '', type: 'mod', offset: 0, total: 0 },
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

function loaderLabel(inst) {
  return `${inst.gameVersion} · ${inst.loader === 'fabric' ? 'Fabric' : 'Vanilla'}`;
}

function iconFor(url) {
  return url ? el('img', { src: url, alt: '' }) : el('div', { className: 'icon' });
}

// ---------- Instances ----------

async function refreshInstances(selectId) {
  state.instances = await api.listInstances();
  for (const inst of state.instances) {
    if (inst.running && !state.status[inst.id]) state.status[inst.id] = { state: 'running', text: 'Running' };
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
      el('strong', { textContent: inst.name }),
      el('span', { className: 'muted', textContent: loaderLabel(inst) }),
    ]);
    item.onclick = () => selectInstance(inst.id);
    return item;
  }));
  $('#server-list').replaceChildren(...state.servers.map((server) => {
    const active = state.view === 'server' && server.id === state.selectedServer;
    const running = ['starting', 'running', 'stopping'].includes(state.serverStatus[server.id]?.state);
    const item = el('li', { className: active ? 'active' : '' }, [
      el('strong', { textContent: server.name }),
      el('span', { className: 'muted' }, [
        `${server.mcVersion} · ${serverFlavor(server)}`,
        running ? el('span', { className: 'dot', textContent: ' ● running' }) : null,
      ]),
    ]);
    item.onclick = () => selectServer(server.id);
    return item;
  }));
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

function selectInstance(id) {
  if (state.view === 'instance' && id === state.selected) return;
  if (id !== state.selected) {
    $('#search-results').replaceChildren();
    $('#load-more').hidden = true;
  }
  state.selected = id;
  state.view = 'instance';
  renderSidebar();
  renderMain();
}

function renderInstance() {
  const inst = current();
  if (!inst) return;

  $('#inst-name').textContent = inst.name;
  $('#inst-meta').textContent = inst.loader === 'fabric'
    ? `${loaderLabel(inst)} ${inst.loaderVersion}`
    : loaderLabel(inst);
  renderStatus();
  showTab(state.tab);
}

function renderStatus() {
  const inst = current();
  if (!inst) return;
  const s = state.status[inst.id] || { state: 'idle', text: '' };
  const statusEl = $('#status');
  statusEl.textContent = s.text;
  statusEl.className = `status${s.state === 'error' ? ' error' : ''}`;

  const play = $('#play');
  play.disabled = isBusy(inst.id);
  play.textContent = s.state === 'running' ? 'Running' : s.state === 'installing' ? 'Installing…' : 'Play';
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
  if (tab === 'sync') renderSync();
  if (tab === 'log') renderLog();
}

async function loadMods() {
  const inst = current();
  const list = $('#mod-list');
  if (inst.loader === 'vanilla') {
    list.replaceChildren(el('li', { className: 'empty-row', textContent: 'Vanilla instances cannot load mods.' }));
    return;
  }
  const mods = await api.listMods(inst.id);
  if (!mods.length) {
    list.replaceChildren(el('li', { className: 'empty-row', textContent: 'No mods yet. Find some in Browse Modrinth.' }));
    return;
  }
  list.replaceChildren(...mods.map((mod) => {
    const remove = el('button', { className: 'danger', textContent: 'Remove' });
    remove.onclick = async () => {
      await api.removeMod(inst.id, mod.file);
      loadMods();
    };
    return el('li', {}, [
      iconFor(mod.iconUrl),
      el('div', { className: 'info' }, [
        el('div', { className: 'title', textContent: mod.title }),
        el('div', { className: 'desc', textContent: [mod.versionNumber, mod.file].filter(Boolean).join(' · ') }),
      ]),
      remove,
    ]);
  }));
}

function renderSync() {
  const inst = current();
  const container = $('#sync-options');
  container.replaceChildren(...Object.entries(SYNC_LABELS).map(([item, label]) => {
    const box = el('input', { type: 'checkbox', checked: Boolean(inst.sync[item]), disabled: isBusy(inst.id) });
    box.onchange = async () => {
      $('#sync-error').textContent = '';
      try {
        const updated = await api.setSync(inst.id, item, box.checked);
        Object.assign(inst, updated);
      } catch (err) {
        box.checked = !box.checked;
        $('#sync-error').textContent = errorText(err);
      }
    };
    return el('label', {}, [box, label]);
  }));
}

function renderLog() {
  const logEl = $('#log');
  logEl.textContent = (state.logs[state.selected] || []).join('\n');
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

// ---------- Modrinth browsing ----------

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
    results.replaceChildren(el('li', { className: 'empty-row', textContent: 'Vanilla instances cannot load mods. Create a Fabric instance.' }));
    $('#load-more').hidden = true;
    return;
  }

  let page;
  try {
    page = await api.search(inst.id, s.query, s.type, s.offset);
  } catch (err) {
    results.replaceChildren(el('li', { className: 'empty-row', textContent: errorText(err) }));
    return;
  }
  const rows = page.hits.map((hit) => searchRow(inst, hit, s.type));
  if (append) results.append(...rows);
  else results.replaceChildren(...(rows.length ? rows : [el('li', { className: 'empty-row', textContent: 'No results.' })]));
  s.offset += page.hits.length;
  s.total = page.total;
  $('#load-more').hidden = s.offset >= s.total;
}

function searchRow(inst, hit, type) {
  const button = el('button', {
    className: hit.installed ? '' : 'primary',
    textContent: hit.installed ? 'Installed' : 'Install',
    disabled: hit.installed,
  });
  button.onclick = async () => {
    button.disabled = true;
    button.textContent = 'Installing…';
    try {
      Object.assign(inst, await api.install(inst.id, hit.projectId, type));
      button.textContent = 'Installed';
      button.className = '';
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Install';
      state.status[inst.id] = { state: 'error', text: errorText(err) };
      renderStatus();
    }
  };
  const title = el('a', { className: 'title', textContent: hit.title });
  title.onclick = () => api.openExternal(`https://modrinth.com/${type}/${hit.slug}`);
  return el('li', {}, [
    iconFor(hit.iconUrl),
    el('div', { className: 'info' }, [
      el('div', {}, [title, el('span', { className: 'muted', textContent: ` by ${hit.author} · ${hit.downloads.toLocaleString()} downloads` })]),
      el('div', { className: 'desc', textContent: hit.description }),
    ]),
    button,
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
  $('#srv-meta').textContent = `${serverFlavor(server)} ${server.mcVersion} · ${server.dir}`;
  const statusEl = $('#srv-status');
  statusEl.textContent = s.text;
  statusEl.className = `status${s.state === 'error' ? ' error' : ''}`;

  const toggle = $('#srv-toggle');
  toggle.textContent = { idle: 'Start', error: 'Start', starting: 'Starting…', running: 'Stop', stopping: 'Stopping…' }[s.state];
  toggle.disabled = s.state === 'starting' || s.state === 'stopping';
  $('#srv-remove').disabled = s.state !== 'idle' && s.state !== 'error';

  // Only instances on the same Minecraft version can join.
  const select = $('#srv-instance');
  const previous = select.value;
  const matching = state.instances.filter((i) => i.gameVersion === server.mcVersion);
  select.replaceChildren(...(matching.length
    ? matching.map((i) => el('option', { value: i.id, textContent: `${i.name} (${loaderLabel(i)})` }))
    : [el('option', { value: '', textContent: `No ${server.mcVersion} instances` })]));
  if (matching.some((i) => i.id === previous)) select.value = previous;
  const join = $('#srv-join');
  join.textContent = s.state === 'running' ? 'Join' : 'Start & Join';
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
    $('#new-error').textContent = `Could not load versions: ${errorText(err)}`;
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

function accountLabel(account) {
  if (account.type === 'microsoft') return account.name;
  return `${account.name} (offline${account.locked ? ', locked' : ''})`;
}

function renderAccounts(next) {
  if (next) accountState = next;
  const { accounts, selected, canUseOffline } = accountState;

  const select = $('#account-select');
  select.replaceChildren(...(accounts.length
    ? accounts.map((a) => el('option', { value: a.id, textContent: accountLabel(a) }))
    : [el('option', { value: '', textContent: 'No account' })]));
  select.value = selected || '';
  select.disabled = !accounts.length;

  $('#account-list').replaceChildren(...(accounts.length
    ? accounts.map((a) => {
      const remove = el('button', { className: 'danger', textContent: 'Remove', type: 'button' });
      remove.onclick = async () => renderAccounts(await api.removeAccount(a.id));
      return el('li', {}, [
        el('div', { className: 'info' }, [
          el('div', { className: 'title', textContent: a.name }),
          el('div', { className: 'desc', textContent: a.locked ? 'Locked until a Microsoft account that owns the game is added' : '' }),
        ]),
        el('span', { className: 'badge', textContent: a.type === 'microsoft' ? 'Microsoft' : 'Offline' }),
        remove,
      ]);
    })
    : [el('li', { className: 'empty-row', textContent: 'No accounts yet.' })]));

  $('#offline-name').disabled = !canUseOffline;
  $('#add-offline').disabled = !canUseOffline;
  $('#offline-hint').textContent = canUseOffline
    ? 'Offline accounts are for local and offline-mode servers. They stay available while your Microsoft account is signed in.'
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

api.onStatus(({ id, state: s, text }) => {
  state.status[id] = { state: s, text };
  if (id === state.selected) {
    renderStatus();
    // Refresh the mods list after an install finishes (dependencies may have been added).
    if (s === 'idle' && state.tab === 'mods') loadMods();
  }
  if (state.view === 'server' && currentServer()) renderServer(); // join button depends on instance state
});

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
  state.status[inst.id] = { state: 'installing', text: 'Preparing…' };
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
  if (!confirm(`Delete "${inst.name}" and all its worlds and mods? Synced items in the shared folder are kept.`)) return;
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
  runSearch(false);
};
$('#search-type').onchange = () => runSearch(false);
$('#load-more').onclick = () => runSearch(true);

$('#new-instance').onclick = openNewDialog;
$('#new-snapshots').onchange = fillVersions;
$('#new-cancel').onclick = () => $('#new-dialog').close();
$('#new-form').onsubmit = createInstance;

$('#memory').onchange = saveSettings;

$('#account-select').onchange = async () => renderAccounts(await api.selectAccount($('#account-select').value));
$('#manage-accounts').onclick = () => {
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
  if (!confirm(`Remove "${server.name}" from the launcher? The server folder itself is not touched.`)) return;
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
})();

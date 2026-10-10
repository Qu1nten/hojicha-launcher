import { accountState } from './accounts.js';
import {
  $,
  api,
  askConfirm,
  current,
  el,
  errorText,
  icon,
  isBusy,
  loaderLabel,
  MAX_SERVER_LOG_LINES,
  ONLINE_PLAY,
  state,
} from './core.js';
import { openIconPicker } from './iconPicker.js';
import { renderLog } from './instance.js';
import { closeMenu, MENUS, openMenu } from './menus.js';
import { remember, renderMain } from './nav.js';
import { confirmDiscard, loadFiles, loadSettings } from './serverFiles.js';
import { renderSidebar } from './sidebar.js';

export function currentServer() {
  return state.servers.find((s) => s.id === state.selectedServer) || null;
}

// "paper-1.21.11-132.jar" -> "Paper"
export function serverFlavor(server) {
  const name = server.jar.split(/[-_.]/)[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function serverState(id) {
  return state.serverStatus[id]?.state || 'idle';
}

export async function refreshServers(selectId) {
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

export function selectServer(id) {
  if (id !== state.selectedServer && !confirmDiscard(() => selectServer(id))) return;
  state.selectedServer = id;
  if (state.serverTab === 'settings') loadSettings();
  if (state.serverTab === 'files') loadFiles();
  state.view = 'server';
  renderSidebar();
  renderMain();
  renderServerLog(true);
}

export function renderServer() {
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
}

let playitState = { linked: false };
let linking = false;
const serverOnline = {}; // server id -> { state: off | connecting | online | error, address, srv, text }

// At startup: whether playit.gg is set up, and each server's online state.
export async function loadOnlinePlay() {
  playitState = await api.playitStatus();
  for (const server of state.servers) serverOnline[server.id] = await api.serverOnline(server.id);
  if (state.view === 'server') renderMain();
}

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
    clearServerLog(server.id);
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
export function showServerTab(tab) {
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

// A server (re)starting begins a new console.
export function clearServerLog(id) {
  state.serverLogs[id] = [];
  if (id === state.selectedServer) renderServerLog(true);
}

function showServerError(id, err) {
  state.serverStatus[id] = { state: serverState(id) === 'running' ? 'running' : 'error', text: errorText(err) };
  if (id === state.selectedServer) renderServer();
}

// A start page with three choices (custom setup, a Modrinth modpack, a modpack file), then the setup page for it.

api.onServerStatus(({ id, state: s, text }) => {
  state.serverStatus[id] = { state: s, text };
  renderSidebar();
  if (state.view === 'server' && id === state.selectedServer) renderServer();
});

// Server output arrives in batches too, and only the new lines are added to the page. Old lines are dropped in one go
// once there are SERVER_LOG_SLACK too many, so the console is only redrawn whole now and then.
const SERVER_LOG_SLACK = 500;
api.onServerLog(({ id, lines: added }) => {
  const lines = (state.serverLogs[id] ??= []);
  const clean = added.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '')); // strip console colour codes
  for (const line of clean) lines.push(line);
  const trim = lines.length > MAX_SERVER_LOG_LINES + SERVER_LOG_SLACK;
  if (trim) lines.splice(0, lines.length - MAX_SERVER_LOG_LINES);
  if (state.view !== 'server' || id !== state.selectedServer) return;
  if (trim) {
    renderServerLog(false);
    return;
  }
  const logEl = $('#srv-log');
  const scroller = logEl.parentElement;
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 20;
  logEl.append(`${lines.length > clean.length ? '\n' : ''}${clean.join('\n')}`);
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
});

$('#srv-menu-icon').onclick = () => openIconPicker('server', currentServer());

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
      clearServerLog(id);
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
  if (serverState(id) !== 'running') clearServerLog(id);
  state.logs[instanceId] = [];
  if (instanceId === state.selected && state.tab === 'log') renderLog();
  try {
    await api.joinServer(id, instanceId);
  } catch (err) {
    showServerError(id, err);
  }
}

// The join menu: each instance that can join, with its icon and version; one that's already playing can't.
export function fillJoinMenu() {
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

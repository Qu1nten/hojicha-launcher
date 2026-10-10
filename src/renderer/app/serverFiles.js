import { $, api, askConfirm, el, errorText, state } from './core.js';
import { clearServerLog, currentServer, serverState } from './servers.js';

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

export async function loadSettings() {
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
    clearServerLog(id);
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

let fileState = { serverId: null, files: [], path: null, saved: '', modified: null };
const fileDirty = () => fileState.path !== null && $('#file-text').value !== fileState.saved;

// Unsaved edits in a server's Settings form or open file.
export function hasUnsaved() {
  return Boolean((state.serverTab === 'settings' && Object.keys(settingsState.edits).length) || (state.serverTab === 'files' && fileDirty()));
}

export function askDiscard(options = {}) {
  return askConfirm({
    title: 'Discard your changes?',
    text: state.serverTab === 'files' ? `Your changes to ${fileState.path} aren't saved yet.` : "Your changes to this server's settings aren't saved yet.",
    confirm: 'Discard changes',
    cancel: 'Keep editing',
    ...options,
  });
}

export function dropEdits() {
  settingsState.edits = {};
  if (fileState.path !== null) $('#file-text').value = fileState.saved;
}

// Leaving a server's Settings or Files tab loses unsaved edits. With none, returns true and the caller carries on.
// Otherwise it asks, returns false, and if the edits may go, drops them and runs retry (the same step again).
export function confirmDiscard(retry) {
  if (!hasUnsaved()) return true;
  askDiscard().then((discard) => {
    if (!discard) return;
    dropEdits();
    retry();
  });
  return false;
}

export async function loadFiles() {
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

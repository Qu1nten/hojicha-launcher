import { $, api, el, errorText, isBusy, state } from './core.js';
import { renderMain } from './nav.js';
import { confirmDiscard } from './serverFiles.js';
import { renderSidebar } from './sidebar.js';

let update = { state: 'none' };

export function renderUpdate() {
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

// The Settings page (gear in the sidebar) and each instance's Settings tab.
let appInfo = { version: '', packaged: false, totalMemoryMb: 0 };
export let appSettings = { memoryMb: 4096, javaPath: '', theme: 'hojicha', borderless: false, protectAccount: true };
let updateMessage = ''; // the answer to the last "Check for updates"

// At startup: the settings, and what main.js says about the launcher itself.
export async function loadAppSettings() {
  [appSettings, appInfo] = await Promise.all([api.getSettings(), api.getAppInfo()]);
  $('#app-version').textContent = `v${appInfo.version}`;
}

// At startup: whether an update is downloading or ready (later ones come through api.onUpdate).
export async function loadUpdate() {
  update = await api.getUpdate();
  renderUpdate();
}

export function openSettings() {
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

export const gb = (mb) => `${Number((mb / 1024).toFixed(1))} GB`;

// Memory choices in whole steps up to what the PC has, plus the saved value if it's an odd one.
export function memoryOptions(select, currentMb, defaultLabel) {
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

export function renderAppSettings() {
  memoryOptions($('#memory'), appSettings.memoryMb);
  $('#memory-help').textContent = '4 GB is enough for most games. Big modpacks may need more.';

  const custom = Boolean(appSettings.javaPath);
  $('#java-help').textContent = custom
    ? `Using ${appSettings.javaPath}, for every game and server.`
    : 'Automatic: Hojicha downloads the Java version each Minecraft version needs.';
  $('#java-auto').hidden = !custom;
  $('#java-pick').textContent = custom ? 'Choose another' : 'Choose java.exe';
  $('#borderless').checked = appSettings.borderless;
  $('#protect-account').checked = appSettings.protectAccount;

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

api.onUpdate((next) => {
  update = next;
  renderUpdate();
});

$('#update-install').onclick = () => api.installUpdate().catch(() => renderUpdate());

$('#open-settings').onclick = openSettings;
for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.onclick = () => chooseTheme(button.dataset.themeChoice);
}
showTheme(document.documentElement.dataset.theme); // set by theme.js; marks the right button straight away
$('#memory').onchange = () => saveAppSettings({ memoryMb: Number($('#memory').value) });
$('#java-auto').onclick = () => saveAppSettings({ javaPath: '' });
$('#borderless').onchange = () => saveAppSettings({ borderless: $('#borderless').checked });
$('#protect-account').onchange = () => saveAppSettings({ protectAccount: $('#protect-account').checked });
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

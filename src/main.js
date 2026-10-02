const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, safeStorage } = require('electron');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const paths = require('./core/paths');
const settings = require('./core/settings');
const instances = require('./core/instances');
const minecraft = require('./core/minecraft');
const modrinth = require('./core/modrinth');
const sync = require('./core/sync');
const servers = require('./core/servers');
const accounts = require('./core/accounts');
const storage = require('./core/storage');
const { autoUpdater } = require('electron-updater');

const APP_ID = 'com.hojicha.launcher'; // must match build.appId so pinned taskbar icons group with the window
const ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// The launcher's home folder: next to the .exe when installed (see core/storage.js). Electron's own browser
// data goes to config\electron inside it; that has to be set before the app is ready.
const HOME = storage.chooseHome({ isPackaged: app.isPackaged, exePath: process.execPath, appData: app.getPath('appData') });
paths.setRoot(HOME);
storage.carryOverEncryptionKey(HOME, app.getPath('appData'), paths.electron);
app.setPath('userData', paths.electron);

let win = null;
// Instance id -> child process (or null while it is still installing).
const running = new Map();

const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};
// progress (0-1) drives the launch progress bar while an instance is being prepared.
const status = (id, state, text = '', progress = null) => send('status', { id, state, text, progress });
const log = (id, line) => send('log', { id, line });

servers.setHooks({
  status: (id, state, text = '') => send('server-status', { id, state, text }),
  log: (id, line) => send('server-log', { id, line }),
});

function assertIdle(id) {
  if (running.has(id)) throw new Error('Close the game first');
}

// options.join = "host:port" to connect to a server as soon as the game starts.
async function launch(id, options = {}) {
  assertIdle(id);
  running.set(id, null);
  try {
    const instance = instances.get(id);
    const gameDir = instances.gameDir(id);
    status(id, 'installing', 'Signing in', 0.01);
    const account = await accounts.launchIdentity();
    const report = (text, progress = null) => status(id, 'installing', text, progress);
    const { java, args } = await minecraft.prepare(instance, gameDir, settings.get(), account, report, options);
    sync.beforeLaunch(instance);

    log(id, `> Launching ${instance.name} (${instance.gameVersion} ${instance.loader}) as ${account.name}`);
    const child = spawn(java, args, { cwd: gameDir, windowsHide: true });
    running.set(id, child);
    const started = Date.now();
    instances.save({ ...instances.get(id), lastPlayed: started });
    status(id, 'running', 'Playing', 1);
    readline.createInterface({ input: child.stdout }).on('line', (line) => log(id, line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => log(id, line));

    let finished = false;
    const finish = (message) => {
      if (finished) return;
      finished = true;
      running.delete(id);
      try {
        const current = instances.get(id);
        instances.save({ ...current, playtime: (current.playtime || 0) + (Date.now() - started) });
      } catch (err) {
        log(id, `> Could not save play time: ${err.message}`);
      }
      try {
        sync.afterExit(instances.get(id));
      } catch (err) {
        message = `Sync failed: ${err.message}`;
      }
      log(id, `> ${message}`);
      status(id, 'idle', message);
    };
    child.on('error', (err) => finish(`Failed to start Java: ${err.message}`));
    child.on('exit', (code) => finish(`Game exited with code ${code}`));
  } catch (err) {
    running.delete(id);
    status(id, 'error', err.message);
    throw err;
  }
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

  handle('settings:get', () => settings.get());
  handle('settings:save', (patch) => settings.save(patch));

  handle('accounts:list', () => accounts.summary());
  handle('accounts:select', (id) => accounts.select(id));
  handle('accounts:remove', (id) => accounts.remove(id));
  handle('accounts:addOffline', (name) => accounts.addOffline(name));
  handle('accounts:loginStart', () => accounts.startMicrosoftLogin());
  handle('accounts:loginFinish', () => accounts.finishMicrosoftLogin());
  handle('accounts:loginCancel', () => accounts.cancelMicrosoftLogin());
  handle('accounts:copyCodeAndOpen', (code, url) => {
    clipboard.writeText(code);
    if (/^https:\/\/(www\.)?microsoft\.com\//.test(url)) shell.openExternal(url);
  });

  handle('versions:list', () => minecraft.listGameVersions());

  handle('instances:list', () => instances.list().map((i) => ({ ...i, running: running.has(i.id) })));
  handle('instances:create', async ({ name, gameVersion, loader }) => {
    const loaderVersion = loader === 'fabric' ? await minecraft.latestFabricLoader(gameVersion) : null;
    return instances.create({ name: name.trim() || gameVersion, gameVersion, loader, loaderVersion });
  });
  handle('instances:delete', (id) => {
    assertIdle(id);
    sync.deleteInstance(id);
  });
  handle('instances:openFolder', (id) => shell.openPath(instances.gameDir(id)));
  handle('instances:setSync', (id, item, enabled) => {
    assertIdle(id);
    return sync.setSync(id, item, enabled);
  });
  handle('instances:launch', launch);

  handle('mods:list', (id) => modrinth.listMods(id));
  handle('mods:remove', (id, file) => modrinth.removeMod(id, file));
  handle('mods:versions', (id, file) => modrinth.listModVersions(id, file));
  handle('mods:setVersion', async (id, file, versionId) => {
    if (running.has(id)) throw new Error('Close the game first: Windows keeps mod files locked while it runs.');
    try {
      return await modrinth.setModVersion(id, file, versionId, (text) => status(id, 'busy', text));
    } finally {
      status(id, running.has(id) ? 'running' : 'idle', running.has(id) ? 'Playing' : '');
    }
  });
  handle('modrinth:search', (id, query, type, offset) => modrinth.search(id, query, type, offset));
  handle('modrinth:install', async (id, projectId, type) => {
    try {
      return await modrinth.install(id, projectId, type, (text) => status(id, 'busy', text));
    } finally {
      status(id, running.has(id) ? 'running' : 'idle', running.has(id) ? 'Running' : '');
    }
  });
  handle('servers:list', () => servers.list().map((s) => ({ ...s, running: servers.isRunning(s.id) })));
  handle('servers:add', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Choose your server folder', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return servers.add(result.filePaths[0]);
  });
  handle('servers:remove', (id) => servers.remove(id));
  handle('servers:openFolder', (id) => shell.openPath(servers.get(id).dir));
  // The selected account is made operator on the local server so FAWE/Arceon-style commands work.
  const serverOptions = () => ({ javaPath: settings.get().javaPath, opUsername: accounts.current()?.name });
  handle('servers:start', async (id) => {
    await servers.start(id, serverOptions());
  });
  handle('servers:stop', (id) => servers.stop(id));
  handle('servers:command', (id, text) => servers.command(id, text));
  handle('servers:join', async (id, instanceId) => {
    const server = servers.get(id);
    const instance = instances.get(instanceId);
    if (instance.gameVersion !== server.mcVersion) {
      throw new Error(`${instance.name} is ${instance.gameVersion} but the server is ${server.mcVersion}`);
    }
    assertIdle(instanceId);
    await accounts.launchIdentity(); // fail before starting the server if the account can't play
    const join = await servers.start(id, serverOptions());
    await launch(instanceId, { join });
  });

  handle('app:version', () => app.getVersion());
  handle('update:get', () => update);
  handle('update:install', () => {
    if (update.state !== 'ready') return;
    if (running.size) throw new Error('Close the game first');
    autoUpdater.quitAndInstall(true, true); // silent installer, then start the new version
  });

  handle('openExternal', (url) => {
    if (url.startsWith('https://modrinth.com/')) shell.openExternal(url);
  });
}

// The whole UI is drawn 10% larger than its CSS sizes. The Windows buttons aren't zoomed, so their height
// is the title bar's CSS height (40px, see .titlebar in style.css) times the zoom.
const ZOOM = 1.1;
const TITLEBAR_HEIGHT = Math.round(40 * ZOOM);

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 790,
    minWidth: 900,
    minHeight: 570,
    backgroundColor: '#241913',
    title: 'Hojicha Launcher',
    icon: ICON,
    // Our own title bar (see .titlebar in style.css). Windows still draws the minimise/maximise/close buttons
    // over it, tinted to the palette, so Snap Layouts and the usual hover behaviour keep working.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#241913', symbolColor: '#b09d8d', height: TITLEBAR_HEIGHT },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), zoomFactor: ZOOM },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// Updates come from the GitHub releases (build.publish in package.json). A newer version downloads in the
// background; the title bar then offers a restart, and otherwise it installs when the launcher closes.
// The installer runs in update mode, which replaces app\ only and keeps instances (build/installer.nsh).
let update = { state: 'none' }; // none | downloading (version, progress 0-1) | ready (version)
const setUpdate = (next) => {
  update = next;
  send('update', update);
};

function startUpdateChecks() {
  if (!app.isPackaged) return; // running from source: nothing to update
  autoUpdater.on('update-available', (info) => setUpdate({ state: 'downloading', version: info.version, progress: 0 }));
  autoUpdater.on('download-progress', (p) => setUpdate({ ...update, progress: p.percent / 100 }));
  autoUpdater.on('update-downloaded', (info) => setUpdate({ state: 'ready', version: info.version }));
  // Offline or GitHub unreachable: try again at the next check, without bothering anyone.
  autoUpdater.on('error', () => {
    if (update.state === 'downloading') setUpdate({ state: 'none' });
  });
  const check = () => {
    if (update.state === 'none') autoUpdater.checkForUpdates().catch(() => {});
  };
  check();
  setInterval(check, 4 * 60 * 60 * 1000);
}

// Small window shown while data from an older version is moved into the home folder.
function showMovingWindow() {
  const moving = new BrowserWindow({
    width: 420, height: 140, frame: false, resizable: false, backgroundColor: '#241913', icon: ICON, show: false,
  });
  const page = `<body style="margin:0;height:100vh;display:grid;place-content:center;gap:6px;background:#241913;
    color:#efe6dc;font:15px 'Segoe UI',sans-serif;text-align:center"><b>Moving your launcher data</b>
    <span style="color:#b09d8d;font-size:13px">into ${HOME.replace(/[<&]/g, '')}<br>This only happens once.</span></body>`;
  moving.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  moving.once('ready-to-show', () => moving.show());
  return moving;
}

app.whenReady().then(async () => {
  const moves = storage.pendingMoves(HOME, app.getPath('appData'));
  let moving = null;
  if (moves.length) {
    moving = showMovingWindow();
    try {
      await storage.migrate(HOME, app.getPath('appData'), moves);
    } catch (err) {
      dialog.showErrorBox('Hojicha Launcher', `Some data could not be moved into ${HOME}:\n\n${err.message}\n\nNothing was lost. The launcher will try again next time it starts.`);
    }
  }
  instances.renameOldFolders();
  sync.relinkAll();
  if (safeStorage.isEncryptionAvailable()) {
    accounts.setCipher({
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
    });
  }
  servers.restoreAllPending();
  registerIpc();
  createWindow();
  if (moving) moving.destroy();
  startUpdateChecks();
});

app.on('window-all-closed', () => app.quit());

// Servers would keep running headless after the launcher closes, so save and stop them first.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !servers.list().some((s) => servers.isRunning(s.id))) return;
  event.preventDefault();
  quitting = true;
  servers.stopAll().finally(() => app.quit());
});

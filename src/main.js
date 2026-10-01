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

const APP_ID = 'com.hojicha.launcher'; // must match build.appId so pinned taskbar icons group with the window
const ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

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
    status(id, 'running', 'Playing', 1);
    readline.createInterface({ input: child.stdout }).on('line', (line) => log(id, line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => log(id, line));

    let finished = false;
    const finish = (message) => {
      if (finished) return;
      finished = true;
      running.delete(id);
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

  handle('openExternal', (url) => {
    if (url.startsWith('https://modrinth.com/')) shell.openExternal(url);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#15171c',
    title: 'Hojicha Launcher',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

app.whenReady().then(() => {
  // %APPDATA%\Hojicha Launcher\data, shared by `npm start` and the installed .exe.
  paths.setRoot(path.join(app.getPath('userData'), 'data'));
  if (safeStorage.isEncryptionAvailable()) {
    accounts.setCipher({
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
    });
  }
  servers.restoreAllPending();
  registerIpc();
  createWindow();
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

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, safeStorage } = require('electron');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const paths = require('./core/paths');
const settings = require('./core/settings');
const instances = require('./core/instances');
const minecraft = require('./core/minecraft');
const modrinth = require('./core/modrinth');
const modpacks = require('./core/modpacks');
const sync = require('./core/sync');
const icons = require('./core/icons');
const servers = require('./core/servers');
const serverTypes = require('./core/serverTypes');
const serverConfig = require('./core/serverConfig');
const playit = require('./core/playit');
const accounts = require('./core/accounts');
const storage = require('./core/storage');
const { autoUpdater } = require('electron-updater');

const EULA_URL = 'https://aka.ms/MinecraftEULA';
const HOMEPAGE = require('../package.json').homepage;
const APP_ID = 'com.hojicha.launcher'; // must match build.appId so pinned taskbar icons group with the window
const ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// The launcher's home folder: next to the .exe when installed (see core/storage.js). Electron's own browser
// data goes to config\electron inside it; that has to be set before the app is ready.
let HOME;
try {
  HOME = storage.chooseHome({ isPackaged: app.isPackaged, exePath: process.execPath });
} catch (err) {
  dialog.showErrorBox('Hojicha Launcher', err.message);
  process.exit(1);
}
paths.setRoot(HOME);
app.setPath('userData', paths.electron);

// One launcher at a time: two would start the same servers and games and write the same files. Opening it again
// brings the running window to the front instead (the lock belongs to the userData folder set just above).
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

let win = null;
// Instance id -> child process (or null while it is still installing).
const running = new Map();

const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};
// progress (0-1) drives the launch progress in Play while an instance is being prepared. Checking files that are
// already there reports thousands of steps in a blink, so 'installing' updates go out at most every 80 ms (always
// ending on the latest one); every other state goes out at once and drops any update still waiting.
const STATUS_INTERVAL = 80;
const statusThrottle = new Map(); // id -> { sentAt, timer, pending }
const status = (id, state, text = '', progress = null) => {
  const entry = statusThrottle.get(id) || { sentAt: 0, timer: null, pending: null };
  statusThrottle.set(id, entry);
  const message = { id, state, text, progress };
  if (state !== 'installing') {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.pending = null;
    entry.sentAt = 0;
    send('status', message);
    return;
  }
  const wait = entry.sentAt + STATUS_INTERVAL - Date.now();
  if (wait <= 0 && !entry.timer) {
    entry.sentAt = Date.now();
    send('status', message);
    return;
  }
  entry.pending = message;
  entry.timer ??= setTimeout(() => {
    entry.timer = null;
    entry.sentAt = Date.now();
    if (entry.pending) send('status', entry.pending);
    entry.pending = null;
  }, Math.max(0, wait));
};
const log = (id, line) => send('log', { id, line });

servers.setHooks({
  status: (id, state, text = '') => {
    if (state === 'idle' || state === 'error') goOffline(id);
    send('server-status', { id, state, text });
  },
  log: (id, line) => send('server-log', { id, line }),
});

// Online play (see core/playit.js): while a public server runs, playit's agent relays players to it.
// Server id -> { state: 'connecting' | 'online' | 'error', address, srv, text }; absent while not online.
const online = new Map();
const setOnline = (id, value) => {
  if (value) online.set(id, value);
  else online.delete(id);
  send('server-online', { id, ...(value || { state: 'off' }) });
};

// The newest goOnline per server: after a restart, an older one still connecting must leave the new one alone.
const onlineAttempts = new Map();

async function goOnline(id) {
  if (!servers.get(id).public) return;
  const attempt = {};
  onlineAttempts.set(id, attempt);
  const superseded = () => onlineAttempts.get(id) !== attempt;
  // The server stopped (or never got going) while connecting. goOffline may have run before the agent was up, so
  // stop it here too, or it would keep relaying to nothing until the launcher closes.
  const gone = () => !servers.isRunning(id);
  setOnline(id, { state: 'connecting', text: 'Connecting to playit.gg…' });
  try {
    await playit.startAgent(id, (line) => send('server-log', { id, line }));
    if (superseded()) return;
    if (gone()) throw new Error('Server stopped');
    const port = servers.port(id);
    const address = await playit.ensureTunnel(port, (err) => {
      send('server-log', { id, line: `[playit] Creating the tunnel failed: ${err.endpoint} answered ${err.reply}` });
      setOnline(id, { state: 'manual', port });
    }, () => superseded() || gone());
    if (superseded()) return;
    if (gone()) throw new Error('Server stopped');
    setOnline(id, { state: 'online', address });
  } catch (err) {
    if (superseded()) return;
    onlineAttempts.delete(id);
    playit.stopAgent(id);
    if (gone()) {
      if (online.has(id)) setOnline(id, null);
      return;
    }
    if (err.endpoint) send('server-log', { id, line: `[playit] ${err.endpoint} answered ${err.reply}` });
    setOnline(id, { state: 'error', text: err.message });
  }
}

function goOffline(id) {
  playit.stopAgent(id);
  if (online.has(id)) setOnline(id, null);
}

function assertIdle(id) {
  if (running.has(id)) throw new Error('Close the game first');
  if (modrinth.isWorking(id)) throw new Error('Wait until the mods have finished downloading');
}

// Installing, switching or removing mods reports its steps as 'busy' (Play waits meanwhile). A game that's starting or
// running keeps its own status instead: it says more, and the game isn't touched by the change until its next start.
const modStatus = (id) => (text) => {
  if (!running.has(id)) status(id, 'busy', text);
};
const modWorkDone = (id) => {
  if (!running.has(id) && !modrinth.isWorking(id)) status(id, 'idle'); // not while more installs wait their turn
};

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
    // An instance can have its own memory; otherwise it uses the launcher's default.
    const launchSettings = { ...settings.get(), ...(instance.memoryMb ? { memoryMb: instance.memoryMb } : {}) };
    const { java, args } = await minecraft.prepare(instance, gameDir, launchSettings, account, report, options);
    unpackIcons(); // a newer version may bring new items
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
    const finish = (message, failed = false) => {
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
        failed = true;
      }
      log(id, `> ${message}`);
      status(id, failed ? 'error' : 'idle', message);
    };
    child.on('error', (err) => finish(`Failed to start Java: ${err.message}`, true));
    child.on('exit', (code) => finish(code ? `The game crashed (exit code ${code}). See the Log tab for details.` : 'Game closed', Boolean(code)));
  } catch (err) {
    running.delete(id);
    status(id, 'error', err.message);
    throw err;
  }
}

// Item icons for instances and servers (core/icons.js). Unpacking needs a downloaded game version, so a launcher
// without one shows placeholders until the first game is prepared.
function unpackIcons() {
  try {
    icons.ensure();
  } catch (err) {
    console.error('Could not unpack the item icons:', err.message);
  }
}

// Anything without an icon yet gets a random item, saved so it stays the same.
function iconFor(item, save) {
  if (icons.has(item.icon)) return item.icon;
  const name = icons.random();
  if (name) save(name);
  return name;
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args));

  handle('settings:get', () => settings.get());
  handle('window:popup', (open) => {
    popupOpen = Boolean(open);
    if (win && !win.isDestroyed()) paintTitleBarButtons();
  });
  handle('settings:save', (patch) => {
    const saved = settings.save(patch);
    if (patch.theme) applyTheme(saved.theme);
    return saved;
  });
  // Settings > Java: the player picks java.exe here, so the page never names a program to run.
  handle('settings:pickJava', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose java.exe',
      filters: [{ name: 'Java', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    if (!/^javaw?\.exe$/i.test(path.basename(file))) throw new Error('Choose java.exe (or javaw.exe), in the bin folder of a Java install.');
    return settings.save({ javaPath: file });
  });

  handle('accounts:list', () => accounts.summary());
  handle('accounts:refreshProfiles', () => accounts.refreshProfiles());
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

  handle('instances:list', () => instances.list().map((i) => {
    const icon = iconFor(i, (name) => instances.save({ ...instances.get(i.id), icon: name }));
    return { ...i, icon, iconUrl: icons.url(icon), running: running.has(i.id) };
  }));
  // The instance's Settings tab: its name (the folder keeps its own) and its memory (null: the launcher default).
  handle('instances:update', (id, patch) => {
    const instance = instances.get(id);
    if ('name' in patch) {
      const name = String(patch.name).trim();
      if (!name) throw new Error('Give the instance a name.');
      if (name.length > 64) throw new Error('Keep the name to 64 characters.');
      instance.name = name;
    }
    if ('memoryMb' in patch) {
      const mb = patch.memoryMb === null ? null : Number(patch.memoryMb);
      if (mb !== null && !(mb >= 512)) throw new Error('Give the game at least 512 MB.');
      instance.memoryMb = mb;
    }
    return instances.save(instance);
  });
  handle('instances:setIcon', (id, name) => {
    if (!icons.has(name)) throw new Error('Unknown icon');
    return instances.save({ ...instances.get(id), icon: name });
  });
  handle('instances:create', async ({ name, gameVersion, loader }) => {
    const loaderVersion = loader === 'fabric' ? await minecraft.latestFabricLoader(gameVersion) : null;
    const instance = instances.create({ name: name.trim() || gameVersion, gameVersion, loader, loaderVersion });
    sync.linkFolders(instance); // synced from the start, so downloads land in the shared folders
    return instance;
  });
  handle('instances:delete', (id) => {
    assertIdle(id);
    sync.deleteInstance(id);
  });
  handle('instances:openFolder', (id) => shell.openPath(instances.gameDir(id)));
  handle('instances:setSync', (id, item, enabled) => {
    assertIdle(id);
    // Switching off copies the shared files, and a running game holds some of them (an open world's session.lock).
    const users = enabled || !sync.FOLDERS.includes(item) ? [] : [...running.keys()].filter((other) => sync.isSynced(instances.get(other), item));
    if (users.length) throw new Error(`Close ${instances.get(users[0]).name} first: it's using the shared ${item}.`);
    return sync.setSync(id, item, enabled);
  });
  handle('instances:launch', launch);

  handle('content:list', (id) => modrinth.listContent(id));
  // Windows locks the files a running game uses: for a shared pack, that's any running instance sharing it.
  handle('content:remove', (id, type, file) => {
    const shared = modrinth.isSharedContent(id, type);
    const folder = modrinth.FOLDERS[type];
    const inUse = running.has(id) || (shared && [...running.keys()].some((other) => sync.isSynced(instances.get(other), folder)));
    if (inUse) throw new Error('Close the game first: Windows keeps the file locked while it runs.');
    return modrinth.removeContent(id, type, file);
  });
  handle('mods:setEnabled', (id, file, enabled) => {
    if (running.has(id)) throw new Error('Close the game first: Windows keeps mod files locked while it runs.');
    return modrinth.setModEnabled(id, file, enabled);
  });
  handle('mods:updates', (id) => modrinth.checkModUpdates(id));
  handle('mods:versions', (id, file) => modrinth.listModVersions(id, file));
  handle('mods:setVersion', async (id, file, versionId) => {
    if (running.has(id)) throw new Error('Close the game first: Windows keeps mod files locked while it runs.');
    try {
      return await modrinth.setModVersion(id, file, versionId, modStatus(id));
    } finally {
      modWorkDone(id);
    }
  });
  handle('modrinth:search', (id, query, type, offset) => modrinth.search(id, query, type, offset));
  handle('modrinth:install', async (id, projectId, type) => {
    try {
      return await modrinth.install(id, projectId, type, modStatus(id));
    } finally {
      modWorkDone(id);
    }
  });
  // Modpacks make a new instance. It's returned straight away; its files download in the background, reported
  // through its status, and it counts as busy (no Play, Delete or sync changes) until they're in.
  const installPack = (pack) => {
    const { id } = pack.instance;
    running.set(id, null);
    status(id, 'installing', 'Installing modpack', 0);
    (async () => {
      let result = ['idle', 'Modpack installed'];
      try {
        await modrinth.exclusive(id, () => modpacks.fillInstance(pack, (text, progress = null) => status(id, 'installing', text, progress)));
        sync.linkFolders(instances.get(id));
      } catch (err) {
        result = ['error', `The modpack didn't finish installing (${err.message}). Delete this instance and try again.`];
      }
      running.delete(id);
      status(id, ...result);
    })();
    return pack.instance;
  };
  handle('modpacks:search', (query, offset) => modrinth.searchModpacks(query, offset));
  handle('modpacks:gameVersions', (projectId) => modpacks.listGameVersions(projectId));
  handle('modpacks:install', async (projectId, name, versionId) => installPack(await modpacks.createInstance(projectId, name, versionId)));
  // The file is chosen here and remembered, so the page can only install the file the player picked.
  let pickedPack = null;
  handle('modpacks:pickFile', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a modpack',
      filters: [{ name: 'Modrinth modpack', extensions: ['mrpack'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const info = modpacks.describeFile(result.filePaths[0]);
    pickedPack = result.filePaths[0];
    return info;
  });
  handle('modpacks:installFile', async (name) => {
    if (!pickedPack) throw new Error('Choose a modpack file first.');
    return installPack(await modpacks.createInstanceFromFile(pickedPack, name));
  });

  handle('servers:list', () => servers.list().map((s) => {
    const icon = iconFor(s, (name) => servers.update(s.id, (server) => { server.icon = name; }));
    return { ...s, icon, iconUrl: icons.url(icon), running: servers.isRunning(s.id) };
  }));
  handle('servers:setIcon', (id, name) => {
    if (!icons.has(name)) throw new Error('Unknown icon');
    return servers.update(id, (server) => { server.icon = name; });
  });
  handle('icons:list', () => icons.list());
  handle('servers:add', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Choose your server folder', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return servers.add(result.filePaths[0]);
  });
  handle('servers:versions', (type) => serverTypes.listVersions(type));
  handle('servers:create', (options) => servers.create(options));
  handle('servers:remove', (id) => servers.remove(id));
  handle('servers:openFolder', (id) => shell.openPath(servers.get(id).dir));
  // The selected account is made operator on the local server so FAWE/Arceon-style commands work.
  const serverOptions = () => ({ javaPath: settings.get().javaPath, opUsername: accounts.current()?.name });
  const startServer = async (id) => {
    const ready = servers.start(id, serverOptions());
    goOnline(id);
    await ready;
  };
  handle('servers:start', startServer);
  handle('servers:restart', async (id) => {
    await servers.stop(id);
    await startServer(id);
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
    const ready = servers.start(id, serverOptions());
    goOnline(id);
    await launch(instanceId, { join: await ready });
  });
  handle('servers:online', (id) => online.get(id) || { state: 'off' });
  const serverDir = (id) => servers.get(id).dir;
  handle('servers:properties', (id) => ({ values: serverConfig.readProperties(serverDir(id)), managed: serverConfig.MANAGED_KEYS }));
  handle('servers:setProperties', (id, changes) => serverConfig.writeProperties(serverDir(id), changes));
  handle('servers:files', (id) => serverConfig.listFiles(serverDir(id)));
  handle('servers:readFile', (id, file) => serverConfig.readFile(serverDir(id), file));
  handle('servers:writeFile', (id, file, text, modified) => serverConfig.writeFile(serverDir(id), file, text, modified));
  handle('servers:setPublic', (id, on) => servers.setPublic(id, on));
  handle('servers:whitelistAdd', (id, name) => servers.addToWhitelist(id, name));
  handle('servers:whitelistRemove', (id, name) => servers.removeFromWhitelist(id, name));

  handle('playit:status', () => ({ linked: playit.isLinked() }));
  handle('playit:linkStart', async () => {
    const url = await playit.startLink();
    shell.openExternal(url);
    return url;
  });
  handle('playit:linkFinish', () => playit.finishLink());
  handle('playit:linkCancel', () => playit.cancelLink());
  handle('playit:unlink', () => {
    if (online.size) throw new Error('Stop your online servers first');
    playit.unlink();
  });

  // The player chose to close anyway: servers save and stop first; games end with the launcher.
  handle('app:stopServersAndClose', async () => {
    await servers.stopAll();
    allowClose = true;
    if (win && !win.isDestroyed()) win.close();
  });
  handle('update:get', () => update);
  // Settings > About: look for a newer version now instead of at the next 4-hourly check.
  handle('update:check', async () => {
    if (!app.isPackaged || update.state !== 'none') return update;
    await autoUpdater.checkForUpdates();
    return update;
  });
  handle('app:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
  }));
  handle('app:openFolder', () => shell.openPath(paths.root));
  handle('update:install', () => {
    if (update.state !== 'ready') return;
    if (running.size) throw new Error('Close the game first');
    autoUpdater.quitAndInstall(true, true); // silent installer, then start the new version
  });

  handle('openExternal', (url) => {
    if (url.startsWith('https://modrinth.com/') || url === EULA_URL || url === playit.TUNNELS_PAGE || url === HOMEPAGE) shell.openExternal(url);
  });
}

// The whole UI is drawn 10% larger than its CSS sizes. The Windows buttons aren't zoomed, so their height
// is the title bar's CSS height (52px, see .titlebar in style.css) times the zoom.
const ZOOM = 1.1;
const TITLEBAR_HEIGHT = Math.round(52 * ZOOM);

let allowClose = false; // set once running servers have stopped after the player chose to close

// Window colours per theme (keep in step with --roast, --steam-dim and --backdrop in style.css): the background
// shown before the page paints, and the Windows title bar buttons, which sit on the plain background colour.
// Windows draws those buttons outside the page, so a popup's backdrop can't dim them: the dim pair is the same
// colours under that backdrop, used while a popup is open.
const THEME_COLORS = {
  hojicha: { background: '#241913', symbols: '#b09d8d', dimBackground: '#160f0b', dimSymbols: '#473d35' },
  matcha: { background: '#eef0d8', symbols: '#575d3a', dimBackground: '#a8ab93', dimSymbols: '#464b2c' },
};
let currentTheme = null;
let popupOpen = false;

function paintTitleBarButtons() {
  const colors = THEME_COLORS[currentTheme] || THEME_COLORS.hojicha;
  win.setTitleBarOverlay({
    color: popupOpen ? colors.dimBackground : colors.background,
    symbolColor: popupOpen ? colors.dimSymbols : colors.symbols,
    height: TITLEBAR_HEIGHT,
  });
}

function applyTheme(theme) {
  if (!win || win.isDestroyed()) return;
  currentTheme = theme;
  win.setBackgroundColor((THEME_COLORS[theme] || THEME_COLORS.hojicha).background);
  paintTitleBarButtons();
}

function createWindow() {
  const { theme } = settings.get();
  currentTheme = theme;
  const colors = THEME_COLORS[theme] || THEME_COLORS.hojicha;
  win = new BrowserWindow({
    width: 1200,
    height: 790,
    minWidth: 900,
    minHeight: 570,
    backgroundColor: colors.background,
    title: 'Hojicha Launcher',
    icon: ICON,
    // Our own title bar (see .titlebar in style.css). Windows still draws the minimise/maximise/close buttons
    // over it, tinted to the palette, so Snap Layouts and the usual hover behaviour keep working.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors.background, symbolColor: colors.symbols, height: TITLEBAR_HEIGHT },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), zoomFactor: ZOOM },
  });
  win.removeMenu();
  // Closing while something runs keeps the window open and asks first (see the close dialog in the UI). A server
  // has to save and stop, and the launcher shouldn't look closed while that happens. A game can't be asked to
  // stop: it ends with the launcher (Windows ends a program's child processes with it), without saving, so the
  // player hears about that too, as well as about an instance that's still getting ready.
  win.on('close', (event) => {
    const runningServers = servers.list().filter((s) => servers.isRunning(s.id));
    const games = [...running.entries()].map(([id, child]) => {
      let name = id;
      try {
        name = instances.get(id).name;
      } catch {
        // deleted meanwhile: its folder name will do
      }
      return { name, preparing: !child };
    });
    if (allowClose || (!runningServers.length && !games.length)) return;
    event.preventDefault();
    if (win.isMinimized()) win.restore();
    win.focus();
    send('close-requested', { servers: runningServers.map((s) => s.name), games });
  });
  // Some mouse drivers send their back and forward buttons as Windows app commands instead of mouse buttons: pass
  // them to the page, which steps through its own history (and ignores the same press arriving both ways).
  win.on('app-command', (_event, command) => {
    if (command === 'browser-backward') send('navigate', 'back');
    if (command === 'browser-forward') send('navigate', 'forward');
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { theme } }); // read by renderer/theme.js
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

app.whenReady().then(() => {
  if (!firstInstance) return;
  sync.relinkAll();
  modrinth.settleAll(); // pack details move to the shared folder they belong with
  unpackIcons();
  if (safeStorage.isEncryptionAvailable()) {
    const cipher = {
      encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
      decrypt: (text) => safeStorage.decryptString(Buffer.from(text, 'base64')),
    };
    accounts.setCipher(cipher);
    playit.setCipher(cipher);
  }
  servers.restoreAllPending();
  registerIpc();
  createWindow();
  startUpdateChecks();
});

app.on('window-all-closed', () => app.quit());

// Servers would keep running headless after the launcher closes, so save and stop them first.
let quitting = false;
// The relay must never outlive the launcher.
app.on('will-quit', () => playit.stopAll());

app.on('before-quit', (event) => {
  if (quitting || !servers.list().some((s) => servers.isRunning(s.id))) return;
  event.preventDefault();
  quitting = true;
  servers.stopAll().finally(() => app.quit());
});

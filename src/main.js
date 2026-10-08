const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, safeStorage } = require('electron');
const fs = require('fs');
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
const borderless = require('./core/borderless');
const authProxy = require('./core/authProxy');
const sandbox = require('./core/sandbox');
const skins = require('./core/skins');
const schematics = require('./core/schematics');
const blocks = require('./core/blocks');
const store = require('./core/store');
const screenshots = require('./core/screenshots');
const { writeJson } = require('./core/util');
const { redactor } = require('./core/redact');
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
// Game output can run to thousands of lines a second while mods load: it goes to the page in batches instead of a
// message per line.
const LOG_INTERVAL = 50;
const pendingLogs = new Map(); // instance id -> lines not sent yet
let logTimer = null;
const log = (id, line) => {
  if (!pendingLogs.has(id)) pendingLogs.set(id, []);
  pendingLogs.get(id).push(line);
  logTimer ??= setTimeout(() => {
    logTimer = null;
    for (const [logId, lines] of pendingLogs) send('log', { id: logId, lines });
    pendingLogs.clear();
  }, LOG_INTERVAL);
};

// Server consoles have no account token to look for, but a plugin may still print a token it was given.
const hideSecrets = redactor();
const serverLog = (id, line) => send('server-log', { id, line: hideSecrets(line) });

servers.setHooks({
  status: (id, state, text = '') => {
    if (state === 'idle' || state === 'error') goOffline(id);
    send('server-status', { id, state, text });
  },
  log: serverLog,
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
    await playit.startAgent(id, (line) => serverLog(id, line));
    if (superseded()) return;
    if (gone()) throw new Error('Server stopped');
    const port = servers.port(id);
    const address = await playit.ensureTunnel(port, (err) => {
      serverLog(id, `[playit] Creating the tunnel failed: ${err.endpoint} answered ${err.reply}`);
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
    if (err.endpoint) serverLog(id, `[playit] ${err.endpoint} answered ${err.reply}`);
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
  let proxy = null;
  try {
    const instance = instances.get(id);
    const gameDir = instances.gameDir(id);
    status(id, 'installing', 'Signing in', 0.01);
    const account = await accounts.launchIdentity();
    const report = (text, progress = null) => status(id, 'installing', text, progress);
    // An instance can have its own memory; otherwise it uses the launcher's default.
    const launchSettings = { ...settings.get(), ...(instance.memoryMb ? { memoryMb: instance.memoryMb } : {}) };
    // An offline account's token is worth nothing, so it needs no protecting.
    if (launchSettings.protectAccount && account.userType === 'msa') {
      proxy = await authProxy.start({ realToken: () => accounts.tokenFor(account.id), log: (text) => log(id, text) });
    }
    const sandboxed = launchSettings.sandbox && sandbox.supported;
    const { java, args, protectedAccount } = await minecraft.prepare(instance, gameDir, launchSettings, account, report,
      { ...options, authProxy: proxy, jvmArgs: sandboxed ? sandbox.jvmArgs(id) : null });
    if (proxy && !protectedAccount) {
      proxy.close();
      proxy = null;
      log(id, `> Account protection needs Minecraft 1.16 or newer, so ${instance.gameVersion} gets your account's real token.`);
    }
    // Before sync copies settings in: if the sandbox can't be set up, nothing is left half done.
    let box = null;
    if (sandboxed) {
      report('Preparing the sandbox', 0.98);
      box = await sandbox.ready(instance, java, (text) => log(id, text));
    }
    unpackIcons(); // a newer version may bring new items
    sync.beforeLaunch(instance);
    const fullscreenKey = launchSettings.borderless ? borderless.prepare(gameDir) : null; // after sync: it copies options.txt in

    log(id, `> Launching ${instance.name} (${instance.gameVersion} ${instance.loader}) as ${account.name}`);
    if (proxy) log(id, "> Account protection is on: the game and its mods get a stand-in for your account's token.");
    if (box) log(id, "> Sandbox is on: the game and its mods can only reach this instance's folder, the game's files and the internet.");
    const child = box ? sandbox.start(box, instance, java, args) : spawn(java, args, { cwd: gameDir, windowsHide: true });
    running.set(id, child);
    // The borderless helper needs the game's own process; in the sandbox that's not child, which is the sandbox's
    // helper, and it says which one it started.
    let windowHelper = null;
    const watchWindow = (pid) => {
      if (launchSettings.borderless) windowHelper = borderless.watch(pid, fullscreenKey, (error) => log(id, `> Borderless window didn't work: ${error}`));
    };
    if (!box) watchWindow(child.pid);
    const screenshotWatcher = screenshots.watch(gameDir, (error) => log(id, `> Screenshots won't be copied to the clipboard: ${error}`));
    const started = Date.now();
    instances.save({ ...instances.get(id), lastPlayed: started });
    status(id, 'running', 'Playing', 1);
    // Once the game has finished loading, what it and its mods did to the settings while starting isn't the
    // player's (sync.js). The sound engine starts last; without a sound device the game says it's turning sound off.
    // The Log tab never shows the account's token (core/redact.js), so the log is safe to share.
    const hide = redactor([account.accessToken, proxy?.token]);
    let loaded = false;
    const onLine = (line) => {
      log(id, hide(line));
      if (loaded || !/Sound engine started|Error starting SoundSystem/.test(line)) return;
      loaded = true;
      try {
        sync.markLoaded(instance);
      } catch (err) {
        log(id, `> Could not note the settings the game loaded with: ${err.message}`);
      }
    };
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    // Until the sandbox's helper has started the game, its stderr is the helper's: the game's process id, an error,
    // or PowerShell's own chatter, which the Log tab doesn't need.
    let gameStarted = !box;
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      if (gameStarted) return onLine(line);
      const pid = line.match(/^HOJICHA-SANDBOX-PID (\d+)/)?.[1];
      if (pid) {
        gameStarted = true;
        watchWindow(Number(pid));
      }
      const error = line.match(/^HOJICHA-SANDBOX-ERROR (.*)/)?.[1];
      if (error) log(id, `> The sandbox couldn't start the game: ${error}`);
    });

    let finished = false;
    const finish = (message, failed = false) => {
      if (finished) return;
      finished = true;
      running.delete(id);
      windowHelper?.kill(); // it also stops by itself when the game is gone
      screenshotWatcher?.close();
      proxy?.close(); // the stand-in token stops working with it
      try {
        const current = instances.get(id);
        instances.save({ ...current, playtime: (current.playtime || 0) + (Date.now() - started) });
      } catch (err) {
        log(id, `> Could not save play time: ${err.message}`);
      }
      try {
        if (!sync.afterExit(instances.get(id))) log(id, "> Settings weren't saved: the game closed before it finished loading.");
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
    proxy?.close();
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

// Once: the mods and packs instances got before store.js become links to one stored copy too, freeing the space the
// duplicates took. It runs in the background, an instance at a time, and leaves an instance alone while it plays or
// changes its mods; one it had to leave gets its turn at the next start.
async function mergeStoredFiles() {
  if (fs.existsSync(paths.storeMergedFile)) return;
  let freed = 0;
  let unfinished = false;
  for (const instance of instances.list()) {
    const busy = () => running.has(instance.id) || modrinth.isWorking(instance.id);
    const result = await store.merge(instances.gameDir(instance.id), busy);
    freed += result.freed;
    unfinished ||= result.stopped;
  }
  if (freed) console.log(`Merged copies of the same mods and packs, freeing ${Math.round(freed / 1024 / 1024)} MB`);
  if (!unfinished) writeJson(paths.storeMergedFile, { mergedAt: Date.now(), freedBytes: freed });
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
  // The skin window (the face in the sidebar or under Accounts). Saved skins live in skins/ (core/skins.js), and the
  // account's own skin joins them when the window opens. Images reach the page as data: URLs, which WebGL can draw.
  const download = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  };
  handle('skins:open', async (accountId) => {
    let profile = null;
    let error = null;
    try {
      profile = await accounts.profile(accountId);
    } catch (err) {
      error = `Mojang couldn't be reached, so capes and changes have to wait. ${err.message}`;
    }
    // Without Mojang: the skin the launcher last saw, which is public (it may still download).
    const known = profile || accounts.summary().accounts.find((a) => a.id === accountId);
    let current = null;
    if (known?.skinUrl) {
      try {
        current = skins.add(await download(known.skinUrl), known.skinVariant);
      } catch (err) {
        console.error('Could not save the current skin:', err.message);
      }
    }
    const capes = await Promise.all((profile?.capes || []).map(async (cape) => ({
      ...cape,
      url: await download(cape.url).then((png) => `data:image/png;base64,${png.toString('base64')}`, () => null),
    })));
    return { skins: skins.list(), current, variant: known?.skinVariant || 'classic', capes, error };
  });
  handle('skins:font', () => {
    const png = icons.fontSheet();
    return png ? `data:image/png;base64,${png.toString('base64')}` : null;
  });
  // Saves skin files ({ name, read }), saying which ones weren't skins.
  const addSkinFiles = (files) => {
    let added = null;
    const problems = [];
    for (const file of files) {
      try {
        added = skins.add(file.read(), 'classic'); // the page guesses the arms from the image
      } catch (err) {
        problems.push(`${file.name}: ${err.message}`);
      }
    }
    return { skins: skins.list(), added, error: problems.join('\n') || null };
  };
  handle('skins:add', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Add skins',
      filters: [{ name: 'Minecraft skin', extensions: ['png'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return addSkinFiles(result.filePaths.map((file) => ({ name: path.basename(file), read: () => fs.readFileSync(file) })));
  });
  // Files dropped on the skin window: the page sends their bytes.
  handle('skins:addDropped', (files) => addSkinFiles(files.map((file) => ({
    name: String(file.name),
    read: () => Buffer.from(file.data),
  }))));
  handle('skins:remove', (skinId) => {
    skins.remove(skinId);
    return skins.list();
  });
  // skinId: a saved skin to wear, with variant arms (or null to keep the skin). capeId: a cape, null for none, or
  // undefined to keep it.
  handle('skins:apply', async (accountId, { skinId, variant, capeId }) => {
    if (skinId) {
      await accounts.changeSkin(accountId, skins.read(skinId), variant);
      skins.setVariant(skinId, variant);
    }
    if (capeId !== undefined) await accounts.setCape(accountId, capeId);
    return accounts.summary();
  });

  // The Schematics view (core/schematics.js lists them; the page reads and draws them with core/blocks.js's block
  // models). Deleting moves a file to the Recycle Bin, so it can be brought back.
  handle('schematics:list', () => schematics.list());
  // Read in a thread of their own; how far it got goes to the page as it reads.
  ipcMain.handle('schematics:load', (event, file, cells, budget) => schematics.load(file, cells, budget, (fraction) => {
    if (!event.sender.isDestroyed()) event.sender.send('schematics:progress', file, fraction);
  }));
  handle('schematics:blocks', () => blocks.get());
  handle('schematics:savePreview', (file, dataUrl, info) => schematics.savePreview(file, dataUrl, info));
  handle('schematics:reveal', (file) => shell.showItemInFolder(schematics.check(file)));
  // The shared folder, or one in it (its names from the top).
  handle('schematics:openFolder', (parts = []) => {
    fs.mkdirSync(paths.schematics, { recursive: true });
    return shell.openPath(schematics.folderDir(parts));
  });
  handle('schematics:import', (files, parent) => schematics.importFiles(files, parent));
  // Schematics (paths) and shared folders (their names from the top) with everything in them.
  handle('schematics:trash', async (files = [], folders = []) => {
    const dirs = folders.map((parts) => {
      if (!Array.isArray(parts) || !parts.length) throw new Error('That folder is gone.');
      return schematics.folderDir(parts);
    });
    for (const file of files.map(schematics.check)) await shell.trashItem(file);
    for (const dir of dirs) await shell.trashItem(dir);
    return schematics.list();
  });
  handle('schematics:group', (files, name, parent) => schematics.group(files, name, parent));
  handle('schematics:groups', (parent) => schematics.groups(parent));
  handle('schematics:rename', (file, name) => schematics.rename(file, name));
  handle('schematics:move', (files, folders, target) => schematics.move(files, folders, target));
  handle('schematics:renameFolder', (parts, name) => schematics.renameFolder(parts, name));
  handle('schematics:newFolder', (parent, name) => schematics.newFolder(parent, name));
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
  // The file is chosen here (or dropped on the window: the preload script gives the dropped file's path, which only a
  // real dropped file has) and remembered, so the page can only install the file the player picked.
  let pickedPack = null;
  const choosePack = (file) => {
    const info = modpacks.describeFile(file);
    pickedPack = file;
    return info;
  };
  handle('modpacks:pickFile', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose a modpack',
      filters: [{ name: 'Modrinth modpack or Prism Launcher export', extensions: ['mrpack', 'zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return choosePack(result.filePaths[0]);
  });
  handle('modpacks:dropFile', (file) => {
    if (typeof file !== 'string' || !/\.(mrpack|zip)$/i.test(file) || !fs.existsSync(file)) {
      throw new Error("That file isn't a modpack. Drop a Modrinth .mrpack file or a Prism Launcher export (.zip).");
    }
    return choosePack(file);
  });
  handle('modpacks:installFile', async (name, trust) => {
    if (!pickedPack) throw new Error('Choose a modpack file first.');
    return installPack(await modpacks.createInstanceFromFile(pickedPack, name, trust === true));
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
    // macOS draws its window buttons top left instead; centred in the title bar, where the logo would be.
    trafficLightPosition: { x: 20, y: Math.round((TITLEBAR_HEIGHT - 14) / 2) },
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
  // If the page ever crashes (out of memory, say), the window would stay empty: start it again instead.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('The launcher page stopped:', details.reason, details.exitCode);
    if (details.reason !== 'clean-exit' && !win.isDestroyed()) win.reload();
  });
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
  store.prune(); // mods and packs no instance has any more (before anything downloads)
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
  setTimeout(() => mergeStoredFiles().catch((err) => console.error('Could not merge mod copies:', err.message)), 5000);
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

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const paths = require('./paths');
const minecraft = require('./minecraft');
const { readJson, writeJson } = require('./util');

// Local servers are existing server folders (Paper, Purpur, vanilla...) the launcher can start.
// They are started with --online-mode false and --host 127.0.0.1: offline accounts can join and nobody else
// can reach the server. The server writes those overrides into server.properties, so the launcher records
// the original values first and puts them back when the server stops (or on next launch after a crash).

const HOST = '127.0.0.1';
const STOP_TIMEOUT_MS = 60000;
const OVERRIDDEN_KEYS = ['online-mode', 'server-ip'];

const file = () => paths.serversFile;
const restoreFile = () => paths.serverRestoreFile;
const processes = new Map(); // id -> { child, ready: Promise, port }
let hooks = { status: () => {}, log: () => {} };

function setHooks(newHooks) {
  hooks = { ...hooks, ...newHooks };
}

function list() {
  try {
    return readJson(file());
  } catch {
    return [];
  }
}

function saveAll(servers) {
  writeJson(file(), servers);
}

function get(id) {
  const server = list().find((s) => s.id === id);
  if (!server) throw new Error('Server not found');
  return server;
}

function detect(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
  const jars = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
  const jar = jars.find((f) => /^(paper|purpur|folia|pufferfish|spigot|fabric-server|server|minecraft_server)/i.test(f)) || jars[0];
  if (!jar) throw new Error('No server .jar found in that folder');

  let mcVersion = null;
  try {
    mcVersion = readJson(path.join(dir, 'version_history.json')).currentVersion.match(/MC: ([^)]+)\)/)?.[1] || null;
  } catch {
    // Not a Paper-family server, or it has never been started.
  }
  mcVersion ??= jar.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] || null;
  if (!mcVersion) throw new Error(`Could not tell which Minecraft version ${jar} is for`);
  return { jar, mcVersion };
}

function add(dir) {
  const servers = list();
  if (servers.some((s) => path.resolve(s.dir) === path.resolve(dir))) throw new Error('That server is already added');
  const server = { id: `server-${Date.now()}`, name: path.basename(dir), dir, memoryMb: 4096, ...detect(dir) };
  servers.push(server);
  saveAll(servers);
  return server;
}

function remove(id) {
  if (processes.has(id)) throw new Error('Stop the server first');
  saveAll(list().filter((s) => s.id !== id));
}

// Re-detects the jar and version in case the server was updated since it was added.
function refresh(id) {
  const servers = list();
  const server = servers.find((s) => s.id === id);
  if (!server) throw new Error('Server not found');
  Object.assign(server, detect(server.dir));
  saveAll(servers);
  return server;
}

function readPort(dir) {
  try {
    const match = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').match(/^server-port=(\d+)/m);
    if (match) return Number(match[1]);
  } catch {
    // Default port below.
  }
  return 25565;
}

// ---------- server.properties protection ----------

function readProperties(dir, keys) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  } catch {
    // No file yet: every key counts as missing.
  }
  const values = {};
  for (const key of keys) {
    const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
    values[key] = match ? match[1].replace(/\r$/, '') : null;
  }
  return values;
}

function writeProperties(dir, values) {
  const propsFile = path.join(dir, 'server.properties');
  if (!fs.existsSync(propsFile)) return;
  let text = fs.readFileSync(propsFile, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*(\r?\n)?`, 'm');
    if (value === null) text = text.replace(pattern, '');
    else if (pattern.test(text)) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`);
    else text += `${text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  }
  fs.writeFileSync(propsFile, text);
}

function pendingRestores() {
  try {
    return readJson(restoreFile());
  } catch {
    return {};
  }
}

function rememberOriginals(dir) {
  const pending = pendingRestores();
  // If a restore is already pending (crash last time), keep those older, genuine originals.
  pending[dir] ??= readProperties(dir, OVERRIDDEN_KEYS);
  writeJson(restoreFile(), pending);
}

function restoreOriginals(dir) {
  const pending = pendingRestores();
  if (!pending[dir]) return;
  writeProperties(dir, pending[dir]);
  delete pending[dir];
  writeJson(restoreFile(), pending);
}

// Called at launcher start-up: undo overrides left behind if the launcher closed while a server ran.
function restoreAllPending() {
  for (const dir of Object.keys(pendingRestores())) {
    try {
      restoreOriginals(dir);
    } catch {
      // Folder gone or unreadable; try again next start.
    }
  }
}

function eulaAccepted(dir) {
  try {
    return /^eula=true/m.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'));
  } catch {
    return false;
  }
}

function isRunning(id) {
  return processes.has(id);
}

function address(id) {
  const proc = processes.get(id);
  return proc ? `${HOST}:${proc.port}` : null;
}

// Starts the server (if needed) and resolves once it has finished loading.
// opUsername, if given, is made operator once the server is up so FAWE/Arceon commands work.
function start(id, { javaPath, opUsername } = {}) {
  if (processes.has(id)) return processes.get(id).ready;
  const entry = { child: null, port: null, ready: null };
  processes.set(id, entry);

  entry.ready = (async () => {
    const server = refresh(id);
    if (!eulaAccepted(server.dir)) {
      throw new Error('This server has not accepted the Minecraft EULA yet. Set eula=true in its eula.txt first.');
    }
    hooks.status(id, 'starting', 'Preparing Java…');
    const java = javaPath || await minecraft.javaFor(server.mcVersion, (text) => hooks.status(id, 'starting', text));
    entry.port = readPort(server.dir);

    rememberOriginals(server.dir);
    const args = [`-Xmx${server.memoryMb}M`, '-jar', server.jar, '--nogui', '--online-mode', 'false', '--host', HOST];
    hooks.log(id, `> Starting ${server.name} (${server.mcVersion}) on ${HOST}:${entry.port}, offline logins allowed`);
    const child = spawn(java, args, { cwd: server.dir, windowsHide: true });
    entry.child = child;
    hooks.status(id, 'starting', 'Starting server…');

    return new Promise((resolve, reject) => {
      let ready = false;
      const onLine = (line) => {
        hooks.log(id, line);
        if (!ready && /\bDone \(\d/.test(line)) {
          ready = true;
          if (opUsername) child.stdin.write(`op ${opUsername}\n`);
          hooks.status(id, 'running', `Running on ${HOST}:${entry.port}`);
          resolve(`${HOST}:${entry.port}`);
        }
      };
      readline.createInterface({ input: child.stdout }).on('line', onLine);
      readline.createInterface({ input: child.stderr }).on('line', onLine);

      let finished = false;
      const finish = (message) => {
        if (finished) return;
        finished = true;
        processes.delete(id);
        try {
          restoreOriginals(server.dir);
        } catch (err) {
          message += ` (could not restore server.properties: ${err.message})`;
        }
        hooks.log(id, `> ${message}`);
        hooks.status(id, 'idle', message);
        if (!ready) reject(new Error(`Server stopped before it finished starting (${message}). Check the console.`));
      };
      child.on('error', (err) => finish(`Failed to start Java: ${err.message}`));
      child.on('exit', (code) => finish(`Server stopped (exit code ${code})`));
    });
  })();

  entry.ready.catch((err) => {
    if (!entry.child) {
      // Failed before the process existed (EULA, Java download...).
      processes.delete(id);
      hooks.status(id, 'error', err.message);
    }
  });
  return entry.ready;
}

function command(id, text) {
  const proc = processes.get(id);
  if (!proc?.child) throw new Error('Server is not running');
  hooks.log(id, `> ${text}`);
  proc.child.stdin.write(`${text}\n`);
}

// Asks the server to save and stop; kills it if it hasn't exited after a minute.
function stop(id) {
  const proc = processes.get(id);
  if (!proc?.child) return Promise.resolve();
  hooks.status(id, 'stopping', 'Stopping…');
  return new Promise((resolve) => {
    const timer = setTimeout(() => proc.child.kill(), STOP_TIMEOUT_MS);
    proc.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.child.stdin.write('stop\n');
  });
}

function stopAll() {
  return Promise.all([...processes.keys()].map(stop));
}

module.exports = { setHooks, list, get, add, remove, start, stop, stopAll, command, isRunning, address, restoreAllPending };

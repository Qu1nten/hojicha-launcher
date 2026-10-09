const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const minecraft = require('./minecraft');
const serverTypes = require('./serverTypes');
const { folderName } = require('./instances');
const { readJson, readJsonOr, writeJson } = require('./util');

// Local servers are server folders (Paper, Purpur, Fabric, vanilla...) the launcher can start: existing ones
// that were added, or new ones created in the launcher's servers\ folder.
// They listen on 127.0.0.1 only, in one of two modes:
// - private (the default): offline mode, so offline accounts can join; nobody else can reach the server.
// - public (online play, see playit.js): online mode with an enforced whitelist, because playit relays players
//   from the internet to 127.0.0.1. Only whitelisted Microsoft accounts get in.
// The launcher writes those settings into server.properties before starting (every server type reads that
// file), records the original values first, and puts them back when the server stops (or on next launch
// after a crash).

const HOST = '127.0.0.1';
const STOP_TIMEOUT_MS = 60000;
const OVERRIDDEN_KEYS = ['online-mode', 'server-ip', 'white-list', 'enforce-whitelist'];
const PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/;

const file = () => paths.serversFile;
const restoreFile = () => paths.serverRestoreFile;
const processes = new Map(); // id -> { child, ready: Promise, port }
let hooks = { status: () => {}, log: () => {} };

function setHooks(newHooks) {
  hooks = { ...hooks, ...newHooks };
}

function list() {
  return readJsonOr(file(), []);
}

function saveAll(servers) {
  writeJson(file(), servers);
}

// Saves the sidebar order: ids, top to bottom. Servers not in ids (none, normally) keep their place at the end.
function reorder(ids) {
  const servers = list();
  const at = (s) => (ids.includes(s.id) ? ids.indexOf(s.id) : Infinity);
  saveAll(servers.sort((a, b) => at(a) - at(b)));
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
  // Plain names like server.jar: Mojang's server jars say their version in a version.json inside. Fabric's
  // fabric-server-launch.jar runs the vanilla jar next to it (server.jar unless its properties file says otherwise).
  if (!mcVersion) {
    for (const candidate of [jar, fabricServerJar(dir), 'server.jar']) {
      mcVersion = candidate && jarVersion(path.join(dir, candidate));
      if (mcVersion) break;
    }
  }
  if (!mcVersion) throw new Error(`Could not tell which Minecraft version ${jar} is for`);
  return { jar, mcVersion };
}

function jarVersion(file) {
  try {
    const entry = new AdmZip(file).getEntry('version.json');
    return entry ? JSON.parse(entry.getData().toString('utf8')).id || null : null;
  } catch {
    return null; // not there, or not a jar Mojang made
  }
}

function fabricServerJar(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'fabric-server-launcher.properties'), 'utf8').match(/^serverJar=(.+)$/m)?.[1].trim() || null;
  } catch {
    return null;
  }
}

function add(dir) {
  const servers = list();
  if (servers.some((s) => path.resolve(s.dir) === path.resolve(dir))) throw new Error('That server is already added');
  const server = { id: `server-${Date.now()}`, name: path.basename(dir), dir, memoryMb: 4096, ...detect(dir) };
  servers.push(server);
  saveAll(servers);
  return server;
}

// A new server in servers\<name>: downloads the server jar and, when the player agreed to the EULA, writes eula.txt.
async function create({ name, type, version, eula }) {
  if (!eula) throw new Error('Agree to the Minecraft EULA to create a server');
  const base = folderName(name.trim() || `${serverTypes.label(type)} ${version}`);
  let dir = path.join(paths.servers, base);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(paths.servers, `${base} (${n})`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await serverTypes.download(type, version, dir);
    const agreed = `# Agreed in Hojicha Launcher on ${new Date().toISOString()}\n# https://aka.ms/MinecraftEULA\n`;
    fs.writeFileSync(path.join(dir, 'eula.txt'), `${agreed}eula=true\n`);
    return add(dir);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true }); // nothing worth keeping in a half-made server
    throw err;
  }
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

// create: write the file when it doesn't exist yet (a server that has never started), instead of skipping it.
function writeProperties(dir, values, { create = false } = {}) {
  const propsFile = path.join(dir, 'server.properties');
  if (!fs.existsSync(propsFile) && !create) return;
  let text = fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*(\r?\n)?`, 'm');
    if (value === null) text = text.replace(pattern, '');
    else if (pattern.test(text)) text = text.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`);
    else text += `${text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  }
  fs.writeFileSync(propsFile, text);
}

function pendingRestores() {
  return readJsonOr(restoreFile(), {});
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

// Players seen while the server ran in offline mode get offline UUIDs (version 3, derived from the name), which
// never match a real Microsoft account. The server keeps them in its player cache and reuses them for
// "whitelist add" and "op", so drop them from all three files before an online start; the whitelist add and op
// commands then look up the real UUIDs.
function dropOfflineEntries(dir) {
  for (const name of ['usercache.json', 'whitelist.json', 'ops.json']) {
    const file = path.join(dir, name);
    try {
      const entries = readJson(file);
      const online = entries.filter((e) => e.uuid?.[14] !== '3');
      if (online.length !== entries.length) writeJson(file, online);
    } catch {
      // File not there yet.
    }
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
    if (server.public) dropOfflineEntries(server.dir);
    const args = [`-Xmx${server.memoryMb}M`, '-jar', server.jar, '--nogui'];
    writeProperties(server.dir, server.public
      ? { 'online-mode': 'true', 'server-ip': HOST, 'white-list': 'true', 'enforce-whitelist': 'true' }
      : { 'online-mode': 'false', 'server-ip': HOST }, { create: true });
    hooks.log(id, server.public
      ? `> Starting ${server.name} (${server.mcVersion}) for online play: whitelisted Microsoft accounts only`
      : `> Starting ${server.name} (${server.mcVersion}) on ${HOST}:${entry.port}, offline logins allowed`);
    const child = spawn(java, args, { cwd: server.dir, windowsHide: true });
    entry.child = child;
    hooks.status(id, 'starting', 'Starting server…');

    return new Promise((resolve, reject) => {
      let ready = false;
      const onLine = (line) => {
        hooks.log(id, line);
        if (!ready && /\bDone \(\d/.test(line)) {
          ready = true;
          if (server.public) {
            for (const name of new Set([opUsername, ...(server.whitelist || [])].filter(Boolean))) child.stdin.write(`whitelist add ${name}\n`);
          }
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

// ---------- Online play settings ----------

function update(id, change) {
  const servers = list();
  const server = servers.find((s) => s.id === id);
  if (!server) throw new Error('Server not found');
  change(server);
  saveAll(servers);
  return server;
}

// Takes effect the next time the server starts (it changes server.properties and how the server is reached).
function setPublic(id, on) {
  if (processes.has(id)) throw new Error('Stop the server first');
  return update(id, (server) => { server.public = Boolean(on); });
}

function addToWhitelist(id, name) {
  name = name.trim();
  if (!PLAYER_NAME.test(name)) throw new Error(`"${name}" isn't a Minecraft name (3 to 16 letters, numbers or _)`);
  const server = update(id, (s) => {
    s.whitelist = [...new Set([...(s.whitelist || []), name])].sort((a, b) => a.localeCompare(b));
  });
  if (server.public && processes.get(id)?.child) command(id, `whitelist add ${name}`);
  return server;
}

// Takes the player off the server's own whitelist too: through the console while the server runs (it keeps the list
// in memory and would write it back), otherwise straight from whitelist.json. Starting only ever adds names.
function removeFromWhitelist(id, name) {
  const server = update(id, (s) => { s.whitelist = (s.whitelist || []).filter((n) => n !== name); });
  if (processes.get(id)?.child) command(id, `whitelist remove ${name}`);
  else dropFromWhitelistFile(server.dir, name);
  return server;
}

function dropFromWhitelistFile(dir, name) {
  const file = path.join(dir, 'whitelist.json');
  let entries;
  try {
    entries = readJson(file);
  } catch {
    return; // no whitelist yet
  }
  const kept = entries.filter((e) => e.name?.toLowerCase() !== name.toLowerCase()); // names aren't case-sensitive
  if (kept.length !== entries.length) writeJson(file, kept);
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

module.exports = {
  setHooks, list, reorder, get, add, create, remove, update, setPublic, addToWhitelist, removeFromWhitelist,
  start, stop, stopAll, command, isRunning, address, restoreAllPending,
  port: (id) => readPort(get(id).dir),
};

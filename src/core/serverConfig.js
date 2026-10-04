const fs = require('fs');
const path = require('path');

// Reading and editing a server's own settings: server.properties as key/value pairs for the Settings tab, and its
// config files as text for the Files tab. Everything stays inside the server's folder.

// Set by servers.js every time a server starts (online play, local-only), so the Settings tab leaves them alone.
const MANAGED_KEYS = ['online-mode', 'server-ip', 'white-list', 'enforce-whitelist'];

const MAX_FILE_BYTES = 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.properties', '.yml', '.yaml', '.toml', '.json', '.json5', '.txt', '.conf', '.cfg', '.ini']);
// Files the server or the launcher keep up to date themselves; editing them by hand only causes confusion.
const SKIP_FILES = new Set([
  'ops.json', 'whitelist.json', 'usercache.json', 'banned-players.json', 'banned-ips.json',
  'version_history.json', 'eula.txt', 'permissions.yml', 'help.yml',
]);

// ---------- server.properties (Java properties format) ----------

const unescape = (s) => s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
  if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
  return { t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c;
});

// Backslashes and line breaks are escaped, and so is anything outside ASCII (as \uXXXX), which every Minecraft
// version reads back the same way. A leading space would otherwise be dropped.
const escapeValue = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/\n/g, '\\n')
  .replace(/\r/g, '\\r')
  .replace(/^ /, '\\ ')
  .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// The key on a properties line ends at the first unescaped "=", ":" or space.
function splitLine(line) {
  const trimmed = line.replace(/^\s+/, '');
  if (!trimmed || trimmed[0] === '#' || trimmed[0] === '!') return null;
  const match = trimmed.match(/^((?:\\.|[^=:\s\\])*)\s*[=:\s]\s*(.*)$/) || [null, trimmed, ''];
  return { key: unescape(match[1]), value: unescape(match[2]) };
}

function propertiesFile(dir) {
  return path.join(dir, 'server.properties');
}

// All properties of a server, or null when it has never been started (the server writes the file on first start).
function readProperties(dir) {
  let text;
  try {
    text = fs.readFileSync(propertiesFile(dir), 'utf8');
  } catch {
    return null;
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const entry = splitLine(line);
    if (entry) values[entry.key] = entry.value;
  }
  return values;
}

// Changes some properties, keeping every other line (comments, order, unknown keys) as it was.
function writeProperties(dir, changes) {
  for (const key of Object.keys(changes)) {
    if (MANAGED_KEYS.includes(key)) throw new Error(`${key} is set by Hojicha each time the server starts`);
    if (!/^[a-z0-9.\-_]+$/i.test(key)) throw new Error(`"${key}" isn't a server setting`);
  }
  const file = propertiesFile(dir);
  if (!fs.existsSync(file)) throw new Error('Start the server once first: it creates its settings file then.');
  const original = fs.readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const remaining = { ...changes };
  const lines = original.split(/\r?\n/).map((line) => {
    const entry = splitLine(line);
    if (!entry || !(entry.key in remaining)) return line;
    const value = remaining[entry.key];
    delete remaining[entry.key];
    return `${entry.key}=${escapeValue(value)}`;
  });
  if (lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(remaining)) lines.push(`${key}=${escapeValue(value)}`);
  writeAtomic(file, lines.join(eol) + eol);
  return readProperties(dir);
}

// ---------- Config files ----------

// A path from the UI, as a real file inside the server folder (never outside it, also not through a link).
function resolveInside(dir, relative) {
  const root = fs.realpathSync(dir);
  const target = path.resolve(root, relative);
  if (path.relative(root, target).startsWith('..') || path.isAbsolute(path.relative(root, target))) {
    throw new Error('That file is outside the server folder');
  }
  const real = fs.realpathSync(target);
  if (path.relative(root, real).startsWith('..')) throw new Error('That file is outside the server folder');
  if (!TEXT_EXTENSIONS.has(path.extname(real).toLowerCase())) throw new Error('Only settings files can be edited here');
  return real;
}

// The editable settings files: the server's own (top level), config\ (Paper, Fabric mods) and each plugin's folder.
function listFiles(dir) {
  const found = [];
  const add = (relative, group) => {
    try {
      const stat = fs.statSync(path.join(dir, relative));
      if (stat.isFile() && stat.size <= MAX_FILE_BYTES) found.push({ path: relative.replace(/\\/g, '/'), group, size: stat.size });
    } catch {
      // Vanished while listing.
    }
  };
  const textFiles = (relative) => {
    try {
      return fs.readdirSync(path.join(dir, relative), { withFileTypes: true })
        .filter((e) => e.isFile() && TEXT_EXTENSIONS.has(path.extname(e.name).toLowerCase()) && !SKIP_FILES.has(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  };
  const folders = (relative) => {
    try {
      return fs.readdirSync(path.join(dir, relative), { withFileTypes: true })
        // Dot folders (like Paper's .paper-remapped cache) aren't settings.
        .filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  };

  for (const name of textFiles('.')) add(name, 'Server');
  for (const name of textFiles('config')) add(path.join('config', name), 'config');
  for (const sub of folders('config')) for (const name of textFiles(path.join('config', sub))) add(path.join('config', sub, name), 'config');
  for (const plugin of folders('plugins')) {
    for (const name of textFiles(path.join('plugins', plugin))) add(path.join('plugins', plugin, name), `Plugin: ${plugin}`);
  }
  // server.properties first: it's the one people look for.
  return found.sort((a, b) => (b.path === 'server.properties') - (a.path === 'server.properties'));
}

function readFile(dir, relative) {
  const file = resolveInside(dir, relative);
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) throw new Error('That file is too big to edit here');
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\u0000')) throw new Error("That file isn't text");
  return { text, modified: stat.mtimeMs };
}

// modified: the time the file had when it was opened. If something else (usually the server) changed it since,
// saving is refused so those changes aren't silently lost.
function writeFile(dir, relative, text, modified) {
  const file = resolveInside(dir, relative);
  if (modified != null && Math.abs(fs.statSync(file).mtimeMs - modified) > 1) {
    throw new Error('This file changed on disk since you opened it. Reload it to see the new version.');
  }
  writeAtomic(file, text);
  return { modified: fs.statSync(file).mtimeMs };
}

// Write to a temporary file next to it, then swap it in, so a crash never leaves half a settings file.
function writeAtomic(file, text) {
  const temp = `${file}.hojicha-saving`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

module.exports = { MANAGED_KEYS, readProperties, writeProperties, listFiles, readFile, writeFile };

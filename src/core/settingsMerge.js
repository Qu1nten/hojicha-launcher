const path = require('path');

// Three-way merges of mod settings files (sync.js). base is the file when the game had finished loading, local the
// file when it closed, shared the copy all instances share. The shared copy takes every setting that changed between
// base and local and keeps the rest, so what one instance doesn't have or didn't change is never undone. Settings an
// instance dropped are left alone: a setting is never removed from the shared copy.
// Returns the new shared text, or null when the format can't be merged setting by setting.
function merge(file, base, local, shared) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return mergeJson(base, local, shared);
  if (ext === '.properties') return mergeLines(base, local, shared, 'properties');
  if (ext === '.ini') return mergeLines(base, local, shared, 'ini');
  if (ext === '.toml') return mergeLines(base, local, shared, 'toml');
  return null;
}

// ---------- JSON ----------
// Objects merge key by key, all the way down. Anything else (a list, a number) is one setting: a list changed in
// one instance replaces the shared list whole.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The settings that differ between base and local, as [path, value].
function changes(base, local, at = [], out = []) {
  if (isObject(base) && isObject(local)) {
    for (const key of Object.keys(local)) {
      if (key !== '__proto__') changes(base[key], local[key], [...at, key], out);
    }
  } else if (base === undefined && isObject(local) && at.length) {
    for (const key of Object.keys(local)) { // a new section: each of its settings is new
      if (key !== '__proto__') changes(undefined, local[key], [...at, key], out);
    }
  } else if (!same(base, local)) {
    out.push([at, local]);
  }
  return out;
}

function setAt(target, at, value) {
  let node = target;
  for (const key of at.slice(0, -1)) {
    if (!isObject(node[key])) node[key] = {};
    node = node[key];
  }
  node[at[at.length - 1]] = value;
}

function mergeJson(baseText, localText, sharedText) {
  let base, local, shared;
  try {
    base = baseText ? JSON.parse(baseText) : undefined;
    local = JSON.parse(localText);
    shared = JSON.parse(sharedText);
  } catch {
    return null; // JSON with comments (JSON5) or a broken file
  }
  if (!isObject(local) || !isObject(shared)) return null;
  const changed = changes(isObject(base) ? base : {}, local).filter(([at, value]) => !same(getAt(shared, at), value));
  if (!changed.length) return sharedText;
  for (const [at, value] of changed) setAt(shared, at, value);
  const indent = /\n([ \t]+)"/.exec(localText)?.[1] ?? 2; // written the way the mod writes it
  return JSON.stringify(shared, null, indent) + (/\n$/.test(localText) ? '\n' : '');
}

function getAt(target, at) {
  let node = target;
  for (const key of at) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

// ---------- key = value lines ----------
// .properties, .ini and .toml: a setting is a key in a [section]. A changed setting's line is copied over the
// shared one as the mod wrote it, so comments and the order of the shared file stay. Anything the simple line view
// can't follow (a value over several lines, [[arrays of tables]], a key twice) leaves the file to be used whole.

// lines, entries (section + key -> { index, value, section }) and where each section ends, or null.
function parseLines(text, kind) {
  const lines = text.split(/\r?\n/);
  const entries = new Map();
  const ends = new Map([['', -1]]); // section -> index of its last line; '' is the part before any section
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^[#;!]/.test(line)) continue;
    if (line.startsWith('[')) {
      const header = /^\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
      if (kind === 'properties' || !header) return null;
      section = header[1].trim();
      if (ends.has(section) && section) return null;
      ends.set(section, i);
      continue;
    }
    const pair = (kind === 'properties' ? /^([^=:]+?)\s*[=:]\s*(.*)$/ : /^([^=]+?)\s*=\s*(.*)$/).exec(line);
    if (!pair) return null;
    const value = pair[2];
    if (kind === 'properties' && /(^|[^\\])(\\\\)*\\$/.test(value)) return null; // continues on the next line
    if (kind === 'toml' && !closedOnLine(value)) return null;
    const id = `${section}\u0000${pair[1]}`;
    if (entries.has(id)) return null;
    entries.set(id, { index: i, value, section });
    ends.set(section, i);
  }
  return { lines, entries, ends };
}

// False for a TOML value that goes on over the next lines: a multi-line string, or a list or table left open.
function closedOnLine(value) {
  const triple = /^("""|''')/.exec(value)?.[1];
  if (triple) return value.indexOf(triple, 3) !== -1;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') break;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth === 0 && !quote;
}

function mergeLines(baseText, localText, sharedText, kind) {
  const base = parseLines(baseText, kind);
  const local = parseLines(localText, kind);
  const shared = parseLines(sharedText, kind);
  if (!base || !local || !shared) return null;
  const replace = new Map(); // shared line index -> the line from local
  const add = new Map(); // section -> lines it doesn't have yet
  for (const [id, entry] of local.entries) {
    if (base.entries.get(id)?.value === entry.value) continue; // unchanged this session
    const line = local.lines[entry.index];
    const at = shared.entries.get(id);
    if (at) {
      if (at.value !== entry.value) replace.set(at.index, line);
    } else {
      add.set(entry.section, [...(add.get(entry.section) || []), line]);
    }
  }
  if (!replace.size && !add.size) return sharedText;

  // New settings go at the end of their section; a section the shared file doesn't have goes at the end.
  const lines = [...shared.lines];
  const trailing = lines.length > 1 && lines[lines.length - 1] === '' ? lines.pop() : null;
  const after = new Map(); // line index -> lines to put after it (-1: before everything)
  const tail = [];
  for (const [section, added] of add) {
    if (shared.ends.has(section)) after.set(shared.ends.get(section), added);
    else tail.push('', `[${section}]`, ...added);
  }
  const out = [...(after.get(-1) || [])];
  lines.forEach((line, i) => out.push(replace.get(i) ?? line, ...(after.get(i) || [])));
  out.push(...tail);
  if (trailing !== null) out.push(trailing);
  return out.join(/\r\n/.test(sharedText) ? '\r\n' : '\n');
}

module.exports = { merge };

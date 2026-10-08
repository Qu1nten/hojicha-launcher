const path = require('path');
const paths = require('./paths');
const { mavenPath } = require('./minecraft');
const { readJsonOr, writeJson } = require('./util');

// A Prism Launcher (or MultiMC) instance export is a zip of the instance folder: instance.cfg (name, memory),
// mmc-pack.json (its components: Minecraft, a mod loader, and any custom ones), patches/<uid>.json describing the
// custom components (another main class, extra libraries), libraries/ for the jars those bring along instead of
// downloading, and the game folder itself as .minecraft/ (minecraft/ in older exports). Some exports wrap it all in
// one more folder. Installing one makes a new instance; modpacks.js does that, this reads the zip.

// Components Hojicha provides itself, by uid; a pack can't change them (that needs a patch for them).
const MINECRAFT = 'net.minecraft';
const FABRIC = 'net.fabricmc.fabric-loader';
const PROVIDED = new Set([MINECRAFT, FABRIC, 'net.fabricmc.intermediary', 'org.lwjgl', 'org.lwjgl3']);
const OTHER_LOADERS = {
  'net.minecraftforge': 'Forge',
  'net.neoforged': 'NeoForge',
  'org.quiltmc.quilt-loader': 'Quilt',
  'com.mumfrey.liteloader': 'LiteLoader',
};
// What a custom component's patch may hold. Anything else (jar mods, another game jar, old-style tweakers, Java
// agents...) is something Hojicha can't launch.
const PATCH_KEYS = new Set([
  'formatVersion', 'uid', 'name', 'version', 'releaseTime', 'type', 'order', 'requires', 'conflicts', 'volatile',
  'mainClass', 'libraries', '+libraries', '+jvmArgs', '+traits', 'compatibleJavaMajors', 'compatibleJavaName',
]);
// A library's maven name: group:artifact:version[:classifier][@extension], no part of it "." or "..".
const LIBRARY_NAME = /^[\w.+-]+(:[\w.+-]+){2,3}(@\w+)?$/;

// instance.cfg is an INI file, sometimes with a [General] heading.
function readCfg(text) {
  const cfg = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^=#;[\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (match) cfg[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return cfg;
}

// The folder in the zip holding mmc-pack.json ('' for the top), or null when the zip isn't an instance export.
function findRoot(zip) {
  const found = zip.getEntries().map((e) => e.entryName).filter((name) => /(^|\/)mmc-pack\.json$/.test(name));
  if (!found.length) return null;
  const top = found.sort((a, b) => a.split('/').length - b.split('/').length)[0];
  return top.slice(0, -'mmc-pack.json'.length);
}

const unsafePath = (p) => typeof p !== 'string' || path.isAbsolute(p) || p.split(/[\\/]/).some((part) => part === '..');

// Checks a custom component's patch and returns what launching needs from it, plus the jars it brings along.
function readPatch(zip, root, patch, label) {
  const unsupported = Object.keys(patch).filter((key) => !PATCH_KEYS.has(key));
  if (unsupported.length) throw new Error(`This pack's ${label} needs launcher features Hojicha doesn't have (${unsupported.join(', ')}).`);
  const libraries = [...(patch.libraries || []), ...(patch['+libraries'] || [])];
  const localJars = [];
  for (const lib of libraries) {
    const name = String(lib.name);
    const artifacts = [lib.downloads?.artifact, ...Object.values(lib.downloads?.classifiers || {})].filter(Boolean);
    const urls = [lib.url, ...artifacts.map((a) => a.url)].filter(Boolean);
    if (!LIBRARY_NAME.test(name) || name.split(/[:@]/).some((part) => /^\.+$/.test(part))
      || artifacts.some((a) => a.path !== undefined && unsafePath(a.path))) {
      throw new Error(`This pack's ${label} has a library with an unsafe name: ${name}`);
    }
    if (urls.some((url) => !url.startsWith('https://'))) throw new Error(`This pack's ${label} downloads a library without https: ${name}`);
    if (lib['MMC-hint'] === 'local') {
      // Prism keeps these in the instance's libraries folder by file name.
      const file = path.basename(mavenPath(name));
      const entry = `${root}libraries/${file}`;
      if (!zip.getEntry(entry)) throw new Error(`The pack is missing ${file}, which its ${label} needs.`);
      localJars.push({ entry, file });
    }
  }
  const jvmArgs = patch['+jvmArgs'] || [];
  if (!Array.isArray(jvmArgs) || jvmArgs.some((arg) => typeof arg !== 'string')) throw new Error(`This pack's ${label} has damaged Java arguments.`);
  return {
    patch: { uid: patch.uid, name: label, mainClass: patch.mainClass || null, libraries, jvmArgs },
    localJars,
  };
}

// The pack.json a Supernova pack keeps in its game folder: its name, description and the server its startup code
// downloads from.
function supernovaMeta(zip, gamePrefix) {
  try {
    const meta = JSON.parse(zip.getEntry(`${gamePrefix}pack.json`).getData().toString('utf8')).meta || {};
    const { protocol, hostname } = new URL(meta.url);
    return { name: meta.name, description: meta.description, source: ['https:', 'http:'].includes(protocol) ? hostname : null };
  } catch {
    return {};
  }
}

// Everything installing the export needs, or null when the zip isn't one. fileName names the pack when nothing
// inside does.
function read(zip, fileName) {
  const root = findRoot(zip);
  if (root === null) return null;
  const json = (name) => {
    const entry = zip.getEntry(root + name);
    if (!entry) return null;
    try {
      return JSON.parse(entry.getData().toString('utf8'));
    } catch {
      throw new Error(`The pack's ${name} is damaged.`);
    }
  };
  const pack = json('mmc-pack.json');
  const cfg = readCfg(zip.getEntry(`${root}instance.cfg`)?.getData().toString('utf8') || '');

  let gameVersion = null;
  let loaderVersion = null;
  const patches = [];
  const localJars = [];
  for (const component of pack.components || []) {
    if (component.disabled) continue;
    const { uid } = component;
    if (OTHER_LOADERS[uid]) throw new Error(`This pack needs ${OTHER_LOADERS[uid]}, and Fabric is the only mod loader Hojicha supports.`);
    const patch = json(`patches/${uid}.json`);
    const label = component.cachedName || patch?.name || uid;
    if (PROVIDED.has(uid)) {
      if (patch) throw new Error(`This pack changes ${label} itself, which Hojicha can't do.`);
      if (uid === MINECRAFT) gameVersion = component.version;
      if (uid === FABRIC) loaderVersion = component.version;
      continue;
    }
    if (!patch) throw new Error(`This pack needs ${label}, which Hojicha doesn't know.`);
    const custom = readPatch(zip, root, patch, label);
    patches.push(custom.patch);
    localJars.push(...custom.localJars);
  }
  if (!gameVersion) throw new Error("The pack doesn't say which Minecraft version it needs.");

  const entries = zip.getEntries();
  const gamePrefix = [`${root}.minecraft/`, `${root}minecraft/`].find((prefix) => entries.some((e) => e.entryName.startsWith(prefix)))
    ?? `${root}.minecraft/`;
  const supernova = supernovaMeta(zip, gamePrefix);
  const memoryMb = cfg.OverrideMemory === 'true' ? Number(cfg.MaxMemAlloc) : NaN;
  const runsCode = patches.some((p) => p.mainClass || p.libraries.length || p.jvmArgs.length);
  return {
    title: supernova.name || cfg.name || path.basename(fileName, path.extname(fileName)),
    description: supernova.description || '',
    gameVersion,
    loaderVersion,
    memoryMb: memoryMb >= 512 ? memoryMb : null,
    gamePrefix,
    patches,
    localJars,
    mods: entries.filter((e) => !e.isDirectory && e.entryName.startsWith(`${gamePrefix}mods/`) && e.entryName.endsWith('.jar')).length,
    // Custom components run the pack's own code before the game (what they're called, and where they download
    // from when the pack says).
    startup: runsCode ? { names: patches.map((p) => p.name), source: supernova.source || null } : null,
  };
}

// ---------- Trust ----------
// Packs with their own startup code install only once the player says they trust it. Trusting a pack that names
// its server trusts that server's later packs too.

const trustedSources = () => readJsonOr(paths.trustedPacksFile, []);

function isTrusted(startup) {
  return !startup || Boolean(startup.source && trustedSources().includes(startup.source));
}

function trust(startup) {
  if (!startup?.source || isTrusted(startup)) return;
  writeJson(paths.trustedPacksFile, [...trustedSources(), startup.source]);
}

module.exports = { read, isTrusted, trust };

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const instances = require('./instances');
const { readJson, writeJson } = require('./util');
const { LAUNCHER_VERSION, fetchJson, downloadFile, runPool } = require('./http');
const { ensureJava } = require('./java');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const RESOURCES_URL = 'https://resources.download.minecraft.net';
const MOJANG_LIBRARIES = 'https://libraries.minecraft.net/';

const OS_NAME = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform];

// ---------- Version lists ----------

let manifestCache = null;
async function getVersionManifest() {
  if (!manifestCache) manifestCache = await fetchJson(MANIFEST_URL);
  return manifestCache;
}

async function listGameVersions() {
  const manifest = await getVersionManifest();
  return manifest.versions.map((v) => ({ id: v.id, type: v.type }));
}

async function latestFabricLoader(gameVersion) {
  const loaders = await fetchJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}`);
  if (!loaders.length) throw new Error(`Fabric does not support Minecraft ${gameVersion}`);
  return (loaders.find((l) => l.loader.stable) || loaders[0]).loader.version;
}

// ---------- Version JSONs ----------
// Each version JSON is cached under meta/versions/<id>/<id>.json so installed instances launch offline.

async function getVanillaVersionJson(id) {
  const file = path.join(paths.versions, id, `${id}.json`);
  if (!fs.existsSync(file)) {
    const entry = (await getVersionManifest()).versions.find((v) => v.id === id);
    if (!entry) throw new Error(`Unknown Minecraft version ${id}`);
    await downloadFile(entry.url, file, { sha1: entry.sha1 });
  }
  return readJson(file);
}

async function getFabricVersionJson(gameVersion, loaderVersion) {
  const id = `fabric-loader-${loaderVersion}-${gameVersion}`;
  const file = path.join(paths.versions, id, `${id}.json`);
  if (!fs.existsSync(file)) {
    const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
    writeJson(file, await fetchJson(url));
  }
  return readJson(file);
}

function libraryKey(name) {
  const [group, artifact, , classifier] = name.split('@')[0].split(':');
  return `${group}:${artifact}:${classifier || ''}`;
}

// Applies a loader profile (child) on top of the vanilla version (parent).
function mergeVersions(parent, child) {
  const childKeys = new Set(child.libraries.map((l) => libraryKey(l.name)));
  return {
    ...parent,
    id: child.id,
    mainClass: child.mainClass || parent.mainClass,
    libraries: [...child.libraries, ...parent.libraries.filter((l) => !childKeys.has(libraryKey(l.name)))],
    arguments: parent.arguments && {
      game: [...(parent.arguments.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments.jvm || []), ...(child.arguments?.jvm || [])],
    },
  };
}

// Applies an instance's custom components (from a Prism Launcher pack, see prismPacks.js) on top: another main
// class, extra libraries (replacing any of the same name) and Java arguments. A library the pack brought along as a
// file ("MMC-hint": "local") is read from the instance's own libraries folder.
function applyPatches(version, instance) {
  for (const patch of instance.patches || []) {
    const libraries = patch.libraries.map((lib) => (lib['MMC-hint'] === 'local'
      ? { ...lib, localPath: path.join(instances.librariesDir(instance.id), path.basename(mavenPath(lib.name))) }
      : lib));
    const keys = new Set(libraries.map((l) => libraryKey(l.name)));
    version = {
      ...version,
      mainClass: patch.mainClass || version.mainClass,
      libraries: [...libraries, ...version.libraries.filter((l) => !keys.has(libraryKey(l.name)))],
      extraJvm: [...(version.extraJvm || []), ...patch.jvmArgs],
    };
  }
  return version;
}

// Returns the full version JSON for an instance; jarId is the vanilla version whose client jar is used.
async function resolveVersion(instance) {
  const vanilla = await getVanillaVersionJson(instance.gameVersion);
  vanilla.jarId = vanilla.id;
  const version = instance.loader === 'fabric'
    ? mergeVersions(vanilla, await getFabricVersionJson(instance.gameVersion, instance.loaderVersion))
    : vanilla;
  return applyPatches(version, instance);
}

// ---------- Rules & libraries ----------

function archMatches(arch) {
  if (arch === 'x86') return process.arch === 'ia32';
  return arch === process.arch;
}

function ruleMatches(rule, features) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== OS_NAME) return false;
    if (rule.os.arch && !archMatches(rule.os.arch)) return false;
  }
  if (rule.features) {
    for (const [key, value] of Object.entries(rule.features)) {
      if (Boolean(features[key]) !== value) return false;
    }
  }
  return true;
}

// Mojang rule semantics: start disallowed, the last matching rule decides.
function rulesAllow(rules, features = {}) {
  if (!rules?.length) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allowed = rule.action === 'allow';
  }
  return allowed;
}

// Newer versions list natives for every arch (natives-windows, natives-windows-arm64, ...); keep only ours.
function isForeignNative(name) {
  const match = name.match(/:natives-([a-z]+)(?:-([a-z0-9_]+))?$/);
  if (!match) return false;
  const os = match[1] === 'macos' ? 'osx' : match[1];
  if (os !== OS_NAME) return true;
  const ourArch = process.arch === 'x64' ? undefined : process.arch === 'ia32' ? 'x86' : process.arch;
  return match[2] !== ourArch;
}

function mavenPath(name) {
  const [coords, ext = 'jar'] = name.split('@');
  const [group, artifact, version, classifier] = coords.split(':');
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

function toDownload(artifact, fallbackPath) {
  const rel = artifact.path || fallbackPath;
  return { path: path.join(paths.libraries, rel), url: artifact.url, sha1: artifact.sha1, size: artifact.size };
}

// Splits the version's libraries into classpath jars and native jars that need extracting.
function collectLibraries(version) {
  const classpath = [];
  const natives = [];
  for (const lib of version.libraries) {
    if (!rulesAllow(lib.rules) || isForeignNative(lib.name)) continue;
    if (lib.localPath) {
      classpath.push({ path: lib.localPath, local: true }); // nothing to download
      continue;
    }
    const downloads = lib.downloads;
    if (downloads?.artifact) {
      const entry = toDownload(downloads.artifact, mavenPath(lib.name));
      classpath.push(entry);
      if (lib.name.includes(':natives-')) natives.push(entry);
    } else if (!downloads) {
      // Fabric-style entry: just a maven name and repository url.
      const rel = mavenPath(lib.name);
      classpath.push({ path: path.join(paths.libraries, rel), url: (lib.url || MOJANG_LIBRARIES) + rel, sha1: lib.sha1, size: lib.size });
    }
    // Pre-1.19 versions ship natives as a classifier of the library.
    const nativeKey = lib.natives?.[OS_NAME];
    if (nativeKey) {
      const classifier = nativeKey.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
      const artifact = downloads?.classifiers?.[classifier];
      if (artifact) natives.push(toDownload(artifact, mavenPath(`${lib.name}:${classifier}`)));
    }
  }
  return { classpath, natives };
}

function extractNatives(jars, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const jar of jars) {
    for (const entry of new AdmZip(jar).getEntries()) {
      if (entry.isDirectory || entry.entryName.startsWith('META-INF/')) continue;
      if (!/\.(dll|so|dylib|jnilib)$/i.test(entry.entryName)) continue;
      const target = path.join(dir, path.basename(entry.entryName));
      // Skip existing files: another running instance of the same version may have them locked.
      if (!fs.existsSync(target)) fs.writeFileSync(target, entry.getData());
    }
  }
}

// ---------- Install ----------

async function installAssets(version, report) {
  const index = version.assetIndex;
  const indexFile = path.join(paths.assets, 'indexes', `${index.id}.json`);
  await downloadFile(index.url, indexFile, { sha1: index.sha1, size: index.size });
  const { objects, virtual, map_to_resources: mapToResources } = readJson(indexFile);

  const unique = new Map();
  for (const obj of Object.values(objects)) unique.set(obj.hash, obj);
  await runPool([...unique.values()], 16, (obj) => {
    const sub = obj.hash.slice(0, 2);
    return downloadFile(`${RESOURCES_URL}/${sub}/${obj.hash}`, path.join(paths.assets, 'objects', sub, obj.hash), { sha1: obj.hash, size: obj.size });
  }, (done, total) => report(`Preparing assets (${done} of ${total})`, 0.25 + 0.6 * (done / total)));

  // Very old versions read assets by name instead of by hash.
  if (virtual || mapToResources) {
    const virtualDir = path.join(paths.assets, 'virtual', index.id);
    for (const [name, obj] of Object.entries(objects)) {
      const target = path.join(virtualDir, name);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(paths.assets, 'objects', obj.hash.slice(0, 2), obj.hash), target);
    }
    return { gameAssets: virtualDir, mapToResources: Boolean(mapToResources) };
  }
  return { gameAssets: paths.assets, mapToResources: false };
}

async function installGame(version, report) {
  const client = version.downloads.client;
  const clientJar = path.join(paths.versions, version.jarId, `${version.jarId}.jar`);
  report('Preparing the game', 0.06);
  await downloadFile(client.url, clientJar, { sha1: client.sha1, size: client.size });

  const { classpath, natives } = collectLibraries(version);
  const missing = classpath.find((lib) => lib.local && !fs.existsSync(lib.path));
  if (missing) throw new Error(`${path.basename(missing.path)} is missing from this instance's libraries folder. Install the modpack again.`);
  const unique = new Map();
  for (const lib of [...classpath, ...natives]) if (lib.url) unique.set(lib.path, lib);
  await runPool([...unique.values()], 8, (lib) => downloadFile(lib.url, lib.path, lib),
    (done, total) => report(`Preparing libraries (${done} of ${total})`, 0.08 + 0.17 * (done / total)));

  const nativesDir = path.join(paths.versions, version.jarId, 'natives');
  extractNatives(natives.map((n) => n.path), nativesDir);

  const assets = await installAssets(version, report);
  return { clientJar, classpath: classpath.map((l) => l.path), nativesDir, ...assets };
}

// ---------- Launch ----------

// Minecraft 1.16 and newer (authlib 1.6 and up) read where Mojang's account services are from Java system properties,
// which is what lets core/authProxy.js stand in for them. Older versions have the addresses built in.
function readsServiceHosts(version) {
  const lib = version.libraries.find((l) => l.name.startsWith('com.mojang:authlib:'));
  const [major, minor] = (lib ? lib.name.split(':')[2] : '0').split('.').map(Number);
  return major > 1 || (major === 1 && minor >= 6);
}

// account = { name, uuid, accessToken, userType } from accounts.launchIdentity().
// options.join = "host:port" makes the game connect to that server straight after starting.
// options.authProxy = a started core/authProxy.js; used when the version can talk to it (see readsServiceHosts).
function buildArgs(version, install, gameDir, settings, account, options = {}) {
  const classpath = [...install.classpath, install.clientJar].join(path.delimiter);
  const proxy = options.authProxy && readsServiceHosts(version) ? options.authProxy : null;
  const accessToken = proxy ? proxy.token : account.accessToken;
  const vars = {
    auth_player_name: account.name,
    auth_uuid: account.uuid,
    auth_access_token: accessToken,
    auth_session: accessToken,
    auth_xuid: '',
    clientid: '',
    user_type: account.userType,
    user_properties: '{}',
    version_name: version.id,
    version_type: version.type,
    game_directory: gameDir,
    assets_root: paths.assets,
    game_assets: install.gameAssets,
    assets_index_name: version.assetIndex.id,
    natives_directory: install.nativesDir,
    library_directory: paths.libraries,
    classpath,
    classpath_separator: path.delimiter,
    launcher_name: 'hojicha-launcher',
    launcher_version: LAUNCHER_VERSION,
    quickPlayMultiplayer: options.join || '',
  };
  const features = { is_quick_play_multiplayer: Boolean(options.join) };
  const sub = (s) => s.replace(/\$\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
  const expand = (list) => list.flatMap((arg) => {
    if (typeof arg === 'string') return [sub(arg)];
    return rulesAllow(arg.rules, features) ? [].concat(arg.value).map(sub) : [];
  });

  const jvm = [`-Xmx${settings.memoryMb}M`];
  if (version.arguments?.jvm) jvm.push(...expand(version.arguments.jvm));
  else jvm.push(`-Djava.library.path=${install.nativesDir}`, '-cp', classpath);
  if (version.extraJvm) jvm.push(...version.extraJvm.map(sub));
  if (proxy) jvm.push(...proxy.jvmArgs);

  const game = version.arguments?.game
    ? expand(version.arguments.game)
    : version.minecraftArguments.split(' ').map(sub);

  // Versions before quick play (pre-1.20) use the older --server/--port arguments.
  const hasQuickPlay = JSON.stringify(version.arguments?.game || []).includes('is_quick_play_multiplayer');
  if (options.join && !hasQuickPlay) {
    const [host, port] = options.join.split(':');
    game.push('--server', host, '--port', port);
  }

  return { args: [...jvm, version.mainClass, ...game], protectedAccount: Boolean(proxy) };
}

// Installs everything the instance needs and returns what to spawn, and whether the game got the account through
// options.authProxy.
// report(text, fraction) receives overall progress from 0 to 1 for the launch progress bar.
async function prepare(instance, gameDir, settings, account, report, options = {}) {
  report('Checking versions', 0.03);
  const version = await resolveVersion(instance);
  const install = await installGame(version, report);

  if (install.mapToResources) {
    fs.cpSync(install.gameAssets, path.join(gameDir, 'resources'), { recursive: true, force: false });
  }

  const java = settings.javaPath || await ensureJava(version.javaVersion?.component || 'jre-legacy',
    (done, total) => report(`Preparing Java (${done} of ${total})`, 0.85 + 0.12 * (done / total)));

  return { java, ...buildArgs(version, install, gameDir, settings, account, options) };
}

// Java for a given Minecraft version (used to run servers with the same runtime as the game).
async function javaFor(gameVersion, report) {
  const version = await getVanillaVersionJson(gameVersion);
  return ensureJava(version.javaVersion?.component || 'jre-legacy', (done, total) => report(`Preparing Java (${done} of ${total})`));
}

module.exports = { listGameVersions, latestFabricLoader, prepare, javaFor, mavenPath };

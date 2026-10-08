const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const instances = require('./instances');
const minecraft = require('./minecraft');
const prismPacks = require('./prismPacks');
const { fetchJson, downloadFile, runPool } = require('./http');

// A Modrinth modpack is an .mrpack: a zip with modrinth.index.json (game and loader versions, files to download)
// plus overrides/ and client-overrides/ folders copied over the game directory. Installing one makes a new instance.
// A file from the PC can also be a Prism Launcher (or MultiMC) instance export, read by prismPacks.js.

const API = 'https://api.modrinth.com/v2';
// The only hosts the .mrpack format lets packs download from.
const ALLOWED_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
// Folders the index's mod files may also land in, tracked like Browse installs so the Installed tab knows them.
const TRACKED = ['mods/', 'resourcepacks/', 'shaderpacks/'];

function fabricVersions(projectId) {
  const params = new URLSearchParams({ loaders: JSON.stringify(['fabric']) });
  return fetchJson(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`);
}

// The Minecraft versions a pack can be installed for, newest first, each with the pack version that brings it
// (the newest full release for it, else the newest beta).
async function listGameVersions(projectId) {
  const [versions, known] = await Promise.all([fabricVersions(projectId), minecraft.listGameVersions()]);
  const order = new Map(known.map((v, i) => [v.id, i])); // Mojang lists newest first
  const picks = new Map();
  for (const v of versions) { // newest first
    for (const game of v.game_versions) {
      const pick = picks.get(game);
      if (!pick || (pick.type !== 'release' && v.version_type === 'release')) {
        picks.set(game, { gameVersion: game, versionId: v.id, versionNumber: v.version_number, type: v.version_type });
      }
    }
  }
  if (!picks.size) throw new Error("This modpack has no Fabric version, and Fabric is the only mod loader Hojicha supports.");
  return [...picks.values()].sort((a, b) => (order.get(a.gameVersion) ?? Infinity) - (order.get(b.gameVersion) ?? Infinity));
}

// Resolves a path from the pack inside gameDir, refusing anything that would land outside it.
function safeTarget(gameDir, rel) {
  const root = path.resolve(gameDir);
  const target = path.resolve(root, rel);
  if (path.isAbsolute(rel) || !target.startsWith(root + path.sep)) throw new Error(`The modpack has an unsafe file path: ${rel}`);
  return target;
}

function allowedUrl(urls) {
  return urls.find((url) => {
    try {
      const { protocol, hostname } = new URL(url);
      return protocol === 'https:' && ALLOWED_HOSTS.includes(hostname);
    } catch {
      return false;
    }
  });
}

const NOT_A_PACK = "That file isn't a modpack. Choose a Modrinth .mrpack file or a Prism Launcher export (.zip).";

function openPack(file) {
  try {
    return new AdmZip(file);
  } catch {
    throw new Error(NOT_A_PACK);
  }
}

// A pack file on the PC: a Modrinth .mrpack ({ index }) or a Prism Launcher export ({ prism }).
function readFile(zip, fileName) {
  if (zip.getEntry('modrinth.index.json')) return { index: readIndex(zip) };
  const prism = prismPacks.read(zip, fileName);
  if (!prism) throw new Error(NOT_A_PACK);
  return { prism };
}

function readIndex(zip) {
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error("That file isn't a Modrinth modpack (it has no modrinth.index.json).");
  const index = JSON.parse(entry.getData().toString('utf8'));
  const deps = index.dependencies || {};
  const other = ['forge', 'neoforge', 'quilt-loader'].find((loader) => deps[loader]);
  if (other) throw new Error(`This modpack needs ${other}, and Fabric is the only mod loader Hojicha supports.`);
  if (!deps.minecraft) throw new Error("The modpack doesn't say which Minecraft version it needs.");
  return index;
}

// Creates the instance from the pack's metadata, before anything big is downloaded.
// An empty name means the pack's own.
async function makeInstance(zip, name, modpack) {
  const index = readIndex(zip);
  const instance = instances.create({
    name: name.trim() || modpack.title,
    gameVersion: index.dependencies.minecraft,
    loader: 'fabric',
    loaderVersion: index.dependencies['fabric-loader'] || await minecraft.latestFabricLoader(index.dependencies.minecraft),
  });
  // The pack ships its own mod settings: keep them out of the shared config folder. The same for its options.txt
  // (keybinds, which resource packs are on) if it has one, which the shared one would replace at the first launch.
  instance.sync = { config: false };
  if (['overrides/options.txt', 'client-overrides/options.txt'].some((name) => zip.getEntry(name))) instance.sync['options.txt'] = false;
  instance.modpack = modpack;
  instances.save(instance);
  return { instance, zip, index };
}

// From Modrinth: versionId picks the pack version (see listGameVersions); without it, the newest one.
async function createInstance(projectId, name = '', versionId = null) {
  const [project, versions] = await Promise.all([fetchJson(`${API}/project/${encodeURIComponent(projectId)}`), fabricVersions(projectId)]);
  const version = versionId
    ? versions.find((v) => v.id === versionId)
    : versions.find((v) => v.version_type === 'release') || versions[0];
  if (!version) throw new Error("This modpack has no Fabric version, and Fabric is the only mod loader Hojicha supports.");
  const file = version.files.find((f) => f.primary) || version.files[0];
  const tmp = path.join(os.tmpdir(), `hojicha-${version.id}.mrpack`);
  await downloadFile(file.url, tmp, { sha1: file.hashes.sha1, size: file.size });
  let zip;
  try {
    zip = new AdmZip(tmp);
  } finally {
    fs.rmSync(tmp, { force: true }); // AdmZip has read it all into memory
  }
  return makeInstance(zip, name, { projectId, versionId: version.id, title: project.title, versionNumber: version.version_number, iconUrl: project.icon_url });
}

// What a modpack file on disk would install, for the dialog to show before creating anything. startup: the pack
// runs its own code before the game (a Prism Launcher pack's custom components), which needs the player's trust.
function describeFile(file) {
  const { index, prism } = readFile(openPack(file), file);
  if (prism) {
    const { title, description, gameVersion, loaderVersion, mods, startup } = prism;
    return { title, description, versionNumber: '', gameVersion, loader: loaderVersion ? 'Fabric' : null, mods, startup: startup && { ...startup, trusted: prismPacks.isTrusted(startup) } };
  }
  return {
    title: index.name || path.basename(file, path.extname(file)),
    description: index.summary || '',
    versionNumber: index.versionId || '',
    gameVersion: index.dependencies.minecraft,
    loader: 'Fabric',
    mods: (index.files || []).filter((f) => f.env?.client !== 'unsupported').length,
    startup: null,
  };
}

// trust: the player said they trust the pack's startup code, if it has any.
async function createInstanceFromFile(file, name = '', trust = false) {
  const zip = openPack(file);
  const { index, prism } = readFile(zip, file);
  if (prism) return makePrismInstance(zip, prism, name, trust);
  const title = index.name || path.basename(file, path.extname(file));
  return makeInstance(zip, name, { projectId: null, versionId: null, title, versionNumber: index.versionId || '', iconUrl: null });
}

async function makePrismInstance(zip, prism, name, trust) {
  if (!prismPacks.isTrusted(prism.startup) && !trust) throw new Error('This pack runs its own code. Tick that you trust it to install it.');
  const instance = instances.create({
    name: name.trim() || prism.title,
    gameVersion: prism.gameVersion,
    loader: prism.loaderVersion ? 'fabric' : 'vanilla',
    loaderVersion: prism.loaderVersion,
  });
  prismPacks.trust(prism.startup);
  // As for Modrinth packs, its mod settings stay its own. So do its resource packs, shader packs, options and server
  // list when it brings them, or runs code that may (a Supernova pack downloads its own servers.dat): the shared
  // ones would mix in, or be overwritten.
  instance.sync = { config: false };
  const has = (rel) => zip.getEntries().some((e) => e.entryName.startsWith(prism.gamePrefix + rel));
  for (const item of ['resourcepacks/', 'shaderpacks/', 'options.txt', 'servers.dat']) {
    if (prism.startup || has(item)) instance.sync[item.replace('/', '')] = false;
  }
  if (prism.memoryMb) instance.memoryMb = prism.memoryMb;
  if (prism.patches.length) instance.patches = prism.patches;
  instance.modpack = { projectId: null, versionId: null, title: prism.title, versionNumber: '', iconUrl: null };
  instances.save(instance);
  return { instance, zip, prism };
}

// Copies a Prism Launcher pack's game folder and the libraries it brought along into the new instance.
async function fillPrismInstance({ instance, zip, prism }, report) {
  const gameDir = instances.gameDir(instance.id);
  report('Copying modpack files');
  const tracked = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith(prism.gamePrefix)) continue;
    const rel = entry.entryName.slice(prism.gamePrefix.length);
    const target = safeTarget(gameDir, rel);
    const data = entry.getData();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    if (TRACKED.some((dir) => rel.startsWith(dir))) tracked.push({ rel, sha1: crypto.createHash('sha1').update(data).digest('hex') });
  }
  const libraries = instances.librariesDir(instance.id);
  fs.mkdirSync(libraries, { recursive: true });
  for (const { entry, file } of prism.localJars) fs.writeFileSync(path.join(libraries, file), zip.getEntry(entry).getData());
  await trackContent(instance, tracked);
}

// Downloads the pack's files and copies its overrides into the new instance.
async function fillInstance(pack, report) {
  if (pack.prism) return fillPrismInstance(pack, report);
  const { instance, zip, index } = pack;
  const gameDir = instances.gameDir(instance.id);
  const files = (index.files || []).filter((f) => f.env?.client !== 'unsupported');
  const downloads = files.map((f) => {
    const url = allowedUrl(f.downloads || []);
    if (!url) throw new Error(`The modpack wants to download ${f.path} from a site Modrinth packs may not use.`);
    return { url, target: safeTarget(gameDir, f.path), rel: f.path.replace(/\\/g, '/'), sha1: f.hashes?.sha1, size: f.fileSize };
  });
  report('Downloading mods', 0);
  await runPool(downloads, 8, (d) => downloadFile(d.url, d.target, { sha1: d.sha1, size: d.size }),
    (done, total) => report(`Downloading mods (${done}/${total})`, done / total));

  // client-overrides go last so they win over overrides.
  report('Copying modpack files');
  for (const prefix of ['overrides/', 'client-overrides/']) {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue;
      const target = safeTarget(gameDir, entry.entryName.slice(prefix.length));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.getData());
    }
  }

  await trackContent(instance, downloads.filter((d) => d.sha1 && TRACKED.some((dir) => d.rel.startsWith(dir))));
}

// Looks the downloaded files up on Modrinth so they show with names and icons, and can switch versions.
// Only cosmetic: a failure here leaves the files installed but untracked.
async function trackContent(instance, files) {
  if (!files.length) return;
  try {
    const versions = await fetchJson(`${API}/version_files`, { hashes: files.map((f) => f.sha1), algorithm: 'sha1' });
    const projectIds = [...new Set(Object.values(versions).map((v) => v.project_id))];
    const projects = projectIds.length ? await fetchJson(`${API}/projects?${new URLSearchParams({ ids: JSON.stringify(projectIds) })}`) : [];
    const byId = new Map(projects.map((p) => [p.id, p]));
    for (const file of files) {
      const version = versions[file.sha1];
      if (!version) continue;
      const project = byId.get(version.project_id);
      instance.content[file.rel] = {
        projectId: version.project_id,
        versionId: version.id,
        title: project?.title || path.basename(file.rel),
        versionNumber: version.version_number,
        iconUrl: project?.icon_url || null,
      };
    }
    instances.patch(instance.id, { content: instance.content }); // a rename meanwhile stays
  } catch (err) {
    console.error('Could not look up the modpack files on Modrinth:', err.message);
  }
}

module.exports = { listGameVersions, createInstance, describeFile, createInstanceFromFile, fillInstance };

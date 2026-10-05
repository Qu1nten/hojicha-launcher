const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const instances = require('./instances');
const sync = require('./sync');
const { readJson, writeJson } = require('./util');
const { fetchJson, hashFile, downloadFile } = require('./http');

const API = 'https://api.modrinth.com/v2';

// Modrinth project type -> folder inside the game directory.
const FOLDERS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };
const PACK_FOLDERS = [FOLDERS.resourcepack, FOLDERS.shader];

// Resource packs and shaders usually live in folders shared between instances (sync.js). Their Modrinth details
// are kept with the shared folder, in synced/content.json, so every instance that shares a pack shows its name and
// icon and Browse knows it's installed. Everything else (mods, and packs in a folder that isn't shared) keeps its
// details in the instance itself (instance.content). Both are keyed "folder/file", like "resourcepacks/x.zip".
const sharedFile = () => path.join(paths.synced, 'content.json');

function readShared() {
  try {
    return readJson(sharedFile());
  } catch {
    return {};
  }
}

const folderOf = (rel) => rel.split('/')[0];
const isShared = (instance, folder) => PACK_FOLDERS.includes(folder) && sync.isSynced(instance, folder);

// Moves the details of packs in shared folders from the instance to the shared record, and forgets shared details
// whose file is gone. Run whenever an instance is loaded, so details written before this existed move over too.
function settle(instance) {
  const shared = readShared();
  let instanceChanged = false;
  let sharedChanged = false;
  for (const [rel, meta] of Object.entries(instance.content)) {
    if (!isShared(instance, folderOf(rel))) continue;
    shared[rel] = meta;
    delete instance.content[rel];
    instanceChanged = sharedChanged = true;
  }
  for (const rel of Object.keys(shared)) {
    if (!fs.existsSync(path.join(paths.synced, rel))) {
      delete shared[rel];
      sharedChanged = true;
    }
  }
  if (instanceChanged) instances.save(instance);
  if (sharedChanged) writeJson(sharedFile(), shared);
  return instance;
}

// At startup: every instance's shared pack details move over at once, so all instances see them straight away.
function settleAll() {
  for (const instance of instances.list()) {
    try {
      settle(pruneMissing(instance));
    } catch (err) {
      console.error(`Could not tidy the pack details of ${instance.id}:`, err.message);
    }
  }
}

// The details for every file the instance has: its own, plus the shared ones for files it has (also a copy kept
// after it stopped sharing the folder, which has the same name).
function records(instance) {
  const gameDir = instances.gameDir(instance.id);
  const all = { ...instance.content };
  for (const [rel, meta] of Object.entries(readShared())) {
    if (!(rel in all) && fs.existsSync(path.join(gameDir, rel))) all[rel] = meta;
  }
  return all;
}

function forgetRecord(instance, rel) {
  delete instance.content[rel];
  const shared = readShared();
  if (rel in shared) {
    delete shared[rel];
    writeJson(sharedFile(), shared);
  }
}

function installedProjects(instance) {
  return new Set(Object.values(records(instance)).map((c) => c.projectId));
}

// Forgets records whose file is gone (e.g. deleted in Explorer), so they no longer count as installed.
function pruneMissing(instance) {
  const gameDir = instances.gameDir(instance.id);
  let changed = false;
  for (const rel of Object.keys(instance.content)) {
    if (!fs.existsSync(path.join(gameDir, rel))) {
      delete instance.content[rel];
      changed = true;
    }
  }
  if (changed) instances.save(instance);
  return instance;
}

function loadInstance(id) {
  return settle(pruneMissing(instances.get(id)));
}

async function search(id, query, type = 'mod', offset = 0) {
  const instance = loadInstance(id);
  const facets = [[`project_type:${type}`], [`versions:${instance.gameVersion}`]];
  if (type === 'mod') facets.push([`categories:${instance.loader}`]);
  const result = await searchModrinth(query, facets, offset);
  const installed = installedProjects(instance);
  return { total: result.total, hits: result.hits.map((h) => ({ ...h, installed: installed.has(h.projectId) })) };
}

// Fabric modpacks for the New instance dialog. A pack sets its own game version, so any version goes.
function searchModpacks(query, offset = 0) {
  return searchModrinth(query, [['project_type:modpack'], ['categories:fabric']], offset);
}

async function searchModrinth(query, facets, offset) {
  // With no search text, show the most downloaded projects instead of an arbitrary "relevance" order.
  const index = query ? 'relevance' : 'downloads';
  const params = new URLSearchParams({ query, index, facets: JSON.stringify(facets), limit: '20', offset: String(offset) });
  const result = await fetchJson(`${API}/search?${params}`);
  return {
    total: result.total_hits,
    hits: result.hits.map((h) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      iconUrl: h.icon_url,
    })),
  };
}

// All versions of a project that work with the instance (its Minecraft version, and loader for mods), newest first.
function compatibleVersions(instance, projectId, type) {
  const params = new URLSearchParams({ game_versions: JSON.stringify([instance.gameVersion]) });
  if (type === 'mod') params.set('loaders', JSON.stringify([instance.loader]));
  return fetchJson(`${API}/project/${projectId}/version?${params}`);
}

// Newest version that fits the instance, preferring full releases over betas.
async function pickVersion(instance, projectId, type) {
  const versions = await compatibleVersions(instance, projectId, type);
  if (!versions.length) throw new Error(`No version of this project supports ${instance.gameVersion} ${type === 'mod' ? instance.loader : ''}`.trim());
  return versions.find((v) => v.version_type === 'release') || versions[0];
}

async function installVersion(instance, version, type, report, visited) {
  if (visited.has(version.project_id)) return;
  visited.add(version.project_id);

  const project = await fetchJson(`${API}/project/${version.project_id}`);
  const file = version.files.find((f) => f.primary) || version.files[0];
  const folder = FOLDERS[type];
  const gameDir = instances.gameDir(instance.id);
  report(`Downloading ${project.title}`);
  await downloadFile(file.url, path.join(gameDir, folder, file.filename), { sha1: file.hashes.sha1, size: file.size });

  // Replace any older file of the same project (its details may be the instance's or shared).
  for (const [rel, meta] of Object.entries(records(instance))) {
    if (meta.projectId === version.project_id && rel !== `${folder}/${file.filename}`) {
      fs.rmSync(path.join(gameDir, rel), { force: true, recursive: true });
      forgetRecord(instance, rel);
    }
  }
  instance.content[`${folder}/${file.filename}`] = {
    projectId: version.project_id,
    versionId: version.id,
    title: project.title,
    versionNumber: version.version_number,
    iconUrl: project.icon_url,
  };

  if (type !== 'mod') return;
  const installed = installedProjects(instance);
  for (const dep of version.dependencies) {
    if (dep.dependency_type !== 'required') continue;
    if (dep.project_id && (installed.has(dep.project_id) || visited.has(dep.project_id))) continue;
    const depVersion = dep.version_id
      ? await fetchJson(`${API}/version/${dep.version_id}`)
      : await pickVersion(instance, dep.project_id, 'mod');
    await installVersion(instance, depVersion, 'mod', report, visited);
  }
}

// Installs a project (and, for mods, its required dependencies) into the instance.
async function install(id, projectId, type = 'mod', report = () => {}) {
  const instance = loadInstance(id);
  if (type === 'mod' && instance.loader === 'vanilla') throw new Error('Vanilla instances cannot load mods. Create a Fabric instance.');
  const version = await pickVersion(instance, projectId, type);
  try {
    await installVersion(instance, version, type, report, new Set());
  } finally {
    instances.save(instance); // keep track of whatever did get installed
    settle(instance); // a pack in a shared folder keeps its details with the folder
  }
  return instance;
}

// The Installed tab: every mod, resource pack and shader the instance has, with Modrinth info where we have it.
// Packs can be a .zip or an unpacked folder; anything else in those folders (Iris keeps a .txt of settings next
// to each shader) isn't a pack.
function listContent(id) {
  const instance = loadInstance(id);
  const gameDir = instances.gameDir(id);
  const known = records(instance);
  const entries = (folder, isItem) => {
    const dir = path.join(gameDir, folder);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter(isItem).map((entry) => entry.name);
  };
  const item = (folder, file, title) => {
    const meta = known[`${folder}/${file}`];
    return {
      file,
      title: meta?.title || title,
      versionNumber: meta?.versionNumber || '',
      iconUrl: meta?.iconUrl || null,
      fromModrinth: Boolean(meta),
    };
  };
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  const packs = (folder) => entries(folder, (e) => e.isDirectory() || /\.zip$/i.test(e.name))
    .map((file) => ({ ...item(folder, file, file.replace(/\.zip$/i, '')), shared: isShared(instance, folder) }))
    .sort(byTitle);
  return {
    mod: entries(FOLDERS.mod, (e) => e.isFile() && /\.jar(\.disabled)?$/i.test(e.name))
      .map((file) => ({
        ...item(FOLDERS.mod, file, file.replace(/\.jar(\.disabled)?$/i, '')), // only Modrinth ones can switch versions
        enabled: !/\.disabled$/i.test(file),
      }))
      .sort(byTitle),
    resourcepack: packs(FOLDERS.resourcepack),
    shader: packs(FOLDERS.shader),
  };
}

// Is the pack shared with other instances (so removing it removes it there too)?
function isSharedContent(id, type) {
  return type !== 'mod' && isShared(instances.get(id), FOLDERS[type]);
}

// Switches a mod on or off the way Fabric expects: a switched-off mod is renamed to .jar.disabled, so the game
// skips it but it stays in the list. Returns its new file name.
function setModEnabled(id, file, enabled) {
  if (file.includes('/') || file.includes('\\')) throw new Error('Invalid file name');
  const instance = loadInstance(id);
  const modsDir = path.join(instances.gameDir(id), 'mods');
  const base = file.replace(/\.disabled$/i, '');
  const target = enabled ? base : `${base}.disabled`;
  if (target === file) return target;
  if (fs.existsSync(path.join(modsDir, target))) throw new Error(`The mods folder already has a file called ${target}.`);
  fs.renameSync(path.join(modsDir, file), path.join(modsDir, target));
  const meta = instance.content[`mods/${file}`];
  if (meta) {
    delete instance.content[`mods/${file}`];
    instance.content[`mods/${target}`] = meta;
    instances.save(instance);
  }
  return target;
}

// Newer versions of the instance's Modrinth mods, found in one request by the files' hashes: file -> { versionId,
// versionNumber }. Only full releases count as updates, the same as a fresh install prefers them.
async function checkModUpdates(id) {
  const instance = loadInstance(id);
  const gameDir = instances.gameDir(id);
  const byHash = new Map();
  for (const [rel, meta] of Object.entries(instance.content)) {
    if (!rel.startsWith('mods/')) continue;
    byHash.set(await hashFile(path.join(gameDir, rel), 'sha1'), { file: rel.slice('mods/'.length), meta });
  }
  if (!byHash.size) return {};
  const latest = await fetchJson(`${API}/version_files/update`, {
    hashes: [...byHash.keys()], algorithm: 'sha1', loaders: [instance.loader], game_versions: [instance.gameVersion],
  });
  const updates = {};
  for (const [hash, version] of Object.entries(latest)) {
    const mod = byHash.get(hash);
    if (!mod || version.id === mod.meta.versionId || version.version_type !== 'release') continue;
    updates[mod.file] = { versionId: version.id, versionNumber: version.version_number };
  }
  return updates;
}

function modrinthMeta(instance, file) {
  const meta = instance.content[`mods/${file}`];
  if (!meta) throw new Error("This mod wasn't installed from Modrinth, so Hojicha can't list its other versions.");
  return meta;
}

// Every version of an installed mod that works with the instance, newest first.
async function listModVersions(id, file) {
  const instance = loadInstance(id);
  const meta = modrinthMeta(instance, file);
  const versions = await compatibleVersions(instance, meta.projectId, 'mod');
  return versions.map((v) => ({
    id: v.id,
    versionNumber: v.version_number,
    type: v.version_type, // release, beta or alpha
    published: v.date_published,
    current: v.id === meta.versionId,
  }));
}

// Swaps an installed mod for another of its versions (plus any required dependencies that version adds).
async function setModVersion(id, file, versionId, report = () => {}) {
  const instance = loadInstance(id);
  const meta = modrinthMeta(instance, file);
  const version = await fetchJson(`${API}/version/${encodeURIComponent(versionId)}`);
  if (version.project_id !== meta.projectId) throw new Error('That version belongs to a different mod.');
  try {
    await installVersion(instance, version, 'mod', report, new Set());
  } finally {
    instances.save(instance);
  }
  // A switched-off mod stays off in its new version.
  if (/\.disabled$/i.test(file)) {
    const fresh = Object.keys(instance.content).find((rel) => rel.startsWith('mods/') && instance.content[rel].versionId === version.id);
    if (fresh && !/\.disabled$/i.test(fresh)) setModEnabled(id, fresh.slice('mods/'.length), false);
  }
  return { title: meta.title, versionNumber: version.version_number };
}

// Removes a mod, resource pack or shader. A pack in a shared folder goes for every instance that shares it.
function removeContent(id, type, file) {
  if (!FOLDERS[type]) throw new Error(`Unknown content type ${type}`);
  if (!file || file.includes('/') || file.includes('\\') || file === '.' || file === '..') throw new Error('Invalid file name');
  const instance = loadInstance(id);
  const rel = `${FOLDERS[type]}/${file}`;
  fs.rmSync(path.join(instances.gameDir(id), rel), { force: true, recursive: true, maxRetries: 3 });
  forgetRecord(instance, rel);
  instances.save(instance);
}

module.exports = {
  FOLDERS, settleAll, search, searchModpacks, install, listContent, isSharedContent, setModEnabled, checkModUpdates,
  removeContent, listModVersions, setModVersion,
};

const fs = require('fs');
const path = require('path');
const instances = require('./instances');
const { fetchJson, downloadFile } = require('./http');

const API = 'https://api.modrinth.com/v2';

// Modrinth project type -> folder inside the game directory.
const FOLDERS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };

function installedProjects(instance) {
  return new Set(Object.values(instance.content).map((c) => c.projectId));
}

async function search(id, query, type = 'mod', offset = 0) {
  const instance = instances.get(id);
  const facets = [[`project_type:${type}`], [`versions:${instance.gameVersion}`]];
  if (type === 'mod') facets.push([`categories:${instance.loader}`]);
  const params = new URLSearchParams({ query, facets: JSON.stringify(facets), limit: '20', offset: String(offset) });
  const result = await fetchJson(`${API}/search?${params}`);
  const installed = installedProjects(instance);
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
      installed: installed.has(h.project_id),
    })),
  };
}

// Newest version of a project that fits the instance, preferring full releases over betas.
async function pickVersion(instance, projectId, type) {
  const params = new URLSearchParams({ game_versions: JSON.stringify([instance.gameVersion]) });
  if (type === 'mod') params.set('loaders', JSON.stringify([instance.loader]));
  const versions = await fetchJson(`${API}/project/${projectId}/version?${params}`);
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

  // Replace any older file of the same project.
  for (const [rel, meta] of Object.entries(instance.content)) {
    if (meta.projectId === version.project_id && rel !== `${folder}/${file.filename}`) {
      fs.rmSync(path.join(gameDir, rel), { force: true });
      delete instance.content[rel];
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
  const instance = instances.get(id);
  if (type === 'mod' && instance.loader === 'vanilla') throw new Error('Vanilla instances cannot load mods. Create a Fabric instance.');
  const version = await pickVersion(instance, projectId, type);
  try {
    await installVersion(instance, version, type, report, new Set());
  } finally {
    instances.save(instance); // keep track of whatever did get installed
  }
  return instance;
}

// Lists every file in the instance's mods folder, with Modrinth info where we have it.
function listMods(id) {
  const instance = instances.get(id);
  const modsDir = path.join(instances.gameDir(id), 'mods');
  if (!fs.existsSync(modsDir)) return [];
  return fs.readdirSync(modsDir)
    .filter((f) => /\.jar(\.disabled)?$/i.test(f))
    .map((file) => {
      const meta = instance.content[`mods/${file}`];
      return { file, title: meta?.title || file, versionNumber: meta?.versionNumber || '', iconUrl: meta?.iconUrl || null };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function removeMod(id, file) {
  if (file.includes('/') || file.includes('\\')) throw new Error('Invalid file name');
  const instance = instances.get(id);
  fs.rmSync(path.join(instances.gameDir(id), 'mods', file), { force: true });
  delete instance.content[`mods/${file}`];
  instances.save(instance);
}

module.exports = { search, install, listMods, removeMod };

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const instances = require('./instances');
const minecraft = require('./minecraft');
const { fetchJson, downloadFile, runPool } = require('./http');

// A Modrinth modpack is an .mrpack: a zip with modrinth.index.json (game and loader versions, files to download)
// plus overrides/ and client-overrides/ folders copied over the game directory. Installing one makes a new instance.

const API = 'https://api.modrinth.com/v2';
// The only hosts the .mrpack format lets packs download from.
const ALLOWED_HOSTS = ['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com'];
// Folders the index's mod files may also land in, tracked like Browse installs so the Mods tab knows them.
const TRACKED = ['mods/', 'resourcepacks/', 'shaderpacks/'];

// Newest version of the pack that runs on Fabric, preferring full releases over betas.
async function pickVersion(projectId) {
  const params = new URLSearchParams({ loaders: JSON.stringify(['fabric']) });
  const versions = await fetchJson(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`);
  if (!versions.length) throw new Error("This modpack has no Fabric version, and Fabric is the only mod loader Hojicha supports.");
  return versions.find((v) => v.version_type === 'release') || versions[0];
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

function readIndex(zip) {
  const entry = zip.getEntry('modrinth.index.json');
  if (!entry) throw new Error('This modpack file has no modrinth.index.json.');
  const index = JSON.parse(entry.getData().toString('utf8'));
  const deps = index.dependencies || {};
  const other = ['forge', 'neoforge', 'quilt-loader'].find((loader) => deps[loader]);
  if (other) throw new Error(`This modpack needs ${other}, and Fabric is the only mod loader Hojicha supports.`);
  if (!deps.minecraft) throw new Error("The modpack doesn't say which Minecraft version it needs.");
  return index;
}

// Creates the instance from the pack's metadata, before anything big is downloaded.
// An empty name means the pack's own.
async function createInstance(projectId, name = '') {
  const [project, version] = await Promise.all([fetchJson(`${API}/project/${encodeURIComponent(projectId)}`), pickVersion(projectId)]);
  const file = version.files.find((f) => f.primary) || version.files[0];
  const tmp = path.join(os.tmpdir(), `hojicha-${version.id}.mrpack`);
  await downloadFile(file.url, tmp, { sha1: file.hashes.sha1, size: file.size });
  let zip;
  try {
    zip = new AdmZip(tmp);
  } finally {
    fs.rmSync(tmp, { force: true }); // AdmZip has read it all into memory
  }
  const index = readIndex(zip);
  const instance = instances.create({
    name: name.trim() || project.title,
    gameVersion: index.dependencies.minecraft,
    loader: 'fabric',
    loaderVersion: index.dependencies['fabric-loader'] || await minecraft.latestFabricLoader(index.dependencies.minecraft),
  });
  // The pack ships its own mod settings: keep them out of the shared config folder.
  instance.sync = { config: false };
  instance.modpack = { projectId, versionId: version.id, title: project.title, versionNumber: version.version_number, iconUrl: project.icon_url };
  instances.save(instance);
  return { instance, zip, index };
}

// Downloads the pack's files and copies its overrides into the new instance.
async function fillInstance({ instance, zip, index }, report) {
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
    instances.save(instance);
  } catch (err) {
    console.error('Could not look up the modpack files on Modrinth:', err.message);
  }
}

module.exports = { createInstance, fillInstance };

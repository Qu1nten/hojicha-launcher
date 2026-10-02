const path = require('path');
const { fetchJson, downloadFile } = require('./http');
const minecraft = require('./minecraft');

// Server software the launcher can set up in a new server folder. Each type lists the Minecraft versions it
// supports (newest first) and downloads its server jar. Jar names start with the type and contain the Minecraft
// version, which is how servers.js tells them apart later (see detect() there).

const PAPER = 'https://fill.papermc.io/v3/projects/paper';
const PURPUR = 'https://api.purpurmc.org/v2/purpur';
const FABRIC_META = 'https://meta.fabricmc.net/v2';

const isRelease = (version) => /^\d+(\.\d+)+$/.test(version); // no snapshots, pre-releases or release candidates

const TYPES = {
  paper: {
    name: 'Paper',
    async versions() {
      const project = await fetchJson(PAPER);
      return Object.values(project.versions).flat().filter(isRelease);
    },
    async download(version, dir) {
      const build = await fetchJson(`${PAPER}/versions/${encodeURIComponent(version)}/builds/latest`);
      const jar = build.downloads['server:default'];
      await downloadFile(jar.url, path.join(dir, jar.name), { sha256: jar.checksums.sha256, size: jar.size });
      return jar.name;
    },
  },

  purpur: {
    name: 'Purpur',
    async versions() {
      const project = await fetchJson(PURPUR);
      return project.versions.filter(isRelease).reverse();
    },
    async download(version, dir) {
      const build = await fetchJson(`${PURPUR}/${encodeURIComponent(version)}/latest`);
      const name = `purpur-${version}-${build.build}.jar`;
      await downloadFile(`${PURPUR}/${encodeURIComponent(version)}/${build.build}/download`, path.join(dir, name), { md5: build.md5 });
      return name;
    },
  },

  // Fabric's server launcher jar: on first start it downloads the vanilla server from Mojang, then runs it with Fabric.
  fabric: {
    name: 'Fabric',
    async versions() {
      const games = await fetchJson(`${FABRIC_META}/versions/game`);
      return games.filter((g) => g.stable).map((g) => g.version);
    },
    async download(version, dir) {
      const loader = await minecraft.latestFabricLoader(version);
      const installers = await fetchJson(`${FABRIC_META}/versions/installer`);
      const installer = (installers.find((i) => i.stable) || installers[0]).version;
      const name = `fabric-server-mc.${version}-loader.${loader}-launcher.${installer}.jar`;
      const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(version)}/${loader}/${installer}/server/jar`;
      await downloadFile(url, path.join(dir, name));
      return name;
    },
  },
};

function type(id) {
  const t = TYPES[id];
  if (!t) throw new Error(`Unknown server type "${id}"`);
  return t;
}

module.exports = {
  listVersions: (id) => type(id).versions(),
  download: (id, version, dir) => type(id).download(version, dir),
  label: (id) => type(id).name,
};

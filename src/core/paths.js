const path = require('path');

// Everything the launcher stores lives under one home folder (see storage.js for which one):
//   instances\   one folder per instance
//   servers\     servers created in the launcher (added server folders stay where they are)
//   synced\      worlds, mod configs, resource packs, shader packs, screenshots, schematics and options shared
//                between instances
//   skins\       saved skins (skins.js)
//   meta\        game versions, libraries, assets, Java runtimes, item icons, block models and schematic previews,
//                shared by all instances
//   config\      settings, accounts, servers, and Electron's own browser data
let root = null;

const under = (...parts) => {
  if (!root) throw new Error('paths.setRoot() has not been called');
  return path.join(root, ...parts);
};

module.exports = {
  setRoot(dir) {
    root = dir;
  },
  get root() { return under(); },
  get instances() { return under('instances'); },
  get servers() { return under('servers'); },
  get synced() { return under('synced'); },
  get schematics() { return under('synced', 'schematics'); },
  get skins() { return under('skins'); },
  get versions() { return under('meta', 'versions'); },
  get libraries() { return under('meta', 'libraries'); },
  get assets() { return under('meta', 'assets'); },
  get runtimes() { return under('meta', 'java'); },
  get playit() { return under('meta', 'playit'); },
  get icons() { return under('meta', 'icons'); },
  get font() { return under('meta', 'font'); },
  get blocks() { return under('meta', 'blocks'); },
  get schematicPreviews() { return under('meta', 'schematic-previews'); },
  get schematicImports() { return under('meta', 'schematic-imports'); },
  get settingsFile() { return under('config', 'settings.json'); },
  get accountsFile() { return under('config', 'accounts.json'); },
  get serversFile() { return under('config', 'servers.json'); },
  get serverRestoreFile() { return under('config', 'server-properties-restore.json'); },
  get playitFile() { return under('config', 'playit.json'); },
  get electron() { return under('config', 'electron'); },
};

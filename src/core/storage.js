const fs = require('fs');
const path = require('path');
const { FOLDERS } = require('./sync');

// Picks the launcher's home folder and moves data there from older versions.
//
// Installed launchers keep everything next to the .exe, like the Modrinth App does, so the folder picked in
// the installer holds the instances too. When that folder isn't writable (an all-users install in
// Program Files) or when running from source, the home is %APPDATA%\Hojicha Launcher instead.
// HOJICHA_HOME overrides both (handy for testing).
//
// Up to 0.2.x everything lived in %APPDATA%\Hojicha Launcher\data with a flatter layout, and Electron's
// browser data sat in %APPDATA%\Hojicha Launcher itself.

// [path inside the old data folder, path inside the home folder]
const LEGACY_ITEMS = [
  ['instances', 'instances'],
  ['shared', 'synced'],
  ['versions', 'meta/versions'],
  ['libraries', 'meta/libraries'],
  ['assets', 'meta/assets'],
  ['runtimes', 'meta/java'],
  ['settings.json', 'config/settings.json'],
  ['accounts.json', 'config/accounts.json'],
  ['servers.json', 'config/servers.json'],
  ['server-properties-restore.json', 'config/server-properties-restore.json'],
];

function canWrite(dir) {
  const probe = path.join(dir, `.write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

function legacyRoot(appData) {
  return path.join(appData, 'Hojicha Launcher');
}

function chooseHome({ isPackaged, exePath, appData }) {
  if (process.env.HOJICHA_HOME) return path.resolve(process.env.HOJICHA_HOME);
  const exeDir = path.dirname(exePath);
  if (isPackaged && canWrite(exeDir)) return exeDir;
  return legacyRoot(appData);
}

// Must run before Electron is ready: safeStorage's encryption key (which protects saved sign-ins) lives in
// "Local State" inside Electron's data folder, and that folder moves to config\electron.
function carryOverEncryptionKey(home, appData, electronDir) {
  const target = path.join(electronDir, 'Local State');
  const source = path.join(legacyRoot(appData), 'Local State');
  if (fs.existsSync(target) || !fs.existsSync(source) || path.resolve(source) === path.resolve(target)) return;
  fs.mkdirSync(electronDir, { recursive: true });
  fs.copyFileSync(source, target);
}

// Old items that still need moving. Anything already present in the home folder is left alone.
function pendingMoves(home, appData) {
  const oldData = path.join(legacyRoot(appData), 'data');
  return LEGACY_ITEMS
    .map(([from, to]) => [path.join(oldData, from), path.join(home, ...to.split('/'))])
    .filter(([from, to]) => fs.existsSync(from) && !fs.existsSync(to));
}

// Rename when possible (same drive: instant); otherwise copy to a temporary name, then swap it in, so an
// interrupted copy never looks finished and the original is only deleted once the copy is complete.
async function move(from, to) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  const partial = `${to}.moving`;
  await fs.promises.rm(partial, { recursive: true, force: true });
  await fs.promises.cp(from, partial, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  await fs.promises.rename(partial, to);
  await fs.promises.rm(from, { recursive: true, force: true });
}

// Synced folders inside instances are junctions to the old shared folder. Remove them before moving so a
// copy never follows them; sync.relinkAll() recreates them pointing at the new synced folder.
function unlinkSyncedFolders(instancesDir) {
  if (!fs.existsSync(instancesDir)) return;
  for (const id of fs.readdirSync(instancesDir)) {
    for (const name of FOLDERS) {
      const link = path.join(instancesDir, id, 'minecraft', name);
      try {
        if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      } catch {
        // not there: nothing to do
      }
    }
  }
}

async function migrate(home, appData, moves, report = () => {}) {
  const root = legacyRoot(appData);
  const oldData = path.join(root, 'data');
  unlinkSyncedFolders(path.join(oldData, 'instances'));
  for (const [from, to] of moves) {
    report(path.relative(home, to));
    await move(from, to);
  }
  // Clean up only once the old data folder is completely empty. What's left in the old root then is
  // Electron's browser cache, which isn't needed when the home is somewhere else.
  if (fs.existsSync(oldData) && fs.readdirSync(oldData).length === 0) {
    fs.rmdirSync(oldData);
    const homeInside = !path.relative(root, home).startsWith('..') && !path.isAbsolute(path.relative(root, home));
    if (!homeInside) fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { chooseHome, carryOverEncryptionKey, pendingMoves, migrate, legacyRoot };

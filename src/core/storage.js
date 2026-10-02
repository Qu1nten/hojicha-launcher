const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { FOLDERS } = require('./sync');

// Picks the launcher's home folder and moves data there from older versions.
//
// Launchers keep everything in the folder picked in the installer, like the Modrinth App does: instances,
// servers, settings and Electron's own data. Nothing is written to AppData (see chooseHome).
//
// Up to 0.2.x everything lived in %APPDATA%\Hojicha Launcher\data with a flatter layout, and Electron's
// browser data sat in %APPDATA%\Hojicha Launcher itself. That is only read, to move it into the home folder.

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

// The launcher folder for an app\ folder or .exe folder. Since 0.4.0 the installer puts the app in an app\
// sub-folder of the launcher folder (see build/installer.nsh); 0.3.x installs had the .exe in the launcher folder.
function launcherDirOf(exeDir) {
  return path.basename(exeDir).toLowerCase() === 'app' ? path.dirname(exeDir) : exeDir;
}

// Where the installer put the launcher, as recorded by electron-builder's installer under the app's GUID
// (a fixed UUID derived from build.appId, com.hojicha.launcher). Per-user installs first, then all-users ones.
const INSTALL_KEY = 'Software\\6bbc57a8-1bb3-5cae-9fad-38e12f729b31';
function installedLauncherDir() {
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\${INSTALL_KEY}`, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true });
      const location = out.match(/InstallLocation\s+REG_\w+\s+(.+)/)?.[1]?.trim();
      if (location && fs.existsSync(location)) return launcherDirOf(location);
    } catch {
      // Not installed for this hive.
    }
  }
  return null;
}

// Everything lives in the launcher folder picked in the installer, never in AppData.
// - Installed: the folder above app\. If it isn't writable (an all-users install in Program Files), this throws
//   and main.js explains it, rather than putting data somewhere the player didn't choose.
// - Running from source: the installed launcher's folder, so testing uses the same data; when the launcher isn't
//   installed, dev-home\ in the project (ignored by git).
// HOJICHA_HOME overrides both (handy for testing).
function chooseHome({ isPackaged, exePath }) {
  if (process.env.HOJICHA_HOME) return path.resolve(process.env.HOJICHA_HOME);
  if (!isPackaged) return installedLauncherDir() || path.join(__dirname, '..', '..', 'dev-home');
  const launcherDir = launcherDirOf(path.dirname(exePath));
  if (!canWrite(launcherDir)) {
    throw new Error(`Hojicha Launcher can't save anything in ${launcherDir}. Reinstall it for just you, or in a folder you can write to.`);
  }
  return launcherDir;
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

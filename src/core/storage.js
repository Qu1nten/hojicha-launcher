const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Picks the launcher's home folder. Launchers keep everything in the folder picked in the installer, like the
// Modrinth App does: instances, servers, settings and Electron's own data. Nothing is written to AppData.

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

// The launcher folder for the .exe's folder: the installer puts the app in an app\ sub-folder of the launcher
// folder (see build/installer.nsh).
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

module.exports = { chooseHome };

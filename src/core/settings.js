const paths = require('./paths');
const { readJson, writeJson } = require('./util');

// Player names come from accounts.js; settings only hold launcher preferences.
// publicDomain: the player's own domain for online play (like mc.example.com), shown instead of playit's address.
const DEFAULTS = { memoryMb: 4096, javaPath: '', publicDomain: '' };

function get() {
  try {
    const { memoryMb, javaPath, publicDomain } = { ...DEFAULTS, ...readJson(paths.settingsFile) };
    return { memoryMb, javaPath, publicDomain };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const settings = { ...get(), ...patch };
  settings.memoryMb = Math.max(512, Number(settings.memoryMb) || DEFAULTS.memoryMb);
  settings.publicDomain = String(settings.publicDomain || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  writeJson(paths.settingsFile, settings);
  return settings;
}

module.exports = { get, save };

const paths = require('./paths');
const { readJson, writeJson } = require('./util');

// Player names come from accounts.js; settings only hold launcher preferences.
const DEFAULTS = { memoryMb: 4096, javaPath: '' };

function get() {
  try {
    const { memoryMb, javaPath } = { ...DEFAULTS, ...readJson(paths.settingsFile) };
    return { memoryMb, javaPath };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const settings = { ...get(), ...patch };
  settings.memoryMb = Math.max(512, Number(settings.memoryMb) || DEFAULTS.memoryMb);
  writeJson(paths.settingsFile, settings);
  return settings;
}

module.exports = { get, save };

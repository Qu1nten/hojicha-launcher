const paths = require('./paths');
const { readJson, writeJson } = require('./util');

// Player names come from accounts.js; settings only hold launcher preferences.
const THEMES = ['hojicha', 'matcha']; // dark and light, see the switch in the title bar
const DEFAULTS = { memoryMb: 4096, javaPath: '', theme: 'hojicha' };

function get() {
  try {
    const { memoryMb, javaPath, theme } = { ...DEFAULTS, ...readJson(paths.settingsFile) };
    return { memoryMb, javaPath, theme: THEMES.includes(theme) ? theme : DEFAULTS.theme };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const settings = { ...get(), ...patch };
  settings.memoryMb = Math.max(512, Number(settings.memoryMb) || DEFAULTS.memoryMb);
  if (!THEMES.includes(settings.theme)) settings.theme = DEFAULTS.theme;
  writeJson(paths.settingsFile, settings);
  return settings;
}

module.exports = { get, save };

const paths = require('./paths');
const { readJsonOr, writeJson } = require('./util');

// Player names come from accounts.js; settings only hold launcher preferences.
const THEMES = ['hojicha', 'matcha']; // dark and light, see the switch in the title bar
// borderless: play in a borderless window over the whole monitor instead of real fullscreen (core/borderless.js).
// protectAccount: the game gets a stand-in for the account's token (core/authProxy.js).
// sandbox: the game runs in a Windows AppContainer (core/sandbox.js).
const DEFAULTS = { memoryMb: 4096, javaPath: '', theme: 'hojicha', borderless: false, protectAccount: true, sandbox: false };

function get() {
  const { memoryMb, javaPath, theme, borderless, protectAccount, sandbox } = { ...DEFAULTS, ...readJsonOr(paths.settingsFile, {}) };
  return {
    memoryMb, javaPath, theme: THEMES.includes(theme) ? theme : DEFAULTS.theme,
    borderless: borderless === true, protectAccount: protectAccount !== false, sandbox: sandbox === true,
  };
}

function save(patch) {
  const settings = { ...get(), ...patch };
  settings.memoryMb = Math.max(512, Number(settings.memoryMb) || DEFAULTS.memoryMb);
  if (!THEMES.includes(settings.theme)) settings.theme = DEFAULTS.theme;
  settings.borderless = settings.borderless === true;
  settings.protectAccount = settings.protectAccount !== false;
  settings.sandbox = settings.sandbox === true;
  writeJson(paths.settingsFile, settings);
  return settings;
}

module.exports = { get, save };

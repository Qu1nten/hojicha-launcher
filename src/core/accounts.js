const crypto = require('crypto');
const paths = require('./paths');
const auth = require('./auth');
const { readJson, writeJson } = require('./util');

// Accounts are stored in config/accounts.json. Tokens are encrypted with the OS keystore (Windows DPAPI via
// Electron safeStorage) when available. Offline accounts can only be added and used while a Microsoft account
// that owns Minecraft: Java Edition is signed in, the same rule other launchers such as Prism use.

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cipher = { encrypt: (s) => s, decrypt: (s) => s };
function setCipher(newCipher) {
  cipher = newCipher;
}

const file = () => paths.accountsFile;

function load() {
  try {
    return readJson(file());
  } catch {
    return { selected: null, accounts: [] };
  }
}

function save(store) {
  writeJson(file(), store);
}

function hasVerifiedOwner(store = load()) {
  return store.accounts.some((a) => a.type === 'microsoft' && a.ownsGame);
}

// What the UI may see: no tokens.
function summary() {
  const store = load();
  const unlocked = hasVerifiedOwner(store);
  return {
    selected: store.selected,
    canUseOffline: unlocked,
    accounts: store.accounts.map((a) => ({
      id: a.id,
      type: a.type,
      name: a.name,
      skinUrl: a.skinUrl?.replace(/^http:/, 'https:') || null, // older saved accounts kept http://
      locked: a.type === 'offline' && !unlocked,
    })),
  };
}

function current(store = load()) {
  return store.accounts.find((a) => a.id === store.selected) || null;
}

function select(id) {
  const store = load();
  if (!store.accounts.some((a) => a.id === id)) throw new Error('Account not found');
  store.selected = id;
  save(store);
  return summary();
}

function remove(id) {
  const store = load();
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.selected === id) store.selected = store.accounts[0]?.id ?? null;
  save(store);
  return summary();
}

// Same UUID the vanilla server assigns to offline-mode players (Java's UUID.nameUUIDFromBytes).
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return hash.toString('hex');
}

function addOffline(name) {
  const store = load();
  if (!hasVerifiedOwner(store)) {
    throw new Error('Add a Microsoft account that owns Minecraft: Java Edition before adding offline accounts.');
  }
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Names must be 3-16 characters: letters, numbers or _');
  const id = `offline-${name.toLowerCase()}`;
  if (!store.accounts.some((a) => a.id === id)) store.accounts.push({ id, type: 'offline', name });
  store.selected = id;
  save(store);
  return summary();
}

function storeMicrosoft(store, ms, session) {
  const id = `ms-${session.uuid}`;
  const account = {
    id,
    type: 'microsoft',
    name: session.name,
    uuid: session.uuid,
    skinUrl: session.skinUrl,
    ownsGame: true,
    refreshToken: cipher.encrypt(ms.refresh_token),
    accessToken: cipher.encrypt(session.accessToken),
    expiresAt: session.expiresAt,
  };
  const index = store.accounts.findIndex((a) => a.id === id);
  if (index >= 0) store.accounts[index] = account;
  else store.accounts.push(account);
  return account;
}

// Device-code sign-in. start() returns the code to show; finish() resolves once the user has signed in.
let pendingLogin = null;

async function startMicrosoftLogin() {
  if (pendingLogin) pendingLogin.cancelled = true;
  const device = await auth.startDeviceLogin();
  pendingLogin = { device, cancelled: false };
  return { userCode: device.userCode, verificationUri: device.verificationUri, expiresIn: device.expiresIn };
}

async function finishMicrosoftLogin() {
  const login = pendingLogin;
  if (!login) throw new Error('No sign-in in progress');
  try {
    const ms = await auth.waitForDeviceLogin(login.device, () => login.cancelled);
    const session = await auth.minecraftLogin(ms.access_token);
    const store = load();
    const account = storeMicrosoft(store, ms, session);
    store.selected = account.id;
    save(store);
    return summary();
  } finally {
    if (pendingLogin === login) pendingLogin = null;
  }
}

function cancelMicrosoftLogin() {
  if (pendingLogin) pendingLogin.cancelled = true;
}

// Picks up skin and name changes made since the last sign-in. Accounts that can't be reached keep what they had.
async function refreshProfiles() {
  const microsoft = load().accounts.filter((a) => a.type === 'microsoft');
  const profiles = await Promise.all(microsoft.map((a) => auth.publicProfile(a.uuid).catch(() => null)));
  const store = load(); // reload: the store may have changed while the requests ran
  let changed = false;
  microsoft.forEach((a, i) => {
    const profile = profiles[i];
    const account = store.accounts.find((s) => s.id === a.id);
    if (!profile || !account) return;
    if (account.name !== profile.name || account.skinUrl !== profile.skinUrl) {
      account.name = profile.name;
      account.skinUrl = profile.skinUrl;
      changed = true;
    }
  });
  if (changed) save(store);
  return summary();
}

// Returns what the game needs to start as the selected account, refreshing Microsoft tokens when needed.
async function launchIdentity() {
  const store = load();
  const account = current(store);
  if (!account) throw new Error('Add an account first: click "Add an account" at the bottom of the sidebar.');

  if (account.type === 'offline') {
    if (!hasVerifiedOwner(store)) {
      throw new Error('Offline accounts need a signed-in Microsoft account that owns Minecraft: Java Edition.');
    }
    return { name: account.name, uuid: offlineUuid(account.name), accessToken: '0', userType: 'legacy' };
  }

  if (Date.now() > account.expiresAt - REFRESH_MARGIN_MS) {
    const ms = await auth.refreshMicrosoft(cipher.decrypt(account.refreshToken));
    let session;
    try {
      session = await auth.minecraftLogin(ms.access_token);
    } catch (err) {
      // Lost ownership (e.g. Game Pass ended): offline accounts lock again too.
      if (err.code === 'not_owned') {
        account.ownsGame = false;
        save(store);
      }
      throw err;
    }
    const refreshToken = ms.refresh_token || cipher.decrypt(account.refreshToken);
    const updated = storeMicrosoft(store, { refresh_token: refreshToken }, session);
    save(store);
    return { name: updated.name, uuid: updated.uuid, accessToken: session.accessToken, userType: 'msa' };
  }
  return { name: account.name, uuid: account.uuid, accessToken: cipher.decrypt(account.accessToken), userType: 'msa' };
}

module.exports = {
  setCipher, summary, current, select, remove, addOffline, hasVerifiedOwner, refreshProfiles,
  startMicrosoftLogin, finishMicrosoftLogin, cancelMicrosoftLogin, launchIdentity,
};

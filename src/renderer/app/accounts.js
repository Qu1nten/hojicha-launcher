import { $, api, el, emptyRow, errorText } from './core.js';
import { openSkins } from './skins.js';

export let accountState = { selected: null, canUseOffline: false, accounts: [] };

// Shows the face (plus hat layer) from a Minecraft skin, or the account's initial.
function setAvatar(node, account, size) {
  node.style.width = node.style.height = `${size}px`;
  if (account?.skinUrl) {
    const scale = size / 8;
    const sheet = `${64 * scale}px auto`; // auto keeps old 64x32 skins from stretching
    node.textContent = '';
    node.style.background = `url("${account.skinUrl}") ${-40 * scale}px ${-8 * scale}px / ${sheet} no-repeat, `
      + `url("${account.skinUrl}") ${-8 * scale}px ${-8 * scale}px / ${sheet} no-repeat`;
  } else {
    node.style.background = '';
    node.textContent = account ? account.name.charAt(0).toUpperCase() : '+';
  }
}

function kindLabel(account) {
  if (account.type === 'microsoft') return 'Microsoft account';
  return account.locked ? 'Offline, locked' : 'Offline account';
}

export function renderAccounts(next) {
  if (next) accountState = next;
  const { accounts, selected, canUseOffline } = accountState;
  const active = accounts.find((a) => a.id === selected) || null;

  const chip = $('#account-chip');
  chip.classList.toggle('needs-account', !active);
  setAvatar($('#account-avatar'), active, 32);
  $('#account-face').hidden = active?.type !== 'microsoft';
  $('#account-face').ariaLabel = active ? `Change ${active.name}'s skin` : 'Change skin';
  $('#account-name').textContent = active ? active.name : 'Add an account';
  $('#account-kind').textContent = active ? kindLabel(active) : 'Needed to play';

  $('#account-list').replaceChildren(...(accounts.length
    ? accounts.map((a) => {
      // Only Microsoft accounts have a skin at Mojang to change.
      const avatar = a.type === 'microsoft'
        ? el('button', { type: 'button', className: 'avatar skin-button', title: 'Change skin', ariaLabel: `Change ${a.name}'s skin` })
        : el('span', { className: 'avatar' });
      if (a.type === 'microsoft') avatar.onclick = () => openSkins(a);
      setAvatar(avatar, a, 30);
      let use;
      if (a.id === selected) {
        use = el('span', { className: 'selected-note', textContent: 'In use' });
      } else {
        use = el('button', { textContent: 'Use', type: 'button' });
        use.onclick = async () => renderAccounts(await api.selectAccount(a.id));
      }
      const remove = el('button', { className: 'quiet danger', textContent: 'Remove', type: 'button' });
      remove.onclick = async () => renderAccounts(await api.removeAccount(a.id));
      return el('li', {}, [
        avatar,
        el('div', { className: 'info' }, [
          el('div', { className: 'title', textContent: a.name }),
          el('div', { className: 'kind', textContent: kindLabel(a) }),
        ]),
        use,
        remove,
      ]);
    })
    : [emptyRow('No accounts yet. Add your Microsoft account to play.')]));

  $('#offline-name').disabled = !canUseOffline;
  $('#add-offline').disabled = !canUseOffline;
  $('#offline-hint').textContent = canUseOffline
    ? 'Offline accounts are for local and offline-mode servers. They work while your Microsoft account is signed in.'
    : 'Offline accounts unlock after you add a Microsoft account that owns Minecraft: Java Edition.';
}

export async function refreshAccounts() {
  renderAccounts(await api.listAccounts());
}

let loginActive = false;
let loginAttempt = 0; // a cancelled attempt that finishes late must not touch a newer one

async function startMicrosoftLogin() {
  const attempt = ++loginAttempt;
  const errorEl = $('#accounts-error');
  errorEl.textContent = '';
  $('#add-microsoft').disabled = true;
  let code;
  try {
    code = await api.loginStart();
  } catch (err) {
    errorEl.textContent = errorText(err);
    $('#add-microsoft').disabled = false;
    return;
  }
  if (attempt !== loginAttempt) return;
  loginActive = true;
  $('#login-url').textContent = code.verificationUri.replace(/^https:\/\//, '');
  $('#login-code').textContent = code.userCode;
  $('#login-copy-open').onclick = () => api.copyCodeAndOpen(code.userCode, code.verificationUri);
  $('#login-panel').hidden = false;
  try {
    const result = await api.loginFinish();
    if (attempt === loginAttempt) renderAccounts(result);
  } catch (err) {
    if (attempt === loginAttempt) errorEl.textContent = errorText(err);
  } finally {
    if (attempt === loginAttempt) {
      loginActive = false;
      $('#login-panel').hidden = true;
      $('#add-microsoft').disabled = false;
    }
  }
}

function cancelMicrosoftLogin() {
  loginAttempt++;
  loginActive = false;
  api.loginCancel();
  $('#login-panel').hidden = true;
  $('#add-microsoft').disabled = false;
}

$('#account-chip').onclick = () => {
  $('#accounts-error').textContent = '';
  $('#accounts-dialog').showModal();
};
$('#account-face').onclick = () => {
  const active = accountState.accounts.find((a) => a.id === accountState.selected);
  if (active) openSkins(active);
};
$('#accounts-close').onclick = () => {
  if (loginActive) cancelMicrosoftLogin();
  $('#accounts-dialog').close();
};
$('#accounts-dialog').addEventListener('close', () => {
  if (loginActive) cancelMicrosoftLogin();
});
$('#add-microsoft').onclick = startMicrosoftLogin;
$('#login-cancel').onclick = cancelMicrosoftLogin;
$('#offline-form').onsubmit = async (event) => {
  event.preventDefault();
  $('#accounts-error').textContent = '';
  try {
    renderAccounts(await api.addOfflineAccount($('#offline-name').value.trim()));
    $('#offline-name').value = '';
  } catch (err) {
    $('#accounts-error').textContent = errorText(err);
  }
};

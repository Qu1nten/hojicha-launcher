const { USER_AGENT } = require('./http');

// Microsoft account sign-in for Minecraft: Java Edition.
//   Microsoft OAuth (device code flow) -> Xbox Live -> XSTS -> Minecraft services -> profile (ownership).
// Hojicha is a public client: there is no client secret, and passwords are only ever typed on Microsoft's own site.

const CLIENT_ID = '5d579359-0bae-4b69-9a15-7fa7ac2f2075';
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPE = 'XboxLive.signin offline_access';

const XSTS_ERRORS = {
  2148916227: 'This account is banned from Xbox Live.',
  2148916233: 'This Microsoft account has no Xbox profile yet. Sign in once at xbox.com to create one, then try again.',
  2148916235: 'Xbox Live is not available in your country or region.',
  2148916236: 'This account needs adult verification on xbox.com before it can play.',
  2148916237: 'This account needs adult verification on xbox.com before it can play.',
  2148916238: 'This is a child account. An adult must add it to a Microsoft family group before it can play.',
};

const APP_NOT_APPROVED = 'Microsoft sign-in worked, but Mojang has not approved Hojicha Launcher for the Minecraft API yet. '
  + 'Sign-in will start working once the app is approved.';

class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, { form, json, token } = {}) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form);
  } else if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data };
}

function microsoftError(data) {
  const description = (data.error_description || data.error || 'Unknown error').split(/\r?\n|Trace ID/)[0].trim();
  return new AuthError(`Microsoft sign-in failed: ${description}`, data.error || 'microsoft');
}

// Step 1: ask Microsoft for a code the user enters at microsoft.com/link.
async function startDeviceLogin() {
  const { ok, data } = await request(`${AUTHORITY}/devicecode`, { form: { client_id: CLIENT_ID, scope: SCOPE } });
  if (!ok) throw microsoftError(data);
  return {
    userCode: data.user_code,
    deviceCode: data.device_code,
    verificationUri: data.verification_uri,
    interval: data.interval || 5,
    expiresIn: data.expires_in || 900,
  };
}

// Step 2: wait until the user has entered the code and signed in.
async function waitForDeviceLogin({ deviceCode, interval, expiresIn }, isCancelled) {
  const deadline = Date.now() + expiresIn * 1000;
  let delay = interval;
  while (Date.now() < deadline) {
    await sleep(delay * 1000);
    if (isCancelled()) throw new AuthError('Sign-in cancelled.', 'cancelled');
    const { ok, data } = await request(`${AUTHORITY}/token`, {
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, device_code: deviceCode },
    });
    if (ok) return data;
    if (data.error === 'authorization_pending') continue;
    if (data.error === 'slow_down') {
      delay += 5;
      continue;
    }
    if (data.error === 'authorization_declined') throw new AuthError('Sign-in was declined.', 'declined');
    if (data.error === 'expired_token') break;
    throw microsoftError(data);
  }
  throw new AuthError('The code expired. Please try again.', 'expired');
}

async function refreshMicrosoft(refreshToken) {
  const { ok, data } = await request(`${AUTHORITY}/token`, {
    form: { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken, scope: SCOPE },
  });
  if (!ok) throw new AuthError('Your Microsoft sign-in has expired. Remove the account and add it again.', 'refresh_failed');
  return data;
}

// Steps 3-5: turn a Microsoft access token into a Minecraft session and confirm the account owns the game.
async function minecraftLogin(msAccessToken) {
  const xbl = await request('https://user.auth.xboxlive.com/user/authenticate', {
    json: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
  });
  if (!xbl.ok) throw new AuthError(`Xbox Live sign-in failed (HTTP ${xbl.status}).`, 'xbox');
  const userHash = xbl.data.DisplayClaims.xui[0].uhs;

  const xsts = await request('https://xsts.auth.xboxlive.com/xsts/authorize', {
    json: {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    },
  });
  if (!xsts.ok) {
    throw new AuthError(XSTS_ERRORS[xsts.data.XErr] || `Xbox Live authorization failed (HTTP ${xsts.status}).`, 'xsts');
  }

  const mc = await request('https://api.minecraftservices.com/authentication/login_with_xbox', {
    json: { identityToken: `XBL3.0 x=${userHash};${xsts.data.Token}` },
  });
  if (!mc.ok) {
    const message = JSON.stringify(mc.data);
    if (mc.status === 403 || /Invalid app registration/i.test(message)) throw new AuthError(APP_NOT_APPROVED, 'app_not_approved');
    throw new AuthError(`Minecraft sign-in failed (HTTP ${mc.status}).`, 'minecraft');
  }
  const accessToken = mc.data.access_token;

  // A Java Edition profile only exists for accounts that own the game (directly or through Game Pass).
  const profile = await request('https://api.minecraftservices.com/minecraft/profile', { token: accessToken });
  if (profile.status === 404) {
    throw new AuthError("This Microsoft account doesn't own Minecraft: Java Edition.", 'not_owned');
  }
  if (!profile.ok) throw new AuthError(`Could not load your Minecraft profile (HTTP ${profile.status}).`, 'profile');

  return {
    accessToken,
    expiresAt: Date.now() + (mc.data.expires_in || 86400) * 1000,
    uuid: profile.data.id,
    name: profile.data.name,
  };
}

module.exports = { AuthError, startDeviceLogin, waitForDeviceLogin, refreshMicrosoft, minecraftLogin };

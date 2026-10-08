const http = require('http');
const https = require('https');
const crypto = require('crypto');

// Keeps the account's real Minecraft token out of the game. The game starts with a stand-in token and with Mojang's
// account services pointed at this proxy on 127.0.0.1 (system properties authlib reads, Minecraft 1.16 and newer).
// The proxy swaps the stand-in for the real token, and only for what playing needs: joining servers, chat signing,
// skins, the block list. Anything else, like changing the account's name or skin, is refused. A mod that copies the
// token from the game gets the stand-in, which is worthless anywhere but here, and here only while the game runs.
//
// What reaches Mojang is the game's own request, so their signed answers (skins, chat keys) still check out.

// Path prefix on the proxy -> Mojang host.
const UPSTREAMS = {
  session: 'sessionserver.mojang.com',
  services: 'api.minecraftservices.com',
  profiles: 'api.mojang.com',
  auth: 'authserver.mojang.com', // old Mojang-account sign-in; the game never needs it
};

// From Minecraft 26.3 (authlib 10), the game looks up every service address from this document instead.
const DISCOVERY_URL = 'https://discovery.minecraftservices.com/minecraft/client';

const ANY = null;
const profileLookups = [
  ['GET', /^\/minecraft\/profile\/lookup\/(name\/[^/]+|[0-9a-f-]+)$/i],
  ['POST', /^\/minecraft\/profile\/lookup\/bulk\/byname$/],
];
// What the game may ask for, per upstream: [method or ANY, path].
const ALLOWED = {
  session: [
    ['POST', /^\/session\/minecraft\/join$/],
    ['GET', /^\/session\/minecraft\/hasJoined$/], // someone joining a world opened to LAN
    ['GET', /^\/session\/minecraft\/profile\/[0-9a-f-]+$/i],
    ['GET', /^\/blockedservers$/],
  ],
  services: [
    ['GET', /^\/publickeys$/],
    ['POST', /^\/player\/certificates$/], // chat signing keys
    ['GET', /^\/player\/attributes$/],
    ['POST', /^\/player\/attributes$/], // in-game preferences, like the profanity filter
    ['POST', /^\/player\/report$/],
    ['GET', /^\/privacy\/blocklist$/],
    ['POST', /^\/events$/], // telemetry
    [ANY, /^\/presence$/],
    [ANY, /^\/friends(\/[\w-]+)*$/],
    ...profileLookups,
  ],
  profiles: [
    ['POST', /^\/profiles\/minecraft$/],
    ['GET', /^\/users\/profiles\/minecraft\/[^/]+$/],
    ...profileLookups,
  ],
  auth: [],
};

const MAX_BODY = 8 * 1024 * 1024;

function allowed(upstream, method, pathname) {
  return (ALLOWED[upstream] || []).some(([m, pattern]) => (m === ANY || m === method) && pattern.test(pathname));
}

// Shaped like a real token (a JWT), so the game, mods and the log redaction treat it like one.
function standInToken() {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ hojicha: 'stand-in', id: crypto.randomUUID() })}.${crypto.randomBytes(32).toString('base64url')}`;
}

function readBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        stream.destroy();
        reject(new Error('Body too large'));
      } else chunks.push(chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

const swap = (buffer, from, to) => (buffer.includes(from) ? Buffer.from(buffer.toString('utf8').split(from).join(to)) : buffer);

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 30_000 }, async (res) => {
      try {
        resolve({ status: res.statusCode, headers: res.headers, body: await readBody(res) });
      } catch (err) {
        reject(err);
      }
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// Headers worth passing between the game and Mojang; connection details are each side's own business.
const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'accept-encoding', 'content-encoding', 'proxy-connection', 'upgrade']);
const passHeaders = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP_HEADERS.has(name.toLowerCase())));

// Starts a proxy for one game launch.
// realToken: async () => the account's current Minecraft token (refreshed when it runs out, so long sessions keep working).
// log(text): a line for the instance's Log tab.
// Resolves to { token, jvmArgs, close() }: start the game with token as its access token and jvmArgs among its Java arguments.
function start({ realToken, log }) {
  const token = standInToken();
  const refused = new Set();
  let base = '';

  const reply = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  async function discovery(res) {
    const doc = JSON.parse((await request(DISCOVERY_URL)).body.toString('utf8'));
    const prefixOf = Object.fromEntries(Object.entries(UPSTREAMS).map(([prefix, host]) => [host, prefix]));
    for (const service of Object.values(doc.discovery || {})) {
      for (const endpoint of Object.values(service.endpoints || {})) {
        if (typeof endpoint.uri !== 'string') continue;
        // Kept as text: the addresses contain placeholders such as {profileId}.
        const match = endpoint.uri.match(/^https:\/\/([^/]+)(\/.*)?$/);
        const prefix = match && prefixOf[match[1].toLowerCase()];
        // A service on a host the proxy doesn't know keeps its address; it gets the stand-in token, never the real one.
        if (prefix) endpoint.uri = `${base}/${prefix}${match[2] || ''}`;
      }
    }
    reply(res, 200, doc);
  }

  async function handle(req, res) {
    // Only the game, on this computer: a web page that renamed itself to 127.0.0.1 still sends its own host name.
    if (req.headers.host !== base.slice('http://'.length)) return reply(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url, base);
    const [, prefix, ...rest] = url.pathname.split('/');
    if (prefix === 'discovery' && rest.length === 0 && req.method === 'GET') return discovery(res);

    const pathname = `/${rest.join('/')}`;
    if (!(prefix in UPSTREAMS) || !allowed(prefix, req.method, pathname)) {
      const what = `${req.method} ${prefix in UPSTREAMS ? UPSTREAMS[prefix] : ''}${pathname}`;
      if (!refused.has(what)) {
        refused.add(what);
        log(`> Account protection stopped the game from using ${what}`);
      }
      return reply(res, 403, { error: 'ForbiddenOperationException', errorMessage: 'Hojicha Launcher keeps the account out of reach of mods; this request is not allowed.' });
    }

    let body = await readBody(req);
    const headers = passHeaders(req.headers);
    // The real token only goes where the game sent the stand-in.
    const auth = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization');
    const needsToken = (auth && headers[auth].includes(token)) || body.includes(token);
    const real = needsToken ? await realToken() : null;
    if (real) {
      if (auth) headers[auth] = headers[auth].split(token).join(real);
      body = swap(body, token, real);
    }
    if (body.length) headers['Content-Length'] = body.length;

    const upstream = await request(`https://${UPSTREAMS[prefix]}${pathname}${url.search}`, { method: req.method, headers, body: body.length ? body : undefined });
    // Mojang doesn't send the token back, but if it ever did, the game would only see the stand-in.
    const answer = real ? swap(upstream.body, real, token) : upstream.body;
    res.writeHead(upstream.status, { ...passHeaders(upstream.headers), 'Content-Length': answer.length });
    res.end(answer);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`> Account protection couldn't pass on a request: ${err.message}`);
      if (!res.headersSent) reply(res, 502, { error: 'BadGateway', errorMessage: err.message });
      else res.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      const host = (prefix) => `${base}/${prefix}`;
      resolve({
        token,
        jvmArgs: [
          // authlib 1.6 to 4 want all of auth, account and session (and services from 2.1); 5 to 9 a subset of these
          // plus profiles; 10 only discovery. Each version ignores the ones it doesn't know.
          `-Dminecraft.api.auth.host=${host('auth')}`,
          `-Dminecraft.api.account.host=${host('profiles')}`,
          `-Dminecraft.api.session.host=${host('session')}`,
          `-Dminecraft.api.services.host=${host('services')}`,
          `-Dminecraft.api.profiles.host=${host('profiles')}`,
          `-Dminecraft.api.discovery.host=${host('discovery')}`,
        ],
        close: () => {
          server.close();
          server.closeAllConnections(); // the game keeps connections open; the stand-in stops working now
        },
      });
    });
  });
}

module.exports = { start, allowed };

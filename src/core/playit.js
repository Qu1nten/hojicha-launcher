const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const paths = require('./paths');
const { readJson, writeJson } = require('./util');
const { LAUNCHER_VERSION, downloadFile } = require('./http');

// Online play through playit.gg: friends join a public address, and playit relays them to the local server
// through a connection the PC makes outwards, so nothing has to be opened on the router.
//
// - Linking: the launcher makes a claim code, the player approves it on playit.gg once, and the launcher
//   exchanges the code for the agent's secret key (stored encrypted in config/playit.json).
// - The agent is playit's own playitd.exe (pinned below, checked by SHA-256), run as an ordinary child process
//   while a public server runs: no service, no install, no admin rights.
// - Tunnels: one Minecraft Java tunnel per local port, created through playit's API on first use.
// The API calls mirror playit's open-source agent (github.com/playit-cloud/playit-agent, packages/api_client).

const API = 'https://api.playit.gg';
const CLAIM_PAGE = 'https://playit.gg/claim/';
const TUNNELS_PAGE = 'https://playit.gg/account/tunnels';
const AGENT = {
  version: '1.0.10',
  url: 'https://github.com/playit-cloud/playit-agent/releases/download/v1.0.10/playit-windows-x86_64-signed.exe',
  sha256: '2dbdaad119844cbbc062cc9774b8b462afa5f1b4b7832a9fc5ef4676cae887cf',
  size: 4822072,
};
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const TUNNEL_TIMEOUT_MS = 10 * 60 * 1000; // includes time to add the tunnel on playit.gg by hand

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cipher = { encrypt: (s) => s, decrypt: (s) => s };
function setCipher(newCipher) {
  cipher = newCipher;
}

function secret() {
  try {
    const stored = readJson(paths.playitFile).secretKey;
    return stored ? cipher.decrypt(stored) : null;
  } catch {
    return null;
  }
}

function isLinked() {
  return Boolean(secret());
}

// playit's API answers {status: "success" | "fail" | "error", data}. "fail" is an expected outcome with a code
// (like NotAccepted while a claim waits); "error" is a broken request or bad key.
async function call(endpoint, body, key = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Agent-Key ${key}`;
  const res = await fetch(`${API}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.status === 429) throw Object.assign(new Error('playit.gg is busy, try again in a moment'), { code: 'TooManyRequests' });
  const text = await res.text();
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    reply = { status: 'error', data: { message: `HTTP ${res.status}` } };
  }
  if (reply.status === 'success') return reply.data;
  const code = typeof reply.data === 'string' ? reply.data : reply.data?.message || reply.data?.type || 'Unknown';
  // endpoint and reply go to the server console (see main.js), so a failing request is easy to pin down.
  const details = { code, endpoint, reply: text.slice(0, 500) };
  if (code === 'InvalidAgentKey') throw Object.assign(new Error('The link with playit.gg was removed. Set up online play again.'), details);
  throw Object.assign(new Error(`playit.gg: ${code}`), details);
}

// ---------- Linking ----------

let claim = null; // { code, cancelled }

async function startLink() {
  const code = crypto.randomBytes(5).toString('hex');
  await call('/claim/setup', { code, agent_type: 'self-managed', version: `Hojicha Launcher ${LAUNCHER_VERSION}` });
  claim = { code, cancelled: false };
  return `${CLAIM_PAGE}${code}`;
}

// Resolves once the player approved the launcher on playit.gg (or rejects when they declined or cancelled).
async function finishLink() {
  const current = claim;
  if (!current) throw new Error('Start setting up online play first');
  const giveUp = Date.now() + CLAIM_TIMEOUT_MS;
  const check = () => {
    if (current.cancelled) throw new Error('Cancelled');
    if (Date.now() > giveUp) throw new Error('Setting up online play timed out. Try again.');
  };

  for (;;) {
    check();
    const state = await call('/claim/setup', { code: current.code, agent_type: 'self-managed', version: `Hojicha Launcher ${LAUNCHER_VERSION}` });
    if (state === 'UserAccepted') break;
    if (state === 'UserRejected') throw new Error('Online play was not approved on playit.gg');
    await sleep(1500);
  }
  for (;;) {
    check();
    try {
      const { secret_key: key } = await call('/claim/exchange', { code: current.code });
      writeJson(paths.playitFile, { secretKey: cipher.encrypt(key) });
      claim = null;
      return;
    } catch (err) {
      if (err.code !== 'NotAccepted' && err.code !== 'NotSetup') throw err;
    }
    await sleep(2000);
  }
}

function cancelLink() {
  if (claim) claim.cancelled = true;
  claim = null;
}

function unlink() {
  stopAll();
  fs.rmSync(paths.playitFile, { force: true });
}

// ---------- Agent ----------

let agent = null; // { child, users: Set of server ids }

// Starts playitd for a server (shared when several public servers run). log receives the agent's output.
async function startAgent(serverId, log) {
  const key = secret();
  if (!key) throw new Error('Set up online play first');
  if (!agent) {
    const exe = path.join(paths.playit, 'playitd.exe');
    await downloadFile(AGENT.url, exe, { sha256: AGENT.sha256, size: AGENT.size });
    const child = spawn(exe, ['--secret', key, '--socket-path', '\\\\.\\pipe\\hojicha-playitd', '--log-path', path.join(paths.playit, 'playitd.log')], {
      cwd: paths.playit,
      windowsHide: true,
    });
    agent = { child, users: new Set() };
    const forward = (line) => log(`[playit] ${line}`);
    readline.createInterface({ input: child.stdout }).on('line', forward);
    readline.createInterface({ input: child.stderr }).on('line', forward);
    child.on('error', (err) => log(`[playit] Could not start: ${err.message}`));
    child.on('exit', () => {
      if (agent?.child === child) agent = null;
    });
  }
  agent.users.add(serverId);
}

function stopAgent(serverId) {
  if (!agent) return;
  agent.users.delete(serverId);
  if (!agent.users.size) {
    agent.child.kill();
    agent = null;
  }
}

function stopAll() {
  if (agent) agent.child.kill();
  agent = null;
}

// ---------- Tunnel ----------

const field = (tunnel, name) => tunnel.agent_config?.fields?.find((f) => f.name === name)?.value;

// The public address of the Minecraft tunnel to 127.0.0.1:<port>, creating the tunnel the first time.
// If playit refuses to create it, onManual(err) is called once and this keeps waiting for the player to add the
// tunnel on playit.gg themselves (the agent is running meanwhile, so the website can see it).
// isCancelled stops the waiting, e.g. once the server has stopped.
async function ensureTunnel(port, onManual = () => {}, isCancelled = () => false) {
  const key = secret();
  const giveUp = Date.now() + TUNNEL_TIMEOUT_MS;
  let created = false;
  for (;;) {
    if (isCancelled()) throw new Error('Cancelled');
    const run = await call('/v1/agents/rundata', {}, key);
    const matches = (t) => t.tunnel_type === 'minecraft-java' && Number(field(t, 'local_port') || 25565) === port;
    const tunnel = run.tunnels.find(matches);
    if (tunnel) {
      if (tunnel.disabled_reason) throw new Error(`playit.gg turned the tunnel off: ${tunnel.disabled_reason}`);
      return tunnel.display_address;
    }
    if (!created && !run.pending.some(matches)) {
      created = true; // one attempt; after that, wait for the tunnel to show up
      await call('/v1/tunnels/create', {
        ports: { type: 'tunnel-type', details: 'minecraft-java' },
        origin: {
          type: 'agent',
          data: {
            agent_id: run.agent_id,
            config: { fields: [{ name: 'local_ip', value: '127.0.0.1' }, { name: 'local_port', value: String(port) }] },
          },
        },
        enabled: true,
        alloc: null,
        name: `Hojicha (port ${port})`,
        firewall_id: null,
      }, key).catch((err) => {
        if (err.code === 'InvalidAgentKey') throw err;
        onManual(err);
      });
    }
    if (Date.now() > giveUp) throw new Error('No tunnel showed up on playit.gg. Start the server again to retry.');
    await sleep(3000);
  }
}

module.exports = {
  setCipher, isLinked, startLink, finishLink, cancelLink, unlink,
  startAgent, stopAgent, stopAll, ensureTunnel, TUNNELS_PAGE,
};

// Publishes the installer that `npm run dist` just built as one GitHub release, run by `npm run release`.
//
// electron-builder's own publishing uploads files in parallel and sometimes opens two drafts at once, splitting
// the files between them. This creates a single release for the pushed commit, uploads the installer, its
// blockmap and latest.yml one by one, and only then publishes it, so the launcher's updater never sees half a
// release. Needs GH_TOKEN: a fine-grained token for this repository with Contents: Read and write.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const pkg = require('../package.json');

const { owner, repo } = pkg.build.publish[0];
const version = pkg.version;
const tag = `v${version}`;
const dist = path.join(__dirname, '..', 'dist');
const installer = `Hojicha-Launcher-Setup-${version}.exe`;
const files = [installer, `${installer}.blockmap`, 'latest.yml'];

const token = process.env.GH_TOKEN;
const git = (args) => execSync(`git ${args}`, { encoding: 'utf8' }).trim();

function fail(message) {
  console.error(`\n  Release stopped: ${message}\n`);
  process.exit(1);
}

async function github(method, url, body, headers = {}) {
  const res = await fetch(url.startsWith('https:') ? url : `https://api.github.com/repos/${owner}/${repo}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hojicha-release',
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body,
  });
  const text = await res.text();
  if (!res.ok) fail(`GitHub said HTTP ${res.status} to ${method} ${url}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  if (!token) fail('GH_TOKEN is not set. Set it in this terminal first: $env:GH_TOKEN = "your-token"');

  for (const file of files) {
    if (!fs.existsSync(path.join(dist, file))) fail(`dist\\${file} is missing. Did the build finish?`);
  }
  const yml = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}\\s*$`, 'm').test(yml)) fail(`dist\\latest.yml is not for ${version}.`);

  // The tag goes on the commit you pushed, so the release always matches what's on GitHub.
  const head = git('rev-parse HEAD');
  let upstream = '';
  try {
    upstream = git('rev-parse @{u}');
  } catch {
    // no upstream branch
  }
  if (head !== upstream) fail('this commit is not pushed. Run git push first.');

  const releases = await github('GET', '/releases?per_page=100');
  if (releases.some((r) => r.tag_name === tag && !r.draft)) fail(`${tag} is already released. Bump the version first.`);
  // Leftover drafts for this version from a failed run are replaced; published releases are never touched.
  for (const draft of releases.filter((r) => r.draft && r.tag_name === tag)) {
    console.log(`  Removing leftover draft ${draft.name || draft.tag_name} (${draft.assets.length} files)`);
    await github('DELETE', `/releases/${draft.id}`);
  }

  // Release notes: the "Release vx.y.z" commit's message, without the title and co-author lines. Older release
  // commits have no "v" ("Release 0.6.1"), so both are found.
  const notes = git(`log -1 --format=%b -E --grep="^Release v?${version.replace(/\./g, '\\.')}$"`).split('\n').filter((l) => !/^Co-Authored-By:/i.test(l)).join('\n').trim();
  const release = await github('POST', '/releases', {
    tag_name: tag, target_commitish: head, name: tag, body: notes, draft: true,
  });

  for (const file of files) {
    const data = fs.readFileSync(path.join(dist, file));
    console.log(`  Uploading ${file} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
    const url = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(file)}`;
    await github('POST', url, data, { 'Content-Type': 'application/octet-stream' });
  }

  const published = await github('PATCH', `/releases/${release.id}`, { draft: false, make_latest: 'true' });
  console.log(`\n  Released ${version}: ${published.html_url}\n`);
}

main().catch((err) => fail(err.message));

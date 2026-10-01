const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { fetchJson, downloadFile, runPool } = require('./http');

// Mojang's index of the Java runtimes the official launcher uses (java-runtime-delta = Java 21, jre-legacy = Java 8, ...).
const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  const { platform, arch } = process;
  if (platform === 'win32') return { x64: 'windows-x64', arm64: 'windows-arm64', ia32: 'windows-x86' }[arch];
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return arch === 'ia32' ? 'linux-i386' : 'linux';
}

// Returns the path to java(.exe) for the given runtime component, downloading it the first time.
async function ensureJava(component, onProgress) {
  const dir = path.join(paths.runtimes, component);
  const javaExe = path.join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const marker = path.join(dir, '.complete');
  if (fs.existsSync(marker) && fs.existsSync(javaExe)) return javaExe;

  const index = await fetchJson(RUNTIME_INDEX);
  const entries = index[platformKey()]?.[component];
  if (!entries?.length) throw new Error(`Mojang has no "${component}" Java runtime for ${platformKey()}`);
  const manifest = await fetchJson(entries[0].manifest.url);

  const files = [];
  for (const [rel, info] of Object.entries(manifest.files)) {
    const target = path.join(dir, rel);
    if (info.type === 'directory') fs.mkdirSync(target, { recursive: true });
    else if (info.type === 'file') files.push({ target, executable: info.executable, ...info.downloads.raw });
    // 'link' entries only exist in the macOS/Linux runtimes.
  }
  await runPool(files, 16, async (file) => {
    await downloadFile(file.url, file.target, { sha1: file.sha1, size: file.size });
    if (file.executable && process.platform !== 'win32') fs.chmodSync(file.target, 0o755);
  }, onProgress);

  fs.writeFileSync(marker, entries[0].version.name);
  return javaExe;
}

module.exports = { ensureJava };

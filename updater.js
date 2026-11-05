// Self-updater. A release only needs to contain the app code (app.asar, about 7 MB) because the
// Electron runtime in Kinetic.exe rarely changes. Flow:
//   check  -> asks GitHub Releases (or LAUNCHER_UPDATE_URL) for the latest release
//   download -> fetches app.asar, verifies it against the release's app.asar.sha256 file
//   install -> a tiny helper script waits for the launcher to exit, swaps app.asar, and starts it again
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'Kinetic-Updater' };

// "1.10.0" > "1.9.2"; ignores a leading v and any -prerelease suffix
function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function checkLatest({ repo, url, current, fetchFn }) {
  const endpoint = url || (repo ? `https://api.github.com/repos/${repo}/releases/latest` : '');
  if (!endpoint) throw new Error('No update source set. Add your GitHub repo (owner/name) in Settings → Updates.');
  const res = await fetchFn(endpoint, { headers: HEADERS });
  if (res.status === 404) throw new Error('No release found. Check the repo name, and that it has a published release.');
  if (!res.ok) throw new Error(`Update server returned ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const asset = (rel.assets || []).find((a) => a.name === 'app.asar');
  const sha = (rel.assets || []).find((a) => a.name === 'app.asar.sha256');
  if (!version) throw new Error('The latest release has no version tag.');
  if (!asset || !sha) throw new Error(`Release ${version} is missing app.asar or app.asar.sha256.`);
  return {
    available: compareVersions(version, current) > 0,
    version, current, notes: rel.body || '',
    assetUrl: asset.browser_download_url, shaUrl: sha.browser_download_url, size: asset.size || 0,
  };
}

// streams the file to disk while hashing it; the file is deleted if the hash does not match
async function download(info, dest, fetchFn, onProgress) {
  const shaRes = await fetchFn(info.shaUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!shaRes.ok) throw new Error(`Could not fetch the checksum (${shaRes.status})`);
  const expected = (await shaRes.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('The checksum file is not valid.');

  const res = await fetchFn(info.assetUrl, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || info.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (onProgress && total) onProgress(got / total);
    }
    await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
  } catch (err) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw err;
  }
  if (hash.digest('hex') !== expected) {
    fs.rmSync(dest, { force: true });
    throw new Error('The download did not match its checksum, so it was discarded.');
  }
}

// Writes and starts a helper that survives this process: it retries the swap until the launcher has exited
// (Windows keeps app.asar locked while it is running), then restarts the exe.
function applyAndRestart({ newFile, targetFile, exe, tries = 60 }) {
  const script = path.join(os.tmpdir(), `kinetic-update-${process.pid}.cmd`);
  const q = (p) => String(p).replace(/"/g, '');
  fs.writeFileSync(script, [
    '@echo off',
    `set "NEW=${q(newFile)}"`,
    `set "TARGET=${q(targetFile)}"`,
    `set "EXE=${q(exe)}"`,
    'set /a n=0',
    ':retry',
    'move /y "%NEW%" "%TARGET%" >nul 2>&1',
    'if not errorlevel 1 goto done',
    'set /a n+=1',
    `if %n% GEQ ${tries} goto fail`,
    'ping 127.0.0.1 -n 2 >nul',
    'goto retry',
    ':done',
    'start "" "%EXE%"',
    'goto end',
    ':fail',
    'del "%NEW%" >nul 2>&1',
    ':end',
    '(goto) 2>nul & del "%~f0"',
    '',
  ].join('\r\n'));
  const child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return script;
}

module.exports = { compareVersions, checkLatest, download, applyAndRestart };

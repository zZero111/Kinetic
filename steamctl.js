// Starts Steam installs and updates without showing Steam. Steam stays signed in and does the downloading.
// This relies on undocumented behaviour, and manifests are only ever changed while Steam is closed:
// - updates: Steam delays pending updates until ScheduledAutoUpdate, so moving that into the past makes the
//   update run when Steam next starts. The state flags are left alone (changing them made Steam ignore the game).
// - installs: a new manifest marked "update running" (StateFlags 1026) is downloaded when Steam next starts.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const DOWNLOADING = 1026; // update required + update started
const INSTALLED = 4, RUNNING = 256, PAUSED = 512, STARTED = 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (err, out) => resolve(err ? '' : out)));

async function root() {
  const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']));
  const p = m ? m[1].trim().replace(/\//g, '\\') : '';
  return p && fs.existsSync(path.join(p, 'steam.exe')) ? p : null;
}

function libraries(steamRoot) {
  const seen = new Map([[steamRoot.toLowerCase(), steamRoot]]);
  try {
    const vdf = fs.readFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) { const p = m[1].replace(/\\\\/g, '\\'); seen.set(p.toLowerCase(), p); }
  } catch {}
  return [...seen.values()].filter((l) => fs.existsSync(path.join(l, 'steamapps')));
}

function manifestPath(steamRoot, id) {
  for (const lib of libraries(steamRoot)) {
    const f = path.join(lib, 'steamapps', `appmanifest_${id}.acf`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const freeSpace = (dir) => { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return 0; } };

// the default place for a new game: the library with the most free space
function roomiestLibrary(steamRoot) {
  return libraries(steamRoot).sort((a, b) => freeSpace(b) - freeSpace(a))[0];
}

const safeFolder = (name) => name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').replace(/\s+/g, ' ').replace(/[. ]+$/, '').trim() || 'Game';

function markForUpdate(file, backupDir) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/"StateFlags"\s+"\d+"/.test(text)) throw new Error('Unexpected Steam manifest format');
  const due = /"ScheduledAutoUpdate"\s+"\d+"/.test(text)
    ? text.replace(/("ScheduledAutoUpdate"\s+")\d+"/, '$11"')
    : text.replace(/("StateFlags"\s+"\d+"\r?\n)/, '$1\t"ScheduledAutoUpdate"\t\t"1"\n');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(file, path.join(backupDir, `${path.basename(file)}.${Date.now()}`));
  fs.writeFileSync(file, withFlags(due, (f) => f & ~PAUSED));
}

const withFlags = (text, fn) => text.replace(/("StateFlags"\s+")(\d+)"/, (_m, head, f) => `${head}${fn(Number(f))}"`);

function pause(file) {
  fs.writeFileSync(file, withFlags(fs.readFileSync(file, 'utf8'), (f) => (f | PAUSED) & ~(RUNNING | STARTED)));
}

// the update stays pending in Steam, delayed for a week; files already downloaded are kept by Steam
function cancelUpdate(file) {
  const later = Math.floor(Date.now() / 1000) + 7 * 86400;
  const text = withFlags(fs.readFileSync(file, 'utf8'), (f) => f & ~(RUNNING | STARTED | PAUSED));
  fs.writeFileSync(file, text.replace(/("ScheduledAutoUpdate"\s+")\d+"/, `$1${later}"`));
}

// only for a game that never finished installing. The manifest goes now, while Steam is closed; the partial
// download can be many GB, so its folders are returned for removeLeftovers to delete in the background.
function cancelInstall(file, id) {
  const flags = Number(/"StateFlags"\s+"(\d+)"/.exec(fs.readFileSync(file, 'utf8'))?.[1] || 0);
  if (flags & INSTALLED) throw new Error('This game is already installed, so it was left alone');
  const apps = path.dirname(file);
  fs.rmSync(file, { force: true });
  return ['downloading', 'temp'].map((d) => path.join(apps, d, String(id)));
}

const removeLeftovers = (dirs) => Promise.all(dirs.map((d) => fs.promises.rm(d, { recursive: true, force: true }).catch(() => {})));

function writeInstallManifest(lib, id, name) {
  const q = (s) => String(s).replace(/["\\]/g, '');
  const file = path.join(lib, 'steamapps', `appmanifest_${id}.acf`);
  fs.writeFileSync(file, [
    '"AppState"', '{', `\t"appid"\t\t"${id}"`, '\t"Universe"\t\t"1"', `\t"name"\t\t"${q(name)}"`,
    `\t"StateFlags"\t\t"${DOWNLOADING}"`, `\t"installdir"\t\t"${q(safeFolder(name))}"`, '}', '',
  ].join('\n'));
  return file;
}

// Steam only writes download progress to the manifest when it finishes. While it runs, it adds a 48-byte
// record per chunk to downloading/state_<appid>_<depot>.patch, so the size gives a live estimate.
// 900 KB per record was measured on a real 8.6 GB update (9,570 records).
const PATCH_RECORD = 48, BYTES_PER_RECORD = 900000;
function estimateBytes(file) {
  const id = /appmanifest_(\d+)\.acf$/.exec(file)?.[1];
  const dir = path.join(path.dirname(file), 'downloading');
  let bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`state_${id}_`) && f.endsWith('.patch')) bytes += fs.statSync(path.join(dir, f)).size;
    }
  } catch {}
  return Math.floor(bytes / PATCH_RECORD) * BYTES_PER_RECORD;
}

function progress(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    const num = (k) => Number(new RegExp(`"${k}"\\s+"(\\d+)"`).exec(t)?.[1] || 0);
    const flags = num('StateFlags');
    const total = num('BytesToDownload'), written = num('BytesDownloaded');
    const estimated = !written && (flags & (RUNNING | STARTED)) !== 0;
    const got = estimated ? Math.min(estimateBytes(file), Math.floor(total * 0.99)) : written;
    const stage = num('BytesToStage'), staged = num('BytesStaged');
    const installing = !!total && got >= total && stage > 0;
    const part = installing ? staged / stage : total ? got / total : 0;
    return {
      stage, owned: num('LastOwner') !== 0, result: num('UpdateResult'), done: (flags & INSTALLED) !== 0 && (flags & 2) === 0 && (flags & STARTED) === 0, got, total,
      estimated, paused: (flags & PAUSED) !== 0, active: (flags & (RUNNING | STARTED)) !== 0, installing,
      percent: Math.min(100, Math.floor(part * 100)),
    };
  } catch { return null; }
}

const steamRunning = async () => /steam\.exe/i.test(await run('tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH']));

async function gameRunning() {
  const m = /RunningAppID\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'RunningAppID']));
  return !!m && parseInt(m[1], 16) !== 0;
}

async function shutdown(steamRoot) {
  if (!(await steamRunning())) return;
  spawn(path.join(steamRoot, 'steam.exe'), ['-shutdown'], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 60; i++) { await sleep(500); if (!(await steamRunning())) return; }
  throw new Error('Steam did not close in time, so nothing was changed');
}

// -silent starts Steam minimised to the tray with no window; the debug flag lets steamlive.js read exact progress
function start(steamRoot) {
  spawn(path.join(steamRoot, 'steam.exe'), ['-silent', '-cef-enable-debugging'], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { root, libraries, freeSpace, manifestPath, roomiestLibrary, markForUpdate, pause, cancelUpdate, cancelInstall, removeLeftovers, writeInstallManifest, progress, gameRunning, shutdown, start, safeFolder };

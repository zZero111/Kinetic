// Detects games installed through other launchers. Nothing is modified; each scanner just reads the
// launcher's own files / registry entries and returns candidates for the user to confirm.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const reg = (args) => new Promise((resolve) =>
  execFile('reg', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out)));

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

// ---------------------------------------------------------------- Steam
async function steamRoot() {
  const out = await reg(['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(out);
  const p = m ? m[1].trim().replace(/\//g, '\\') : '';
  return p && exists(p) ? p : null;
}

// librarycache layout differs between Steam versions: either <appid>/<hash>/file or <appid>_file at the top.
function findCache(root, appid, name) {
  const base = path.join(root, 'appcache', 'librarycache');
  const flat = path.join(base, `${appid}_${name}`);
  if (exists(flat)) return flat;
  const dir = path.join(base, String(appid));
  const direct = path.join(dir, name);
  if (exists(direct)) return direct;
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isDirectory() && exists(path.join(dir, d.name, name))) return path.join(dir, d.name, name);
    }
  } catch {}
  return '';
}

async function scanSteam() {
  const root = await steamRoot();
  if (!root) return { error: 'Steam was not found on this PC' };
  const libs = new Set([root]);
  try {
    const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  } catch {}
  const games = [];
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    let files = [];
    try { files = fs.readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
    for (const f of files) {
      let acf = '';
      try { acf = fs.readFileSync(path.join(apps, f), 'utf8'); } catch { continue; }
      const appid = /"appid"\s+"(\d+)"/.exec(acf)?.[1];
      const name = /"name"\s+"([^"]+)"/.exec(acf)?.[1];
      const dir = /"installdir"\s+"([^"]+)"/.exec(acf)?.[1];
      if (!appid || !name || appid === '228980') continue; // 228980 = Steamworks Common Redistributables
      if (/^(Steam Linux Runtime|Proton|Steamworks)/i.test(name)) continue;
      const folder = dir ? path.join(apps, 'common', dir) : '';
      games.push({
        key: `steam:${appid}`, source: 'steam', sourceId: appid, title: name, tag: 'Steam',
        launchUri: `steam://rungameid/${appid}`, watchFolder: folder, exe: '',
        cover: findCache(root, appid, 'library_600x900.jpg'),
        background: findCache(root, appid, 'library_hero.jpg'),
        logo: findCache(root, appid, 'logo.png'),
        detail: folder,
      });
    }
  }
  return { games };
}

// ---------------------------------------------------------------- Epic Games
async function scanEpic() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  if (!exists(dir)) return { error: 'The Epic Games Launcher was not found on this PC' };
  const games = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.item'))) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!m.DisplayName || !m.InstallLocation) continue;
    if (m.bIsIncompleteInstall) continue;
    if (Array.isArray(m.AppCategories) && !m.AppCategories.includes('games')) continue;
    const exe = m.LaunchExecutable ? path.join(m.InstallLocation, m.LaunchExecutable) : '';
    const uri = m.CatalogNamespace && m.CatalogItemId && m.AppName
      ? `com.epicgames.launcher://apps/${m.CatalogNamespace}%3A${m.CatalogItemId}%3A${m.AppName}?action=launch&silent=true` : '';
    games.push({
      key: `epic:${m.AppName}`, source: 'epic', sourceId: m.AppName, title: m.DisplayName, tag: 'Epic Games',
      launchUri: uri, watchFolder: m.InstallLocation, exe, cover: '', background: '', logo: '',
      detail: m.InstallLocation,
    });
  }
  return { games };
}

// ---------------------------------------------------------------- GOG
async function scanGog() {
  const out = await reg(['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s']);
  if (!out) return { error: 'No GOG games were found (GOG Galaxy / GOG installers were not detected)' };
  const blocks = out.split(/\r?\n\r?\n/);
  const games = [];
  for (const b of blocks) {
    if (!/GOG\.com\\Games\\\d+\s*$/m.test(b.split(/\r?\n/)[0] || '')) continue;
    const val = (k) => new RegExp(`^[ \\t]+${k}[ \\t]+REG_\\w+[ \\t]*(.*)$`, 'm').exec(b)?.[1]?.trim() || '';
    const id = val('gameID') || /\\(\d+)\s*$/.exec(b.split(/\r?\n/)[0])?.[1];
    const name = val('gameName');
    const exe = val('exe');
    if (!name || !exe) continue;
    games.push({
      key: `gog:${id}`, source: 'gog', sourceId: id, title: name, tag: 'GOG',
      exe, args: val('launchParam'), cwd: val('workingDir'), launchUri: '', watchFolder: '',
      cover: '', background: '', logo: '', detail: val('path'),
    });
  }
  return { games };
}

// Every installed Steam game and whether Steam has an update waiting (StateFlags bit 2 = update required)
async function steamState() {
  const root = await steamRoot();
  if (!root) return [];
  const libs = new Set([root]);
  try {
    const vdf = await fs.promises.readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  } catch {}
  const found = new Map(); // the same library can be listed twice with different letter case
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    let files = [];
    try { files = (await fs.promises.readdir(apps)).filter((f) => /^appmanifest_\d+\.acf$/.test(f)); } catch { continue; }
    await Promise.all(files.map(async (f) => {
      try {
        const acf = await fs.promises.readFile(path.join(apps, f), 'utf8');
        const get = (k) => new RegExp(`"${k}"\\s+"([^"]*)"`).exec(acf)?.[1];
        const id = get('appid');
        if (id && id !== '228980') found.set(id, { id, name: get('name') || id, update: !!(Number(get('StateFlags')) & 2) });
      } catch {}
    }));
  }
  return [...found.values()];
}

const scanners = { steam: scanSteam, epic: scanEpic, gog: scanGog };

async function scan(platform) {
  const fn = scanners[platform];
  if (!fn) return { error: 'Unknown platform' };
  try { return await fn(); } catch (err) { return { error: err.message }; }
}

module.exports = { scan, steamState };

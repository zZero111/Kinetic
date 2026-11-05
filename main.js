const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, net, screen } = require('electron');
const importers = require('./importers');
const updater = require('./updater');
const { spawn, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// a packaged exe would otherwise use a different folder name and lose the library
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'game-launcher'));
const userData = () => app.getPath('userData');
const libraryFile = () => path.join(userData(), 'library.json');
const settingsFile = () => path.join(userData(), 'settings.json');
const running = new Map(); // game id -> child process
let win = null;
let tray = null;
let discord = null;

// ---------------------------------------------------------------- persistence
function loadLibrary() {
  try {
    return JSON.parse(fs.readFileSync(libraryFile(), 'utf8'));
  } catch {
    // fall back to the automatic backup if the main file is corrupt
    try { return JSON.parse(fs.readFileSync(libraryFile() + '.bak', 'utf8')); } catch { return []; }
  }
}

function saveLibrary(games) {
  try { if (fs.existsSync(libraryFile())) fs.copyFileSync(libraryFile(), libraryFile() + '.bak'); } catch {}
  fs.writeFileSync(libraryFile(), JSON.stringify(games, null, 2));
}

const defaultSettings = { sgdbKey: '', discordId: '', closeToTray: false, azimuthPath: '', display: '', launchAtStartup: false, startMinimised: false, startFullscreen: false, afterLaunch: 'stay', updateRepo: '', autoUpdate: true };
function loadSettings() {
  try { return { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch { return { ...defaultSettings }; }
}
function saveSettings(s) { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }

function newGame(fields) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: '', exe: '', args: '', cwd: '', env: '', admin: false,
    description: '', tag: '', cover: '', background: '', logo: '', icon: '',
    saveDir: '', displayMode: '', priority: '', preLaunch: '', postExit: '', favourite: false, playTimeSec: 0, lastPlayed: null, launches: 0,
    added: new Date().toISOString(),
    ...fields,
  };
}

// ---------------------------------------------------------------- window / tray
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 32, height: 32 }));
  tray.setToolTip('Game Launcher');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open launcher', click: showWindow },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function chosenDisplay() {
  const id = loadSettings().display;
  return screen.getAllDisplays().find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}

// centred on the chosen monitor, never larger than its work area
function startBounds() {
  const wa = chosenDisplay().workArea;
  const width = Math.min(1400, wa.width), height = Math.min(860, wa.height);
  return { width, height, x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2) };
}

function moveToDisplay() {
  if (!win || win.isDestroyed()) return;
  const wasFull = win.isFullScreen();
  if (wasFull) win.setFullScreen(false);
  setTimeout(() => {
    win.setBounds(startBounds());
    if (wasFull) setTimeout(() => win.setFullScreen(true), 250);
  }, wasFull ? 350 : 0);
}

// launched by Windows at login with 'start minimised' on
function startHidden() { return process.argv.includes('--startup') && !!loadSettings().startMinimised; }

function createWindow() {
  win = new BrowserWindow({
    ...startBounds(), minWidth: 900, minHeight: 560,
    backgroundColor: '#07080f',
    show: !startHidden(),
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (startHidden()) createTray();
  else if (loadSettings().startFullscreen) win.once('ready-to-show', () => win && win.setFullScreen(true));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  win.on('focus', () => { syncAzimuth(); });
  win.on('close', (e) => {
    if (!app.isQuitting && loadSettings().closeToTray) {
      e.preventDefault();
      createTray();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
  return win;
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// ---------------------------------------------------------------- single instance + --launch
const launchArg = (argv) => (argv.find((a) => a.startsWith('--launch=')) || '').slice(9);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const id = launchArg(argv);
    if (id) launchGame(id); else showWindow();
  });
  app.whenReady().then(() => {
    const id = launchArg(process.argv);
    createWindow();
    if (loadSettings().discordId) setTimeout(discordConnect, 3000);
    if (app.isPackaged) fs.rm(path.join(process.resourcesPath, 'app.asar.new'), { force: true }, () => {}); // leftover from a failed update
    setTimeout(() => { if (loadSettings().autoUpdate !== false) checkForUpdate(); }, 8000);
    win.webContents.once('did-finish-load', () => { setTimeout(syncAzimuth, 1500); if (id) launchGame(id); });
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on('window-all-closed', () => { if (!loadSettings().closeToTray) app.quit(); });
  app.on('before-quit', () => { app.isQuitting = true; });
}

// ---------------------------------------------------------------- library IPC
function problemFor(g) {
  if (g.launchUri) {
    if (!g.watchFolder || fs.existsSync(g.watchFolder)) return '';
    const r = path.parse(g.watchFolder).root;
    return r && !fs.existsSync(r) ? `Drive ${r.replace(/[\\/]+$/, '')} is not connected` : 'Game is no longer installed';
  }
  if (fs.existsSync(g.exe)) return '';
  const root = path.parse(g.exe).root;
  if (root && !fs.existsSync(root)) return `Drive ${root.replace(/[\\/]+$/, '')} is not connected`;
  return 'Game file not found';
}

const pathExists = (p) => fs.promises.access(p).then(() => true, () => false);
async function problemForAsync(g) {
  const root = (p) => { const r = path.parse(p).root; return r ? r.replace(/[\\/]+$/, '') : ''; };
  if (g.launchUri) {
    if (!g.watchFolder || await pathExists(g.watchFolder)) return '';
    return root(g.watchFolder) && !(await pathExists(root(g.watchFolder) + '\\')) ? `Drive ${root(g.watchFolder)} is not connected` : 'Game is no longer installed';
  }
  if (await pathExists(g.exe)) return '';
  return root(g.exe) && !(await pathExists(root(g.exe) + '\\')) ? `Drive ${root(g.exe)} is not connected` : 'Game file not found';
}

ipcMain.handle('library:get', async () => {
  const games = loadLibrary();
  const problems = await Promise.all(games.map(problemForAsync)); // checked in parallel, off the main thread
  return games.map((g, i) => ({ ...newGame({}), ...g, running: running.has(g.id), problem: problems[i] }));
});

ipcMain.handle('library:add', async () => {
  const exe = await dialog.showOpenDialog({
    title: 'Select the game executable',
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe', 'bat', 'lnk'] }],
  });
  if (exe.canceled) return null;
  const exePath = exe.filePaths[0];
  const games = loadLibrary();
  games.push(newGame({ title: path.basename(exePath, path.extname(exePath)), exe: exePath }));
  saveLibrary(games);
  return true;
});

// ---- Azimuth: games live in azimuth.ini as [title-<id>] sections; game=<id> under [launcher] selects one.
function findAzimuth() {
  const candidates = [
    path.join(__dirname, 'azimuth', 'azimuth.exe'),
    path.join(path.dirname(process.execPath), 'azimuth', 'azimuth.exe'),
    loadSettings().azimuthPath,
    ...loadLibrary().filter((g) => g.azimuth).map((g) => g.azimuth),
    'C:\\Games\\Xbox One\\Azimuth\\azimuth.exe',
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function importAzimuth(azimuth) {
  const iniPath = path.join(path.dirname(azimuth), 'data', 'azimuth.ini');
  if (!fs.existsSync(iniPath)) return 0;
  const ini = fs.readFileSync(iniPath, 'utf16le');
  const games = loadLibrary();
  let changed = 0;
  for (const m of ini.matchAll(/^\[title-([0-9a-f]+)\]\r?\n((?:(?!\[).*\r?\n?)*)/gim)) {
    const titleId = m[1];
    const { cover, background } = findAzimuthArt(azimuth, titleId);
    // match by title id so switching to a portable Azimuth copy updates entries instead of duplicating them
    const existing = games.find((g) => g.azimuth && g.titleId === titleId);
    if (existing) {
      if (existing.azimuth !== azimuth) { existing.azimuth = azimuth; existing.exe = azimuth; changed++; }
      if (!existing.cover && cover) { existing.cover = cover; changed++; }
      if (!existing.background && background) { existing.background = background; changed++; }
      continue;
    }
    const name = /^name=(.*)$/m.exec(m[2]);
    games.push(newGame({
      title: name ? name[1].trim() : `Azimuth ${titleId}`,
      exe: azimuth, azimuth, titleId, cover, background, tag: 'Xbox One',
    }));
    changed++;
  }
  if (changed) saveLibrary(games);
  return changed;
}

// Pick up games added in Azimuth itself whenever the launcher regains focus.
let lastIniMtime = 0;
function syncAzimuth() {
  try {
    const az = findAzimuth();
    if (!az) return;
    const mtime = fs.statSync(path.join(path.dirname(az), 'data', 'azimuth.ini')).mtimeMs;
    if (mtime === lastIniMtime) return;
    lastIniMtime = mtime;
    if (loadLibrary().some((g) => g.azimuth) && importAzimuth(az)) send('library:changed');
  } catch {}
}

ipcMain.handle('library:addAzimuth', async () => {
  let azimuth = findAzimuth();
  if (!azimuth) {
    const pick = await dialog.showOpenDialog({
      title: 'Select azimuth.exe',
      properties: ['openFile'],
      filters: [{ name: 'Azimuth', extensions: ['exe'] }],
    });
    if (pick.canceled) return null;
    azimuth = pick.filePaths[0];
  }
  const s = loadSettings();
  s.azimuthPath = azimuth;
  saveSettings(s);
  return importAzimuth(azimuth);
});

// Azimuth caches art as data/titles/<ID>/art/<hash>/tile.png; prefer the hash folder that also has splash.jpg.
function findAzimuthArt(azimuth, titleId) {
  const artDir = path.join(path.dirname(azimuth), 'data', 'titles', titleId.toUpperCase(), 'art');
  try {
    const tiles = fs.readdirSync(artDir)
      .map((d) => path.join(artDir, d))
      .filter((d) => fs.existsSync(path.join(d, 'tile.png')))
      .sort((a, b) => fs.existsSync(path.join(b, 'splash.jpg')) - fs.existsSync(path.join(a, 'splash.jpg')));
    if (!tiles.length) return { cover: '', background: '' };
    const splash = path.join(tiles[0], 'splash.jpg');
    return { cover: path.join(tiles[0], 'tile.png'), background: fs.existsSync(splash) ? splash : '' };
  } catch {
    return { cover: '', background: '' };
  }
}

function selectAzimuthTitle(azimuth, titleId, display) {
  const iniPath = path.join(path.dirname(azimuth), 'data', 'azimuth.ini');
  const ini = fs.readFileSync(iniPath, 'utf16le'); // BOM is kept as \ufeff and written back
  let updated = ini.replace(/^(\ufeff?\[launcher\]\r?\n(?:(?!\[).*\r?\n)*?)game=.*$/m, `$1game=${titleId}`);
  if (display === 'fullscreen' || display === 'windowed') {
    updated = updated.replace(/^(\ufeff?\[launcher\]\r?\n(?:(?!\[).*\r?\n)*?)display=.*$/m, `$1display=${display}`);
  }
  if (updated !== ini) fs.writeFileSync(iniPath, updated, 'utf16le');
}

ipcMain.handle('library:update', (_e, id, patch) => {
  const games = loadLibrary();
  const g = games.find((x) => x.id === id);
  if (g) Object.assign(g, patch);
  saveLibrary(games);
});

ipcMain.handle('library:remove', (_e, id) => {
  saveLibrary(loadLibrary().filter((g) => g.id !== id));
});

ipcMain.handle('library:pickArt', async (_e, kind) => {
  const r = await dialog.showOpenDialog({
    title: `Select ${kind} image`,
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:pickFolder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------------------------------------------------------------- launching
function parseEnv(str) {
  const env = {};
  for (const part of (str || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) env[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return env;
}

// ---- Discord Rich Presence (status + last error are kept so Settings can show what went wrong) ----
let discordStatus = 'Not connected';
let discordPending = null;
let discordGame = null; // game currently being shown, re-applied after a reconnect
function dlog(msg) {
  discordStatus = msg;
  try { fs.appendFileSync(path.join(userData(), 'discord.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function discordConnect() {
  const id = loadSettings().discordId;
  if (!id) { dlog('No application ID set'); return Promise.resolve(false); }
  if (discord) return Promise.resolve(true);
  if (discordPending) return discordPending;
  discordPending = (async () => {
    try {
      const { Client } = require('@xhayper/discord-rpc');
      const c = new Client({ clientId: id });
      c.on('disconnected', () => { discord = null; dlog('Disconnected from Discord'); });
      await Promise.race([c.login(), new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out — is the Discord desktop app open?')), 8000))]);
      discord = c;
      dlog(`Connected as ${c.user ? c.user.username : 'unknown user'}`);
      if (discordGame) discordActivity(discordGame);
      return true;
    } catch (err) {
      discord = null;
      dlog('Connection failed: ' + (err && err.message ? err.message : err));
      return false;
    } finally { discordPending = null; }
  })();
  return discordPending;
}

function discordActivity(g) {
  discordGame = g;
  if (!discord || !discord.user) return;
  const call = g
    ? discord.user.setActivity({ details: g.title, state: 'via Kinetic', startTimestamp: new Date(), instance: false, statusDisplayType: 2 })
    : discord.user.clearActivity();
  Promise.resolve(call).then(() => dlog(g ? `Showing "${g.title}"` : 'Cleared activity'))
    .catch((err) => dlog('Could not set activity: ' + (err && err.message ? err.message : err)));
}

ipcMain.handle('discord:test', async () => {
  const ok = await discordConnect();
  if (ok) {
    discordActivity({ title: 'Test (this will clear in 10s)' });
    setTimeout(() => { if (!running.size) discordActivity(null); }, 10000);
  }
  return { ok, message: discordStatus };
});

function azimuthFolder(azimuth, titleId) {
  try {
    const ini = fs.readFileSync(path.join(path.dirname(azimuth), 'data', 'azimuth.ini'), 'utf16le');
    const start = ini.toLowerCase().indexOf('[title-' + titleId.toLowerCase() + ']');
    if (start < 0) return '';
    const rest = ini.slice(start + 1);
    const section = rest.slice(0, Math.max(0, rest.indexOf('[')) || rest.length);
    const f = /^folder=(.*)$/m.exec(section);
    return f ? f[1].trim() : '';
  } catch { return ''; }
}

// true if a process other than `ignorePid` is running from `folder` (or azimuth.exe is alive).
// Uses one filtered WMI query, so each probe costs far less than listing every process.
function gameProcessAlive(folder, ignorePid, matchAzimuth = true) {
  return new Promise((resolve) => {
    const unsafe = !folder || /['"`$]/.test(folder);
    const conds = [];
    if (folder && !unsafe) conds.push("ExecutablePath LIKE '" + folder.replace(/[%_\[]/g, (m) => '[' + m + ']').replace(/\\/g, '\\\\') + "%'");
    if (matchAzimuth) conds.push("Name = 'azimuth.exe'");
    if (!conds.length) return resolve(false);
    const cmd = 'Get-CimInstance Win32_Process -Filter "' + conds.join(' OR ') + '" | Where-Object { $_.ProcessId -ne ' + (ignorePid || 0) + ' } | Select-Object -First 1 -ExpandProperty ProcessId';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 20000 }, (err, out) => resolve(!err && /\d/.test(out)));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// pre-launch / post-exit commands run through cmd.exe; pre-launch is awaited (max 60s), post-exit is fire-and-forget
function runCommand(cmd, wait) {
  return new Promise((resolve) => {
    try {
      const child = execFile('cmd.exe', ['/c', cmd], { windowsHide: true, timeout: 60000 }, () => resolve());
      if (!wait) { child.unref(); resolve(); }
    } catch { resolve(); }
  });
}

// minimise or hide the launcher while a game runs (settings: "When a game starts")
function afterGameStarts() {
  const mode = loadSettings().afterLaunch;
  if (!win || win.isDestroyed()) return;
  if (mode === 'minimise') win.minimize();
  else if (mode === 'tray') { createTray(); win.hide(); }
}

function endSession(id, started, code, err, hint, countPlay = true, endTime = Date.now()) {
  running.delete(id);
  const secs = Math.max(0, Math.round((endTime - started) / 1000));
  if (countPlay) {
    const games = loadLibrary();
    const cur = games.find((x) => x.id === id);
    if (cur) {
      cur.playTimeSec += secs;
      cur.lastPlayed = new Date().toISOString();
      cur.launches = (cur.launches || 0) + 1;
      saveLibrary(games);
    }
  }
  if (!running.size) discordActivity(null);
  if (err) send('game:failed', id, `Could not start: ${err.message}`);
  else if (countPlay && secs < 6 && code) send('game:failed', id, `Exited after ${secs}s with code ${code}.${hint ? ' ' + hint : ''}`);
  const gg = loadLibrary().find((x) => x.id === id);
  if (gg && gg.postExit) runCommand(gg.postExit, false);
  const mode = loadSettings().afterLaunch;
  if (!running.size && mode && mode !== 'stay') showWindow();
  send('game:exited', id);
}

// Steam / Epic games start through their own launcher, so we open the launcher's URI, wait for a process
// to appear in the game's folder, and treat the game as running until that folder has no processes left.
async function launchViaUri(g) {
  const id = g.id;
  if (g.saveDir && fs.existsSync(g.saveDir)) { try { backupSaves(g); } catch {} }
  if (g.preLaunch) await runCommand(g.preLaunch, true);
  running.set(id, {});
  discordGame = g;
  discordConnect().then((ok) => { if (ok && running.has(id)) discordActivity(g); });
  try {
    await shell.openExternal(g.launchUri);
  } catch (err) {
    endSession(id, Date.now(), 1, err, '', false);
    return { ok: false, error: 'Could not open the launcher: ' + err.message };
  }
  (async () => {
    const deadline = Date.now() + 180000;
    let seen = false;
    while (Date.now() < deadline && !seen) { await sleep(5000); seen = await gameProcessAlive(g.watchFolder, 0, false); }
    if (!seen) {
      endSession(id, Date.now(), 0, null, '', false);
      send('game:failed', id, `Could not see ${g.title} start. Check that ${g.source === 'epic' ? 'Epic' : 'Steam'} is signed in and the game updated.`);
      return;
    }
    const started = Date.now();
    afterGameStarts();
    let misses = 0, lastSeen = Date.now();
    while (misses < 2) {
      await sleep(8000);
      if (await gameProcessAlive(g.watchFolder, 0, false)) { misses = 0; lastSeen = Date.now(); } else misses++;
    }
    endSession(id, started, 0, null, '', true, lastSeen);
  })();
  return { ok: true };
}

async function launchGame(id) {
  const g = loadLibrary().find((x) => x.id === id);
  if (!g) return { ok: false, error: 'Game not found' };
  if (running.has(id)) return { ok: false, error: 'Already running' };
  const problem = problemFor(g);
  if (problem) return { ok: false, error: problem };
  if (g.launchUri) return launchViaUri(g);

  const args = g.args ? g.args.match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, '')) : [];
  if (g.azimuth) {
    try { selectAzimuthTitle(g.azimuth, g.titleId, g.displayMode); } catch (err) { return { ok: false, error: 'Could not update azimuth.ini: ' + err.message }; }
    args.unshift('--skip-launcher');
  } else if (g.displayMode === 'fullscreen' && !args.includes('-fullscreen')) args.push('-fullscreen');
  else if (g.displayMode === 'windowed' && !args.includes('-windowed')) args.push('-windowed');
  const cwd = g.cwd && fs.existsSync(g.cwd) ? g.cwd : path.dirname(g.exe);
  if (g.saveDir && fs.existsSync(g.saveDir)) { try { backupSaves(g); } catch {} }

  const env = { ...process.env, ...parseEnv(g.env) };
  if (g.preLaunch) await runCommand(g.preLaunch, true);
  let child;
  if (g.admin) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const cmd = `Start-Process -FilePath ${q(g.exe)} ${args.length ? `-ArgumentList ${q(args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '))}` : ''} -WorkingDirectory ${q(cwd)} -Verb RunAs -Wait`;
    child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], { env, stdio: 'ignore', windowsHide: true });
  } else {
    child = spawn(g.exe, args, { cwd, env, detached: false, stdio: 'ignore' });
  }
  const started = Date.now();
  running.set(id, child);
  if (g.priority && child.pid) {
    try { os.setPriority(child.pid, g.priority === 'high' ? os.constants.priority.PRIORITY_HIGH : os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch {}
  }
  afterGameStarts();
  discordGame = g;
  discordConnect().then((ok) => { if (ok && running.has(id)) discordActivity(g); });

  let done = false;
  const finish = (code, err, endTime) => {
    if (done) return;
    done = true;
    endSession(id, started, code, err, "If it is an Azimuth game, check Azimuth's own log.", true, endTime);
  };
  // Azimuth may hand the game to another process and exit, so for Azimuth titles keep the game "running"
  // (play time, Discord status) while anything is still running from the title's folder or azimuth.exe itself.
  child.on('exit', async (code) => {
    let lastSeen = Date.now();
    if (g.azimuth) {
      const folder = azimuthFolder(g.azimuth, g.titleId);
      let misses = 0;
      await sleep(5000);
      while (misses < 2) {
        if (await gameProcessAlive(folder, child.pid)) { misses = 0; lastSeen = Date.now(); } else misses++;
        await sleep(8000);
      }
    }
    finish(code, undefined, lastSeen);
  });
  child.on('error', (err) => finish(1, err));
  return { ok: true };
}
ipcMain.handle('game:launch', (_e, id) => launchGame(id));

// ---------------------------------------------------------------- shortcuts / folder / steam
function launcherCommand(g) {
  const args = app.isPackaged ? [] : [`"${app.getAppPath()}"`];
  args.push(`--launch=${g.id}`);
  return { target: process.execPath, args: args.join(' ') };
}

function safeName(s) { return s.replace(/[<>:"/\\|?*]+/g, '').trim() || 'Game'; }

ipcMain.handle('game:shortcut', (_e, id, where) => {
  const g = loadLibrary().find((x) => x.id === id);
  if (!g) return { ok: false, error: 'Game not found' };
  const dir = where === 'startmenu'
    ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : app.getPath('desktop');
  const { target, args } = launcherCommand(g);
  const icon = g.icon && g.icon.toLowerCase().endsWith('.ico') ? g.icon : (g.exe || process.execPath);
  const file = path.join(dir, safeName(g.title) + '.lnk');
  const ok = shell.writeShortcutLink(file, 'create', { target, args, cwd: path.dirname(target), icon, iconIndex: 0, description: g.title });
  return ok ? { ok: true, path: file } : { ok: false, error: 'Windows refused to create the shortcut' };
});

ipcMain.handle('game:folder', (_e, id) => {
  const g = loadLibrary().find((x) => x.id === id);
  if (!g) return;
  if (g.watchFolder && fs.existsSync(g.watchFolder)) shell.openPath(g.watchFolder);
  else if (fs.existsSync(g.exe)) shell.showItemInFolder(g.exe);
  else if (g.exe) shell.openPath(path.dirname(g.exe));
});

// ---- Steam non-Steam shortcut (binary shortcuts.vdf) ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (str) => {
  let c = 0xffffffff;
  for (const b of Buffer.from(str, 'utf8')) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function steamPath() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true }, (err, out) => {
      const m = !err && /SteamPath\s+REG_SZ\s+(.+)/.exec(out);
      resolve(m ? m[1].trim() : null);
    });
  });
}
const isRunning = (exeName) => new Promise((resolve) =>
  execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], { windowsHide: true }, (_e, out) => resolve(!!out && out.toLowerCase().includes(exeName.toLowerCase()))));

function vdfEntry(index, g) {
  const { target, args } = launcherCommand(g);
  const exe = `"${target}"`;
  const appid = (crc32(exe + g.title) | 0x80000000) >>> 0;
  const str = (k, v) => Buffer.concat([Buffer.from([1]), Buffer.from(k + '\0' + v + '\0', 'utf8')]);
  const int = (k, v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return Buffer.concat([Buffer.from([2]), Buffer.from(k + '\0', 'utf8'), b]); };
  return Buffer.concat([
    Buffer.from('\0' + index + '\0', 'utf8'),
    int('appid', appid), str('AppName', g.title), str('Exe', exe), str('StartDir', `"${path.dirname(target)}"`),
    str('icon', g.icon || ''), str('ShortcutPath', ''), str('LaunchOptions', args),
    int('IsHidden', 0), int('AllowDesktopConfig', 1), int('AllowOverlay', 1), int('OpenVR', 0), int('Devkit', 0),
    str('DevkitGameID', ''), int('LastPlayTime', 0),
    Buffer.from('\0tags\0\x08', 'latin1'),
    Buffer.from([8]),
  ]);
}

ipcMain.handle('game:steam', async (_e, id) => {
  const g = loadLibrary().find((x) => x.id === id);
  if (!g) return { ok: false, error: 'Game not found' };
  const steam = await steamPath();
  if (!steam || !fs.existsSync(path.join(steam, 'userdata'))) return { ok: false, error: 'Steam was not found on this PC' };
  if (await isRunning('steam.exe')) return { ok: false, error: 'Close Steam first (it overwrites shortcuts while running), then try again' };
  const users = fs.readdirSync(path.join(steam, 'userdata')).filter((d) => /^\d+$/.test(d) && d !== '0');
  if (!users.length) return { ok: false, error: 'No Steam user profile found' };
  for (const u of users) {
    const dir = path.join(steam, 'userdata', u, 'config');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'shortcuts.vdf');
    let buf = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.concat([Buffer.from('\0shortcuts\0', 'latin1'), Buffer.from([8, 8])]);
    const text = buf.toString('latin1');
    if (text.includes(`AppName\0${g.title}\0`) && text.includes(`--launch=${g.id}`)) continue; // already added
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.launcher-backup');
    const idx = Math.max(-1, ...[...text.matchAll(/\0(\d+)\0\x02appid\0/g)].map((m) => +m[1])) + 1;
    buf = Buffer.concat([buf.subarray(0, buf.length - 2), vdfEntry(idx, g), Buffer.from([8, 8])]);
    fs.writeFileSync(file, buf);
  }
  return { ok: true };
});

// ---------------------------------------------------------------- saves
const backupRoot = (g) => path.join(userData(), 'save-backups', g.id);

function backupSaves(g) {
  if (!g.saveDir || !fs.existsSync(g.saveDir)) throw new Error('Save folder not set or missing');
  const dest = path.join(backupRoot(g), new Date().toISOString().replace(/[:.]/g, '-'));
  fs.cpSync(g.saveDir, dest, { recursive: true });
  const all = fs.readdirSync(backupRoot(g)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 10))) fs.rmSync(path.join(backupRoot(g), old), { recursive: true, force: true });
  return dest;
}

ipcMain.handle('saves:backup', (_e, id) => {
  const g = loadLibrary().find((x) => x.id === id);
  try { return { ok: true, path: backupSaves(g) }; } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('saves:open', (_e, id) => {
  const g = loadLibrary().find((x) => x.id === id);
  if (!g) return;
  fs.mkdirSync(backupRoot(g), { recursive: true });
  shell.openPath(backupRoot(g));
});

// ---------------------------------------------------------------- SteamGridDB
const SGDB = 'https://www.steamgriddb.com/api/v2';
async function sgdb(endpoint) {
  const key = loadSettings().sgdbKey;
  if (!key) throw new Error('Add your SteamGridDB API key in Settings first');
  const res = await net.fetch(SGDB + endpoint, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`SteamGridDB returned ${res.status}`);
  return (await res.json()).data || [];
}

ipcMain.handle('sgdb:search', async (_e, title) => {
  try {
    const games = await sgdb('/search/autocomplete/' + encodeURIComponent(title));
    if (!games.length) return { ok: false, error: 'No match on SteamGridDB' };
    const gid = games[0].id;
    const pick = (list) => list.slice(0, 12).map((x) => ({ url: x.url, thumb: x.thumb || x.url }));
    const [grids, heroes, logos, icons] = await Promise.all([
      sgdb(`/grids/game/${gid}?dimensions=600x900`).catch(() => []),
      sgdb(`/heroes/game/${gid}`).catch(() => []),
      sgdb(`/logos/game/${gid}`).catch(() => []),
      sgdb(`/icons/game/${gid}`).catch(() => []),
    ]);
    return { ok: true, name: games[0].name, cover: pick(grids), background: pick(heroes), logo: pick(logos), icon: pick(icons) };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('sgdb:download', async (_e, url, id, kind) => {
  try {
    if (!/^https:\/\/[^/]*steamgriddb\.com\//i.test(url)) throw new Error('Unexpected image host');
    return { ok: true, path: await sgdbDownload(url, id, kind) };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------------------------------------------------------------- settings / prerequisites / data
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const s = { ...loadSettings(), ...patch };
  const moved = patch.display !== undefined && patch.display !== loadSettings().display;
  saveSettings(s);
  if (moved) moveToDisplay();
  if (patch.launchAtStartup !== undefined || patch.startMinimised !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: !!s.launchAtStartup, path: process.execPath,
      args: app.isPackaged ? ['--startup'] : [app.getAppPath(), '--startup'],
    });
  }
  if (s.closeToTray) createTray();
  else if (tray) { tray.destroy(); tray = null; }
  if (patch.discordId !== undefined) { if (discord) { try { discord.destroy(); } catch {} discord = null; } if (s.discordId) discordConnect(); }
  return s;
});

const regHas = (key, value) => new Promise((resolve) =>
  execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => resolve(!err && /0x1\b/.test(out))));

ipcMain.handle('prereq:check', async () => {
  const sys = path.join(process.env.windir || 'C:\\Windows', 'System32');
  const vc = (await regHas('HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64', 'Installed'))
    || (await regHas('HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\X64', 'Installed'));
  const has = (f) => fs.existsSync(path.join(sys, f));
  return [
    { name: 'Visual C++ 2015-2022 runtime (x64)', ok: vc },
    { name: 'Direct3D 11 / DXGI', ok: has('d3d11.dll') && has('dxgi.dll') },
    { name: 'Direct3D 12', ok: has('d3d12.dll') },
    { name: 'Legacy DirectX 9 runtime (d3dx9_43)', ok: has('d3dx9_43.dll') },
    { name: 'XInput (controllers)', ok: has('xinput1_4.dll') },
  ];
});

ipcMain.handle('prereq:open', (_e, which) => {
  const urls = {
    vcredist: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    directx: 'https://www.microsoft.com/en-us/download/details.aspx?id=8109',
    discord: 'https://discord.com/developers/applications',
  };
  if (urls[which]) shell.openExternal(urls[which]);
});

ipcMain.handle('data:backup', () => {
  const dir = path.join(userData(), 'library-backups');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `library-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.copyFileSync(libraryFile(), dest);
  return dest;
});
ipcMain.handle('data:open', () => shell.openPath(userData()));
ipcMain.handle('window:fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });


// ---------------------------------------------------------------- monitors
ipcMain.handle('display:list', () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Monitor ${i + 1} — ${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}${d.id === primary ? ' (primary)' : ''}`, // size is scaled by Windows display scaling, so multiply back to real pixels
  }));
});

// ---------------------------------------------------------------- importing from other launchers
async function sgdbBest(title) {
  const games = await sgdb('/search/autocomplete/' + encodeURIComponent(title));
  if (!games.length) return null;
  const gid = games[0].id;
  const first = async (ep) => (await sgdb(ep).catch(() => []))[0]?.url || '';
  const [cover, background, logo] = await Promise.all([
    first(`/grids/game/${gid}?dimensions=600x900`), first(`/heroes/game/${gid}`), first(`/logos/game/${gid}`),
  ]);
  return { cover, background, logo };
}

async function sgdbDownload(url, id, kind) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const ext = (path.extname(new URL(url).pathname) || '.png').toLowerCase();
  const dir = path.join(userData(), 'art');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}-${kind}-${Date.now()}${ext}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// fills in missing covers / backgrounds / logos from SteamGridDB (only when the user has added a key)
async function autoArt(ids) {
  if (!loadSettings().sgdbKey) return;
  for (const id of ids) {
    try {
      const g = loadLibrary().find((x) => x.id === id);
      if (!g || (g.cover && g.background && g.logo)) continue;
      const best = await sgdbBest(g.title);
      if (!best) continue;
      const patch = {};
      for (const kind of ['cover', 'background', 'logo']) {
        if (!g[kind] && best[kind]) { try { patch[kind] = await sgdbDownload(best[kind], id, kind); } catch {} }
      }
      if (Object.keys(patch).length) {
        const games = loadLibrary();
        Object.assign(games.find((x) => x.id === id) || {}, patch);
        saveLibrary(games);
        send('library:changed');
      }
    } catch {}
  }
}

ipcMain.handle('import:scan', async (_e, platform) => {
  const r = await importers.scan(platform);
  if (r.error) return { ok: false, error: r.error };
  const have = new Set(loadLibrary().map((g) => g.sourceKey).filter(Boolean));
  return { ok: true, games: r.games.map((g) => ({ ...g, already: have.has(g.key) })).sort((a, b) => a.title.localeCompare(b.title)) };
});

ipcMain.handle('import:add', async (_e, platform, keys) => {
  const r = await importers.scan(platform);
  if (r.error) return { ok: false, error: r.error };
  const games = loadLibrary();
  const have = new Set(games.map((g) => g.sourceKey).filter(Boolean));
  const added = [];
  for (const c of r.games.filter((x) => keys.includes(x.key) && !have.has(x.key))) {
    const { key, detail, ...fields } = c;
    const g = newGame({ ...fields, sourceKey: key });
    games.push(g);
    added.push(g.id);
  }
  saveLibrary(games);
  autoArt(added); // runs in the background
  return { ok: true, count: added.length };
});


// ---------------------------------------------------------------- updates (see updater.js)
let updateInfo = null;
let updating = false;
const updateFetch = (u, o) => net.fetch(u, o);
const updateRepo = () => loadSettings().updateRepo || '';

async function checkForUpdate() {
  try {
    // LAUNCHER_UPDATE_URL is only for testing against a local server
    const info = await updater.checkLatest({ repo: updateRepo(), url: process.env.LAUNCHER_UPDATE_URL, current: app.getVersion(), fetchFn: updateFetch });
    updateInfo = info.available ? info : null;
    send('update:available', updateInfo);
    return { ok: true, ...info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('update:info', () => ({ version: app.getVersion(), repo: updateRepo(), packaged: app.isPackaged }));
ipcMain.handle('update:check', () => checkForUpdate());

ipcMain.handle('update:install', async () => {
  if (!updateInfo) return { ok: false, error: 'No update to install' };
  if (!app.isPackaged) return { ok: false, error: 'Updates install into the packaged Kinetic.exe. Run npm run pack and use that exe.' };
  if (running.size) return { ok: false, error: 'Close your running game first' };
  if (updating) return { ok: false, error: 'Already updating' };
  updating = true;
  const target = path.join(process.resourcesPath, 'app.asar');
  const download = target + '.new';
  try {
    await updater.download(updateInfo, download, updateFetch, (p) => send('update:progress', p));
  } catch (err) {
    updating = false;
    fs.rmSync(download, { force: true });
    return { ok: false, error: err.message };
  }
  app.isQuitting = true;
  updater.applyAndRestart({ newFile: download, targetFile: target, exe: process.execPath });
  setTimeout(() => app.quit(), 200);
  return { ok: true };
});

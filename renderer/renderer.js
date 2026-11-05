const $ = (id) => document.getElementById(id);
const stage = $('stage');
const dlg = $('edit');
const settingsDlg = $('settings');

let games = [];
let tab = 'all';
let index = 0;
let selectedId = null;
let editing = null;
let pending = {};
let first = true;

// ---------------------------------------------------------------- helpers
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.style.display = 'none'), isErr ? 6000 : 3000);
}

const fileUrl = (p) => 'file:///' + p.replace(/%/g, '%25').replace(/\\/g, '/').replace(/#/g, '%23').replace(/'/g, '%27').replace(/\?/g, '%3F');
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const pad = (n) => String(n).padStart(2, '0');

// Steam style: "45 minutes", "1.5 hours", "214 hours"
function fmtHours(sec) {
  if (!sec) return 'Not played yet';
  const mins = Math.max(1, Math.round(sec / 60));
  if (sec < 3600) return `${mins} ${mins === 1 ? 'minute' : 'minutes'}`;
  const h = sec / 3600;
  const val = h >= 10 ? Math.round(h) : Math.round(h * 10) / 10;
  return `${val} ${val === 1 ? 'hour' : 'hours'}`;
}

function fmtLast(iso) {
  if (!iso) return 'Never';
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

// Images are decoded ahead of time, so a card never appears with its art missing or changing fit.
const artOf = (g) => g.bgView || g.background || g.cover;
const faceOf = (g) => g.cover || g.logo;
const warmed = new Map(); // url -> { img, done }; holding the Image keeps it decoded
const portrait = new Map(); // url -> true when the art fills the 3:4 frame
const isPortrait = (img) => Math.abs(img.naturalWidth / img.naturalHeight - 0.75) < 0.12;

function warm(src) {
  if (!src) return Promise.resolve();
  const url = fileUrl(src);
  if (warmed.has(url)) return warmed.get(url).done;
  const img = new Image();
  img.src = url;
  const done = img.decode().then(() => { portrait.set(url, isPortrait(img)); }, () => {});
  warmed.set(url, { img, done });
  if (warmed.size > 40) warmed.delete(warmed.keys().next().value);
  return done;
}
const warmGame = (g) => (g ? Promise.all([warm(artOf(g)), warm(faceOf(g)), warm(g.logo)]) : Promise.resolve());

function warmNeighbours(list) {
  if (list.length < 2) return;
  for (const k of [1, -1, 2, 3, 4]) warmGame(list[(index + k + list.length) % list.length]);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- list state
function visible() {
  const q = $('search').value.trim().toLowerCase();
  let list = games.filter((g) => g.title.toLowerCase().includes(q));
  if (tab === 'fav') list = list.filter((g) => g.favourite);
  if (tab === 'recent') list = list.filter((g) => g.lastPlayed);
  const sort = tab === 'recent' ? 'last' : $('sort').value;
  const by = {
    name: (a, b) => a.title.localeCompare(b.title),
    last: (a, b) => (b.lastPlayed || '').localeCompare(a.lastPlayed || ''),
    time: (a, b) => b.playTimeSec - a.playTimeSec,
    added: (a, b) => (b.added || '').localeCompare(a.added || ''),
  };
  return list.sort(by[sort]);
}

function current(list) {
  const i = list.findIndex((g) => g.id === selectedId);
  index = i >= 0 ? i : Math.min(index, Math.max(0, list.length - 1));
  const g = list[index];
  selectedId = g ? g.id : null;
  return g;
}

function select(i, dir) {
  const list = visible();
  if (!list.length) return;
  const old = index;
  index = (i + list.length) % list.length;
  selectedId = list[index].id;
  render(dir || (i < old ? 'prev' : 'next'));
}

// ---------------------------------------------------------------- render
function render(anim) {
  const list = visible();
  const g = current(list);

  $('c-all').textContent = games.length;
  $('c-fav').textContent = games.filter((x) => x.favourite).length;
  $('c-recent').textContent = games.filter((x) => x.lastPlayed).length;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('pager-count').innerHTML = `<b>${pad(g ? index + 1 : 0)}</b> / ${pad(list.length)}`;

  const dots = $('dots');
  dots.replaceChildren();
  const n = Math.min(list.length, 12);
  for (let i = 0; i < n; i++) dots.append(el('i', i === Math.floor((index * n) / list.length) ? 'on' : ''));

  // carousel: keep a copy of the outgoing card so it can slide away while the new one slides in
  let leaving = null;
  const oldTrack = stage.querySelector('.track:not(.leaving)');
  if ((anim === 'next' || anim === 'prev') && oldTrack) {
    const at = getComputedStyle(oldTrack).transform; // continue from mid-slide when browsing quickly
    leaving = oldTrack.cloneNode(true);
    leaving.style.setProperty('--from', at);
    leaving.classList.add('leaving', 'out-' + anim);
  }
  stage.className = anim ? 'anim-' + anim : '';
  stage.replaceChildren();
  if (leaving) stage.append(leaving);
  if (!g) {
    const empty = el('div', 'empty', games.length ? 'No games match.' : 'No games yet.');
    if (!games.length) {
      empty.append(document.createElement('br'));
      const b = el('button', 'btn', 'Import from Azimuth');
      b.onclick = importAzimuth;
      const b2 = el('button', 'btn', '+ Add game');
      b2.style.marginLeft = '12px';
      b2.onclick = addGame;
      empty.append(b, b2);
    }
    stage.append(empty);
    return;
  }

  const track = el('div', 'track');
  track.append(buildFeature(g, list), buildStrips(list));
  stage.append(track);
  clearTimeout(render.warmTimer);
  render.warmTimer = setTimeout(() => warmNeighbours(list), anim ? 340 : 0);
}

// when the slide ends, drop the outgoing copy and release the animation layers
stage.addEventListener('animationend', (e) => {
  if (!e.target.classList.contains('track')) return;
  if (e.target.classList.contains('leaving')) e.target.remove();
  else stage.className = '';
});

function buildFeature(g, list) {
  const f = el('div');
  f.id = 'feature';
  f.style.setProperty('--hue', hue(g.title));

  const art = artOf(g);
  if (art) {
    const bg = el('div', 'bg');
    bg.style.backgroundImage = `url('${fileUrl(art)}')`;
    f.append(bg);
    if (g.background) f.classList.add('hero');
  }
  f.append(el('div', 'tint'));

  const frame = el('div', 'cover-frame' + (g.cover ? ' has-img' : ''));
  const face = faceOf(g);
  if (face) {
    frame.classList.add('has-img');
    const url = fileUrl(face);
    const img = el('img', 'main');
    img.src = url;
    // portrait art fills the frame; wide/square art is shown whole over a blurred copy of itself
    const backdrop = () => { const blur = el('img', 'blur'); blur.src = url; frame.prepend(blur); };
    if (portrait.has(url)) { if (portrait.get(url)) img.classList.add('fill'); else backdrop(); }
    else img.onload = () => { if (isPortrait(img)) img.classList.add('fill'); else backdrop(); };
    frame.append(img);
  }
  frame.append(el('div', 'cf-title', g.title));

  const d = el('div', 'detail');
  const line = el('div', 'dline');
  line.append(el('div', 'dnum', pad(index + 1)));
  if (g.tag) line.append(el('div', 'tag', g.tag));
  if (g.azimuth) line.append(el('div', 'tag', 'Azimuth'));
  if (g.problem) line.append(el('div', 'tag warn', 'Unavailable'));
  d.append(line);

  if (g.logo && g.cover) {
    const logo = el('img');
    logo.src = fileUrl(g.logo);
    logo.style.cssText = 'max-height:110px;max-width:80%;object-fit:contain;object-position:left;margin-bottom:10px';
    d.append(logo);
  } else d.append(el('h2', 'dtitle', g.title));
  d.append(el('p', 'ddesc', g.description || (g.azimuth ? 'Xbox One game running through the Azimuth translation layer.' : 'Ready to play.')));

  const stats = el('div', 'stats');
  const row = (label, val, bad) => {
    const r = el('div', 'stat');
    r.append(el('label', '', label), el('span', bad ? 'bad' : '', val));
    stats.append(r);
  };
  row('Play time', fmtHours(g.playTimeSec));
  row('Last played', fmtLast(g.lastPlayed));
  row('Launches', String(g.launches || 0));
  row('Status', g.problem || (g.running ? 'Running' : 'Ready'), !!g.problem);
  d.append(stats);

  const max = Math.max(1, ...games.map((x) => x.playTimeSec));
  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = Math.round((g.playTimeSec / max) * 100) + '%';
  bar.append(fill);
  d.append(bar);

  const actions = el('div', 'actions');
  const play = el('button', 'btn play', g.running ? 'Running…' : '▶ Play');
  play.disabled = g.running;
  play.onclick = () => play_(g);
  const details = el('button', 'btn', 'Details');
  details.onclick = () => openEdit(g);
  const fav = el('button', 'btn fav' + (g.favourite ? ' on' : ''), '★');
  fav.title = 'Favourite';
  fav.addEventListener('click', () => fav.classList.add('pop'));
  fav.onclick = () => toggleFav(g);
  actions.append(play, details, fav);
  d.append(actions);

  f.append(frame, d);
  return f;
}

function buildStrips(list) {
  const wrap = el('div');
  wrap.id = 'strips';
  const count = Math.min(3, list.length - 1);
  for (let k = 1; k <= count; k++) {
    const i = (index + k) % list.length;
    const g = list[i];
    const b = el('button', 'strip');
    b.style.setProperty('--hue', hue(g.title));
    b.title = g.title;
    const art = artOf(g);
    if (art) {
      const sb = el('div', 'sbg');
      sb.style.backgroundImage = `url('${fileUrl(art)}')`;
      b.append(sb);
    }
    const inner = el('div', 'sin');
    inner.append(el('div', 'snum', pad(i + 1)), el('div', 'sdot'), el('div', 'sname', g.title), el('div', 'sfav', g.favourite ? '★' : ''));
    b.append(inner);
    b.onclick = () => select(i, 'next');
    wrap.append(b);
  }
  return wrap;
}

// ---------------------------------------------------------------- actions
let lastData = '';
// force redraws after an optimistic change; otherwise identical data leaves the screen untouched
async function refresh(force) {
  const data = await (first ? window.api.initialGames() : window.api.getGames()).catch(() => []);
  const json = JSON.stringify(data);
  if (!first && force !== true && json === lastData) return;
  lastData = json;
  games = data;
  // wait briefly for the art so the card is drawn complete; a slow drive can't hold it up
  const list = visible();
  current(list);
  const onScreen = list.length ? [0, 1, 2, 3].slice(0, list.length).map((k) => list[(index + k) % list.length]) : [];
  await Promise.race([Promise.all(onScreen.map(warmGame)), new Promise((r) => setTimeout(r, first ? 600 : 150))]);
  render();
  if (first) window.api.ready();
  first = false;
}

async function play_(g) {
  g.running = true; // show it straight away; the refresh below corrects this if the launch fails
  render();
  const r = await window.api.launch(g.id);
  if (r && !r.ok) toast(r.error, true);
  refresh(true);
}

async function toggleFav(g) {
  g.favourite = !g.favourite;
  render();
  await window.api.updateGame(g.id, { favourite: g.favourite });
  refresh(true);
}

async function importAzimuth() {
  const n = await window.api.addAzimuth();
  if (n) { toast(`Imported ${n} item(s) from Azimuth`); refresh(); } else if (n === 0) toast('No new Azimuth games found');
}
async function addGame() {
  if (await window.api.addGame()) refresh();
}

// ---------------------------------------------------------------- details dialog
const ART = ['cover', 'background', 'logo', 'icon'];
const base = (p) => (p ? p.split(/[\\/]/).pop() : '');

function openEdit(g) {
  editing = g;
  pending = {};
  $('e-title').value = g.title;
  $('e-desc').value = g.description || '';
  $('e-tag').value = g.tag || '';
  $('e-args').value = g.args || '';
  $('e-cwd').value = g.cwd || '';
  $('e-env').value = g.env || '';
  $('e-admin').checked = !!g.admin;
  $('e-display').value = g.displayMode || '';
  $('e-priority').value = g.priority || '';
  $('e-pre').value = g.preLaunch || '';
  $('e-post').value = g.postExit || '';
  $('e-save').value = g.saveDir || '';
  for (const k of ART) $('n-' + k).textContent = base(g[k]);
  $('sgdb-results').replaceChildren();
  $('sgdb-msg').textContent = '';
  dlg.returnValue = ''; // otherwise Esc reuses the last result and saves again
  dlg.showModal();
}

document.querySelectorAll('[data-art]').forEach((b) => {
  b.onclick = async () => {
    const p = await window.api.pickArt(b.dataset.art);
    if (p) { pending[b.dataset.art] = p; $('n-' + b.dataset.art).textContent = base(p); }
  };
});

$('e-sgdb').onclick = async () => {
  const msg = $('sgdb-msg');
  const box = $('sgdb-results');
  box.replaceChildren();
  msg.textContent = ' Searching…';
  const r = await window.api.sgdbSearch($('e-title').value.trim() || editing.title);
  if (!r.ok) { msg.textContent = ' ' + r.error; return; }
  msg.textContent = ` Matched “${r.name}” — click an image to use it`;
  for (const kind of ART) {
    if (!r[kind].length) continue;
    box.append(el('h3', '', kind));
    const grid = el('div', 'sgdb-grid ' + (kind === 'background' ? 'wide' : kind));
    for (const item of r[kind]) {
      const img = el('img');
      img.src = item.thumb;
      img.loading = 'lazy';
      img.onclick = async () => {
        msg.textContent = ' Downloading…';
        const d = await window.api.sgdbDownload(item.url, editing.id, kind);
        if (d.ok) { pending[kind] = d.path; $('n-' + kind).textContent = base(d.path); msg.textContent = ` ${kind} selected — press Save`; } else msg.textContent = ' ' + d.error;
      };
      grid.append(img);
    }
    box.append(grid);
  }
};

$('e-pick-save').onclick = async () => {
  const p = await window.api.pickFolder();
  if (p) $('e-save').value = p;
};
$('e-backup').onclick = async () => {
  await window.api.updateGame(editing.id, { saveDir: $('e-save').value.trim() });
  const r = await window.api.backupSaves(editing.id);
  toast(r.ok ? 'Saves backed up' : r.error, !r.ok);
};
$('e-open-backups').onclick = () => window.api.openBackups(editing.id);
$('e-folder').onclick = () => window.api.openFolder(editing.id);
$('e-desktop').onclick = async () => { const r = await window.api.shortcut(editing.id, 'desktop'); toast(r.ok ? 'Desktop shortcut created' : r.error, !r.ok); };
$('e-startmenu').onclick = async () => { const r = await window.api.shortcut(editing.id, 'startmenu'); toast(r.ok ? 'Start Menu shortcut created' : r.error, !r.ok); };
$('e-steam').onclick = async () => { const r = await window.api.addToSteam(editing.id); toast(r.ok ? 'Added to Steam — restart Steam to see it' : r.error, !r.ok); };

$('e-remove').onclick = async () => {
  if (confirm(`Remove “${editing.title}” from the library? The game files are not deleted.`)) {
    await window.api.removeGame(editing.id);
    dlg.close('cancel');
    refresh();
  }
};

dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save' || !editing) return;
  const patch = {
    title: $('e-title').value.trim() || editing.title,
    description: $('e-desc').value.trim(),
    tag: $('e-tag').value.trim(),
    args: $('e-args').value.trim(),
    cwd: $('e-cwd').value.trim(),
    env: $('e-env').value.trim(),
    admin: $('e-admin').checked,
    displayMode: $('e-display').value,
    priority: $('e-priority').value,
    preLaunch: $('e-pre').value.trim(),
    postExit: $('e-post').value.trim(),
    saveDir: $('e-save').value.trim(),
    ...pending,
  };
  await window.api.updateGame(editing.id, patch);
  refresh();
});

// ---------------------------------------------------------------- settings dialog
async function renderPrereqs() {
  const ul = $('prereq');
  ul.replaceChildren(el('li', '', 'Checking…'));
  const res = await window.api.checkPrereqs();
  ul.replaceChildren(...res.map((r) => {
    const li = el('li');
    li.append(el('span', r.ok ? 'ok' : 'bad', r.ok ? '✔ ' : '✘ '), document.createTextNode(r.name));
    return li;
  }));
}

$('open-settings').onclick = async () => {
  const [s, ui, displays] = await Promise.all([window.api.getSettings(), window.api.updateInfo(), window.api.listDisplays()]);
  $('s-sgdb').value = s.sgdbKey || '';
  $('s-discord').value = s.discordId || '';
  $('s-tray').checked = !!s.closeToTray;
  $('s-fullscreen').checked = !!s.startFullscreen;
  $('s-startup').checked = !!s.launchAtStartup;
  $('s-minimised').checked = !!s.startMinimised;
  $('s-after').value = s.afterLaunch || 'stay';
  $('s-repo').value = s.updateRepo || '';
  $('s-autoupdate').checked = s.autoUpdate !== false;
  $('s-version-top').textContent = `v${ui.version}`;
  $('s-version').textContent = `Installed version ${ui.version}` + (ui.packaged ? '' : ' (running from source)');
  $('s-update-install').hidden = !pendingUpdate;
  $('s-update-msg').textContent = pendingUpdate ? ` Version ${pendingUpdate.version} is available` : '';
  const sel = $('s-display');
  sel.replaceChildren(new Option('Primary monitor (default)', ''));
  for (const d of displays) sel.append(new Option(d.label, d.id));
  sel.value = [...sel.options].some((o) => o.value === s.display) ? s.display : '';
  settingsDlg.returnValue = '';
  settingsDlg.showModal();
};
settingsDlg.addEventListener('close', async () => {
  if (settingsDlg.returnValue !== 'save') return;
  await window.api.setSettings({
    sgdbKey: $('s-sgdb').value.trim(),
    discordId: $('s-discord').value.trim(),
    closeToTray: $('s-tray').checked,
    display: $('s-display').value,
    startFullscreen: $('s-fullscreen').checked,
    launchAtStartup: $('s-startup').checked,
    startMinimised: $('s-minimised').checked,
    afterLaunch: $('s-after').value,
    updateRepo: $('s-repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/(\.git)?\/?$/, ''),
    autoUpdate: $('s-autoupdate').checked,
  });
  toast('Settings saved');
});
$('s-check').onclick = renderPrereqs;
$('s-vcredist').onclick = () => window.api.openPrereq('vcredist');
$('s-dx').onclick = () => window.api.openPrereq('directx');
$('s-export').onclick = async () => toast('Library saved to ' + (await window.api.backupLibrary()));
$('s-open-data').onclick = () => window.api.openData();

// ---------------------------------------------------------------- wiring
$('add').onclick = addGame;
$('add-azimuth').onclick = importAzimuth;
$('bigpicture').onclick = () => window.api.toggleFullscreen();
$('prev').onclick = () => select(index - 1);
$('next').onclick = () => select(index + 1);
$('search').oninput = () => { index = 0; selectedId = null; render(); };
$('sort').onchange = () => render('in');
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { tab = t.dataset.tab; index = 0; selectedId = null; render('in'); }));

// Cancel is a plain button, so Enter in a text box presses Save rather than discarding the edits
document.querySelectorAll('dialog button[value=cancel]').forEach((b) => {
  b.type = 'button';
  b.onclick = () => b.closest('dialog').close('cancel');
});

window.api.onExit(() => refresh(true));
// artwork downloads can fire many change events at once; redraw once
let changedTimer = 0;
window.api.onChanged(() => { clearTimeout(changedTimer); changedTimer = setTimeout(() => refresh(), 300); });
window.api.onFailed((id, msg) => {
  const g = games.find((x) => x.id === id);
  toast(`${g ? g.title : 'Game'}: ${msg}`, true);
});

const importDlg = $('importer');
const modalOpen = () => dlg.open || settingsDlg.open || importDlg.open;

// ---- import installed games from Steam / Epic / GOG
const PLATFORM_NAMES = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG' };
let importPlatform = null;

async function openImporter(platform) {
  importPlatform = platform;
  $('imp-title').textContent = `Import from ${PLATFORM_NAMES[platform]}`;
  $('imp-msg').textContent = 'Scanning…';
  $('imp-list').replaceChildren();
  $('imp-go').disabled = true;
  importDlg.showModal();
  const r = await window.api.scanImport(platform);
  if (!r.ok) { $('imp-msg').textContent = r.error; return; }
  if (!r.games.length) { $('imp-msg').textContent = 'No installed games found.'; return; }
  const fresh = r.games.filter((g) => !g.already).length;
  $('imp-msg').textContent = `${r.games.length} found, ${fresh} not in your library yet.`;
  for (const g of r.games) {
    const row = el('label', 'imp-row' + (g.already ? ' done' : ''));
    const cb = el('input');
    cb.type = 'checkbox';
    cb.value = g.key;
    cb.checked = !g.already;
    cb.disabled = !!g.already;
    row.append(cb, document.createTextNode(g.title + (g.already ? ' (already added)' : '')), el('small', '', g.detail || ''));
    $('imp-list').append(row);
  }
  $('imp-go').disabled = false;
}

const impBoxes = () => [...document.querySelectorAll('#imp-list input:not(:disabled)')];
$('imp-all').onclick = () => impBoxes().forEach((b) => (b.checked = true));
$('imp-none').onclick = () => impBoxes().forEach((b) => (b.checked = false));
$('imp-go').onclick = async () => {
  const keys = impBoxes().filter((b) => b.checked).map((b) => b.value);
  if (!keys.length) { toast('Nothing selected', true); return; }
  $('imp-go').disabled = true;
  const r = await window.api.addImport(importPlatform, keys);
  importDlg.close('cancel');
  if (r.ok) { toast(`Imported ${r.count} game(s)` + (r.count ? ' — fetching artwork if you set a SteamGridDB key' : '')); refresh(); } else toast(r.error, true);
};
document.querySelectorAll('[data-import]').forEach((b) => (b.onclick = () => openImporter(b.dataset.import)));

let keyLock = 0;
document.addEventListener('keydown', (e) => {
  setInput('kbd');
  if (modalOpen() || e.target.matches('input, select, textarea') || e.ctrlKey || e.altKey) return;
  const g = visible()[index];
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'arrowright') {
    const now = Date.now();
    if (e.repeat && now < keyLock) return; // holding a key steps at a steady pace
    keyLock = now + 170;
    select(index + (k === 'arrowleft' ? -1 : 1));
  } else if (k === 'enter' && g && !g.running && !e.target.closest('button, a')) play_(g); // Enter on a focused button presses that button
  else if (k === 'e' && g) openEdit(g);
  else if (k === 'f' && g) toggleFav(g);
});
document.addEventListener('mousemove', () => setInput('kbd'));
document.addEventListener('wheel', () => setInput('kbd'), { passive: true });

// ---- on-screen button prompts follow whichever input was used last
const GLYPHS = {
  kbd: { play: ['Enter'], details: ['E'], fav: ['F'], browse: '← / → or scroll to browse' },
  xbox: { play: ['A', 'xb-a'], details: ['X', 'xb-x'], fav: ['Y', 'xb-y'], browse: 'LB / RB to browse' },
  ps: { play: ['✕', 'ps-cross'], details: ['□', 'ps-square'], fav: ['△', 'ps-triangle'], browse: 'L1 / R1 to browse' },
};
let inputMode = null;
function setInput(mode) {
  if (mode === inputMode) return;
  inputMode = mode;
  const set = GLYPHS[mode];
  document.querySelectorAll('footer kbd[data-k]').forEach((k) => {
    const [txt, cls] = set[k.dataset.k];
    k.textContent = txt;
    k.className = cls || '';
  });
  $('h-browse').textContent = set.browse;
}
setInput('kbd');
$('s-discord-test').onclick = async () => {
  const msg = $('s-discord-msg');
  msg.textContent = ' Saving and testing…';
  await window.api.setSettings({ discordId: $('s-discord').value.trim() });
  const r = await window.api.testDiscord();
  msg.textContent = ' ' + r.message + (r.ok ? ' — check your Discord profile' : '');
  msg.style.color = r.ok ? '#5ee08a' : '#ff5a5a';
};
$('s-discord-open').onclick = (e) => { e.preventDefault(); window.api.openPrereq('discord'); };

// mouse wheel: one game per notch, with a cooldown so trackpads don't skip
let wheelLock = 0, wheelAcc = 0;
stage.addEventListener('wheel', (e) => {
  if (modalOpen()) return;
  e.preventDefault();
  wheelAcc += e.deltaY || e.deltaX;
  const now = Date.now();
  if (Math.abs(wheelAcc) < 40 || now < wheelLock) return;
  select(index + (wheelAcc > 0 ? 1 : -1), wheelAcc > 0 ? 'next' : 'prev');
  wheelAcc = 0;
  wheelLock = now + 240;
}, { passive: false });

// ---------------------------------------------------------------- gamepad (A play, X details, Y favourite, LB/RB browse)
const held = {};
let padLoop = false;
const PS_PAD = /054c|dualshock|dualsense|playstation|wireless controller/i;
// The loop only runs while a controller is connected, and only looks up the current game on a button press.
function pollPad() {
  const pad_ = [...(navigator.getGamepads() || [])].find(Boolean);
  if (!pad_) { padLoop = false; return; }
  const down = (n) => !!pad_.buttons[n] && pad_.buttons[n].pressed;
  const ax = pad_.axes[0] || 0;
  const states = {
    a: down(0), x: down(2), y: down(3), lb: down(4) || down(14) || ax < -0.6,
    rb: down(5) || down(15) || ax > 0.6, start: down(9),
  };
  if (pad_.buttons.some((b) => b.pressed) || Math.abs(ax) > 0.6) setInput(PS_PAD.test(pad_.id) ? 'ps' : 'xbox');
  const edge = (k, fn) => { if (states[k] && !held[k]) fn(); held[k] = states[k]; };
  const cur = () => visible()[index];
  if (!modalOpen()) {
    edge('a', () => { const g = cur(); if (g && !g.running) play_(g); });
    edge('x', () => { const g = cur(); if (g) openEdit(g); });
    edge('y', () => { const g = cur(); if (g) toggleFav(g); });
    edge('lb', () => select(index - 1));
    edge('rb', () => select(index + 1));
    edge('start', () => window.api.toggleFullscreen());
  }
  requestAnimationFrame(pollPad);
}
function startPadLoop() { if (!padLoop) { padLoop = true; requestAnimationFrame(pollPad); } }
window.addEventListener('gamepadconnected', startPadLoop);
if ([...(navigator.getGamepads() || [])].some(Boolean)) startPadLoop();

// ---- import dropdown
{
  const menu = $('import-menu'), btn = $('import-btn');
  const setOpen = (open) => { menu.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); setOpen(!menu.classList.contains('open')); };
  $('import-list').addEventListener('click', () => setOpen(false));
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
}

// keep the strip text parallel to the strip edges (edges lean 20px over the strip's height, which is the stage's)
new ResizeObserver(() => {
  const h = stage.clientHeight;
  if (h > 0) document.documentElement.style.setProperty('--lean', (Math.atan(20 / h) * 180 / Math.PI).toFixed(3));
}).observe(stage);


// ---- updates
let pendingUpdate = null;
function showUpdate(info) {
  pendingUpdate = info && info.available !== false ? info : null;
  const btn = $('update-btn');
  btn.hidden = !pendingUpdate;
  if (pendingUpdate) btn.textContent = `Update ${pendingUpdate.version}`;
  $('s-update-install').hidden = !pendingUpdate;
}
async function installUpdate() {
  if (!pendingUpdate) return;
  if (!confirm(`Install Kinetic ${pendingUpdate.version}?\n\n${(pendingUpdate.notes || '').slice(0, 400)}\n\nThe launcher will restart. Your library and settings are kept.`)) return;
  const btn = $('update-btn');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  const r = await window.api.installUpdate();
  if (!r.ok) { btn.disabled = false; btn.textContent = `Update ${pendingUpdate.version}`; toast(r.error, true); }
  else btn.textContent = 'Restarting…';
}
window.api.onUpdateAvailable(showUpdate);
window.api.onUpdateProgress((p) => { $('update-btn').textContent = `Downloading ${Math.round(p * 100)}%`; });
$('update-btn').onclick = installUpdate;
$('s-update-install').onclick = () => { settingsDlg.close('cancel'); installUpdate(); };
$('s-update-check').onclick = async () => {
  const msg = $('s-update-msg');
  msg.style.color = '#8d92a6';
  msg.textContent = ' Saving and checking…';
  await window.api.setSettings({ updateRepo: $('s-repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/(\.git)?\/?$/, '') });
  const r = await window.api.checkUpdate();
  if (!r.ok) { msg.style.color = '#ff5a5a'; msg.textContent = ' ' + r.error; return; }
  showUpdate(r);
  msg.style.color = r.available ? '#5ee08a' : '#8d92a6';
  msg.textContent = r.available ? ` Version ${r.version} is available` : ` You're up to date (${r.current})`;
};

refresh();

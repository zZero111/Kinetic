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
  if (g.updateNeeded) line.append(el('div', 'tag warn', 'Update available'));
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
  if (g.updateNeeded) {
    const up = el('button', 'btn', 'Update');
    up.onclick = () => steamJob('update', [{ id: g.sourceId, name: g.title }]);
    actions.append(up);
  }
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

// a second press confirms, so these work from a controller
function pressTwice(btn, fn) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = 'Press again to confirm';
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 3000);
}

$('e-remove').onclick = () => pressTwice($('e-remove'), async () => {
  await window.api.removeGame(editing.id);
  dlg.close('cancel');
  refresh();
});

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
$('search').oninput = () => { if (tab === 'store') { storeTyped(); return; } index = 0; selectedId = null; render(); };
$('sort').onchange = () => render('in');
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  const wasStore = tab === 'store';
  tab = t.dataset.tab;
  index = 0;
  selectedId = null;
  if (wasStore !== (tab === 'store')) $('search').value = '';
  document.body.classList.toggle('in-store', tab === 'store');
  document.querySelector('header h1').textContent = tab === 'store' ? 'Store' : 'Library';
  $('tabs').hidden = tab === 'store';
  $('store-tabs').hidden = tab !== 'store';
  $('store').hidden = tab !== 'store';
  render('in');
  // the page stays built while you are in the library, so coming back is instant
  if (tab === 'store') { if (browseGrid) drawStoreTabs(); else showStore(); }
}));

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
// also true on the Store page, where the library's keys and controller buttons must not act
const modalOpen = () => dlg.open || settingsDlg.open || importDlg.open || $('store-item').open || $('cart').open || tab === 'store';

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
  if (tab === 'store' && !openDialog() && !e.target.matches('input, select, textarea') && !e.ctrlKey && !e.altKey) storeKeys(e);
  if (modalOpen() || e.target.matches('input, select, textarea') || e.ctrlKey || e.altKey) return;
  const g = visible()[index];
  const k = e.key.toLowerCase();
  if (tab === 'store') return;
  if (k === 'arrowleft' || k === 'arrowright') {
    const now = Date.now();
    if (e.repeat && now < keyLock) return; // holding a key steps at a steady pace
    keyLock = now + 170;
    select(index + (k === 'arrowleft' ? -1 : 1));
  } else if (k === 'enter' && g && !g.running && !e.target.closest('button, a')) play_(g); // Enter on a focused button presses that button
  else if (k === 'e' && g) openEdit(g);
  else if (k === 'f' && g) toggleFav(g);
});
document.addEventListener('mousemove', () => { setInput('kbd'); document.body.classList.remove('pad'); });
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

// ---------------------------------------------------------------- controller
// Library: A play, X details, Y favourite, LB/RB browse, D-pad up for the top bar.
// Everywhere: LT/RT change tab, View opens Downloads, B goes back, right stick scrolls.
// Polled on a timer rather than animation frames, which stop while the checkout page is on top.
const PS_PAD = /054c|dualshock|dualsense|playstation|wireless controller/i;
const held = {}, repeatAt = {};
let padTimer = 0, zone = null; // zone: 'header' or 'jobs' while the controller is in one of those areas
let buying = false, padLatch = false;

const openDialog = () => [dlg, settingsDlg, importDlg, $('store-item'), $('cart')].find((d) => d.open);
function navRoot() {
  const side = document.querySelector('.store-side');
  if (openDialog()) return openDialog();
  if (zone === 'jobs') return $('jobs');
  if (zone === 'header') return document.querySelector('header');
  if (tab !== 'store') return null;
  return side && !side.hidden ? side : storeEl; // the D-pad stays on the content; X, Y and up reach the rest
}
const canFocus = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; };
const focusables = (root) => [...root.querySelectorAll('button:not([disabled]),select,input,summary,a[href]')]
  .filter((e) => canFocus(e) && !e.matches('.event-arrow, .event-dots button, .store-arrow'));

function focusEl(e) {
  e.focus({ preventScroll: true });
  // in the Store the selection stays near the middle, so the next row is always visible
  // the deals scroll as one block, so moving between cards of different heights doesn't move the page
  const target = e.closest('.events') || e;
  target.scrollIntoView({ block: storeEl.contains(e) && !e.closest('.store-side') ? 'center' : 'nearest', inline: 'nearest' });
}

// the featured card is hidden on tabs like New, so only something actually on the page can be the start
const storeStart = () => [...document.querySelectorAll('.store-hero .btn.play:not([disabled]), .store-hero .btn, .tile')].find(canFocus);

// moves to the nearest control in that direction, wherever the layout has put it
function moveFocus(dir) {
  const root = navRoot();
  const list = focusables(root);
  if (!list.length) return;
  const cur = document.activeElement;
  if (!root.contains(cur) || !list.includes(cur)) { focusEl((root === storeEl && storeStart()) || list[0]); return; }
  const c = cur.getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  const vertical = dir === 'up' || dir === 'down';
  const options = [];
  for (const e of list) {
    if (e === cur) continue;
    const r = e.getBoundingClientRect();
    const dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
    if (vertical) {
      const gap = dir === 'down' ? r.top - c.bottom : c.top - r.bottom; // space between the two, edge to edge
      // the tall strips beside the featured game are reached sideways from its buttons
      if (gap >= -4 && !e.matches('.strip')) options.push({ e, gap, off: Math.abs(dx) });
    } else {
      const along = dir === 'left' ? -dx : dx;
      // sideways moves stay on the same row, so the edge of a grid doesn't jump elsewhere on the page
      if (along > 4 && r.bottom > c.top + 4 && r.top < c.bottom - 4) options.push({ e, gap: along, off: Math.abs(dy) });
    }
  }
  // the nearest row comes first, however far sideways its items are; then the closest item in that row
  const nearest = Math.min(...options.map((o) => o.gap));
  const row = vertical ? options.filter((o) => o.gap <= nearest + 120) : options;
  row.sort((x, y) => (vertical ? x.off - y.off : x.gap + x.off * 3 - y.gap - y.off * 3));
  const best = row.length ? row[0].e : null;
  // sideways past the end of the deals turns the page
  if (cur.closest('.events-body') && (dir === 'left' || dir === 'right') && (!best || !best.closest('.events-body'))) {
    showEvents(eventPage + (dir === 'left' ? -1 : 1));
    focusEl(document.querySelector(dir === 'left' ? '.event-col .event' : '.events-body .event'));
    return;
  }
  if (best) focusEl(best);
  else if (dir === 'up' && root === storeEl) { zone = 'header'; focusEl(focusables(document.querySelector('header'))[0]); }
  else if (dir === 'up' && zone === 'header' && tab !== 'store') zone = null;
  else if (dir === 'down' && zone === 'header') leaveZone();
}

function leaveZone() {
  zone = null;
  const start = tab === 'store' && storeStart();
  if (start) focusEl(start); else document.activeElement.blur();
}

function stepSelect(sel, by) {
  const n = sel.options.length;
  if (!n) return;
  sel.selectedIndex = (sel.selectedIndex + by + n) % n;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

const isTyping = (e) => e.matches('input:not([type=checkbox]):not([type=radio]), textarea');
function activate() {
  const e = document.activeElement;
  if (!e || e === document.body) return;
  if (e.matches('select')) stepSelect(e, 1);
  else if (isTyping(e)) openKeyboard({ input: e });
  else e.click();
}

function goBack() {
  const d = openDialog();
  const side = document.querySelector('.store-side');
  if (d) d.close('cancel');
  else if (tab === 'store' && side && !side.hidden) toggleFilters();
  else if (zone) leaveZone();
  else if (tab === 'store') document.querySelector('[data-tab=all]').click();
}

function changeTab(by) {
  if (tab === 'store') {
    const i = STORE_TABS.findIndex((t) => t[0] === storeTab);
    pickStoreTab(STORE_TABS[(i + by + STORE_TABS.length) % STORE_TABS.length][0]);
    return;
  }
  const tabs = [...document.querySelectorAll('#tabs .tab')];
  const i = tabs.findIndex((t) => t.dataset.tab === tab);
  tabs[(i + by + tabs.length) % tabs.length].click();
}

function scrollArea(amount) {
  const box = openDialog() || (tab === 'store' ? storeEl : null);
  if (box) box.scrollTop += amount;
}

// ---- on-screen keyboard: types into a Kinetic field, or into the checkout page
const OSK_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl@', 'zxcvbnm.-_', '!#$%&*+=?/'];
let osk = null; // { input } or { buy: true }; row and col are the selected key
let oskRow = 1, oskCol = 0, oskCaps = false;
const oskKeys = () => [...OSK_ROWS.map((r) => [...(oskCaps ? r.toUpperCase() : r)]), ['Caps', 'Space', 'Delete', 'Done']];

function drawKeyboard() {
  const box = $('osk');
  const keys = oskKeys();
  oskRow = Math.max(0, Math.min(oskRow, keys.length - 1));
  oskCol = Math.max(0, Math.min(oskCol, keys[oskRow].length - 1));
  box.replaceChildren(el('div', 'osk-show', osk.buy ? 'Typing into the page' : osk.input.value || ' '),
    ...keys.map((row, r) => { const line = el('div', 'osk-row'); line.append(...row.map((k, c) => el('span', 'osk-key' + (r === oskRow && c === oskCol ? ' on' : ''), k))); return line; }),
    el('div', 'osk-help', 'A type · X delete · Y space · B done'));
}
function openKeyboard(target) {
  osk = target;
  $('osk').hidden = false;
  drawKeyboard();
  if (osk.buy) window.api.buyReserve($('osk').offsetHeight);
}
function closeKeyboard() {
  if (osk && osk.buy) window.api.buyReserve(0);
  osk = null;
  $('osk').hidden = true;
}
function typeKey(ch) {
  if (osk.buy) window.api.buyInput('char', ch);
  else { osk.input.value += ch; osk.input.dispatchEvent(new Event('input', { bubbles: true })); }
  drawKeyboard();
}
function deleteKey() {
  if (osk.buy) window.api.buyInput('backspace');
  else { osk.input.value = osk.input.value.slice(0, -1); osk.input.dispatchEvent(new Event('input', { bubbles: true })); }
  drawKeyboard();
}
function pressKey() {
  const k = oskKeys()[oskRow][oskCol];
  if (k === 'Done') closeKeyboard();
  else if (k === 'Delete') deleteKey();
  else if (k === 'Space') typeKey(' ');
  else if (k === 'Caps') { oskCaps = !oskCaps; drawKeyboard(); }
  else typeKey(k);
}
function moveKey(dir) {
  const keys = oskKeys();
  if (dir === 'up' || dir === 'down') {
    const was = oskCol / keys[oskRow].length;
    oskRow = (oskRow + (dir === 'up' ? -1 : 1) + keys.length) % keys.length;
    oskCol = Math.floor(was * keys[oskRow].length);
  } else oskCol = (oskCol + (dir === 'left' ? -1 : 1) + keys[oskRow].length) % keys[oskRow].length;
  drawKeyboard();
}

function toggleFilters() {
  const side = document.querySelector('.store-side');
  if (!side) return;
  side.hidden = !side.hidden;
  if (!side.hidden) focusEl(focusables(side)[0]);
  else focusEl(storeStart() || storeEl);
}

function padHints() {
  const box = $('pad-hints');
  const root = !buying && !osk && inputMode !== 'kbd' && navRoot();
  const text = !root ? '' : openDialog() ? 'A select · B back · Right stick scroll' : tab === 'store' ? 'A select · B back · X filters · Y search · LB / RB featured · LT / RT tabs · View downloads' : 'A select · B back · LT / RT tabs · View downloads';
  if (text === padHints.last) return; // this runs 60 times a second, so it only touches the page when something changed
  padHints.last = text;
  box.hidden = !root;
  box.textContent = text;
}

function readPad(p) {
  const down = (n) => !!p.buttons[n] && p.buttons[n].pressed;
  const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
  return {
    a: down(0), b: down(1), x: down(2), y: down(3), lb: down(4), rb: down(5), lt: down(6), rt: down(7), view: down(8), start: down(9),
    up: down(12) || ay < -0.6, down: down(13) || ay > 0.6, left: down(14) || ax < -0.6, right: down(15) || ax > 0.6,
    scroll: Math.abs(p.axes[3] || 0) > 0.25 ? p.axes[3] : 0,
  };
}

// while a game or anything else has focus, the launcher must not react to the controller
let windowActive = true;
window.api.onWindowActive((on) => { windowActive = on; });

function pollPad() {
  if (!windowActive) return;
  const p = [...(navigator.getGamepads() || [])].find(Boolean);
  if (!p) { clearInterval(padTimer); padTimer = 0; return; }
  const st = readPad(p);
  if (p.buttons.some((b) => b.pressed) || Math.abs(p.axes[0] || 0) > 0.6 || Math.abs(p.axes[1] || 0) > 0.6) {
    setInput(PS_PAD.test(p.id) ? 'ps' : 'xbox');
    document.body.classList.add('pad');
  }
  const now = Date.now();
  const once = (k, fn) => { if (st[k] && !held[k]) fn(); held[k] = st[k]; };
  // directions repeat while held, after a short pause
  const dirs = (fn) => { for (const d of ['up', 'down', 'left', 'right']) {
    if (st[d] && (!held[d] || now >= repeatAt[d])) { repeatAt[d] = now + (held[d] ? 130 : 380); fn(d); }
    held[d] = st[d];
  } };

  if (osk) {
    dirs(moveKey);
    once('a', pressKey); once('x', deleteKey); once('y', () => typeKey(' ')); once('b', closeKeyboard);
  } else if (buying) {
    // a direction still held from before the page opened doesn't count until it is released
    if (padLatch && !(st.up || st.down || st.left || st.right)) padLatch = false;
    if (!padLatch) dirs((d) => window.api.buyInput(d));
    once('a', () => window.api.buyInput('enter'));
    once('x', () => window.api.buyInput('space'));
    once('y', () => openKeyboard({ buy: true }));
    once('b', () => window.api.buyClose());
    if (st.scroll) window.api.buyInput('scroll', st.scroll * 60);
  } else if (navRoot()) {
    dirs((d) => {
      const e = document.activeElement;
      if ((d === 'left' || d === 'right') && e && e.matches('select')) stepSelect(e, d === 'left' ? -1 : 1);
      else moveFocus(d);
    });
    once('a', activate);
    once('b', goBack);
    once('lt', () => { if (!openDialog()) changeTab(-1); });
    once('rt', () => { if (!openDialog()) changeTab(1); });
    once('view', () => { zone = zone === 'jobs' ? null : !$('jobs').hidden ? 'jobs' : zone; });
    once('x', () => { if (!openDialog() && tab === 'store') toggleFilters(); });
    once('y', () => { if (!openDialog() && tab === 'store') { $('search').focus(); openKeyboard({ input: $('search') }); } });
    once('lb', () => { if (!openDialog() && tab === 'store') stepHero(-1); });
    once('rb', () => { if (!openDialog() && tab === 'store') stepHero(1); });
    if (st.scroll) scrollArea(st.scroll * 22);
  } else {
    const cur = () => visible()[index];
    once('a', () => { const g = cur(); if (g && !g.running) play_(g); });
    once('x', () => { const g = cur(); if (g) openEdit(g); });
    once('y', () => { const g = cur(); if (g) toggleFav(g); });
    once('lb', () => select(index - 1));
    once('rb', () => select(index + 1));
    once('start', () => window.api.toggleFullscreen());
    once('lt', () => changeTab(-1));
    once('rt', () => changeTab(1));
    once('view', () => { if (!$('jobs').hidden) zone = 'jobs'; });
    dirs((d) => {
      if (d === 'left') select(index - 1);
      else if (d === 'right') select(index + 1);
      else if (d === 'up') { zone = 'header'; moveFocus('down'); }
    });
  }
  for (const k of ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'start']) held[k] = st[k];
  padHints();
}
function startPadLoop() { if (!padTimer) padTimer = setInterval(pollPad, 16); }
window.addEventListener('gamepadconnected', startPadLoop);
if ([...(navigator.getGamepads() || [])].some(Boolean)) startPadLoop();

window.api.onBuyState((st) => {
  if (st.open && !buying) padLatch = true;
  buying = st.open;
  $('buy-bar').hidden = !st.open;
  if (st.host) $('buy-host').textContent = st.host;
  $('buy-hints').textContent = inputMode === 'kbd' ? '' : 'D-pad move · A press · X tick · Y keyboard · Right stick scroll · B back';
  if (!st.open && osk) closeKeyboard();
  if (!st.open && buyReturn) { const id = buyReturn; buyReturn = null; openStoreItem(id); } // shows Download if it was bought
});
$('buy-close').onclick = () => window.api.buyClose();

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


function storeKeys(e) {
  const k = e.key.toLowerCase(), x = heroList[heroIndex];
  if (k === 'arrowleft') stepHero(-1);
  else if (k === 'arrowright') stepHero(1);
  else if (k === 'e' && x) openStoreItem(x.id);
  else if (k === 'f' && x) { toggleWish(x); drawHero(); }
  else if (k === 'enter' && x && !e.target.closest('button, a')) document.querySelector('.store-hero .btn.play')?.click();
}

// ---- store
const storeEl = $('store');
const itemDlg = $('store-item');
let storeRun = 0; // only the newest request may draw, so a slow reply can't replace a newer search
let installedIds = new Set();
let itemId = null;
let itemName = '';

async function steamAction(action, id) {
  const r = await window.api.steamAction(action, id);
  if (!r.ok) toast(r.error, true);
}

function priceText(x) {
  if (!x.final) return 'Free';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: x.currency }).format(x.final / 100); } catch { return String(x.final / 100); }
}

// The page works from the common game format in store.js, so other stores can feed it later
const STORE_SOURCE = 'steam';
const STORE_TABS = [['all', 'All', {}], ['new', 'New', { sort: 'Released_DESC' }], ['top', 'Top rated', { sort: 'Reviews_DESC' }], ['sale', 'On sale', { specials: true }], ['free', 'Free', { maxprice: 'free' }]];
const STORE_FEATURES = [['2', 'Single-player'], ['1', 'Multi-player'], ['9', 'Co-op'], ['49', 'PvP'], ['28', 'Full controller support'], ['22', 'Achievements'], ['23', 'Cloud saves'], ['30', 'Workshop'], ['29', 'Trading cards']];
const STORE_TYPES = [['998', 'Games'], ['21', 'DLC'], ['994', 'Software'], ['10', 'Demos']];
const STORE_OS = [['win', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux / SteamOS']];
const STORE_LANGS = [['', 'Any language'], ['english', 'English'], ['french', 'French'], ['german', 'German'], ['spanish', 'Spanish'], ['italian', 'Italian'], ['japanese', 'Japanese'], ['koreana', 'Korean'], ['russian', 'Russian'], ['schinese', 'Chinese (Simplified)'], ['brazilian', 'Portuguese (Brazil)']];
const STORE_PRICES = [['', 'Any price'], ['free', 'Free'], ['5', 'Under 5'], ['10', 'Under 10'], ['20', 'Under 20'], ['40', 'Under 40']];
const STORE_SORTS = [['', 'Popular'], ['Reviews_DESC', 'Top rated'], ['Released_DESC', 'Newest'], ['Price_ASC', 'Lowest price'], ['Price_DESC', 'Highest price'], ['Name_ASC', 'Name']];

const emptyFilters = () => ({ sort: '', maxprice: '', type: '998', lang: '', tags: [], features: [], os: [], specials: false, hideF2p: false });
const browseQ = emptyFilters();
let storeTab = 'all', tagOptions = [], heroList = [], heroIndex = 0, heroBox = null, offersBox = null, clearBtn = null, drawer = null;
let browseStart = 0, browseTotal = 0, browseLoading = false, browseGrid = null, browseHead = null, browseSub = null, browseCount = 0;
const saved = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
let wishlist = saved('wishlist'), cart = saved('cart');
const keep = () => { localStorage.setItem('wishlist', JSON.stringify(wishlist)); localStorage.setItem('cart', JSON.stringify(cart)); };

const filterCount = () => browseQ.tags.length + browseQ.features.length + browseQ.os.length + [browseQ.lang, browseQ.hideF2p, browseQ.type !== '998'].filter(Boolean).length + (storeTab === 'all' ? [browseQ.maxprice, browseQ.specials].filter(Boolean).length : 0);
const filtering = () => !!($('search').value.trim() || storeTab !== 'all' || browseQ.sort || filterCount());
const shownPrice = (x) => x.price || priceText(x);
const wasPrice = (x) => x.was || (x.discount && x.original ? priceText({ ...x, final: x.original }) : '');

// tries the store's tall or wide art, then falls back to the image that is always there
function artImg(x, prefer) {
  const img = el('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.src = x[prefer] || x.image;
  img.onerror = () => { img.onerror = null; img.src = x.image; img.classList.add('fallback'); };
  return img;
}

// ---- Discounts & Events: pages of two tall event cards and two wide deals, like Steam's
let eventPages = [], eventPage = 0, eventsBody = null, eventDots = null;
function eventCard(e) {
  const b = el('button', 'event tall');
  b.type = 'button';
  const img = el('img');
  img.src = e.image;
  img.alt = '';
  b.append(img, el('span', 'event-label', e.label));
  if (e.note) b.append(el('span', 'event-note', e.note));
  b.onclick = async () => {
    if (e.id) openStoreItem(e.id);
    else { const r = await window.api.storeBuy(0, e.label, e.url); if (!r.ok) toast(r.error, true); }
  };
  return b;
}
function dealCard(x, label) {
  const b = el('button', 'event wide');
  b.type = 'button';
  const price = el('div', 'event-price');
  price.append(el('b', 'pct', `-${x.discount}%`), el('s', '', wasPrice(x)), el('span', '', shownPrice(x)));
  const pic = artImg(x, 'capsule');
  pic.loading = 'eager';
  b.append(pic, el('span', 'event-label', label), price);
  b.onclick = () => openStoreItem(x.id);
  return b;
}
function showEvents(i) {
  if (!eventPages.length) return;
  eventPage = (i + eventPages.length) % eventPages.length;
  const pg = eventPages[eventPage];
  const col = el('div', 'event-col');
  col.append(...pg.deals.map((d) => dealCard(d.x, d.label)));
  eventsBody.replaceChildren(...pg.tall.map(eventCard), col);
  eventDots.replaceChildren(...eventPages.map((_p, n) => {
    const dot = el('button', n === eventPage ? 'on' : '');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Page ${n + 1}`);
    dot.onclick = () => showEvents(n);
    return dot;
  }));
}
function drawEvents(data) {
  const onSale = [...data.specials, ...data.topSellers, ...data.newReleases].filter((x) => x.discount);
  const unique = [...new Map(onSale.map((x) => [x.id, x])).values()].filter((x) => !data.daily.some((d) => d.id === x.id));
  const deals = [...data.daily.map((x) => ({ x, label: "Today's deal" })), ...unique.sort((a, b) => b.discount - a.discount).map((x) => ({ x, label: 'Special offer' }))];
  // only full pages, so the layout always fills the width
  const count = Math.max(1, Math.min(Math.ceil(data.spotlights.length / 2), Math.floor(deals.length / 4)));
  eventPages = Array.from({ length: count }, (_v, i) => ({ tall: data.spotlights.slice(i * 2, i * 2 + 2), deals: deals.slice(i * 4, i * 4 + 4) }));
  const head = sectionHead('Discounts & Events', '')[0];
  const wrap = el('div', 'events');
  const prev = el('button', 'event-arrow', '‹'), next = el('button', 'event-arrow', '›');
  prev.type = next.type = 'button';
  prev.onclick = () => showEvents(eventPage - 1);
  next.onclick = () => showEvents(eventPage + 1);
  eventsBody = el('div', 'events-body');
  eventDots = el('div', 'event-dots');
  wrap.append(prev, eventsBody, next);
  offersBox.replaceChildren(head, wrap, eventDots);
  showEvents(0);
}

function offerCard(x, n) {
  const b = el('button', 'offer');
  b.type = 'button';
  b.style.setProperty('--hue', hue(x.name));
  const top = el('div', 'offer-art');
  top.append(artImg(x, 'capsule'), el('span', 'off', `-${x.discount}%`));
  const foot = el('div', 'offer-foot');
  const line = el('div', 'price-line');
  line.append(el('b', '', shownPrice(x)), el('s', '', wasPrice(x)));
  foot.append(el('div', 'offer-name', plainText(x.name)), line);
  b.append(top, foot);
  b.onclick = () => openStoreItem(x.id);
  return b;
}

function gameCard(x, n) {
  const b = el('button', 'tile');
  b.type = 'button';
  b.style.setProperty('--hue', hue(x.name));
  const face = el('div', 'tile-art');
  face.append(artImg(x, 'capsule'));
  if (x.discount) face.append(el('span', 'off', `-${x.discount}%`));
  const foot = el('div', 'tile-foot');
  const line = el('div', 'price-line');
  line.append(el('b', '', installedIds.has(String(x.id)) ? 'Installed' : shownPrice(x)), el('s', '', wasPrice(x)));
  foot.append(line, el('span', 'tile-rate', x.rating ? x.rating + '%' : ''));
  b.append(face, el('div', 'tile-name', plainText(x.name)), foot);
  b.onclick = () => openStoreItem(x.id);
  return b;
}

function setHeroInfo(row, label, value) { row.replaceChildren(el('label', '', label), el('span', '', value)); }

// the featured card: drawn straight away, then filled in when the game's details arrive
async function drawHero() {
  const x = heroList[heroIndex];
  if (!x || !heroBox) return;
  $('store-count').innerHTML = `<b>${pad(heroIndex + 1)}</b> / ${pad(heroList.length)}`;
  const card = el('div');
  card.id = 'feature';
  card.className = 'store-hero';
  card.style.setProperty('--hue', hue(x.name));
  const bg = el('div', 'bg');
  bg.style.backgroundImage = `url('${x.wide}'), url('${x.image}')`;
  const frame = el('div', 'cover-frame has-img');
  const cover = artImg(x, 'tall');
  cover.className = 'main fill';
  frame.append(cover);
  const d = el('div', 'detail');
  const line = el('div', 'dline');
  const tag = el('div', 'tag', '');
  line.append(el('div', 'dnum', pad(heroIndex + 1)), tag);
  const desc = el('p', 'ddesc', '');
  const stats = el('div', 'stats');
  const rows = [0, 1, 2, 3].map(() => { const r = el('div', 'stat'); stats.append(r); return r; });
  setHeroInfo(rows[0], 'User rating', '…');
  setHeroInfo(rows[1], 'Released', '…');
  setHeroInfo(rows[2], 'Install size', '…');
  setHeroInfo(rows[3], 'Price', shownPrice(x));
  const bar = el('div', 'bar'), fill = el('i');
  bar.append(fill);
  const actions = el('div', 'actions');
  const buy = el('button', 'btn play', 'Buy now');
  buy.onclick = () => heroAction(x, buy);
  const add = el('button', 'btn', inCart(x) ? 'In cart' : 'Add to cart');
  add.onclick = () => { toggleCart(x); add.textContent = inCart(x) ? 'In cart' : 'Add to cart'; };
  const heart = el('button', 'btn fav' + (isWished(x) ? ' on' : ''), '♥');
  heart.title = 'Wishlist';
  heart.onclick = () => { toggleWish(x); heart.classList.toggle('on', isWished(x)); };
  actions.append(buy, add, heart);
  d.append(line, el('h2', 'dtitle', plainText(x.name)), desc, stats, bar, actions);
  card.append(bg, el('div', 'tint'), frame, d);
  const strips = el('div');
  strips.id = 'strips';
  for (let k = 1; k <= Math.min(3, heroList.length - 1); k++) {
    const i = (heroIndex + k) % heroList.length, g = heroList[i];
    const st = el('button', 'strip');
    st.type = 'button';
    st.style.setProperty('--hue', hue(g.name));
    const sb = el('div', 'sbg');
    sb.style.backgroundImage = `url('${g.wide}'), url('${g.image}')`;
    const inner = el('div', 'sin');
    inner.append(el('div', 'snum', pad(i + 1)), g.discount ? el('div', 'soff', `-${g.discount}%`) : el('div', 'sdot'), el('div', 'sname', plainText(g.name)));
    st.append(sb, inner);
    st.onclick = () => stepHero(i - heroIndex);
    strips.append(st);
  }
  const keepFocus = heroBox.contains(document.activeElement);
  heroBox.replaceChildren(card, strips);
  if (keepFocus || (document.body.classList.contains('pad') && !openDialog() && !storeEl.contains(document.activeElement))) buy.focus({ preventScroll: true });
  const id = x.id;
  // the next game's details and art are fetched now, so moving to it is instant
  const nextGame = heroList[(heroIndex + 1) % heroList.length];
  if (nextGame) { window.api.storeDetails(nextGame.id, STORE_SOURCE); warm(nextGame.tall); }
  const [r, onAccount] = await Promise.all([window.api.storeDetails(id, STORE_SOURCE), window.api.steamOwned(id)]);
  if (heroList[heroIndex] !== x) return;
  const free = r.ok && r.data.free;
  buy.textContent = installedIds.has(String(id)) ? 'Installed' : onAccount || free ? 'Download' : 'Buy now';
  buy.disabled = installedIds.has(String(id));
  if (!r.ok) return;
  const g = r.data;
  tag.textContent = g.genres[0] || 'Game';
  desc.textContent = plainText(g.description);
  setHeroInfo(rows[0], 'User rating', g.rating ? g.rating + '%' : 'No reviews');
  setHeroInfo(rows[1], 'Released', g.released || '—');
  setHeroInfo(rows[2], 'Install size', g.storage ? fmtBytes(g.storage) : '—');
  fill.style.width = (g.rating || 0) + '%';
}

function stepHero(by) {
  if (!heroList.length) return;
  heroIndex = (heroIndex + by + heroList.length) % heroList.length;
  drawHero();
}

function heroAction(x, btn) {
  if (btn.textContent === 'Download') steamJob('install', [{ id: x.id, name: plainText(x.name) }]);
  else if (btn.textContent === 'Buy now') { itemId = x.id; itemName = plainText(x.name); $('si-open').click(); }
}

// ---- wishlist and cart are Kinetic's own: an outside app can't write to a Steam account's cart
const isWished = (x) => wishlist.some((w) => w.id === x.id);
const inCart = (x) => cart.some((w) => w.id === x.id);
const slim = (x) => ({ id: x.id, name: plainText(x.name), final: x.final, currency: x.currency, price: shownPrice(x) });
function toggleWish(x) {
  wishlist = isWished(x) ? wishlist.filter((w) => w.id !== x.id) : [...wishlist, slim(x)];
  keep();
  toast(isWished(x) ? 'Added to wishlist' : 'Removed from wishlist');
}
function drawCartButton() {
  const b = $('cart-btn');
  if (!b) return;
  const total = cart.reduce((n, c) => n + (c.final || 0), 0);
  const money = cart.find((c) => c.currency) || heroList.find((c) => c.currency);
  b.textContent = `Cart ${cart.length} · ${money ? new Intl.NumberFormat(undefined, { style: 'currency', currency: money.currency }).format(total / 100) : '0.00'}`;
}
function toggleCart(x) {
  cart = inCart(x) ? cart.filter((w) => w.id !== x.id) : [...cart, slim(x)];
  keep();
  drawCartButton();
}
function openCart() {
  const list = $('cart-list');
  list.replaceChildren(...(cart.length ? cart.map((c) => {
    const row = el('div', 'cart-row');
    const rm = el('button', '', 'Remove');
    rm.type = 'button';
    rm.onclick = () => { cart = cart.filter((w) => w.id !== c.id); keep(); drawCartButton(); openCart(); };
    row.append(el('span', '', c.name), el('b', '', c.price), rm);
    return row;
  }) : [el('p', 'store-msg', 'Your cart is empty.')]));
  $('cart-go').hidden = !cart.length;
  if (!$('cart').open) { $('cart').returnValue = ''; $('cart').showModal(); }
}
$('cart-go').onclick = async () => {
  const c = cart[0];
  $('cart').close('cancel');
  const r = await window.api.storeBuy(c.id, c.name);
  if (!r.ok) toast(r.error, true);
};
window.api.onBought((id) => { cart = cart.filter((c) => c.id !== id); keep(); drawCartButton(); });

// ---- All games
async function loadMore(run) {
  if (browseLoading || (browseStart && browseStart >= browseTotal)) return;
  browseLoading = true;
  const r = await window.api.storeBrowse({ ...browseQ, source: STORE_SOURCE, term: $('search').value.trim(), start: browseStart });
  if (run !== storeRun) return;
  browseLoading = false;
  if (!r.ok) { browseHead.textContent = 'Could not load the store'; return; }
  browseTotal = r.data.total;
  browseStart += 50;
  browseSub.textContent = `${browseTotal.toLocaleString()} games`;
  browseGrid.append(...r.data.items.map((x) => gameCard(x, ++browseCount)));
  // the first rows are on screen straight away, so they skip the lazy-loading wait
  if (browseCount <= 50) [...browseGrid.querySelectorAll('img')].slice(0, 21).forEach((i) => { i.loading = 'eager'; i.fetchPriority = 'high'; });
  if (!browseTotal) browseGrid.replaceChildren(el('p', 'store-msg', 'Nothing matches these filters.'));
  // a new tab replaces what was selected, so a controller user continues from its first game
  if (browseCount <= 50 && filtering() && document.body.classList.contains('pad') && !osk && !openDialog() && !zone && !storeEl.contains(document.activeElement) && !document.querySelector('.store-side:not([hidden])')) {
    const first = browseGrid.querySelector('.tile');
    if (first) focusEl(first);
  }
  fillStore(run);
}
const fillStore = (run) => { if (storeEl.scrollHeight - storeEl.scrollTop - storeEl.clientHeight < 2200) loadMore(run); };
// measured once per frame at most: reading the page's size on every scroll event forces extra layout work
let scrollQueued = false;
storeEl.addEventListener('scroll', () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; fillStore(storeRun); });
}, { passive: true });

function filterChanged() {
  if (!browseGrid) { showStore(); return; }
  const run = ++storeRun;
  browseStart = 0; browseTotal = 0; browseCount = 0; browseLoading = false;
  heroBox.hidden = offersBox.hidden = filtering();
  $('store-pager').hidden = filtering();
  clearBtn.hidden = !filterCount();
  clearBtn.textContent = `Clear filters (${filterCount()})`;
  browseGrid.replaceChildren();
  browseSub.textContent = 'Loading…';
  drawStoreTabs();
  loadMore(run);
}

function storeSelect(key, options, title) {
  const sel = el('select');
  sel.title = title;
  for (const [value, label] of options) sel.append(new Option(label, value));
  sel.value = browseQ[key];
  sel.onchange = () => { browseQ[key] = sel.value; filterChanged(); };
  return sel;
}

function filterCheck(label, checked, change) {
  const row = el('label', 'sf-check');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.onchange = () => change(box.checked);
  row.append(box, document.createTextNode(label));
  return row;
}

const filterList = (key, options) => options.map(([id, label]) => filterCheck(label, browseQ[key].includes(id), (on) => {
  browseQ[key] = on ? [...browseQ[key], id] : browseQ[key].filter((x) => x !== id);
  filterChanged();
}));

function filterSection(title, children, open) {
  const d = el('details', 'sf-sec');
  d.open = !!open;
  d.append(el('summary', '', title), ...children);
  return d;
}

function storeSidebar() {
  const side = el('aside', 'store-side');
  side.hidden = true;
  clearBtn = el('button', 'sf-clear');
  clearBtn.type = 'button';
  clearBtn.hidden = !filterCount();
  clearBtn.onclick = () => { Object.assign(browseQ, emptyFilters()); pickStoreTab('all'); };
  const close = el('button', 'sf-close', 'Close filters ×');
  close.type = 'button';
  close.onclick = () => { side.hidden = true; };
  const find = el('input', 'sf-find');
  find.placeholder = 'Find a tag';
  const tagBox = el('div', 'sf-tags');
  tagBox.append(...filterList('tags', tagOptions));
  find.oninput = () => {
    const q = find.value.trim().toLowerCase();
    for (const row of tagBox.children) row.hidden = !row.textContent.toLowerCase().includes(q);
  };
  side.append(close, clearBtn,
    filterSection('Price', [storeSelect('maxprice', STORE_PRICES, 'Price'),
      filterCheck('Special offers only', browseQ.specials, (on) => { browseQ.specials = on; filterChanged(); }),
      filterCheck('Hide free to play', browseQ.hideF2p, (on) => { browseQ.hideF2p = on; filterChanged(); })], true),
    filterSection('Tags', [find, tagBox], true),
    filterSection('Type', [storeSelect('type', STORE_TYPES, 'Type')]),
    filterSection('Features', filterList('features', STORE_FEATURES)),
    filterSection('Platform', filterList('os', STORE_OS)),
    filterSection('Language', [storeSelect('lang', STORE_LANGS, 'Language')]));
  return side;
}

// clicking anywhere outside the panel closes it
document.addEventListener('click', (e) => {
  const side = document.querySelector('.store-side');
  if (side && !side.hidden && !side.contains(e.target)) side.hidden = true;
});

// ---- tabs
let tabCounts = {};
function drawStoreTabs() {
  const box = $('store-tabs');
  const lib = el('button', 'tab', '');
  lib.type = 'button';
  lib.dataset.back = '1';
  lib.append(Object.assign(el('span'), { textContent: '‹ Library' }));
  lib.onclick = () => document.querySelector('[data-tab=all]').click();
  box.replaceChildren(lib, ...STORE_TABS.map(([id, label]) => {
    const b = el('button', 'tab' + (id === storeTab ? ' active' : ''));
    b.type = 'button';
    b.dataset.store = id;
    const sp = el('span', '', label + ' ');
    if (tabCounts[id]) sp.append(el('b', '', tabCounts[id].toLocaleString()));
    b.append(sp);
    b.onclick = () => pickStoreTab(id);
    return b;
  }));
}
function pickStoreTab(id) {
  storeTab = id;
  const opts = STORE_TABS.find((t) => t[0] === id)[2];
  Object.assign(browseQ, { sort: opts.sort || '', specials: !!opts.specials, maxprice: opts.maxprice || '' });
  const sort = document.querySelector('.store-sort');
  if (sort) sort.value = browseQ.sort;
  filterChanged();
}
async function countTabs() {
  await Promise.all(STORE_TABS.map(async ([id, , opts]) => {
    const r = await window.api.storeBrowse({ ...emptyFilters(), ...opts, source: STORE_SOURCE, count: 1 });
    if (r.ok) tabCounts[id] = r.data.total;
  }));
  if (tab === 'store') drawStoreTabs();
}

function sectionHead(title, sub) {
  const h = el('div', 'sec-head');
  const s2 = el('span', 'sec-sub', sub);
  h.append(el('h2', 'store-h', title), s2);
  return [h, s2];
}

async function showStore() {
  const run = ++storeRun;
  storeEl.replaceChildren(el('p', 'store-msg', 'Loading the store…'));
  drawStoreTabs();
  const [r, t] = await Promise.all([window.api.storeHome(STORE_SOURCE), tagOptions.length ? null : window.api.storeTags(STORE_SOURCE)]);
  if (run !== storeRun) return;
  if (t && t.ok) tagOptions = t.data.map((x) => [String(x.tagid), x.name]);
  if (!r.ok) { browseGrid = null; storeEl.replaceChildren(el('p', 'store-msg', `Could not reach the store. ${r.error}`)); return; }
  installedIds = new Set(r.data.installed);
  browseStart = 0; browseTotal = 0; browseCount = 0; browseLoading = false;

  // second row: cart, pager, updates, sort and filters
  const bar = el('div', 'store-bar');
  const cartBtn = el('button', 'store-btn');
  cartBtn.id = 'cart-btn';
  cartBtn.type = 'button';
  cartBtn.onclick = openCart;
  const pager = el('div', 'store-pager');
  pager.id = 'store-pager';
  const prev = el('button', 'store-arrow', '‹'), next = el('button', 'store-arrow red', '›'), count = el('div');
  prev.type = next.type = 'button';
  count.id = 'store-count';
  prev.onclick = () => stepHero(-1);
  next.onclick = () => stepHero(1);
  pager.append(prev, count, next);
  const side = storeSidebar();
  const filters = el('button', 'store-btn', 'Filters');
  filters.type = 'button';
  filters.onclick = (e) => { e.stopPropagation(); side.hidden = !side.hidden; };
  const sort = storeSelect('sort', STORE_SORTS, 'Sort');
  sort.classList.add('store-sort');
  bar.append(cartBtn, pager);
  if (r.data.updates.length) {
    const up = el('button', 'store-btn hot', `Update ${r.data.updates.length} ${r.data.updates.length === 1 ? 'game' : 'games'}`);
    up.type = 'button';
    up.title = r.data.updates.map((g) => g.name).join(', ');
    up.onclick = () => steamJob('update', r.data.updates);
    bar.append(up);
  }
  bar.append(el('span', 'spacer'), sort, filters);

  heroList = [...new Map([...r.data.topSellers, ...r.data.newReleases].map((x) => [x.id, x])).values()].slice(0, 12);
  heroIndex = Math.min(heroIndex, Math.max(0, heroList.length - 1));
  heroBox = el('div', 'store-hero-row');
  offersBox = el('div');
  drawEvents(r.data);
  const [head, sub] = sectionHead('Browse', '');
  browseHead = head.querySelector('.store-h');
  browseSub = sub;
  browseGrid = el('div', 'tiles');
  storeEl.replaceChildren(bar, heroBox, offersBox, head, browseGrid, side);
  heroBox.hidden = offersBox.hidden = filtering();
  pager.hidden = filtering();
  drawCartButton();
  drawHero();
  storeEl.scrollTop = 0;
  loadMore(run);
}

let storeTimer = 0;
function storeTyped() {
  clearTimeout(storeTimer);
  storeTimer = setTimeout(filterChanged, 300);
}

// ---- trailers: Steam only serves streams, which hls.js plays. It is loaded the first time a game page opens.
let hlsReady = null, trailerHls = null;
function loadHls() {
  hlsReady = hlsReady || new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/hls.min.js';
    sc.onload = res;
    sc.onerror = rej;
    document.head.append(sc);
  });
  return hlsReady;
}
function stopTrailer() {
  if (trailerHls) { trailerHls.destroy(); trailerHls = null; }
  document.querySelectorAll('.si-stage video').forEach((v) => { v.pause(); v.remove(); });
}
async function playTrailer(box, m) {
  const v = el('video');
  v.poster = m.thumb;
  v.controls = true;
  v.muted = true; // starts quietly, like Steam; the controls turn the sound on
  v.autoplay = true;
  box.replaceChildren(v);
  try {
    await loadHls();
    if (!v.isConnected) return;
    trailerHls = new window.Hls({ capLevelToPlayerSize: true, maxBufferLength: 20 });
    trailerHls.on(window.Hls.Events.ERROR, (_e, data) => { if (data.fatal) { stopTrailer(); const i = el('img'); i.src = m.thumb; box.replaceChildren(i); } });
    trailerHls.loadSource(m.hls);
    trailerHls.attachMedia(v);
  } catch {
    const i = el('img');
    i.src = m.thumb;
    box.replaceChildren(i);
  }
}
itemDlg.addEventListener('close', stopTrailer);

// Steam's descriptions can contain HTML entities; this reads them as plain text
const plainText = (s) => new DOMParser().parseFromString(s, 'text/html').body.textContent;

async function openStoreItem(id) {
  const body = $('si-body');
  itemId = id;
  body.replaceChildren(el('p', 'store-msg', 'Loading…'));
  $('si-install').hidden = true;
  itemDlg.returnValue = '';
  itemDlg.showModal();
  const r = await window.api.storeDetails(id, STORE_SOURCE);
  if (itemId !== id) return;
  if (!r.ok) {
    const retry = el('button', '', 'Try again');
    retry.type = 'button';
    retry.onclick = () => { itemDlg.close('cancel'); openStoreItem(id); };
    body.replaceChildren(el('p', 'store-msg', r.error), retry);
    return;
  }
  const d = r.data;
  const price = d.comingSoon ? 'Coming soon' : d.free ? 'Free' : d.price || 'Not sold in your region';
  const meta = el('div', 'si-meta');
  meta.append(el('span', 'tag', installedIds.has(String(id)) ? 'Installed' : price));
  if (d.discount) meta.append(el('span', 'tag warn', `-${d.discount}%`));
  const facts = el('div', 'si-facts');
  for (const [k, v] of [['Rating', d.rating ? d.rating + '%' : ''], ['Released', d.released], ['Developer', d.developers.join(', ')], ['Genres', d.genres.slice(0, 3).join(', ')]]) {
    if (v) { const r2 = el('div'); r2.append(el('label', '', k), el('span', '', v)); facts.append(r2); }
  }
  const media = el('div', 'si-media');
  const stage2 = el('div', 'si-stage');
  const strip = el('div', 'si-strip');
  const items = [...d.trailers.map((t) => ({ ...t, video: true })), ...d.screenshots];
  const show = (m, btn) => {
    stopTrailer();
    strip.querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
    if (btn) btn.classList.add('on');
    if (m.video) playTrailer(stage2, m);
    else { const i = el('img'); i.src = m.full || m.thumb; i.alt = ''; stage2.replaceChildren(i); }
  };
  items.forEach((m) => {
    const t = el('button', 'si-thumb' + (m.video ? ' video' : ''));
    t.type = 'button';
    const i = el('img');
    i.src = m.thumb;
    i.alt = '';
    i.loading = 'lazy';
    t.append(i);
    t.onclick = () => show(m, t);
    strip.append(t);
  });
  media.append(stage2, strip);
  const info = el('div', 'si-info');
  info.append(el('h2', '', d.name), meta, el('p', 'si-desc', plainText(d.description)), facts);
  body.replaceChildren(media, info);
  if (items.length) show(items[0], strip.firstChild);
  else { const i = el('img'); i.src = d.image; i.alt = ''; stage2.replaceChildren(i); }
  const owned = installedIds.has(String(id));
  // a paid game that isn't on the account can only be bought, so Install is not offered for it
  const onAccount = await window.api.steamOwned(id);
  if (itemId !== id) return;
  const noInstall = owned || d.comingSoon || (!d.free && onAccount === false);
  $('si-install').hidden = noInstall;
  itemStorage = d.storage;
  await drawDrives(noInstall);
  if (itemId !== id) return;
  $('si-open').hidden = d.free || owned || onAccount === true;
  itemName = d.name;
}
// Steam can't start a download unless the whole game fits, so the drive is chosen before installing
let itemStorage = 0;
async function drawDrives(hide) {
  const sel = $('si-lib');
  sel.hidden = hide;
  $('si-space').textContent = '';
  if (hide) return;
  const libs = (await window.api.steamLibraries()).sort((a, b) => b.free - a.free);
  sel.replaceChildren(...libs.map((l) => new Option(`${l.path.slice(0, 2).toUpperCase()} (${fmtBytes(l.free)} free)`, l.path)));
  checkDrive();
}
function checkDrive() {
  const opt = $('si-lib').selectedOptions[0];
  const free = opt ? Number(/([\d.]+) (GB|MB)/.exec(opt.text)?.[1]) * (opt.text.includes(' GB ') ? 1e9 : 1e6) : 0;
  const short = itemStorage && free < itemStorage;
  $('si-space').textContent = itemStorage ? `Needs about ${fmtBytes(itemStorage)}` : '';
  $('si-space').className = short ? 'bad' : '';
}
$('si-lib').onchange = checkDrive;
// the popup has to close first: while it is open, everything outside it is disabled, including the checkout's Back button
let buyReturn = null;
$('si-open').onclick = async () => {
  buyReturn = itemId;
  itemDlg.close('cancel');
  const r = await window.api.storeBuy(itemId, itemName);
  if (!r.ok) { toast(r.error, true); openStoreItem(buyReturn); buyReturn = null; }
};
window.api.onBought((id, name) => {
  $('buy-hints').textContent = `${name} is on your account. Go back to download it.`;
});
$('si-install').onclick = () => {
  const lib = $('si-lib').value;
  itemDlg.close('cancel');
  steamJob('install', [{ id: itemId, name: itemName, lib }]);
};

async function steamJob(kind, items) {
  const r = await window.api.steamJob(kind, items);
  if (!r.ok) toast(r.error, true);
}

const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
function fmtLeft(sec) {
  if (sec < 60) return 'under a minute left';
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${m % 60} min left`;
}
const JOB_STATE = { queued: 'Queued', downloading: 'Downloading', installing: 'Installing', paused: 'Paused', failed: 'Stopped' };

const fmtRate = (b) => `${(b * 8 / 1e6).toFixed(1)} Mbps`;
const fmtClock = (s) => `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function jobDetail(j) {
  if (j.error) return j.error;
  if (j.live) {
    const l = j.live, parts = [];
    if (l.network) parts.push(`Network ${fmtRate(l.network)}`);
    if (l.peak) parts.push(`Peak ${fmtRate(l.peak)}`);
    if (l.disk) parts.push(`Disk ${fmtRate(l.disk)}`);
    if (l.eta > 0) parts.push(`${fmtClock(l.eta)} remaining`);
    return parts.join(' · ');
  }
  const parts = [];
  if (j.total) parts.push(`${j.estimated ? 'About ' : ''}${fmtBytes(j.got)} of ${fmtBytes(j.total)}`);
  if (j.state === 'downloading' && j.speed) {
    parts.push(`${fmtBytes(j.speed)}/s`);
    if (j.total > j.got) parts.push(fmtLeft((j.total - j.got) / j.speed));
  }
  return parts.join(' · ');
}

async function jobControl(action, j, btn) {
  // a second press confirms, so there is no popup to dismiss
  if (action === 'cancel' && !btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Press again';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Cancel'; }, 3000);
    return;
  }
  btn.disabled = true;
  const r = await window.api.steamControl(action, j.id);
  if (!r.ok) { btn.disabled = false; toast(r.error, true); }
}

// rows are updated in place, so a button can't vanish mid-click when progress arrives
const jobRows = new Map();
function jobRow(j) {
  const row = el('div', 'job');
  const name = el('div', 'job-name', j.name), state = el('div', 'job-pct'), detail = el('div', 'job-detail');
  const bar = el('div', 'bar'), fill = el('i');
  bar.append(fill);
  const stages = el('div', 'job-stages');
  const toggle = el('button', 'job-btn'), cancel = el('button', 'job-btn', 'Cancel');
  const btns = el('div', 'job-btns');
  btns.append(toggle, cancel);
  row.append(name, state, bar, stages, detail, btns);
  const r = { row, state, detail, fill, bar, stages, toggle, cancel, job: j };
  toggle.onclick = () => {
    if (r.job.needsLicense) { steamAction('install', r.job.id); return; }
    jobControl(r.job.state === 'paused' || r.job.state === 'failed' ? 'resume' : 'pause', r.job, toggle);
  };
  cancel.onclick = () => jobControl('cancel', r.job, cancel);
  return r;
}

// Steam's two progress lines, shown when its exact figures are available
function stageLine(label, s, bytes) {
  const line = el('div', 'job-stage');
  const pct = s.total ? Math.min(100, Math.floor((s.got / s.total) * 100)) : 0;
  const bar = el('div', 'bar'), fill = el('i');
  fill.style.width = pct + '%';
  bar.append(fill);
  line.append(el('span', '', label), el('span', '', bytes ? `${fmtBytes(s.got)} / ${fmtBytes(s.total)}` : `${pct}%`), bar);
  return line;
}
function drawStages(r, j) {
  const l = j.live;
  r.bar.hidden = !!l;
  r.stages.replaceChildren(...(l ? [l.download && stageLine('Downloading data', l.download, true), l.files && stageLine('Updating files', l.files, false)].filter(Boolean) : []));
}

let jobsOpen = localStorage.getItem('jobsOpen') !== '0';
function drawJobs(list) {
  const box = $('jobs');
  box.hidden = !list.length;
  box.classList.toggle('closed', !jobsOpen);
  const active = list.find((j) => j.state === 'downloading' || j.state === 'installing');
  $('jobs-title').textContent = `Downloads (${list.length})`;
  $('jobs-sum').textContent = active ? `${active.name} ${active.percent}%` : '';
  $('jobs-toggle').textContent = jobsOpen ? '▾' : '▴';
  const seen = new Set();
  for (const j of list) {
    seen.add(j.id);
    if (!jobRows.has(j.id)) { const r = jobRow(j); jobRows.set(j.id, r); $('jobs-list').append(r.row); }
    const r = jobRows.get(j.id);
    const was = r.job.state;
    r.job = j;
    r.state.textContent = `${JOB_STATE[j.state] || 'Starting'}${j.percent ? ' ' + j.percent + '%' : ''}`;
    r.detail.textContent = jobDetail(j);
    r.fill.style.width = j.percent + '%';
    drawStages(r, j);
    r.toggle.textContent = j.needsLicense ? 'Get in Steam' : j.state === 'failed' ? 'Retry' : j.state === 'paused' ? 'Resume' : 'Pause';
    r.detail.classList.toggle('bad', !!j.error);
    if (was !== j.state) { r.toggle.disabled = false; r.cancel.disabled = false; }
  }
  for (const [id, r] of jobRows) if (!seen.has(id)) { r.row.remove(); jobRows.delete(id); }
}
let lastJobs = [];
$('jobs-head').onclick = () => { jobsOpen = !jobsOpen; localStorage.setItem('jobsOpen', jobsOpen ? '1' : '0'); drawJobs(lastJobs); };
window.api.onSteamJobs((list) => { lastJobs = list; drawJobs(list); });
window.api.onSteamFinished((ok, msg) => {
  toast(msg, !ok);
  refresh(true);
});

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
  const btn = $('update-btn');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  const r = await window.api.installUpdate();
  if (!r.ok) { btn.disabled = false; btn.textContent = `Update ${pendingUpdate.version}`; toast(r.error, true); }
  else btn.textContent = 'Restarting…';
}
window.api.onUpdateAvailable(showUpdate);
window.api.onUpdateProgress((p) => { $('update-btn').textContent = `Downloading ${Math.round(p * 100)}%`; });
$('update-btn').onclick = () => pressTwice($('update-btn'), installUpdate);
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

// fetch the Store's first answers once the launcher is idle, so opening it doesn't wait for the network
setTimeout(async () => {
  const load = (u) => { if (u) new Image().src = u; }; // lands in the browser's cache, ready for the page
  const [home, list] = await Promise.all([
    window.api.storeHome(STORE_SOURCE),
    window.api.storeBrowse({ ...browseQ, source: STORE_SOURCE, term: '', start: 0 }),
    window.api.storeTags(STORE_SOURCE),
  ]);
  if (home.ok) {
    for (const s of home.data.spotlights.slice(0, 2)) load(s.image);
    for (const g of [...home.data.daily, ...home.data.topSellers.slice(0, 4)]) { load(g.capsule); load(g.tall); load(g.wide); }
  }
  if (list.ok) list.data.items.slice(0, 21).forEach((g) => load(g.capsule));
}, 4000);

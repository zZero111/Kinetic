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
const faceOf = (g) => g.coverView || g.cover || g.logo;
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
  if (tab.startsWith('c:')) list = list.filter((g) => (g.collections || []).includes(tab.slice(2)));
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

// each collection is a tab beside All, Favourites and Recent, filtering the same carousel
function drawCollectionTabs() {
  const names = [...new Set(games.flatMap((g) => g.collections || []))].sort((a, b) => a.localeCompare(b));
  document.querySelectorAll('#tabs [data-collection]').forEach((t) => t.remove());
  const store = document.querySelector('#tabs [data-tab=store]');
  for (const name of names) {
    const b = el('button', 'tab');
    b.type = 'button';
    b.dataset.tab = 'c:' + name;
    b.dataset.collection = '1';
    const sp = el('span', '', name + ' ');
    sp.append(el('b', '', games.filter((g) => (g.collections || []).includes(name)).length));
    b.append(sp);
    b.onclick = () => { tab = 'c:' + name; index = 0; selectedId = null; render('in'); };
    store.before(b);
  }
  if (tab.startsWith('c:') && !names.includes(tab.slice(2))) tab = 'all';
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
    up.onclick = () => (g.source === 'community' ? communityGet({ id: g.repoId, repo: g.repo, name: g.title }) : steamJob('update', [{ id: g.sourceId, name: g.title }]));
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
  drawCollectionTabs();
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

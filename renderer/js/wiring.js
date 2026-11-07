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

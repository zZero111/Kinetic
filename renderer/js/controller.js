// ---------------------------------------------------------------- controller
// Library: A play, X details, Y favourite, LB/RB browse, D-pad up for the top bar.
// Everywhere: LT/RT change tab, View opens Downloads, B goes back, right stick scrolls.
// Polled on a timer rather than animation frames, which stop while the checkout page is on top.
const PS_PAD = /054c|dualshock|dualsense|playstation|wireless controller/i;
const held = {}, repeatAt = {};
let padTimer = 0, zone = null; // zone: 'header' or 'jobs' while the controller is in one of those areas
let buying = false, padLatch = false;

const openDialog = () => [dlg, settingsDlg, importDlg, $('store-item'), $('cart'), $('mods')].find((d) => d.open);
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
  if (!side || !isSteam()) return;
  side.hidden = !side.hidden;
  if (!side.hidden) focusEl(focusables(side)[0]);
  else focusEl(storeStart() || storeEl);
}

// on the Library's tabs A selects, and X and Y do nothing, so the footer says so
function drawFooterHints() {
  const onTop = tab !== 'store' && zone === 'header';
  if (onTop === drawFooterHints.top) return;
  drawFooterHints.top = onTop;
  const hints = document.querySelectorAll('footer .hint');
  hints[0].lastChild.textContent = onTop ? ' Select' : ' Play';
  hints[1].style.visibility = hints[2].style.visibility = onTop ? 'hidden' : '';
}

function padHints() {
  const box = $('pad-hints');
  // the library has its own footer hints, so this bar is only for the Store and popups
  const root = !buying && !osk && inputMode !== 'kbd' && (tab === 'store' || openDialog()) && navRoot();
  const text = !root ? '' : itemDlg.open && document.querySelector('.si-stage video') ? 'a:Select b:Back x:Sound y:Play / pause' : openDialog() ? 'a:Select b:Back' : isSteam() ? 'a:Select b:Back x:Filters y:Search LB/RB:Featured LT/RT:Tabs View:Downloads' : 'a:Select b:Back y:Search LB/RB:Featured LT/RT:Tabs View:Downloads';
  drawFooterHints();
  if (text === padHints.last) return; // this runs 60 times a second, so it only touches the page when something changed
  padHints.last = text;
  box.hidden = !root;
  box.replaceChildren(...text.split(/ (?=[\w/]+:)/).filter(Boolean).map((part) => {
    const [key, label] = part.split(':');
    const set = GLYPHS[inputMode];
    const item = el('span', 'hint');
    const g = { a: set.play, x: set.details, y: set.fav, b: inputMode === 'ps' ? ['○', 'ps-circle'] : ['B', 'xb-b'] }[key];
    item.append(g ? Object.assign(el('kbd', g[1], g[0])) : el('kbd', 'pad-word', key), document.createTextNode(label));
    return item;
  }));
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
window.api.onWindowActive((on) => {
  windowActive = on;
  if (padTimer) { clearInterval(padTimer); padTimer = setInterval(pollPad, on ? 16 : 500); } // barely runs during a game
  if (!on) document.querySelectorAll('.si-stage video').forEach((v) => v.pause());
});

window.api.onRest(() => {
  stopTrailer();
  warmed.clear();
  portrait.clear();
  if (tab !== 'store' && browseGrid) { browseGrid = null; storeEl.replaceChildren(); } // rebuilt when next opened
  window.api.clearImageCache();
});

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
      // in the Store's top row left and right move on; A changes the value, so the row can't trap you
      if ((d === 'left' || d === 'right') && e && e.matches('select') && !e.closest('.store-bar')) stepSelect(e, d === 'left' ? -1 : 1);
      else moveFocus(d);
    });
    once('a', activate);
    once('b', goBack);
    once('lt', () => { if (!openDialog()) changeTab(-1); });
    once('rt', () => { if (!openDialog()) changeTab(1); });
    once('view', () => { zone = zone === 'jobs' ? null : !$('jobs').hidden ? 'jobs' : zone; });
    const trailer = () => (itemDlg.open ? document.querySelector('.si-stage video') : null);
    once('x', () => {
      const v = trailer();
      if (v) { v.muted = !v.muted; toast(v.muted ? 'Sound off' : 'Sound on'); } else if (!openDialog() && tab === 'store') toggleFilters();
    });
    once('y', () => {
      const v = trailer();
      if (v) { if (v.paused) v.play(); else v.pause(); } else if (!openDialog() && tab === 'store') { $('search').focus(); openKeyboard({ input: $('search') }); }
    });
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

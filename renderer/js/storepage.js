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
let itemName = '', itemUrl = '', itemGame = null;

async function steamAction(action, id) {
  const r = await window.api.steamAction(action, id);
  if (!r.ok) toast(r.error, true);
}

function priceText(x) {
  if (!x.final) return 'Free';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: x.currency }).format(x.final / 100); } catch { return String(x.final / 100); }
}

// The page works from the common game format in store.js, so other stores can feed it later
let STORE_SOURCE = 'steam';
const STORE_NAMES = { steam: 'Steam', gog: 'GOG' };
const isSteam = () => STORE_SOURCE === 'steam';
const STORE_TABS = [['all', 'All', {}], ['new', 'New', { sort: 'Released_DESC' }], ['top', 'Top rated', { sort: 'Reviews_DESC' }], ['sale', 'On sale', { specials: true }], ['free', 'Free', { maxprice: 'free' }], ['wish', 'Wishlist', {}]];
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
  const [r, onAccount] = await Promise.all([window.api.storeDetails(id, STORE_SOURCE), isSteam() ? window.api.steamOwned(id) : null]);
  if (heroList[heroIndex] !== x) return;
  const free = r.ok && r.data.free;
  buy.textContent = installedIds.has(String(id)) ? 'Installed' : isSteam() && (onAccount || free) ? 'Download' : 'Buy now';
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
  else if (btn.textContent === 'Buy now') { itemId = x.id; itemName = plainText(x.name); itemUrl = x.url || ''; $('si-open').click(); }
}

// ---- wishlist and cart are Kinetic's own: an outside app can't write to a Steam account's cart
const isWished = (x) => wishlist.some((w) => w.id === x.id);
const inCart = (x) => cart.some((w) => w.id === x.id);
const slim = (x) => ({ id: x.id, source: x.source || STORE_SOURCE, name: plainText(x.name), final: x.final, currency: x.currency, price: shownPrice(x), image: x.image, capsule: x.capsule, url: x.url });
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
  const r = await window.api.storeBuy(c.source === 'gog' ? 0 : c.id, c.name, c.url);
  if (!r.ok) toast(r.error, true);
};
window.api.onBought((id) => { cart = cart.filter((c) => c.id !== id); keep(); drawCartButton(); });

// ---- All games
function showWishlist() {
  const items = wishlist.filter((w) => (w.source || 'steam') === STORE_SOURCE);
  browseTotal = browseStart = items.length;
  browseCount = items.length;
  browseHead.textContent = 'Wishlist';
  browseSub.textContent = `${items.length} ${items.length === 1 ? 'game' : 'games'}`;
  browseGrid.replaceChildren(...(items.length ? items.map((x, i) => gameCard(x, i + 1)) : [el('p', 'store-msg', 'Nothing here yet. Press the heart on a game to save it.')]));
}

async function loadMore(run) {
  if (storeTab === 'wish') { showWishlist(); return; }
  browseHead.textContent = 'Browse';
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
  installedIds = new Set(isSteam() ? r.data.installed : []);
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
  // plain buttons rather than a dropdown, so one press of A switches store
  const source = el('div', 'store-seg');
  for (const [id, name] of Object.entries(STORE_NAMES)) {
    const b = el('button', id === STORE_SOURCE ? 'on' : '', name);
    b.type = 'button';
    b.dataset.source = id;
    b.onclick = () => {
      if (id === STORE_SOURCE) return;
      STORE_SOURCE = id;
      Object.assign(browseQ, emptyFilters());
      storeTab = 'all';
      tagOptions = [];
      heroIndex = 0;
      $('search').value = '';
      showStore();
    };
    source.append(b);
  }
  filters.hidden = !isSteam(); // GOG's page has the tabs and sort, but not Steam's tags and features
  bar.append(source, cartBtn, pager);
  if (isSteam() && r.data.updates.length) {
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
  $('si-wish').hidden = false;
  itemGame = null;
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
  const onAccount = isSteam() ? await window.api.steamOwned(id) : null;
  if (itemId !== id) return;
  const noInstall = !isSteam() || owned || d.comingSoon || (!d.free && onAccount === false);
  $('si-install').hidden = noInstall;
  itemStorage = d.storage;
  await drawDrives(noInstall);
  if (itemId !== id) return;
  $('si-open').hidden = isSteam() && (d.free || owned || onAccount === true);
  $('si-open').textContent = isSteam() ? 'Buy' : 'Open on GOG';
  itemUrl = d.url || '';
  itemGame = slim({ ...d, price });
  $('si-wish').textContent = isWished(itemGame) ? 'On your wishlist' : 'Add to wishlist';
  // a controller starts on the main action, not on Close
  if (document.body.classList.contains('pad')) setTimeout(() => [$('si-install'), $('si-open'), $('si-wish')].find(canFocus)?.focus({ preventScroll: true }), 0);
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
  const r = await window.api.storeBuy(isSteam() ? itemId : 0, itemName, isSteam() ? undefined : itemUrl);
  if (!r.ok) { toast(r.error, true); openStoreItem(buyReturn); buyReturn = null; }
};
$('si-wish').onclick = () => {
  if (!itemGame) return;
  toggleWish(itemGame);
  $('si-wish').textContent = isWished(itemGame) ? 'On your wishlist' : 'Add to wishlist';
  if (storeTab === 'wish') showWishlist();
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

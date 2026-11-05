// The Steam provider for the Store page. Every store (Epic, GOG, Xbox later) is a module with this same shape,
// registered in main.js:
//   id, name
//   home(cc, fetch)          -> { specials, topSellers, newReleases } of games
//   browse(query, cc, fetch) -> { total, items } of games
//   details(id, cc, fetch)   -> one game's full details, including screenshots and trailers
//   tags(fetch)              -> [{ tagid, name }]
// A game is { source, id, name, image, tall, wide, capsule, final, original, discount, currency, price, released, rating }.
// The page only uses these fields, so it never needs to know which store a game came from.
const BASE = 'https://store.steampowered.com/api';
const HOME_TTL = 10 * 60 * 1000;
let homeCache = null;

async function getJson(fetchFn, url) {
  const res = await Promise.race([fetchFn(url), new Promise((_, reject) => setTimeout(() => reject(new Error('Steam took too long to answer')), 10000))]);
  if (!res.ok) throw new Error(`Steam store returned ${res.status}`);
  return res.json();
}

// standard art locations; newer games use other paths, so the page falls back to `image` if these are missing
const ART = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps';
const art = (id) => ({ source: 'steam', tall: `${ART}/${id}/library_600x900.jpg`, wide: `${ART}/${id}/library_hero.jpg`, capsule: `${ART}/${id}/header.jpg` });

const fromFeatured = (x) => ({
  ...art(x.id), id: x.id, name: x.name, image: x.large_capsule_image || x.header_image || '',
  final: x.final_price || 0, original: x.original_price || 0, discount: x.discount_percent || 0, currency: x.currency || '',
});

// Newer games keep their art under hashed paths, so a guessed URL fails for many of them. One batch request
// returns the exact URLs. If it fails, games keep the guessed URLs and the page's fallback handles the rest.
const ASSET_BASE = 'https://shared.akamai.steamstatic.com/store_item_assets/';
async function withArt(games, cc, fetchFn) {
  const ids = [...new Set(games.map((g) => g.id))];
  if (!ids.length) return games;
  try {
    const input = { ids: ids.map((appid) => ({ appid })), context: { language: 'english', country_code: cc }, data_request: { include_assets: true } };
    const r = await getJson(fetchFn, `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
    const byId = new Map((r.response?.store_items || []).map((i) => [i.appid || i.id, i.assets]));
    for (const g of games) {
      const a = byId.get(g.id);
      if (!a || !a.asset_url_format) continue;
      const url = (file) => (file ? ASSET_BASE + a.asset_url_format.replace('${FILENAME}', file) : '');
      g.capsule = url(a.header) || url(a.main_capsule) || g.capsule;
      g.tall = url(a.library_capsule) || g.tall;
      g.wide = url(a.hero_capsule) || g.wide;
    }
  } catch {}
  return games;
}

async function home(cc, fetchFn) {
  if (homeCache && homeCache.cc === cc && Date.now() - homeCache.at < HOME_TTL) return homeCache.data;
  const f = await getJson(fetchFn, `${BASE}/featuredcategories?l=english&cc=${cc}`);
  // Steam lists each variant of a product separately, e.g. hardware bundles with the same name
  const items = (k) => [...new Map(((f[k] && f[k].items) || []).map((x) => [x.name, fromFeatured(x)])).values()];
  const groups = Object.keys(f).filter((k) => /^\d+$/.test(k)).map((k) => f[k]);
  const spotlights = groups.filter((g) => g.id === 'cat_spotlight').flatMap((g) => g.items || []).map((x) => ({
    label: x.name, image: x.header_image, url: x.url, note: String(x.body || '').replace(/\s*%1\$s\.?/, '').replace(/\s+(until|ends)$/i, '').trim(),
    id: Number(/\/app\/(\d+)/.exec(x.url || '')?.[1]) || 0,
  }));
  const daily = groups.filter((g) => g.id === 'cat_dailydeal').flatMap((g) => g.items || []).map(fromFeatured);
  const data = { spotlights, daily, specials: items('specials'), topSellers: items('top_sellers'), newReleases: items('new_releases') };
  await withArt([...data.daily, ...data.specials, ...data.topSellers, ...data.newReleases], cc, fetchFn);
  homeCache = { cc, at: Date.now(), data };
  return data;
}

async function search(term, cc, fetchFn) {
  const r = await getJson(fetchFn, `${BASE}/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=${cc}`);
  return (r.items || []).map((x) => ({
    id: x.id, name: x.name, image: x.tiny_image || '',
    final: x.price ? x.price.final : 0, original: x.price ? x.price.initial : 0,
    discount: x.price && x.price.initial > x.price.final ? Math.round((1 - x.price.final / x.price.initial) * 100) : 0,
    currency: x.price ? x.price.currency : '',
  }));
}

// the size a game lists under its PC requirements, in bytes; 0 when it doesn't say
function storageNeeded(req) {
  const text = String((req && (req.recommended || req.minimum)) || '').replace(/<[^>]+>/g, ' ');
  const m = /(?:storage|hard (?:disk|drive)(?: space)?)\s*:?\s*([\d.,]+)\s*(GB|MB|TB)/i.exec(text);
  if (!m) return 0;
  return parseFloat(m[1].replace(',', '.')) * { MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()];
}

async function details(id, cc, fetchFn) {
  const r = await getJson(fetchFn, `${BASE}/appdetails?appids=${id}&l=english&cc=${cc}`);
  const entry = r[id];
  if (!entry || !entry.success) throw new Error('Steam has no details for this game in your region');
  const d = entry.data;
  const reviews = await getJson(fetchFn, `https://store.steampowered.com/appreviews/${id}?json=1&language=all&num_per_page=0&purchase_type=all`).catch(() => null);
  const sum = reviews && reviews.query_summary;
  const [art2] = await withArt([{ ...art(id), id }], cc, fetchFn);
  return {
    rating: sum && sum.total_reviews ? Math.round((sum.total_positive / sum.total_reviews) * 100) : 0,
    ...art2, id, name: d.name, description: d.short_description || '', image: d.header_image || '',
    free: !!d.is_free, price: d.price_overview ? d.price_overview.final_formatted : '',
    discount: d.price_overview ? d.price_overview.discount_percent : 0,
    genres: (d.genres || []).map((g) => g.description),
    developers: d.developers || [],
    released: d.release_date ? d.release_date.date : '', comingSoon: !!(d.release_date && d.release_date.coming_soon),
    screenshots: (d.screenshots || []).slice(0, 8).map((s) => ({ thumb: s.path_thumbnail, full: s.path_full })),
    trailers: (d.movies || []).filter((m) => m.hls_h264).slice(0, 4).map((m) => ({ name: m.name, thumb: m.thumbnail, hls: m.hls_h264 })),
    storage: storageNeeded(d.pc_requirements),
  };
}

// The whole catalogue. Steam only offers this as page fragments, so each result row is read out of the HTML.
function parseRows(html) {
  const text = (s) => (s || '').replace(/<[^>]+>/g, '').trim();
  const rows = [];
  for (const part of html.split('<a href="https://store.steampowered.com/').slice(1)) {
    const id = /data-ds-appid="(\d+)/.exec(part)?.[1];
    const name = /<span class="title">([^<]*)</.exec(part)?.[1];
    if (!id || !name) continue; // bundles have no single app id
    const finalCents = /data-price-final="(\d+)"/.exec(part)?.[1];
    const shownPrice = text(/class="discount_final_price[^"]*">([\s\S]*?)<\/div>/.exec(part)?.[1]);
    rows.push({
      ...art(id), rating: Number(/(\d+)% of the/.exec(part)?.[1] || 0),
      was: text(/class="discount_original_price[^"]*">([\s\S]*?)<\/div>/.exec(part)?.[1]),
      id: Number(id), name, image: /<img src="([^"]+)"/.exec(part)?.[1] || '',
      released: text(/search_released[^>]*>([\s\S]*?)<\/div>/.exec(part)?.[1]),
      price: shownPrice || (finalCents === '0' ? 'Free' : ''),
      discount: Number(/data-discount="(\d+)"/.exec(part)?.[1] || 0),
    });
  }
  return rows;
}

const SORTS = new Set(['', 'Reviews_DESC', 'Released_DESC', 'Price_ASC', 'Price_DESC', 'Name_ASC']);
async function browse(q, cc, fetchFn) {
  const type = /^\d+$/.test(q.type || '') ? q.type : '998';
  const p = new URLSearchParams({ start: String(Number(q.start) || 0), count: String(Number(q.count) || 50), infinite: '1', cc, l: 'english', category1: type });
  const ids = (list) => (Array.isArray(list) ? list : []).filter((x) => /^\d+$/.test(x)).join(',');
  if (q.term) p.set('term', q.term);
  if (SORTS.has(q.sort) && q.sort) p.set('sort_by', q.sort);
  if (ids(q.tags)) p.set('tags', ids(q.tags));
  if (ids(q.features)) p.set('category2', ids(q.features));
  if (/^(free|\d+)$/.test(q.maxprice || '')) p.set('maxprice', q.maxprice);
  const os = (Array.isArray(q.os) ? q.os : []).filter((x) => ['win', 'mac', 'linux'].includes(x)).join(',');
  if (os) p.set('os', os);
  if (/^[a-z]+$/.test(q.lang || '')) p.set('supportedlang', q.lang);
  if (q.specials) p.set('specials', '1');
  if (q.hideF2p) p.set('hidef2p', '1');
  const r = await getJson(fetchFn, `https://store.steampowered.com/search/results/?${p}`);
  return { total: r.total_count || 0, items: await withArt(parseRows(r.results_html || ''), cc, fetchFn) };
}

let tagCache = null;
async function tags(fetchFn) {
  if (!tagCache) tagCache = (await getJson(fetchFn, 'https://store.steampowered.com/tagdata/populartags/english')).slice(0, 60);
  return tagCache;
}

module.exports = { id: 'steam', name: 'Steam', home, search, details, browse, tags, parseRows, storageNeeded };

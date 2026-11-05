// Reads Steam's public store data for the Store page. No sign-in is involved: buying and installing
// always happen in the Steam app itself.
const BASE = 'https://store.steampowered.com/api';
const HOME_TTL = 10 * 60 * 1000;
let homeCache = null;

async function getJson(fetchFn, url) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Steam store returned ${res.status}`);
  return res.json();
}

const fromFeatured = (x) => ({
  id: x.id, name: x.name, image: x.large_capsule_image || x.header_image || '',
  final: x.final_price || 0, original: x.original_price || 0, discount: x.discount_percent || 0, currency: x.currency || '',
});

async function home(cc, fetchFn) {
  if (homeCache && homeCache.cc === cc && Date.now() - homeCache.at < HOME_TTL) return homeCache.data;
  const f = await getJson(fetchFn, `${BASE}/featuredcategories?l=english&cc=${cc}`);
  // Steam lists each variant of a product separately, e.g. hardware bundles with the same name
  const items = (k) => [...new Map(((f[k] && f[k].items) || []).map((x) => [x.name, fromFeatured(x)])).values()];
  const data = { specials: items('specials'), topSellers: items('top_sellers'), newReleases: items('new_releases') };
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

async function details(id, cc, fetchFn) {
  const r = await getJson(fetchFn, `${BASE}/appdetails?appids=${id}&l=english&cc=${cc}`);
  const entry = r[id];
  if (!entry || !entry.success) throw new Error('Steam has no details for this game in your region');
  const d = entry.data;
  return {
    id, name: d.name, description: d.short_description || '', image: d.header_image || '',
    free: !!d.is_free, price: d.price_overview ? d.price_overview.final_formatted : '',
    discount: d.price_overview ? d.price_overview.discount_percent : 0,
    genres: (d.genres || []).map((g) => g.description),
    developers: d.developers || [],
    released: d.release_date ? d.release_date.date : '', comingSoon: !!(d.release_date && d.release_date.coming_soon),
    screenshots: (d.screenshots || []).slice(0, 6).map((s) => s.path_thumbnail),
  };
}

module.exports = { home, search, details };

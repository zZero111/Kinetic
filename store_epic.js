// The Epic provider. Epic's full catalogue is behind bot protection, so Kinetic only uses the public list of free
// games and promotions. The rest of the store is reached by opening Epic's own site.
const URL_FREE = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';
const seen = new Map();

const numberFor = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h || 1; };
const art = (e, ...types) => { for (const t of types) { const k = (e.keyImages || []).find((i) => i.type === t); if (k) return k.url; } return e.keyImages?.[0]?.url || ''; };

function toGame(e) {
  const p = e.price?.totalPrice || {};
  const slug = e.catalogNs?.mappings?.[0]?.pageSlug || e.offerMappings?.[0]?.pageSlug || e.productSlug || e.urlSlug || '';
  const wide = art(e, 'OfferImageWide', 'DieselStoreFrontWide', 'featuredMedia');
  const g = {
    source: 'epic', id: numberFor(e.id), name: e.title, url: slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/en-US/free-games',
    image: wide, capsule: wide, wide, tall: art(e, 'OfferImageTall', 'DieselStoreFrontTall', 'Thumbnail') || wide,
    final: p.discountPrice || 0, original: p.originalPrice || 0, currency: p.currencyCode || '', price: p.fmtPrice?.discountPrice === '0' ? 'Free' : p.fmtPrice?.discountPrice || '',
    was: p.discountPrice < p.originalPrice ? p.fmtPrice?.originalPrice || '' : '', discount: p.originalPrice ? Math.round((1 - p.discountPrice / p.originalPrice) * 100) : 0,
    released: e.effectiveDate ? e.effectiveDate.slice(0, 10) : '', rating: 0, about: e.description || '', publisher: e.seller?.name || '',
  };
  seen.set(g.id, g);
  return g;
}

async function all(cc, fetchFn) {
  const res = await Promise.race([fetchFn(`${URL_FREE}?locale=en-GB&country=${cc}&allowCountries=${cc}`), new Promise((_, reject) => setTimeout(() => reject(new Error('Epic took too long to answer')), 10000))]);
  if (!res.ok) throw new Error(`Epic returned ${res.status}`);
  const list = (await res.json()).data?.Catalog?.searchStore?.elements || [];
  return list.filter((e) => e.title && e.offerType !== 'OTHERS' && !/^mystery game/i.test(e.title)).map(toGame);
}

async function home(cc, fetchFn) {
  const games = await all(cc, fetchFn);
  return { spotlights: [], daily: [], specials: [], topSellers: games, newReleases: [] };
}

async function browse(q, cc, fetchFn) {
  if (Number(q.start)) return { total: 0, items: [] };
  const term = String(q.term || '').toLowerCase();
  const items = (await all(cc, fetchFn)).filter((g) => g.name.toLowerCase().includes(term));
  return { total: items.length, items };
}

async function details(id, cc, fetchFn) {
  if (!seen.has(Number(id))) await all(cc, fetchFn);
  const g = seen.get(Number(id));
  if (!g) throw new Error('Epic no longer lists this game');
  return { ...g, description: g.about, free: g.final === 0, comingSoon: false, trailers: [], storage: 0, genres: [], developers: g.publisher ? [g.publisher] : [], screenshots: g.wide ? [{ thumb: g.wide, full: g.wide }] : [] };
}

module.exports = { id: 'epic', name: 'Epic', home, browse, details, tags: async () => [], toGame };

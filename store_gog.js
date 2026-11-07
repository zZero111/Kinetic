// The GOG provider for the Store page, with the same shape as store.js. It uses GOG's public catalogue, so no
// sign-in is involved. GOG has no installer hook like Steam's, so buying and downloading happen on GOG's own pages.
const CATALOG = 'https://catalog.gog.com/v1/catalog';
const PAGE = 50;
const CURRENCY = { GB: 'GBP', US: 'USD', CA: 'CAD', AU: 'AUD' };
const money = (cc) => CURRENCY[cc] || 'EUR';

async function getJson(fetchFn, url) {
  const res = await Promise.race([fetchFn(url), new Promise((_, reject) => setTimeout(() => reject(new Error('GOG took too long to answer')), 10000))]);
  if (!res.ok) throw new Error(`GOG returned ${res.status}`);
  return res.json();
}

const https = (u) => (u && u.startsWith('//') ? 'https:' + u : u || '');
const pageUrl = (slug) => `https://www.gog.com/en/game/${slug}`;

function toGame(p) {
  const pr = p.price || {};
  const final = Math.round(Number(pr.finalMoney?.amount || 0) * 100);
  const wide = https(p.coverHorizontal);
  return {
    source: 'gog', id: Number(p.id), name: p.title, url: pageUrl(p.slug),
    image: wide, capsule: wide, wide, tall: https(p.coverVertical) || wide,
    final, currency: pr.finalMoney?.currency || '', price: final ? pr.final || '' : 'Free',
    was: pr.discount ? pr.base || '' : '', discount: Math.abs(parseInt(pr.discount, 10)) || 0,
    released: p.releaseDate ? String(p.releaseDate).slice(0, 10) : '', rating: p.reviewsRating ? Math.round(p.reviewsRating * 2) : 0,
  };
}

function catalogUrl(params, cc) {
  const q = new URLSearchParams({ countryCode: cc, currencyCode: money(cc), locale: 'en-US', productType: 'in:game,pack', ...params });
  return `${CATALOG}?${q}`;
}

const list = async (params, cc, fetchFn) => ((await getJson(fetchFn, catalogUrl(params, cc))).products || []).map(toGame);

async function home(cc, fetchFn) {
  const [topSellers, newReleases, specials] = await Promise.all([
    list({ limit: 12, order: 'desc:trending' }, cc, fetchFn),
    list({ limit: 12, order: 'desc:releaseDate' }, cc, fetchFn),
    list({ limit: 12, order: 'desc:trending', discounted: 'eq:true' }, cc, fetchFn),
  ]);
  return { spotlights: [], daily: [], specials, topSellers, newReleases };
}

const SORTS = { '': 'desc:trending', Reviews_DESC: 'desc:rating', Released_DESC: 'desc:releaseDate', Price_ASC: 'asc:price', Price_DESC: 'desc:price', Name_ASC: 'asc:title' };
async function browse(q, cc, fetchFn) {
  const limit = Number(q.count) || PAGE;
  const params = { limit, page: Math.floor((Number(q.start) || 0) / limit) + 1, order: SORTS[q.sort] || SORTS[''] };
  if (q.term) params.query = `like:${q.term}`;
  if (q.specials) params.discounted = 'eq:true';
  if (q.maxprice === 'free') params.price = 'between:0,0';
  else if (/^\d+$/.test(q.maxprice || '')) params.price = `between:0,${q.maxprice}`;
  const r = await getJson(fetchFn, catalogUrl(params, cc));
  return { total: r.productCount || 0, items: (r.products || []).map(toGame) };
}

async function details(id, cc, fetchFn) {
  const d = await getJson(fetchFn, `https://api.gog.com/products/${Number(id)}?expand=description,screenshots`);
  const prices = await getJson(fetchFn, `https://api.gog.com/products/${Number(id)}/prices?countryCode=${cc}`).catch(() => null);
  const entry = prices?._embedded?.prices?.find((p) => p.currency?.code === money(cc)) || prices?._embedded?.prices?.[0];
  const [amount, code] = String(entry?.finalPrice || '').split(' ');
  const cents = Number(amount);
  const price = Number.isFinite(cents) && code ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(cents / 100) : '';
  const lead = String(d.description?.lead || d.description?.full || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const shot = (s, size) => s.formatter_template_url.replace('{formatter}', size);
  const image = https(d.images?.background);
  return {
    source: 'gog', id: Number(id), name: d.title, url: pageUrl(d.slug), image, capsule: image, wide: image, tall: image,
    description: lead.length > 420 ? lead.slice(0, 417) + '…' : lead, free: cents === 0, price: cents === 0 ? '' : price, discount: 0,
    genres: [], developers: [], released: d.release_date ? d.release_date.slice(0, 10) : '', comingSoon: !!d.in_development?.active,
    rating: 0, storage: 0, trailers: [], // GOG's trailers are YouTube links, which this page doesn't embed
    screenshots: (d.screenshots || []).slice(0, 8).map((s) => ({ thumb: shot(s, 'ggvgm'), full: shot(s, 'ggvgl_2x') })),
  };
}

const tags = async () => [];

module.exports = { id: 'gog', name: 'GOG', home, browse, details, tags, toGame };

const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../store');
const gog = require('../store_gog');
const { compareVersions } = require('../updater');

const row = `<a href="https://store.steampowered.com/app/620/Portal_2/" data-ds-appid="620"><img src="https://x/c.jpg" ><span class="title">Portal 2</span>
<div class="search_released responsive_secondrow"> 18 Apr, 2011 </div><span data-tooltip-html="Very Positive&lt;br&gt;98% of the 400 user reviews"></span>
<div class="discount_block" data-price-final="819" data-discount="50"><div class="discount_original_price">£16.38</div><div class="discount_final_price">£8.19</div></div></a>`;

test('Steam search rows are read correctly', () => {
  const [g] = store.parseRows(row);
  assert.equal(g.id, 620);
  assert.equal(g.name, 'Portal 2');
  assert.equal(g.price, '£8.19');
  assert.equal(g.was, '£16.38');
  assert.equal(g.discount, 50);
  assert.equal(g.rating, 98);
});

test('bundles without one app id are skipped', () => {
  assert.deepEqual(store.parseRows('<a href="https://store.steampowered.com/bundle/1/"><span class="title">Bundle</span></a>'), []);
});

test('a game\'s listed install size is read from its requirements', () => {
  assert.equal(store.storageNeeded({ minimum: '<strong>Storage:</strong> 150 GB available space' }), 150e9);
  assert.equal(store.storageNeeded({ minimum: 'Hard Drive: 500 MB' }), 500e6);
  assert.equal(store.storageNeeded({}), 0);
});

test('placeholder entries never reach the Store', async () => {
  const items = [{ id: 1, name: 'Uninitialized', large_capsule_image: null }, { id: 2, name: 'Real', large_capsule_image: 'https://x/a.jpg', final_price: 100, currency: 'GBP' }];
  const fetchFn = async (url) => ({ ok: true, json: async () => (url.includes('featuredcategories') ? { top_sellers: { items }, specials: { items: [] }, new_releases: { items: [] } } : { response: { store_items: [] } }) });
  const h = await store.home('ZZ', fetchFn);
  assert.deepEqual(h.topSellers.map((g) => g.name), ['Real']);
});

test('GOG products become the common game format', () => {
  const g = gog.toGame({ id: '42', title: 'Test', slug: 'test', coverHorizontal: '//images/a.jpg', price: { final: '£5.00', base: '£10.00', discount: '-50%', finalMoney: { amount: '5.00', currency: 'GBP' } } });
  assert.equal(g.source, 'gog');
  assert.equal(g.id, 42);
  assert.equal(g.image, 'https://images/a.jpg');
  assert.equal(g.final, 500);
  assert.equal(g.discount, 50);
  assert.equal(g.url, 'https://www.gog.com/en/game/test');
});

test('versions compare as numbers', () => {
  assert.equal(compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(compareVersions('v0.1.2', '0.1.2'), 0);
  assert.equal(compareVersions('0.1.1', '0.1.2'), -1);
});

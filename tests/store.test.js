const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../store');
const gog = require('../store_gog');
const community = require('../community');
const fs = require('fs'), os = require('os'), path = require('path');
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

test('the Windows zip is chosen from a release', () => {
  const pick = (...n) => community.pickAsset(n.map((name) => ({ name })))?.name;
  assert.equal(pick('App-Linux.zip', 'App-Windows.zip', 'App-macOS.zip'), 'App-Windows.zip');
  assert.equal(pick('app-windows-portable-win32.zip', 'app-windows-portable-x64.zip', 'app-windows-installer-x64.exe'), 'app-windows-portable-x64.zip');
  assert.equal(pick('pd-i686-windows.zip', 'pd-x86_64-windows.zip'), 'pd-x86_64-windows.zip');
  assert.equal(pick('App-Linux.zip'), undefined);
});

test('a download that does not match its checksum is refused and deleted', async () => {
  const dest = path.join(os.tmpdir(), `kinetic-${process.pid}.bin`);
  const fetchFn = async () => new Response('hello');
  const good = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  assert.deepEqual((await community.download({ browser_download_url: 'x', digest: good }, dest, fetchFn, () => {})).verified, true);
  await assert.rejects(community.download({ browser_download_url: 'x', digest: 'sha256:' + '0'.repeat(64) }, dest, fetchFn, () => {}), /checksum/);
  assert.equal(fs.existsSync(dest), false);
});

test('removing a mod deletes only the files it added', async () => {
  const mods = require('../mods');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetic-mods-'));
  const mine = path.join(dir, 'a.nrm'), theirs = path.join(dir, 'b.nrm');
  fs.writeFileSync(mine, 'x'); fs.writeFileSync(theirs, 'y');
  await mods.remove([mine]);
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(theirs), true);
});

test('dependencies come first, once each, even in a loop', () => {
  const mods = require('../mods');
  const a = { id: 'a', deps: ['b', 'c'] }, b = { id: 'b', deps: ['c', 'a'] }, c = { id: 'c', deps: ['gone'] };
  assert.deepEqual(mods.withDependencies(a, [a, b, c]).map((m) => m.id), ['c', 'b', 'a']);
});

test('every catalogue entry is usable', () => {
  const list = require('../catalog.json');
  assert.ok(list.length >= 15);
  assert.equal(new Set(list.map((c) => c.id)).size, list.length);
  for (const c of list) { assert.ok(Number.isInteger(c.id)); assert.match(c.repo, /^[\w.-]+\/[\w.-]+$/); assert.ok(c.title && c.about); }
});

test('Epic promotions become the common game format', () => {
  const epic = require('../store_epic');
  const g = epic.toGame({ id: 'abc', title: 'Test', productSlug: 'test', keyImages: [{ type: 'OfferImageWide', url: 'https://x/w.jpg' }], price: { totalPrice: { discountPrice: 0, originalPrice: 1999, currencyCode: 'GBP', fmtPrice: { discountPrice: '0', originalPrice: '£19.99' } } } });
  assert.equal(g.price, 'Free');
  assert.equal(g.discount, 100);
  assert.equal(g.url, 'https://store.epicgames.com/en-US/p/test');
});

test('only games with a rule offer mods', () => {
  const mods = require('../mods');
  assert.ok(mods.ruleFor({ repo: 'Zelda64Recomp/Zelda64Recomp' }));
  assert.equal(mods.ruleFor({ repo: 'someone/else' }), null);
});

test('versions compare as numbers', () => {
  assert.equal(compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(compareVersions('v0.1.2', '0.1.2'), 0);
  assert.equal(compareVersions('0.1.1', '0.1.2'), -1);
});

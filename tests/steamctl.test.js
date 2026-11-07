const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const c = require('../steamctl');

const folder = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetic-')); fs.mkdirSync(path.join(d, 'downloading')); return d; };
const manifest = (flags, extra = '') => `"AppState"\n{\n\t"StateFlags"\t\t"${flags}"\n\t"ScheduledAutoUpdate"\t\t"999"\n\t"BytesToDownload"\t\t"100"\n\t"BytesDownloaded"\t\t"40"\n\t"BytesToStage"\t\t"10"\n\t"BytesStaged"\t\t"5"\n${extra}}\n`;
const flagsOf = (f) => Number(/"StateFlags"\s+"(\d+)"/.exec(fs.readFileSync(f, 'utf8'))[1]);

test('an update keeps the flags Steam wrote and moves its timer', () => {
  const d = folder(), f = path.join(d, 'appmanifest_5.acf');
  fs.writeFileSync(f, manifest(6));
  c.markForUpdate(f, path.join(d, 'bk'));
  assert.equal(flagsOf(f), 6);
  assert.match(fs.readFileSync(f, 'utf8'), /"ScheduledAutoUpdate"\s+"1"/);
  assert.equal(fs.readdirSync(path.join(d, 'bk')).length, 1); // always backed up first
});

test('pause and resume set and clear the paused flag', () => {
  const d = folder(), f = path.join(d, 'appmanifest_5.acf');
  fs.writeFileSync(f, manifest(1030));
  c.pause(f);
  assert.equal(flagsOf(f), 518);
  assert.equal(c.progress(f).paused, true);
  c.markForUpdate(f, path.join(d, 'bk'));
  assert.equal(flagsOf(f), 6);
});

test('an installed game can never be cancelled away', () => {
  const d = folder(), f = path.join(d, 'appmanifest_5.acf');
  fs.writeFileSync(f, manifest(6));
  assert.throws(() => c.cancelInstall(f, 5));
  assert.ok(fs.existsSync(f));
});

test('progress estimates from the patch file and never claims to be finished', () => {
  const d = folder(), f = path.join(d, 'appmanifest_5.acf');
  fs.writeFileSync(f, manifest(1030).replace('"40"', '"0"').replace('"100"', '"8619388080"'));
  fs.writeFileSync(path.join(d, 'downloading', 'state_5_1.patch'), Buffer.alloc(229680));
  fs.writeFileSync(path.join(d, 'downloading', 'state_9_1.patch'), Buffer.alloc(999984)); // another game
  const p = c.progress(f);
  assert.equal(p.estimated, true);
  assert.ok(p.percent >= 49 && p.percent <= 50, String(p.percent));
  fs.writeFileSync(path.join(d, 'downloading', 'state_5_1.patch'), Buffer.alloc(5000000));
  assert.ok(c.progress(f).percent < 100);
  assert.equal(c.progress(f).done, false);
});

test('an unowned install is reported as unowned', () => {
  const d = folder(), f = path.join(d, 'appmanifest_5.acf');
  fs.writeFileSync(f, manifest(1026));
  assert.equal(c.progress(f).owned, false);
  fs.writeFileSync(f, manifest(1026, '\t"LastOwner"\t\t"7656"\n'));
  assert.equal(c.progress(f).owned, true);
});

test('folder names are safe for Windows', () => {
  assert.equal(c.safeFolder('Bad: "Name"? / Test.'), 'Bad Name Test');
});

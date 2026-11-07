// Mods for community games. Each game has a rule saying where its mods come from and where they go. Only the mod
// files themselves are copied, and Kinetic remembers them, so removing a mod deletes exactly what it added.
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { Readable } = require('stream');
const { extract } = require('./community');

const beside = (exe) => path.join(path.dirname(exe), 'mods');
const RULES = {
  'Zelda64Recomp/Zelda64Recomp': {
    key: 'ts-zelda', community: 'zelda-64-recompiled', files: /\.(nrm|rtz)$/i,
    // the game's own code: portable.txt beside the exe, otherwise its folder in local app data
    folder: (exe) => (fs.existsSync(path.join(path.dirname(exe), 'portable.txt'))
      ? path.join(path.dirname(exe), 'mods')
      : path.join(process.env.LOCALAPPDATA || '', 'Zelda64Recompiled', 'mods')),
  },
  // the README: custom asset archives go in the mods folder
  'HarbourMasters/Shipwright': { key: 'gb-soh', gamebanana: 16121, files: /\.(otr|o2r)$/i, flat: true, folder: beside },
  '2ship2harkinian/2ship2harkinian': { key: 'gb-2ship', gamebanana: 20371, files: /\.(otr|o2r)$/i, flat: true, folder: beside },
};

const ruleFor = (g) => RULES[g.repo] || null;
const PACKAGE_FILES = /^(manifest\.json|icon\.png|readme\.md|changelog\.md|license(\.\w+)?)$/i;

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// GameBanana lists newest first, 15 at a time
async function listGameBanana(rule, fetchFn) {
  const pages = await Promise.all([1, 2, 3, 4, 5, 6].map(async (n) => {
    const res = await fetchFn(`https://gamebanana.com/apiv11/Game/${rule.gamebanana}/Subfeed?_nPage=${n}&_csvModelInclusions=Mod`);
    return res.ok ? (await res.json())._aRecords || [] : [];
  }));
  return pages.flat().map((m) => {
    const pic = m._aPreviewMedia?._aImages?.[0];
    return { id: `gb-${m._idRow}`, gb: m._idRow, name: m._sName, owner: m._aSubmitter?._sName || 'GameBanana', version: String(m._tsDateModified || ''), about: clean(m._sDescription), icon: pic ? `${pic._sBaseUrl}/${pic._sFile220 || pic._sFile}` : '', downloads: m._nViewCount || 0, deps: [] };
  });
}

// the file to download; GameBanana's own scan result and checksum come with it
async function gameBananaFile(mod, fetchFn) {
  const res = await fetchFn(`https://gamebanana.com/apiv11/Mod/${mod.gb}/ProfilePage`);
  if (!res.ok) throw new Error(`GameBanana returned ${res.status}`);
  const file = ((await res.json())._aFiles || []).find((f) => !f._bIsArchived);
  if (!file) throw new Error('This mod has no downloadable file');
  if (file._sAvResult && file._sAvResult !== 'clean') throw new Error('GameBanana flagged this file, so it was not installed');
  return { url: file._sDownloadUrl, md5: file._sMd5Checksum };
}

async function list(rule, fetchFn) {
  if (rule.gamebanana) return listGameBanana(rule, fetchFn);
  const res = await Promise.race([fetchFn(`https://thunderstore.io/c/${rule.community}/api/v1/package/`), new Promise((_, reject) => setTimeout(() => reject(new Error('Thunderstore took too long to answer')), 15000))]);
  if (!res.ok) throw new Error(`Thunderstore returned ${res.status}`);
  const all = await res.json();
  return all.filter((p) => !p.is_deprecated && p.versions?.length).map((p) => {
    const v = p.versions[0];
    return { id: p.full_name, name: p.name.replace(/_/g, ' '), owner: p.owner, version: v.version_number, about: v.description, icon: v.icon, url: v.download_url, downloads: p.versions.reduce((n, x) => n + (x.downloads || 0), 0), deps: (v.dependencies || []).map((d) => d.replace(/-[^-]+$/, '')) };
  }).sort((a, b) => b.downloads - a.downloads);
}

// the mod plus everything it needs, dependencies first; `all` is the full list so nothing is missed
function withDependencies(mod, all) {
  const order = [], seen = new Set();
  const visit = (m) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    for (const id of m.deps || []) { const d = all.find((x) => x.id === id); if (d) visit(d); }
    order.push(m);
  };
  visit(mod);
  return order;
}

async function walk(dir) {
  const out = [];
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

async function install(rule, exe, mod, fetchFn, onProgress = () => {}) {
  const source = mod.gb ? await gameBananaFile(mod, fetchFn) : { url: mod.url };
  const res = await fetchFn(source.url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kinetic-mod-'));
  try {
    const zip = path.join(tmp, 'mod.zip');
    const total = Number(res.headers.get('content-length')) || 0;
    const out0 = fs.createWriteStream(zip);
    let got = 0;
    const md5 = crypto.createHash('md5');
    for await (const chunk of Readable.fromWeb(res.body)) {
      got += chunk.length;
      md5.update(chunk);
      if (!out0.write(chunk)) await new Promise((r) => out0.once('drain', r));
      if (total) onProgress(got / total);
    }
    await new Promise((resolve, reject) => { out0.end(resolve); out0.on('error', reject); });
    if (source.md5 && md5.digest('hex') !== source.md5.toLowerCase()) throw new Error('The download did not match its published checksum, so it was refused');
    const out = path.join(tmp, 'files');
    await fs.promises.mkdir(out);
    await extract(zip, out);
    const all = await walk(out);
    const main = all.filter((f) => rule.files.test(f));
    if (!main.length) throw new Error('This mod has no files Kinetic knows how to install');
    // some mods ship a whole runtime beside their .nrm, so everything next to it is kept in the same layout;
    // only the package's own listing files are left out
    const base = path.dirname(main.sort((x, y) => x.length - y.length)[0]);
    const dest = rule.folder(exe);
    const files = [];
    for (const f of all) {
      const rel = rule.flat ? path.basename(f) : path.relative(base, f);
      if (rule.flat && !rule.files.test(f)) continue;
      if (rel.startsWith('..') || (!rel.includes(path.sep) && PACKAGE_FILES.test(rel))) continue;
      const to = path.join(dest, rel);
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      await fs.promises.copyFile(f, to);
      files.push(to);
    }
    return files;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

const remove = (files) => Promise.all((files || []).map((f) => fs.promises.rm(f, { force: true })));

module.exports = { ruleFor, list, install, remove, withDependencies, RULES };

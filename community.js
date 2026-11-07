// The Recomps store: community ports and recompilations published as GitHub releases. It has the same shape as
// store.js, plus downloading. Each file is checked against the SHA-256 GitHub recorded for it. That proves you got
// the file the project published; it can't prove the file itself is safe.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');

const API = 'https://api.github.com';
// catalog.json ships with Kinetic and also lives in the repo, so projects can be added without a new release. Neither
// source uses GitHub's API, whose anonymous limit is 60 requests an hour.
const CATALOG_URL = 'https://raw.githubusercontent.com/zZero111/Kinetic/main/catalog.json';
let CATALOG = require('./catalog.json');
let catalogFetched = 0;
async function refreshCatalog(fetchFn) {
  if (Date.now() - catalogFetched < 3600000) return;
  catalogFetched = Date.now();
  try {
    const res = await fetchFn(CATALOG_URL);
    const list = res.ok ? await res.json() : null;
    if (Array.isArray(list) && list.length && list.every((c) => Number.isInteger(c.id) && /^[\w.-]+\/[\w.-]+$/.test(c.repo) && c.title)) CATALOG = list;
  } catch {} // the built-in list carries on working
}

async function getJson(fetchFn, url) {
  const res = await Promise.race([fetchFn(url), new Promise((_, reject) => setTimeout(() => reject(new Error('GitHub took too long to answer')), 10000))]);
  if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests for now. Try again in a while.');
  if (res.status === 404) throw new Error('That GitHub project was not found');
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  return res.json();
}

const entry = (r) => CATALOG.find((c) => c.id === r.id);
const asRepo = (c) => ({ id: c.id, full_name: c.repo, name: c.title, html_url: `https://github.com/${c.repo}`, owner: { login: c.repo.split('/')[0] }, description: c.about });

function toGame(r) {
  const known = entry(r);
  const image = ''; // GitHub has no game art; the page draws a title card instead
  return {
    source: 'community', id: r.id, repo: r.full_name, name: known ? known.title : r.name, url: r.html_url,
    logo: (known && known.logo) || `https://github.com/${r.owner.login}.png?size=256`, requires: known ? known.needs : '',
    image, capsule: image, wide: image, tall: image, final: 0, price: 'Free', rating: 0, discount: 0,
    released: r.pushed_at ? r.pushed_at.slice(0, 10) : '', currency: '', catalogued: !!known,
  };
}

const catalog = () => CATALOG.map(asRepo).map(toGame);

async function home(_cc, fetchFn) {
  await refreshCatalog(fetchFn);
  const all = catalog();
  return { spotlights: [], daily: [], specials: [], topSellers: all, newReleases: [] };
}

async function browse(q, _cc, fetchFn) {
  const term = String(q.term || '').trim();
  if (Number(q.start)) return { total: 0, items: [] };
  // typing owner/name adds any project, not just the catalogue
  if (/^[\w.-]+\/[\w.-]+$/.test(term)) return { total: 1, items: [toGame(await getJson(fetchFn, `${API}/repos/${term}`))] };
  await refreshCatalog(fetchFn);
  const all = catalog();
  const items = term ? all.filter((g) => `${g.name} ${g.repo}`.toLowerCase().includes(term.toLowerCase())) : all;
  return { total: items.length, items };
}

// the Windows download from a release: a portable zip, preferring 64-bit
function pickAsset(assets) {
  const usable = (assets || []).filter((a) => /\.zip$/i.test(a.name) && !/linux|mac|osx|darwin|arm|android|debug|symbols|pdb|installer|source/i.test(a.name));
  const windows = usable.filter((a) => /win/i.test(a.name));
  return windows.find((a) => /x64|x86_64|win64|amd64/i.test(a.name)) || windows.find((a) => !/win32|i686|i386|32bit|x86(?!_64)/i.test(a.name)) || windows[0] || null;
}

const latest = (repo, fetchFn) => getJson(fetchFn, `${API}/repos/${repo}/releases/latest`);

async function details(id, _cc, fetchFn) {
  const listed = CATALOG.find((c) => c.id === Number(id));
  const r = listed ? asRepo(listed) : await getJson(fetchFn, `${API}/repositories/${Number(id)}`);
  // a project with no release is normal; GitHub's request limit is passed on so the page can say so
  const rel = await latest(r.full_name, fetchFn).catch((err) => { if (/limiting/.test(err.message)) throw err; return null; });
  const asset = rel && pickAsset(rel.assets);
  const known = entry(r);
  const needs = !known ? 'Not in the Kinetic catalogue. Only install projects you trust.' : known.needs ? `You need your own copy of ${known.needs}.` : '';
  return {
    ...toGame(r), free: true, price: '', comingSoon: false, trailers: [], storage: asset ? asset.size : 0,
    screenshots: ((known && known.shots) || []).map((u) => ({ thumb: u, full: u })),
    notes: rel && rel.body ? rel.body.replace(/\[!\w+\]/g, '').replace(/[#*`>_]|\[|\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().slice(0, 420) : '',
    description: `${r.description || ''} ${needs}`.trim(), genres: ['Community'], developers: [r.owner.login],
    released: rel ? `${rel.tag_name} · ${rel.published_at.slice(0, 10)}` : 'No releases', canInstall: !!asset, discount: 0,
  };
}

// streams to disk while hashing; a file that doesn't match GitHub's checksum is deleted and refused
async function download(asset, dest, fetchFn, onProgress, signal) {
  const res = await fetchFn(asset.browser_download_url, { signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  let got = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress(got);
    }
    await new Promise((resolve, reject) => { out.end(resolve); out.on('error', reject); });
  } catch (err) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw err;
  }
  const sha = hash.digest('hex');
  const expected = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase();
  if (expected && expected !== sha) {
    fs.rmSync(dest, { force: true });
    throw new Error('The download did not match its published checksum, so it was refused');
  }
  return { sha, verified: !!expected };
}

const extract = (zip, dir) => new Promise((resolve, reject) => {
  execFile(path.join(process.env.windir || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir], { windowsHide: true }, (err) => (err ? reject(new Error('The download could not be unpacked')) : resolve()));
});

// the game's own exe: helpers are skipped, and the largest remaining file near the top of the folder wins
async function findExe(dir, depth = 0) {
  const found = [];
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) found.push(...await findExe(p, depth + 1));
    else if (e.isFile() && /\.exe$/i.test(e.name) && !/unins|crash|redist|setup|update|helper|vc_/i.test(e.name)) found.push(p);
  }
  if (depth) return found;
  const sized = await Promise.all(found.map(async (p) => ({ p, size: (await fs.promises.stat(p)).size })));
  return sized.sort((a, b) => b.size - a.size)[0]?.p || '';
}

module.exports = { id: 'community', name: 'Recomps', home, browse, details, tags: async () => [], latest, pickAsset, download, extract, findExe, toGame };

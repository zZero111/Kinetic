// ---- updates
let pendingUpdate = null;
function showUpdate(info) {
  pendingUpdate = info && info.available !== false ? info : null;
  const btn = $('update-btn');
  btn.hidden = !pendingUpdate;
  if (pendingUpdate) btn.textContent = `Update ${pendingUpdate.version}`;
  $('s-update-install').hidden = !pendingUpdate;
}
async function installUpdate() {
  if (!pendingUpdate) return;
  const btn = $('update-btn');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  const r = await window.api.installUpdate();
  if (!r.ok) { btn.disabled = false; btn.textContent = `Update ${pendingUpdate.version}`; toast(r.error, true); }
  else btn.textContent = 'Restarting…';
}
window.api.onUpdateAvailable(showUpdate);
window.api.onUpdateProgress((p) => { $('update-btn').textContent = `Downloading ${Math.round(p * 100)}%`; });
$('update-btn').onclick = () => pressTwice($('update-btn'), installUpdate);
$('s-update-install').onclick = () => { settingsDlg.close('cancel'); installUpdate(); };
$('s-update-check').onclick = async () => {
  const msg = $('s-update-msg');
  msg.style.color = '#8d92a6';
  msg.textContent = ' Saving and checking…';
  await window.api.setSettings({ updateRepo: $('s-repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/(\.git)?\/?$/, '') });
  const r = await window.api.checkUpdate();
  if (!r.ok) { msg.style.color = '#ff5a5a'; msg.textContent = ' ' + r.error; return; }
  showUpdate(r);
  msg.style.color = r.available ? '#5ee08a' : '#8d92a6';
  msg.textContent = r.available ? ` Version ${r.version} is available` : ` You're up to date (${r.current})`;
};

refresh();

// fetch the Store's first answers once the launcher is idle, so opening it doesn't wait for the network
setTimeout(async () => {
  const load = (u) => { if (u) new Image().src = u; }; // lands in the browser's cache, ready for the page
  const [home, list] = await Promise.all([
    window.api.storeHome(STORE_SOURCE),
    window.api.storeBrowse({ ...browseQ, source: STORE_SOURCE, term: '', start: 0 }),
    window.api.storeTags(STORE_SOURCE),
  ]);
  if (home.ok) {
    for (const s of home.data.spotlights.slice(0, 2)) load(s.image);
    for (const g of [...home.data.daily, ...home.data.topSellers.slice(0, 4)]) { load(g.capsule); load(g.tall); load(g.wide); }
  }
  if (list.ok) list.data.items.slice(0, 21).forEach((g) => load(g.capsule));
}, 4000);

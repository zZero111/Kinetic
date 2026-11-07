// ---------------------------------------------------------------- details dialog
const ART = ['cover', 'background', 'logo', 'icon'];
const base = (p) => (p ? p.split(/[\\/]/).pop() : '');

function openEdit(g) {
  editing = g;
  pending = {};
  $('e-title').value = g.title;
  $('e-desc').value = g.description || '';
  $('e-tag').value = g.tag || '';
  $('e-coll').value = (g.collections || []).join(', ');
  $('e-mods').hidden = !MOD_GAMES.includes(g.repo);
  $('e-remove').textContent = g.source === 'community' ? 'Uninstall' : 'Remove';
  $('e-args').value = g.args || '';
  $('e-cwd').value = g.cwd || '';
  $('e-env').value = g.env || '';
  $('e-admin').checked = !!g.admin;
  $('e-display').value = g.displayMode || '';
  $('e-priority').value = g.priority || '';
  $('e-pre').value = g.preLaunch || '';
  $('e-post').value = g.postExit || '';
  $('e-save').value = g.saveDir || '';
  for (const k of ART) $('n-' + k).textContent = base(g[k]);
  $('sgdb-results').replaceChildren();
  $('sgdb-msg').textContent = '';
  dlg.returnValue = ''; // otherwise Esc reuses the last result and saves again
  dlg.showModal();
}

document.querySelectorAll('[data-art]').forEach((b) => {
  b.onclick = async () => {
    const p = await window.api.pickArt(b.dataset.art);
    if (p) { pending[b.dataset.art] = p; $('n-' + b.dataset.art).textContent = base(p); }
  };
});

$('e-sgdb').onclick = async () => {
  const msg = $('sgdb-msg');
  const box = $('sgdb-results');
  box.replaceChildren();
  msg.textContent = ' Searching…';
  const r = await window.api.sgdbSearch($('e-title').value.trim() || editing.title);
  if (!r.ok) { msg.textContent = ' ' + r.error; return; }
  msg.textContent = ` Matched “${r.name}” — click an image to use it`;
  for (const kind of ART) {
    if (!r[kind].length) continue;
    box.append(el('h3', '', kind));
    const grid = el('div', 'sgdb-grid ' + (kind === 'background' ? 'wide' : kind));
    for (const item of r[kind]) {
      const img = el('img');
      img.src = item.thumb;
      img.loading = 'lazy';
      img.onclick = async () => {
        msg.textContent = ' Downloading…';
        const d = await window.api.sgdbDownload(item.url, editing.id, kind);
        if (d.ok) { pending[kind] = d.path; $('n-' + kind).textContent = base(d.path); msg.textContent = ` ${kind} selected — press Save`; } else msg.textContent = ' ' + d.error;
      };
      grid.append(img);
    }
    box.append(grid);
  }
};

// ---- mods
const MOD_GAMES = ['Zelda64Recomp/Zelda64Recomp', 'HarbourMasters/Shipwright', '2ship2harkinian/2ship2harkinian'];
const modStatus = new Map();
window.api.onModProgress((id, label, pct) => { const s = modStatus.get(id); if (s) s.textContent = `${label} ${pct}%`; });

async function drawMods(g, warn) {
  const box = $('mods-list');
  box.replaceChildren(el('p', 'store-msg', 'Loading mods…'));
  const r = await window.api.modsList(g.id);
  if (!r.ok) { box.replaceChildren(el('p', 'store-msg', r.error)); return; }
  box.replaceChildren(...r.data.map((m) => {
    const row = el('div', 'mod-row');
    const pic = el('img');
    pic.src = m.icon;
    pic.alt = '';
    pic.loading = 'lazy';
    const text = el('div', 'mod-text');
    text.append(el('b', '', m.name), el('span', '', m.about), el('small', '', `${m.owner} · v${m.version} · ${m.downloads.toLocaleString()} downloads`));
    const btns = el('div', 'mod-btns');
    const act = async (fn, busy, force) => {
      // large texture packs take minutes, so the row itself shows the work until it finishes
      const status = el('span', 'mod-busy', busy);
      btns.replaceChildren(status);
      modStatus.set(m.id, status);
      const res = await fn(g.id, m.id, force);
      modStatus.delete(m.id);
      if (!res.ok) toast(res.error, true);
      else if (res.data?.neededBy) { drawMods(g, { id: m.id, names: res.data.neededBy }); return; }
      else if (res.data > 1) toast(`${m.name} installed, with ${res.data - 1} mod${res.data > 2 ? 's' : ''} it needs`);
      drawMods(g);
    };
    const add = (label, fn, busy, force) => { const b = el('button', '', label); b.type = 'button'; b.onclick = () => act(fn, busy, force); btns.append(b); };
    if (!m.installed) add('Install', window.api.modsInstall, `Installing ${m.name}…`);
    else {
      if (m.installed !== m.version) add('Update', window.api.modsInstall, `Updating ${m.name}…`);
      if (warn && warn.id === m.id) {
        text.append(el('small', 'bad', `Needed by ${warn.names.join(', ')}. Removing it may break them.`));
        add('Remove anyway', window.api.modsRemove, `Removing ${m.name}…`, true);
      } else add('Remove', window.api.modsRemove, `Removing ${m.name}…`);
    }
    row.append(pic, text, btns);
    return row;
  }));
}
$('e-mods').onclick = () => {
  const g = editing;
  dlg.close('cancel');
  $('mods-title').textContent = `${g.title} mods`;
  $('mods').returnValue = '';
  $('mods').showModal();
  drawMods(g);
};

$('e-pick-save').onclick = async () => {
  const p = await window.api.pickFolder();
  if (p) $('e-save').value = p;
};
$('e-backup').onclick = async () => {
  await window.api.updateGame(editing.id, { saveDir: $('e-save').value.trim() });
  const r = await window.api.backupSaves(editing.id);
  toast(r.ok ? 'Saves backed up' : r.error, !r.ok);
};
$('e-open-backups').onclick = () => window.api.openBackups(editing.id);
$('e-folder').onclick = () => window.api.openFolder(editing.id);
$('e-desktop').onclick = async () => { const r = await window.api.shortcut(editing.id, 'desktop'); toast(r.ok ? 'Desktop shortcut created' : r.error, !r.ok); };
$('e-startmenu').onclick = async () => { const r = await window.api.shortcut(editing.id, 'startmenu'); toast(r.ok ? 'Start Menu shortcut created' : r.error, !r.ok); };
$('e-steam').onclick = async () => { const r = await window.api.addToSteam(editing.id); toast(r.ok ? 'Added to Steam — restart Steam to see it' : r.error, !r.ok); };

// a second press confirms, so these work from a controller
function pressTwice(btn, fn, warning = 'Press again to confirm') {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; fn(); return; }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = warning;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 3000);
}

$('e-remove').onclick = () => pressTwice($('e-remove'), async () => {
  const r = await window.api.removeGame(editing.id);
  if (r && !r.ok) { toast(r.error, true); return; }
  dlg.close('cancel');
  refresh();
}, editing.source === 'community' ? 'Press again: deletes the game, its saves and mods' : undefined);

dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save' || !editing) return;
  const patch = {
    title: $('e-title').value.trim() || editing.title,
    description: $('e-desc').value.trim(),
    tag: $('e-tag').value.trim(),
    collections: [...new Set($('e-coll').value.split(',').map((x) => x.trim()).filter(Boolean))],
    args: $('e-args').value.trim(),
    cwd: $('e-cwd').value.trim(),
    env: $('e-env').value.trim(),
    admin: $('e-admin').checked,
    displayMode: $('e-display').value,
    priority: $('e-priority').value,
    preLaunch: $('e-pre').value.trim(),
    postExit: $('e-post').value.trim(),
    saveDir: $('e-save').value.trim(),
    ...pending,
  };
  await window.api.updateGame(editing.id, patch);
  refresh();
});

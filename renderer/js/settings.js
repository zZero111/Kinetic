// ---------------------------------------------------------------- settings dialog
async function renderPrereqs() {
  const ul = $('prereq');
  ul.replaceChildren(el('li', '', 'Checking…'));
  const res = await window.api.checkPrereqs();
  ul.replaceChildren(...res.map((r) => {
    const li = el('li');
    li.append(el('span', r.ok ? 'ok' : 'bad', r.ok ? '✔ ' : '✘ '), document.createTextNode(r.name));
    return li;
  }));
}

$('open-settings').onclick = async () => {
  const [s, ui, displays] = await Promise.all([window.api.getSettings(), window.api.updateInfo(), window.api.listDisplays()]);
  $('s-sgdb').value = s.sgdbKey || '';
  $('s-discord').value = s.discordId || '';
  $('s-tray').checked = !!s.closeToTray;
  $('s-fullscreen').checked = !!s.startFullscreen;
  $('s-startup').checked = !!s.launchAtStartup;
  $('s-minimised').checked = !!s.startMinimised;
  $('s-after').value = s.afterLaunch || 'stay';
  $('s-repo').value = s.updateRepo || '';
  $('s-autoupdate').checked = s.autoUpdate !== false;
  $('s-version-top').textContent = `v${ui.version}`;
  $('s-version').textContent = `Installed version ${ui.version}` + (ui.packaged ? '' : ' (running from source)');
  $('s-update-install').hidden = !pendingUpdate;
  $('s-update-msg').textContent = pendingUpdate ? ` Version ${pendingUpdate.version} is available` : '';
  const sel = $('s-display');
  sel.replaceChildren(new Option('Primary monitor (default)', ''));
  for (const d of displays) sel.append(new Option(d.label, d.id));
  sel.value = [...sel.options].some((o) => o.value === s.display) ? s.display : '';
  settingsDlg.returnValue = '';
  settingsDlg.showModal();
};
settingsDlg.addEventListener('close', async () => {
  if (settingsDlg.returnValue !== 'save') return;
  await window.api.setSettings({
    sgdbKey: $('s-sgdb').value.trim(),
    discordId: $('s-discord').value.trim(),
    closeToTray: $('s-tray').checked,
    display: $('s-display').value,
    startFullscreen: $('s-fullscreen').checked,
    launchAtStartup: $('s-startup').checked,
    startMinimised: $('s-minimised').checked,
    afterLaunch: $('s-after').value,
    updateRepo: $('s-repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/(\.git)?\/?$/, ''),
    autoUpdate: $('s-autoupdate').checked,
  });
  toast('Settings saved');
});
$('s-check').onclick = renderPrereqs;
$('s-vcredist').onclick = () => window.api.openPrereq('vcredist');
$('s-dx').onclick = () => window.api.openPrereq('directx');
$('s-export').onclick = async () => toast('Library saved to ' + (await window.api.backupLibrary()));
$('s-open-data').onclick = () => window.api.openData();

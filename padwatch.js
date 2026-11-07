// Watches for View + Menu held together, even while a game has focus, so Kinetic can be brought back from the sofa.
// It runs as a small hidden PowerShell process using Windows' own XInput library, so there is no compiled add-on.
// It only ever reports that one combination; all other controller input stays in the page. XInput covers Xbox-style
// pads, and other pads only if a tool such as Steam Input presents them as one.
const { spawn } = require('child_process');

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class KineticPad {
  [StructLayout(LayoutKind.Sequential)] public struct State { public uint Packet; public ushort Buttons; public byte LT; public byte RT; public short LX; public short LY; public short RX; public short RY; }
  [DllImport("xinput1_4.dll")] public static extern uint XInputGetState(uint index, out State state);
}
'@
[Console]::Out.WriteLine('ready')
$combo = 0x0030   # Menu (0x10) + View (0x20)
$heldFor = 0; $fired = $false; $s = New-Object KineticPad+State
while ($true) {
  $connected = $false; $down = $false
  foreach ($i in 0..3) {
    if ([KineticPad]::XInputGetState($i, [ref]$s) -eq 0) {
      $connected = $true
      if (($s.Buttons -band $combo) -eq $combo) { $down = $true }
    }
  }
  if ($down) {
    $heldFor += 100
    if ($heldFor -ge 700 -and -not $fired) { $fired = $true; [Console]::Out.WriteLine('combo') }
  } else { $heldFor = 0; $fired = $false }
  # checking for pads that aren't plugged in is slow, so an idle PC looks far less often
  if ($connected) { Start-Sleep -Milliseconds 100 } else { Start-Sleep -Seconds 3 }
}
`;

let child = null;

function start(onCombo, script = SCRIPT) {
  if (child) return child;
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child = proc;
  let text = '';
  proc.stdout.on('data', (d) => {
    text += d;
    const lines = text.split(/\r?\n/);
    text = lines.pop();
    if (lines.includes('combo')) onCombo();
  });
  proc.on('exit', () => { if (child === proc) child = null; });
  proc.on('error', () => { if (child === proc) child = null; });
  return proc;
}

function stop() {
  if (child) child.kill();
  child = null;
}

module.exports = { start, stop, SCRIPT };

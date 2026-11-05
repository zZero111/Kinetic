// Builds a standalone Kinetic.exe: copies only the app files into a staging folder, installs
// production dependencies there, and packages that folder with Electron into dist/.
// Usage: npm run pack
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const stage = path.join(dist, '_stage');
// no shell: paths contain spaces
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const f of ['main.js', 'preload.js', 'importers.js', 'updater.js', 'store.js', 'package-lock.json']) {
  if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(stage, f));
}
fs.cpSync(path.join(root, 'renderer'), path.join(stage, 'renderer'), { recursive: true });
fs.mkdirSync(path.join(stage, 'assets'));
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(stage, 'assets', 'icon.png'));

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2));

run(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund'], stage);

const packager = path.join(root, 'node_modules', '@electron', 'packager', 'bin', 'electron-packager.mjs');
run(process.execPath, [packager,
  stage, 'Kinetic', '--platform=win32', '--arch=x64', `--out=${dist}`, '--overwrite', '--asar',
  `--icon=${path.join(root, 'assets', 'icon.ico')}`, `--app-version=${pkg.version}`,
  `--electron-version=${require(path.join(root, 'node_modules', 'electron', 'package.json')).version}`,
], root);

fs.rmSync(stage, { recursive: true, force: true });
console.log('\nDone: dist/Kinetic-win32-x64/Kinetic.exe');
console.log('To use your portable Azimuth, put it in dist/Kinetic-win32-x64/azimuth/ (azimuth.exe + data/).');

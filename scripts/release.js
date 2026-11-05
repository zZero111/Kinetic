// Prepares a release for the in-app updater: builds the exe, then copies out the two files the updater needs.
// Usage: npm run release   (bump "version" in package.json first)
// It does NOT publish anything; it prints the command to do that.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

execFileSync(process.execPath, [path.join(__dirname, 'pack.js')], { cwd: root, stdio: 'inherit' });

const asar = path.join(root, 'dist', 'Kinetic-win32-x64', 'resources', 'app.asar');
const out = path.join(root, 'dist', 'release');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(asar, path.join(out, 'app.asar'));
const sha = crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex');
fs.writeFileSync(path.join(out, 'app.asar.sha256'), `${sha}  app.asar\n`);

console.log(`\nRelease files for v${pkg.version} are in dist/release/:`);
console.log(`  app.asar (${(fs.statSync(asar).size / 1048576).toFixed(1)} MB)`);
console.log(`  app.asar.sha256  ${sha}`);
console.log('\nPublish them as a GitHub release (tag must be the version, e.g. v' + pkg.version + '):');
console.log(`  gh release create v${pkg.version} dist/release/app.asar dist/release/app.asar.sha256 --title "Kinetic ${pkg.version}" --generate-notes`);
console.log('Or upload both files by hand on the repo\'s Releases page.');

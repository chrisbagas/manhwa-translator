// Zips dist/chrome for "Load unpacked"-free distribution (Chrome Web Store upload).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
const v = JSON.parse(readFileSync('package.json', 'utf8')).version;
mkdirSync('dist/packages', { recursive: true });
execFileSync('python3', ['-c', `import shutil; shutil.make_archive('dist/packages/dalbit-chrome-${v}', 'zip', 'dist/chrome')`], { stdio: 'inherit' });
console.log(`dist/packages/dalbit-chrome-${v}.zip`);

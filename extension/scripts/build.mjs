// Builds dist/chrome and dist/firefox from one codebase.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const base = JSON.parse(readFileSync(join(root, 'manifests/base.json'), 'utf8'));

const entries = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  popup: 'src/popup/popup.ts',
};

for (const target of ['chrome', 'firefox']) {
  const out = join(root, 'dist', target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest = { ...base, ...JSON.parse(readFileSync(join(root, `manifests/${target}.json`), 'utf8')), version: pkg.version };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  cpSync(join(root, 'assets/fonts'), join(out, 'fonts'), { recursive: true });
  cpSync(join(root, 'assets/icons'), join(out, 'icons'), { recursive: true });
  cpSync(join(root, 'src/popup/popup.html'), join(out, 'popup.html'));
  cpSync(join(root, 'src/popup/popup.css'), join(out, 'popup.css'));
  cpSync(join(root, '../LICENSE'), join(out, 'LICENSE'));
  cpSync(join(root, '../THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES.md'));
  const opts = {
    entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(root, v)])),
    outdir: out,
    bundle: true,
    format: 'iife',
    target: target === 'chrome' ? 'chrome116' : 'firefox128',
    sourcemap: false,
    minify: false, // readable output simplifies Mozilla source review
    legalComments: 'inline',
    logLevel: 'warning',
  };
  if (watch) await (await context(opts)).watch();
  else await build(opts);
  console.log(`built ${target} -> ${out}`);
}

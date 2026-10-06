#!/usr/bin/env node

/**
 * Build a self-contained Leabhar package ready for the NSIS installer.
 *
 * Steps:
 *  1. Run `next build` (produces .next/standalone/).
 *  2. Copy static assets (standalone doesn't include them).
 *  3. Copy drizzle migrations.
 *  4. Copy the launcher.
 *  5. Copy the better-sqlite3 native addon (prebuilds/ or build/Release/).
 *  6. Stage everything into dist/leabhar/app/.
 *  7. Write leabhar.bat (the thing the shortcut runs).
 *
 * Staged under an `app/` subfolder, not `dist/leabhar/` directly, so it
 * mirrors exactly what the installer extracts to on the user's machine
 * (`<install dir>\app`) — see `scripts/installer.nsi` and
 * `src/lib/paths.ts`'s "App root vs. data root" for why (issue #59): the
 * installer's uninstaller removes only that `app` subfolder, never its
 * parent, where the user's database/documents/backups live.
 *
 * Usage:  node scripts/build-package.mjs
 * Prereq:  npm ci  (so node_modules is populated)
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, '.next');
const STANDALONE = join(NEXT, 'standalone');
const DIST = join(ROOT, 'dist', 'leabhar', 'app');

function run(label, command) {
  console.log(`\n=== ${label} ===`);
  execSync(command, { stdio: 'inherit', cwd: ROOT });
}

function copy(label, src, dest, filter) {
  console.log(`  copy ${src} → ${dest}`);
  cpSync(src, dest, { recursive: true, ...(filter ? { filter } : {}) });
}

// 1. Build
run('Next.js standalone build', 'npm run build');

// 2. Copy static assets
if (!existsSync(join(NEXT, 'static'))) {
  console.error('ERROR: .next/static not found — did the build fail?');
  process.exit(1);
}
mkdirSync(join(STANDALONE, '.next'), { recursive: true });
copy('static assets', join(NEXT, 'static'), join(STANDALONE, '.next', 'static'));

// 3. Copy drizzle migrations
if (!existsSync(join(ROOT, 'drizzle'))) {
  console.error('ERROR: drizzle/ not found');
  process.exit(1);
}
copy('drizzle migrations', join(ROOT, 'drizzle'), join(STANDALONE, 'drizzle'));

// 3b. Copy the statute sources the statutory VAT rules cite (issue #200):
// the knowledge base is loaded from these files and the provision page
// re-reads them to verify their SHA-256, so they must ship with the app.
// `_inbox` holds collected reference documents (issue #218) that no rule
// loads yet; they stay out of the installer.
const INBOX = join(ROOT, 'docs', 'statutes', '_inbox');
copy('statute sources', join(ROOT, 'docs', 'statutes'), join(STANDALONE, 'docs', 'statutes'),
  (src) => src !== INBOX && !src.startsWith(INBOX + sep));
// Next's file tracing already pulled the whole statutes directory into the
// standalone output (the knowledge base reads it dynamically), `_inbox`
// included, so the filter above cannot keep it out: remove it explicitly.
rmSync(join(STANDALONE, 'docs', 'statutes', '_inbox'), { recursive: true, force: true });

// 3b'. Copy the rules catalogue (issue #443): the sources ported out of
// docs/statutes load from it, and the provision page reads its excerpts.
copy('rules catalogue', join(ROOT, 'catalogue'), join(STANDALONE, 'catalogue'));

// 3c. Copy the OCR and PDF-rendering assets the review screen serves to the
// browser (issue #202). The list mirrors OCR_ASSETS in src/lib/ocrAssets.ts;
// they are read from disk at run time, so file tracing does not pick them up.
for (const asset of [
  'node_modules/tesseract.js/dist/worker.min.js',
  'node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
]) {
  const src = join(ROOT, asset);
  if (!existsSync(src)) {
    console.error(`ERROR: OCR asset missing: ${asset}. Run \`npm ci\` first.`);
    process.exit(1);
  }
  mkdirSync(dirname(join(STANDALONE, asset)), { recursive: true });
  copy('OCR asset', src, join(STANDALONE, asset));
}

// 4. Copy the launcher
copy('launcher', join(ROOT, 'scripts', 'launcher.cjs'), join(STANDALONE, 'launcher.cjs'));

// 5. Verify and copy better-sqlite3 native addon. better-sqlite3 >= 13 ships
// per-platform binaries in `prebuilds/` (and only builds `build/Release` when
// no prebuild matches); 12.x and source builds use `build/Release`. Copy
// whichever exists: file tracing does not pick up either.
const bsqliteRoot = join(ROOT, 'node_modules', 'better-sqlite3');
const bsqliteDest = join(STANDALONE, 'node_modules', 'better-sqlite3');
const nativeDirs = ['prebuilds', join('build', 'Release')].filter((d) =>
  existsSync(join(bsqliteRoot, d)),
);
if (nativeDirs.length === 0) {
  console.error('ERROR: better-sqlite3 native addon not found (no prebuilds/ or build/Release/) in');
  console.error(`  ${bsqliteRoot}`);
  console.error('Run `npm ci` first; on an unsupported platform build it with `npm rebuild better-sqlite3 --build-from-source`.');
  process.exit(1);
}
for (const dir of nativeDirs) {
  mkdirSync(join(bsqliteDest, dir), { recursive: true });
  copy('better-sqlite3 native addon', join(bsqliteRoot, dir), join(bsqliteDest, dir));
}
if (process.platform === 'win32' && !existsSync(join(bsqliteDest, 'prebuilds', 'win32-x64.node'))
    && !existsSync(join(bsqliteDest, 'build', 'Release', 'better_sqlite3.node'))) {
  console.error('ERROR: no Windows x64 better-sqlite3 binary was staged.');
  process.exit(1);
}

// 6. Stage into dist/leabhar/app/
console.log('\n=== Stage dist ===');
if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
copy('standalone server', STANDALONE, DIST);

// 7. Write leabhar.bat (the thing the shortcut runs)
const bat = `@echo off\r
title Leabhar\r
"%~dp0node.exe" "%~dp0launcher.cjs"\r
`;
writeFileSync(join(DIST, 'leabhar.bat'), bat);

console.log(`\nDone. Package staged at: ${DIST}`);
console.log('Next: run `npm run build:installer` to produce Leabhar-Setup.exe');

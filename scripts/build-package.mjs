#!/usr/bin/env node

/**
 * Build a self-contained Leabhar package ready for the NSIS installer.
 *
 * Steps:
 *  1. Run `next build` (produces .next/standalone/).
 *  2. Copy static assets (standalone doesn't include them).
 *  3. Copy drizzle migrations.
 *  4. Copy the launcher.
 *  5. Copy the better-sqlite3 native addon (platform-specific).
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
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NEXT = join(ROOT, '.next');
const STANDALONE = join(NEXT, 'standalone');
const DIST = join(ROOT, 'dist', 'leabhar', 'app');

function run(label, command) {
  console.log(`\n=== ${label} ===`);
  execSync(command, { stdio: 'inherit', cwd: ROOT });
}

function copy(label, src, dest) {
  console.log(`  copy ${src} → ${dest}`);
  cpSync(src, dest, { recursive: true });
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
copy('statute sources', join(ROOT, 'docs', 'statutes'), join(STANDALONE, 'docs', 'statutes'));

// 4. Copy the launcher
copy('launcher', join(ROOT, 'scripts', 'launcher.cjs'), join(STANDALONE, 'launcher.cjs'));

// 5. Verify and copy better-sqlite3 native addon
const nativeAddon = join(ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release');
if (!existsSync(nativeAddon)) {
  console.error('ERROR: better-sqlite3 native addon not found at');
  console.error(`  ${nativeAddon}`);
  console.error('Run `npm ci` first, or `npm run build:native` if compilation is needed.');
  process.exit(1);
}
const bsqliteDest = join(STANDALONE, 'node_modules', 'better-sqlite3', 'build', 'Release');
mkdirSync(bsqliteDest, { recursive: true });
copy('better-sqlite3 native addon', nativeAddon, bsqliteDest);

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

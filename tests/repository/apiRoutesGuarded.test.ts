import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every API route verifies the caller against the database and applies the
 * permission matrix (issue #372): middleware runs on the Edge and can only
 * check that a session cookie exists, so the route itself must call
 * `requireApiActor(...)` (or `requireActor(...)`, which also verifies the
 * session). /api/health is the documented exception — it touches no database
 * and is polled by the launcher before any login can exist.
 */
const API = join(__dirname, '..', '..', 'src', 'app', 'api');

function routes(dir: string = API): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? routes(path) : (entry.name === 'route.ts' ? [path] : []);
  });
}

describe('API routes', () => {
  it('each verify the session and apply the role matrix', () => {
    const unguarded: string[] = [];
    for (const file of routes()) {
      if (file.endsWith(join('api', 'health', 'route.ts'))) continue;
      const source = readFileSync(file, 'utf8');
      if (!/requireApiActor\(|requireActor\(|currentUser\(/.test(source)) {
        unguarded.push(relative(join(API, '..'), file));
      }
    }
    expect(unguarded).toEqual([]);
  });

  it('exports are gated by reports.export, not a read action', () => {
    const exports = routes(join(API, 'export'));
    expect(exports.length).toBeGreaterThan(0);
    for (const file of exports) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toMatch(/requireApiActor\('reports\.export'\)|requireActor\('reports\.export'\)/);
    }
  });
});

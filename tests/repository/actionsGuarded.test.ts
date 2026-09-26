import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every mutating server action passes the permission gate (issue #298): an
 * exported action in `src/app/*actions.ts` calls `requireActor(...)` before it
 * does anything. This catches an action added after the gate was introduced
 * that forgot it; the matrix itself is tested in src/domain/auth.
 */
const APP = join(__dirname, '..', '..', 'src', 'app');

describe('server actions', () => {
  it('each call requireActor', () => {
    const unguarded: string[] = [];
    for (const file of readdirSync(APP).filter((f) => /actions\.ts$/.test(f))) {
      const source = readFileSync(join(APP, file), 'utf8');
      const starts = [...source.matchAll(/^export async function (\w+)/gm)];
      starts.forEach((match, i) => {
        const body = source.slice(match.index, starts[i + 1]?.index ?? source.length);
        if (!body.includes('requireActor(')) unguarded.push(`${file}: ${match[1]}`);
      });
    }
    expect(unguarded).toEqual([]);
  });
});

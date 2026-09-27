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

/**
 * Self-service actions that act only as the signed-in user. They cannot use
 * `requireActor` — it refuses a user still on their inviter's one-time
 * password, and clearing that password (issue #472) is exactly what the one
 * exception exists for. The session check is `currentUser()`, which verifies
 * the session against the database the same way.
 */
const SELF_SERVICE = new Set(['changeOwnPasswordAction']);

describe('server actions', () => {
  it('each call requireActor, or are a listed self-service action', () => {
    const unguarded: string[] = [];
    for (const file of readdirSync(APP).filter((f) => /actions\.ts$/.test(f))) {
      const source = readFileSync(join(APP, file), 'utf8');
      const starts = [...source.matchAll(/^export async function (\w+)/gm)];
      starts.forEach((match, i) => {
        const body = source.slice(match.index, starts[i + 1]?.index ?? source.length);
        if (body.includes('requireActor(')) return;
        if (SELF_SERVICE.has(match[1]!)) {
          if (!body.includes('currentUser(')) {
            unguarded.push(`${file}: ${match[1]} (self-service without a session check)`);
          }
          return;
        }
        unguarded.push(`${file}: ${match[1]}`);
      });
    }
    expect(unguarded).toEqual([]);
  });
});

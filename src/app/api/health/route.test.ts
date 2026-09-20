import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GET } from './route';

describe('GET /api/health', () => {
  it('returns ok status and the real package.json version, not a hardcoded string', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');

    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(body.version).toBe(pkg.version);
  });
});

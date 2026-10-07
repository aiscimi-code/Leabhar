import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { irishActProvisions } from '@/db/schema';
import { ingestRctTdm18_02_04 } from './rctIngestion';

describe('RCT TDM ingestion (issue #199)', () => {
  it('stores the TDM as an exact slice of the committed file, with offsets that point at it', () => {
    const { db } = createTestDatabase();
    const markdown = readFileSync('src/domain/rules/__fixtures__/tdm-18-02-04-excerpt.md', 'utf8');
    const { sourceId } = ingestRctTdm18_02_04(db, { markdown, ingestVersion: 'test' });
    const p = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, sourceId)).get()!;
    expect(markdown.slice(p.sourceStart!, p.sourceEnd!)).toBe(p.provisionText);
  });

  it('refuses a statute file handed to the TDM path', () => {
    const { db } = createTestDatabase();
    const markdown = readFileSync('src/domain/rules/__fixtures__/tca-1997-s530-excerpt.md', 'utf8');
    expect(() => ingestRctTdm18_02_04(db, { markdown, ingestVersion: 'test' })).toThrow(/not Revenue TDM Part 18-02-04/);
  });
});

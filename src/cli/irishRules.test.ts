import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { irishKnowledgeSources, irishActProvisions } from '@/db/schema';
import { main } from './irishRules';

afterEach(() => vi.restoreAllMocks());

describe('rules CLI: ingest --source finance-act-2025 (issue #205)', () => {
  it('ingests the enacted Act from docs/statutes, keeping the s.46 rate sections relevant', async () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Cli Ltd', seedYears: [2025] });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(await main(['ingest', '--source', 'finance-act-2025'], { db, companyId })).toBe(0);
    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.citation, '2025 Act 18')).get()!;
    expect(source.localPath).toMatch(/docs\/statutes\/finance-act-2025\/2025-act-18-enacted\.md$/);
    const s71 = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, source.id)).all()
      .find((p) => p.sectionNumber === '71')!;
    expect(s71.relevant).toBe(true);
    expect(s71.provisionText).toContain('paragraphs 3(1), 3(3) and 13(3) of Schedule 3');
  });
});

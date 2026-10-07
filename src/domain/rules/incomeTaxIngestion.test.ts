import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishActProvisions, irishKnowledgeSources } from '@/db/schema';
import { ingestSwcaFromCatalogue, swcaCatalogueEntry, SWCA_SECTIONS } from './incomeTaxIngestion';
import { readCatalogueEntry } from './catalogue';
import { INCOME_TAX_CURATED_RULES, SWCA_S21_CITATION } from './incomeTaxCuration';
import { SWMPA_2024_CITATION } from './payrollCuration';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Class S Ltd', seedYears: [2025] }));
});

describe('ingestSwcaFromCatalogue (#556)', () => {
  it('loads each SWCA section from its entry, one source and one provision each, and is idempotent', () => {
    const first = ingestSwcaFromCatalogue(db, { companyId });
    expect(first.map((s) => [s.sectionNumber, s.ingested, s.provisionCount])).toEqual(SWCA_SECTIONS.map((n) => [n, true, 1]));
    expect(ingestSwcaFromCatalogue(db, { companyId }).every((s) => !s.ingested)).toBe(true);

    for (const { sectionNumber, sourceId } of first) {
      const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, sourceId)).get()!;
      expect(source.citation).toBe(`SWCA 2005 s.${sectionNumber}`);
      // The revised text is current law on the day it was fetched, not a commencement.
      expect(source.effectiveFrom).toBe('2026-09-25');
      const [provision] = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, sourceId)).all();
      expect(provision!.sectionNumber).toBe(sectionNumber);
      expect(provision!.category).toBe('income_tax');
    }
  });

  it('the €650 minimum quotes s.21 verbatim; the rate quotes the 2024 Act, never the revised text (#711)', () => {
    const excerpt = readCatalogueEntry(swcaCatalogueEntry('21')).provisions[0]!.excerpt;
    const s21 = INCOME_TAX_CURATED_RULES.filter((r) => r.citation === SWCA_S21_CITATION);
    expect(s21.map((r) => [r.ruleKey, r.effectiveFrom])).toEqual([['prsi.class_s_minimum', '2024-10-01']]);
    expect(excerpt).toContain(s21[0]!.statementExcerpt);
    const rate = INCOME_TAX_CURATED_RULES.filter((r) => r.ruleKey === 'prsi.class_s_rate');
    expect(rate.map((r) => [r.citation, r.effectiveFrom, r.effectiveTo, r.numericValue])).toEqual([
      [SWMPA_2024_CITATION, '2024-10-01', '2025-10-01', 410],
      [SWMPA_2024_CITATION, '2025-10-01', '2026-10-01', 420],
      [SWMPA_2024_CITATION, '2026-10-01', '2027-10-01', 435],
      [SWMPA_2024_CITATION, '2027-10-01', '2028-10-01', 450],
      [SWMPA_2024_CITATION, '2028-10-01', null, 470],
    ]);
  });
});

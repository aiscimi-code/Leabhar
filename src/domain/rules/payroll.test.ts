import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules, irishActProvisions, irishKnowledgeSources } from '@/db/schema';
import { deriveStatutoryKnowledgeBase, verifyStatuteFile } from './knowledgeBase';
import { derivePayrollRules, PAYROLL_SLICED_SOURCES } from './payrollIngestion';
import { SIZE_CRITERIA_SLICED_SOURCE } from './sizeCriteriaCuration';
import { PAYROLL_CURATED_RULES } from './payrollCuration';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const rows = (ruleKey: string) => db.select().from(irishTaxRules)
  .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, ruleKey))).all()
  .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Payroll Ltd', vatRegistrationStatus: 'registered', seedYears: [2026] }));
  deriveStatutoryKnowledgeBase(db, { companyId });
});

describe('payroll rules (issue #526)', () => {
  it('derives every curated rule from its source text, unapproved', () => {
    expect(derivePayrollRules(db, { companyId })).toMatchObject({
      created: 0, unchanged: PAYROLL_CURATED_RULES.length, skippedNoProvision: [],
    });
    for (const rule of PAYROLL_CURATED_RULES) {
      const row = rows(rule.ruleKey).find((r) => r.effectiveFrom === rule.effectiveFrom)!;
      expect(row.statement, rule.ruleKey).toBe(rule.statementExcerpt);
      expect(row.reviewStatus).toBe('ai_extracted');
    }
  });

  it('chains the employee rate through the 2024 Act\'s five October substitutions, the latest active', () => {
    const versions = rows('prsi.class_a_employee_rate');
    expect(versions.map((v) => [v.effectiveFrom, v.numericValue])).toEqual([
      ['2024-10-01', 410], ['2025-10-01', 420], ['2026-10-01', 435], ['2027-10-01', 450], ['2028-10-01', 470],
    ]);
    expect(versions.map((v) => v.active)).toEqual([false, false, false, false, true]);
  });

  it('dates the employer threshold from each Act\'s own commencement', () => {
    expect(rows('prsi.class_a_employer_threshold').map((v) => [v.effectiveFrom, v.effectiveTo, v.numericValue])).toEqual([
      ['2025-01-01', '2026-01-01', 52_700], ['2026-01-01', null, 55_200],
    ]);
  });

  it('holds each sliced source from its catalogue entry, cut where the statute copy was cut (#717)', () => {
    for (const source of [...PAYROLL_SLICED_SOURCES, SIZE_CRITERIA_SLICED_SOURCE]) {
      const src = db.select().from(irishKnowledgeSources)
        .where(eq(irishKnowledgeSources.localPath, `catalogue/${source.entry}.json`)).get()!;
      const provisions = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, src.id)).all();
      expect(provisions.map((p) => p.sectionNumber).sort(), source.entry).toEqual(source.provisions.map((p) => p.sectionNumber).sort());
      for (const p of provisions) {
        const slice = source.provisions.find((s) => s.sectionNumber === p.sectionNumber)!;
        const flat = (t: string) => t.replace(/\s+/g, ' ');
        expect(flat(p.provisionText!).startsWith(flat(slice.start)), `${source.entry} ${p.sectionNumber}`).toBe(true);
        // The next provision's heading is where the slice stops, not part of it.
        if (slice.end) expect(flat(p.provisionText!).includes(flat(slice.end)), `${source.entry} ${p.sectionNumber}`).toBe(false);
        const check = verifyStatuteFile(src.localPath, src.sha256, null, null, undefined, p.sectionNumber);
        expect(check.sha256Matches && check.slice === p.provisionText, `${source.entry} ${p.sectionNumber}`).toBe(true);
      }
    }
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules, irishActProvisions, irishKnowledgeSources } from '@/db/schema';
import { loadStatutoryKnowledgeBase, verifyStatuteFile } from './knowledgeBase';
import { derivePayrollRules, PAYROLL_SOURCES } from './payrollIngestion';
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
  loadStatutoryKnowledgeBase(db, { companyId });
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

  it('stores each provision as an exact, re-checkable slice of its committed file', () => {
    for (const source of PAYROLL_SOURCES) {
      const text = readFileSync(source.path, 'utf8');
      const src = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.localPath, source.path)).get()!;
      const provisions = db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, src.id)).all();
      expect(provisions).toHaveLength(source.provisions.length);
      for (const p of provisions) {
        const check = verifyStatuteFile(source.path, src.sha256, p.sourceStart, p.sourceEnd);
        expect(check.sha256Matches).toBe(true);
        expect(check.slice).toBe(p.provisionText);
        expect(text.includes(p.provisionText!)).toBe(true);
      }
    }
  });
});

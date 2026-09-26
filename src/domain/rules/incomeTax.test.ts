import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { deriveIncomeTaxRules } from './incomeTaxIngestion';
import { deriveTaxRules, RETIRED_FINANCE_ACT_2024_RULE_KEYS } from './irishRules';
import { INCOME_TAX_CURATED_RULES } from './incomeTaxCuration';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const rows = (ruleKey: string) => db.select().from(irishTaxRules)
  .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, ruleKey))).all()
  .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'IT Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  loadStatutoryKnowledgeBase(db, { companyId });
});

describe('income tax, USC and PRSI rules (issue #212)', () => {
  it('derives every curated rule from its source text, unapproved', () => {
    expect(deriveIncomeTaxRules(db, { companyId })).toMatchObject({
      created: 0, unchanged: INCOME_TAX_CURATED_RULES.length, skippedNoProvision: [],
    });
    for (const rule of INCOME_TAX_CURATED_RULES) {
      const row = rows(rule.ruleKey).find((r) => r.effectiveFrom === rule.effectiveFrom)!;
      expect(row.statement, rule.ruleKey).toBe(rule.statementExcerpt);
      expect(row.reviewStatus).toBe('ai_extracted');
    }
  });

  it('chains the USC 2% band from the 2025 figure to the 2026 one, the later active', () => {
    const [y2025, y2026] = rows('usc.band_2pct');
    expect([y2025!.numericValue, y2025!.effectiveTo, y2025!.active]).toEqual([1_537_000, '2026-01-01', false]);
    expect([y2026!.numericValue, y2026!.effectiveTo, y2026!.active, y2026!.supersedesRuleId]).toEqual([1_668_800, null, true, y2025!.id]);
  });

  it('retires the Finance Act 2024 keys that misnamed their figures (issue #199)', () => {
    const [oldKey] = RETIRED_FINANCE_ACT_2024_RULE_KEYS;
    const current = rows('usc.medical_card_2pct_threshold')[0]!;
    db.insert(irishTaxRules).values({ ...current, id: 'rule_old_usc', ruleKey: oldKey!, active: true }).run();
    deriveTaxRules(db, { companyId });
    const retired = rows(oldKey!)[0]!;
    expect([retired.active, retired.effectiveTo]).toEqual([false, retired.effectiveFrom]);
    expect(rows('income_tax.second_earner_band_increase_max')[0]!.numericValue).toBe(3_500_000);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { deriveCuratedRuleFamilies } from './incomeTaxIngestion';
import { CAR_EMISSIONS_CURATED_RULES } from './carEmissionsCuration';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Cars Ltd', vatRegistrationStatus: 'registered', seedYears: [2026] }));
  deriveStatutoryKnowledgeBase(db, { companyId });
});

describe('car emissions rules (TCA Part 11C; issue #466)', () => {
  it('derives every rule from its source text', () => {
    expect(deriveCuratedRuleFamilies(db, { companyId, rules: CAR_EMISSIONS_CURATED_RULES, label: 'capital allowances' }))
      .toMatchObject({ created: 0, unchanged: CAR_EMISSIONS_CURATED_RULES.length, skippedNoProvision: [] });
  });

  it('dates the group 1 boundary from the 2008, 2021 and 2027 schemes', () => {
    const rows = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'car.co2_group1_max'))).all()
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    expect(rows.map((r) => [r.effectiveFrom, r.effectiveTo, r.numericValue])).toEqual([
      ['2008-07-01', '2021-01-01', 155], ['2021-01-01', '2027-01-01', 140], ['2027-01-01', null, 120],
    ]);
  });
});

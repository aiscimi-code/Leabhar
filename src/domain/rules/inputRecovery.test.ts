import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { deriveVatScopeRules } from './vatScopeIngestion';
import { suggestFromFacts, type SuggestionFacts } from './vatSuggestion';
import { qualifyingVehicleClawback } from './inputRecoveryCuration';
import type { AppDatabase } from '@/db';

/** Issue #209 part 1: input VAT recovery from the revised ss.59-62. */

let db: AppDatabase;
let companyId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Recover Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] }));
  loadStatutoryKnowledgeBase(db, { companyId });
});

const suggest = (description: string) => {
  const facts: SuggestionFacts = {
    transactionDate: '2026-03-01', amountMinor: 10_000, currency: 'EUR', description, vatRegistered: true,
    direction: 'purchase', counterpartyCountry: 'IE', invoiceAvailable: true,
  };
  return suggestFromFacts(db, { companyId, subjectId: 'line', facts, factSources: {}, bookedTreatmentId: null });
};
const keys = (s: ReturnType<typeof suggest>) => [s.decidingRule, ...s.supportingRules].map((r) => r?.ruleKey);

describe('s.60(2)(a), exactly as listed', () => {
  it('petrol is blocked (v)', () => {
    const s = suggest('Unleaded petrol, 40 litres');
    expect(s.decidingRule?.ruleKey).toBe('vat.blocked_petrol');
    expect(s.treatment?.code).toBe('NON_DEDUCTIBLE');
  });

  it('diesel is not blocked: s.60 does not list it', () => {
    const s = suggest('Diesel, 60 litres');
    expect(keys(s)).not.toContain('vat.blocked_petrol');
    expect(s.treatment?.code).not.toBe('NON_DEDUCTIBLE');
    expect(keys(s)).toContain('vat.input_deduction_taxable_use');
  });

  it('food and accommodation (i), entertainment (iii)', () => {
    expect(suggest('Hotel accommodation, Cork, 2 nights').decidingRule?.ruleKey).toBe('vat.blocked_food_drink_accommodation');
    expect(suggest('Client entertainment evening').decidingRule?.ruleKey).toBe('vat.blocked_entertainment');
  });

  it('a car lease is blocked (iv), and the qualifying-vehicle 20% case is named, nothing pre-decided beyond it', () => {
    const s = suggest('Car lease, March');
    expect(s.decidingRule?.ruleKey).toBe('vat.blocked_motor_vehicle');
    expect(s.treatment?.code).toBe('NON_DEDUCTIBLE');
    expect(s.reviewReasons.join(' ')).toMatch(/qualifying vehicle.*20%/);
  });

  it('a van is not a motor vehicle here, and petrol for a company car is petrol, not a car', () => {
    expect(keys(suggest('Van lease, March'))).not.toContain('vat.blocked_motor_vehicle');
    expect(keys(suggest('Petrol for company car'))).not.toContain('vat.blocked_motor_vehicle');
  });

  it('a blocked cost does not also carry the general deduction', () => {
    expect(keys(suggest('Unleaded petrol'))).not.toContain('vat.input_deduction_taxable_use');
  });
});

describe('s.62: a qualifying vehicle disposed of within two years', () => {
  it('TD x (4 - N) / 4, N the complete 182-day periods held', () => {
    expect(qualifyingVehicleClawback({ taxDeductedMinor: 200_000, acquiredOn: '2026-01-01', eventOn: '2026-05-01' })).toEqual({ n: 0, reductionMinor: 200_000 });
    expect(qualifyingVehicleClawback({ taxDeductedMinor: 200_000, acquiredOn: '2026-01-01', eventOn: '2026-09-01' })).toEqual({ n: 1, reductionMinor: 150_000 });
    expect(qualifyingVehicleClawback({ taxDeductedMinor: 200_000, acquiredOn: '2026-01-01', eventOn: '2028-06-01' })).toEqual({ n: 4, reductionMinor: 0 });
  });
});

describe('the as-enacted s.59/s.60 rules are retired, not deleted', () => {
  it('a stored row from an older install gets an empty window', () => {
    const any = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).get()!;
    db.insert(irishTaxRules).values({
      ...any, id: 'rule_old_s60', ruleKey: 'vat.deduction_exclusions_entertainment', effectiveFrom: '2010-11-01', effectiveTo: null, active: true,
    }).run();
    deriveVatScopeRules(db, { companyId });
    const row = db.select().from(irishTaxRules).where(and(eq(irishTaxRules.id, 'rule_old_s60'))).get()!;
    expect(row).toMatchObject({ effectiveTo: '2010-11-01', active: false });
  });
});

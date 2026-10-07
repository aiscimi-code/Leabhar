import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { deriveVatScopeRules, quotedAsEnacted } from './vatScopeIngestion';
import { suggestFromFacts, type SuggestionFacts } from './vatSuggestion';
import { qualifyingVehicleClawback } from './inputRecoveryCuration';
import type { AppDatabase } from '@/db';

/** Issue #209 part 1: input VAT recovery from the revised ss.59-62. */

let db: AppDatabase;
let companyId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Recover Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] }));
  deriveStatutoryKnowledgeBase(db, { companyId });
});

const suggest = (description: string) => {
  const facts: SuggestionFacts = {
    transactionDate: '2026-03-01', amountMinor: 10_000, currency: 'EUR', description, vatRegistered: true,
    direction: 'purchase', counterpartyCountry: 'IE', invoiceAvailable: true,
  };
  return suggestFromFacts(db, { companyId, subjectId: 'line', facts, factSources: {}, bookedTreatmentId: null });
};
const keys = (s: ReturnType<typeof suggest>) => [s.decidingRule, ...s.supportingRules].map((r) => r?.ruleKey);

// A block denies the deduction beside the treatment; it never replaces it (issue #616).
describe('s.60(2)(a), exactly as listed', () => {
  it('petrol is blocked (v)', () => {
    const s = suggest('Unleaded petrol, 40 litres');
    expect(s.deductionBlocked?.ruleKey).toBe('vat.blocked_petrol');
    expect(s.treatment?.code).toBe('IE_STD');
    expect(s.reviewReasons.join(' ')).toMatch(/not deductible, so none of it is claimed in T2/);
  });

  it('diesel is not blocked: s.60 does not list it', () => {
    const s = suggest('Diesel, 60 litres');
    expect(keys(s)).not.toContain('vat.blocked_petrol');
    expect(s.deductionBlocked).toBeNull();
    expect(keys(s)).toContain('vat.input_deduction_taxable_use');
  });

  it('food and accommodation (i), entertainment (iii)', () => {
    expect(suggest('Hotel accommodation, Cork, 2 nights').deductionBlocked?.ruleKey).toBe('vat.blocked_food_drink_accommodation');
    expect(suggest('Client entertainment evening').deductionBlocked?.ruleKey).toBe('vat.blocked_entertainment');
  });

  it('a car lease is blocked (iv), and the qualifying-vehicle 20% case is named, nothing pre-decided beyond it', () => {
    const s = suggest('Car lease, March');
    expect(s.deductionBlocked?.ruleKey).toBe('vat.blocked_motor_vehicle');
    expect(s.treatment?.code).not.toBe('NON_DEDUCTIBLE');
    expect(s.reviewReasons.join(' ')).toMatch(/qualifying vehicle.*20%/);
  });

  it('accommodation keeps the rate Schedule 3 gives it: the block is not a rate (issue #616)', () => {
    const s = suggest('Hotel accommodation, Cork, 2 nights');
    expect(s.decidingRule?.ruleKey).toBe('vat.reduced_rate_holiday_accommodation');
    expect(s.treatment?.code).not.toBe('NON_DEDUCTIBLE');
  });

  it('a car leased from a lessor established in another Member State: the s.12 reverse charge stands (issue #616)', () => {
    const facts: SuggestionFacts = {
      transactionDate: '2026-03-01', amountMinor: 50_000, currency: 'EUR', description: 'Car leasing, March', vatRegistered: true,
      direction: 'purchase', counterpartyCountry: 'DE', supplierCountry: 'DE', supplierEstablishedOutsideState: true,
      invoiceAvailable: true, supplyType: 'services',
    };
    const s = suggestFromFacts(db, { companyId, subjectId: 'line', facts, factSources: {}, bookedTreatmentId: null });
    expect(s.treatment?.code).toBe('EU_SERVICES_RCV');
    expect(s.decidingRule?.ruleKey).toBe('vat.reverse_charge_services_from_abroad');
    expect(s.deductionBlocked?.ruleKey).toBe('vat.blocked_motor_vehicle');
  });

  it('a sale is never blocked: s.60 is about deducting input VAT', () => {
    const facts: SuggestionFacts = {
      transactionDate: '2026-03-01', amountMinor: 10_000, currency: 'EUR', description: 'Unleaded petrol', vatRegistered: true,
      direction: 'sale', counterpartyCountry: 'IE', invoiceAvailable: true,
    };
    expect(suggestFromFacts(db, { companyId, subjectId: 'line', facts, factSources: {}, bookedTreatmentId: null }).deductionBlocked).toBeNull();
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

describe('s.60(2)(a)(i) over time (#691)', () => {
  const on = (transactionDate: string, description: string) => suggestFromFacts(db, {
    companyId, subjectId: 'line', factSources: {}, bookedTreatmentId: null,
    facts: { transactionDate, amountMinor: 10_000, currency: 'EUR', description, vatRegistered: true,
      direction: 'purchase', counterpartyCountry: 'IE', invoiceAvailable: true },
  });

  it('blocks food, drink and accommodation from 1 November 2010, across the 2024 substitution of the subparagraph', () => {
    for (const date of ['2010-11-01', '2023-06-01', '2024-11-11', '2024-11-12', '2026-03-01']) {
      for (const description of ['Hotel accommodation, Cork, 2 nights', 'Staff lunch, restaurant']) {
        expect(on(date, description).deductionBlocked?.ruleKey, `${date} ${description}`).toBe('vat.blocked_food_drink_accommodation');
      }
    }
  });

  it('is dated from the Act, not the F148 substitution, because its quoted words are in the Act as enacted', () => {
    const rows = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.blocked_food_drink_accommodation'))).all()
      .filter((r) => r.effectiveTo !== r.effectiveFrom);
    expect(rows.map((r) => [r.effectiveFrom, r.effectiveTo, r.active])).toEqual([['2010-11-01', null, true]]);
    expect(quotedAsEnacted(db, { sectionNumber: '60', statementExcerpt: rows[0]!.statement! })).toBe(true);
  });

  it('checks the claim: words s.81 changed are not in the Act as enacted', () => {
    expect(quotedAsEnacted(db, { sectionNumber: '60',
      statementExcerpt: 'being the provision of food or drink, or accommodation, or other personal services' })).toBe(false);
  });
});

describe('rules whose quoted words stand as enacted keep their 2010 start (#695)', () => {
  const window = (ruleKey: string) => db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, ruleKey))).all()
    .filter((r) => r.effectiveTo !== r.effectiveFrom)
    .map((r) => [r.effectiveFrom, r.effectiveTo]);

  it.each([
    ['vat.invoice_prescribed_particulars', '66'],
    ['vat.flat_rate_farmer_purchase', '86'],
  ])('%s is in force from 1 November 2010, its quote checked against enacted s.%s', (ruleKey, section) => {
    expect(window(ruleKey)).toEqual([['2010-11-01', null]]);
    const statement = db.select().from(irishTaxRules).where(eq(irishTaxRules.ruleKey, ruleKey)).get()!.statement!;
    expect(quotedAsEnacted(db, { sectionNumber: section, statementExcerpt: statement })).toBe(true);
  });

  it.each([
    ['vat.place_of_supply_event_admission', '2011-01-01'],
    ['vat.dual_use_apportionment', '2016-12-25'],
    ['vat.self_supply_immovable_goods_private_use', '2011-01-01'],
    ['vat.place_of_supply_electronic_services_consumers', '2015-01-01'],
  ])('%s quotes inserted or replaced words, so it starts on %s', (ruleKey, from) => {
    expect(window(ruleKey)).toEqual([[from, null]]);
  });
});


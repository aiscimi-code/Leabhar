import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH } from './irishRules';
import { ingestVatca2010, deriveVatcaRules, VATCA_2010_MD_PATH } from './vatcaIngestion';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules, VATCA_REVISED_S046_MD_PATH } from './vatcaRevisedIngestion';
import {
  ingestVatcaSchedule, deriveVatcaScheduleRules, VATCA_SCHEDULE_2_MD_PATH, VATCA_SCHEDULE_3_MD_PATH,
} from './vatcaScheduleIngestion';
import { lookupTransactionRules, identifyTopics } from './transactionLookup';
import { irishTaxRules } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const financeActMd = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
const vatcaMd = readFileSync(VATCA_2010_MD_PATH, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Lookup Ltd', seedYears: [2025] }));
  ingestFinanceAct2024(db, { companyId, markdown: financeActMd, ingestVersion: 'v1' });
  deriveTaxRules(db, { companyId });
  ingestVatca2010(db, { companyId, markdown: vatcaMd, ingestVersion: 'v1' });
  deriveVatcaRules(db, { companyId });
});

describe('identifyTopics', () => {
  it('routes a non-Irish digital-service supplier to the vat topic', () => {
    const topics = identifyTopics({
      transactionDate: '2026-09-18', amountMinor: 1230,
      supplierCountry: 'US', supplierType: 'software_service', transactionType: 'AI_SaaS',
    });
    expect(topics).toContain('vat');
    expect(topics).toContain('business_expense');
  });

  it('routes a bank narrative to the banking topic', () => {
    const topics = identifyTopics({ transactionDate: '2026-09-18', amountMinor: 1000, description: 'REVOLUT bank charge' });
    expect(topics).toContain('banking');
  });

  it('routes a personal-use transaction to director_transaction', () => {
    const topics = identifyTopics({
      transactionDate: '2026-09-18', amountMinor: 4750,
      description: 'Personal purchase charged to business account', businessUsePercent: 0,
    });
    expect(topics).toContain('director_transaction');
  });
});

describe('lookupTransactionRules — task example scenarios', () => {
  it('a Revolut bank charge: resolves the general VATCA input-deduction rule, still flags review', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 1000, currency: 'EUR',
        entityType: 'Irish_LTD', vatRegistered: true,
        transactionType: 'bank_charge', description: 'REVOLUT bank charge',
        supplyType: 'services', businessUsePercent: 100, invoiceAvailable: true,
      },
    });
    expect(result.identifiedTopics).toEqual(expect.arrayContaining(['banking', 'business_expense', 'vat']));
    expect(result.applicableRules.map((r) => r.ruleKey)).toContain('vat.input_deduction_general');
    // Still not authoritative: every VATCA rule here is ai_extracted, unreviewed.
    expect(result.reviewRequired).toBe(true);
    // No entertainment/food/motor-vehicle exclusion (VATCA s.60) fires for a bank charge.
    expect(result.applicableRules.map((r) => r.ruleKey)).not.toContain('vat.deduction_exclusions_entertainment');
  });

  it('an AI SaaS charge from a US supplier: resolves the reverse-charge and place-of-supply rules', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        entityType: 'Irish_LTD', vatRegistered: true,
        supplierCountry: 'US', supplierType: 'software_service', transactionType: 'AI_SaaS',
        supplyType: 'services', businessUsePercent: 100, invoiceAvailable: true,
      },
    });
    expect(result.identifiedTopics).toContain('vat');
    const keys = result.applicableRules.map((r) => r.ruleKey);
    expect(keys).toContain('vat.reverse_charge_services_from_abroad');
    expect(keys).toContain('vat.place_of_supply_b2b_general');
    expect(keys).toContain('vat.input_deduction_general');
    // Still flagged: every VATCA rule is ai_extracted and s.34/s.59 carry exceptions this system does not evaluate.
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/not yet human-approved/);
  });

  it('the same AI SaaS charge with no supplyType given: reverse charge is unresolved, not silently assumed', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        entityType: 'Irish_LTD', vatRegistered: true,
        supplierCountry: 'US', supplierType: 'software_service', transactionType: 'AI_SaaS',
        businessUsePercent: 100, invoiceAvailable: true, // supplyType omitted
      },
    });
    expect(result.applicableRules.map((r) => r.ruleKey)).not.toContain('vat.reverse_charge_services_from_abroad');
    expect(result.unresolvedFields).toContain('supplyType');
  });

  it('a personal purchase charged to the business account: flags director_transaction, requires review', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 4750, currency: 'EUR',
        entityType: 'Irish_LTD', vatRegistered: true,
        transactionType: 'card_payment', description: 'Personal purchase charged to business account',
        businessUsePercent: 0, invoiceAvailable: false,
      },
    });
    expect(result.identifiedTopics).toContain('director_transaction');
    const keys = result.applicableRules.map((r) => r.ruleKey);
    // Only the foundational "VAT is chargeable" declaration applies (it has no
    // conditions); the deductibility rule does NOT — no invoice and 0% business
    // use both fail its conditions — so no deduction is invented for this spend.
    expect(keys).toEqual(['vat.charge_general']);
    expect(keys).not.toContain('vat.input_deduction_general');
    expect(result.reviewRequired).toBe(true);
  });
});

describe('lookupTransactionRules — positive/negative/exception/boundary/effective-date', () => {
  it('positive: a payroll transaction on the rule\'s effective date resolves the USC threshold', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: '2025-01-01', amountMinor: 100000, transactionType: 'payroll', description: 'monthly salary' },
    });
    const usc = result.applicableRules.find((r) => r.ruleKey === 'usc.first_band_threshold');
    expect(usc).toBeDefined();
    expect(usc!.effect.tax).toContain('€27,382');
    expect(usc!.citation.sectionNumber).toBe('2');
    expect(usc!.citation.citation).toBe('2024 Act 43');
  });

  it('negative: a transaction with no matching topic keyword surfaces no candidate at all', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: '2025-06-01', amountMinor: 500, transactionType: 'office_supplies', description: 'Stationery order' },
    });
    expect(result.applicableRules.find((r) => r.ruleKey === 'usc.first_band_threshold')).toBeUndefined();
    expect(result.applicableRules.find((r) => r.ruleKey === 'income_tax.standard_rate_threshold')).toBeUndefined();
  });

  it('exception: a rule with a stated exception is never silently applied — it is flagged for review', () => {
    // No extracted rule currently carries a structured exception (the extractor
    // does not yet parse exception clauses), so this asserts the *mechanism*:
    // seed one directly and confirm the lookup surfaces it rather than ignoring it.
    const rule = db.select().from(irishTaxRules)
      .where(eq(irishTaxRules.ruleKey, 'usc.first_band_threshold')).get()!;
    db.update(irishTaxRules)
      .set({ exceptions: [{ condition: 'medical card holders', effect: 'reduced rate applies instead' }] })
      .where(eq(irishTaxRules.id, rule.id)).run();

    const result = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: '2025-06-01', amountMinor: 100000, transactionType: 'payroll' },
    });
    const usc = result.applicableRules.find((r) => r.ruleKey === 'usc.first_band_threshold')!;
    expect(usc.exceptions).toHaveLength(1);
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/exception/);
  });

  it('boundary: the day before and the day of the effective date give different answers', () => {
    const dayBefore = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: '2024-12-31', amountMinor: 100000, transactionType: 'payroll' },
    });
    const dayOf = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: '2025-01-01', amountMinor: 100000, transactionType: 'payroll' },
    });
    expect(dayBefore.applicableRules.find((r) => r.ruleKey === 'usc.first_band_threshold')).toBeUndefined();
    expect(dayOf.applicableRules.find((r) => r.ruleKey === 'usc.first_band_threshold')).toBeDefined();
  });

  it('effective-date: a long-past historical transaction resolves against no rule from this Act', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: '2010-01-01', amountMinor: 100000, transactionType: 'payroll' },
    });
    expect(result.applicableRules.find((r) => r.ruleKey === 'usc.first_band_threshold')).toBeUndefined();
  });
});

describe('lookupTransactionRules — issue #136 data-quality gates', () => {
  it('rejects a non-ISO transactionDate instead of opening every in-force rule', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: 'not-a-date', amountMinor: 100000, transactionType: 'payroll' },
    });
    expect(result.applicableRules).toEqual([]);
    expect(result.unresolvedFields).toContain('transactionDate');
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/not a valid ISO date/);
  });

  it('rejects a negative amountMinor instead of attaching VAT rate/deduction rules', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: -500, currency: 'EUR',
        vatRegistered: true, supplyType: 'services',
      },
    });
    expect(result.applicableRules).toEqual([]);
    expect(result.unresolvedFields).toContain('amountMinor');
    expect(result.reviewRequired).toBe(true);
  });

  it('does not silently default an omitted currency to EUR', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: '2026-09-18', amountMinor: 1000, transactionType: 'payroll' },
    });
    expect(result.transactionContext.currency).toBeUndefined();
  });

  it('describes the KB from the actual ingested citations, not a hardcoded copy', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: { transactionDate: '2025-06-01', amountMinor: 500, transactionType: 'office_supplies', description: 'Stationery order' },
    });
    expect(result.applicableRules).toEqual([]);
    const reasons = result.reviewReasons.join(' ');
    expect(reasons).not.toMatch(/Finance Act 2024 only/);
    expect(reasons).toMatch(/currently ingesting/);
  });

  it('does not route a retail/EV "charge" narrative to the banking topic', () => {
    const topics = identifyTopics({
      transactionDate: '2026-09-18', amountMinor: 500,
      description: 'EV charging point service charge',
    });
    expect(topics).not.toContain('banking');
  });

  it('still routes an actual bank fee (no literal "bank") to the banking topic via ATM/overdraft terms', () => {
    const topics = identifyTopics({
      transactionDate: '2026-09-18', amountMinor: 500,
      description: 'ATM withdrawal fee',
    });
    expect(topics).toContain('banking');
  });
});

describe('lookupTransactionRules — issue #136 bug 4 / issue #138: supplier establishment', () => {
  it('an invalid/garbage supplierCountry does not proxy as "established outside the State"', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', supplierCountry: 'XX',
        supplierType: 'software_service', transactionType: 'AI_SaaS',
      },
    });
    expect(result.applicableRules.map((r) => r.ruleKey)).not.toContain('vat.reverse_charge_services_from_abroad');
    expect(result.unresolvedFields).toContain('supplierEstablishedOutsideStateResolved');
    expect(result.transactionContext.supplierCountry).toBeNull();
  });

  it('a valid non-Irish ISO code still resolves the reverse-charge rule via the country-code proxy', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', supplierCountry: 'us',
        supplierType: 'software_service', transactionType: 'AI_SaaS',
      },
    });
    expect(result.applicableRules.map((r) => r.ruleKey)).toContain('vat.reverse_charge_services_from_abroad');
    expect(result.transactionContext.supplierCountry).toBe('US');
  });

  it('an explicit supplierEstablishedOutsideState overrides an "IE" country code', () => {
    // e.g. a supplier that invoices from an Irish address but is actually
    // established abroad — the crude country-code proxy would say "no reverse
    // charge"; a direct determination should still trigger it.
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', supplierCountry: 'IE',
        supplierEstablishedOutsideState: true,
      },
    });
    expect(result.applicableRules.map((r) => r.ruleKey)).toContain('vat.reverse_charge_services_from_abroad');
  });

  it('an explicit supplierEstablishedOutsideState: false overrides a non-Irish country code', () => {
    // e.g. a supplier invoicing from abroad but actually established in Ireland.
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', supplierCountry: 'US',
        supplierEstablishedOutsideState: false,
      },
    });
    expect(result.applicableRules.map((r) => r.ruleKey)).not.toContain('vat.reverse_charge_services_from_abroad');
  });
});

describe('lookupTransactionRules — issue #136 bugs 1 and 8: VAT rate exclusivity', () => {
  const s46Md = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');
  const schedule2Md = readFileSync(VATCA_SCHEDULE_2_MD_PATH, 'utf8');
  const schedule3Md = readFileSync(VATCA_SCHEDULE_3_MD_PATH, 'utf8');

  beforeEach(() => {
    ingestVatcaRevisedSection(db, { companyId, markdown: s46Md, ingestVersion: 'v1' });
    deriveVatcaRevisedRules(db, { companyId });
    ingestVatcaSchedule(db, { companyId, scheduleNumber: '2', markdown: schedule2Md, ingestVersion: 'v1' });
    ingestVatcaSchedule(db, { companyId, scheduleNumber: '3', markdown: schedule3Md, ingestVersion: 'v1' });
    deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '2' });
    deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '3' });
  });

  it('a domestic professional-services invoice gets only the standard rate, not 23%+13.5%+4.8% at once', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 100000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', description: 'Legal advisory services',
      },
    });
    const rateKeys = result.applicableRules
      .filter((r) => r.topic === 'vat' && r.ruleType === 'rate')
      .map((r) => r.ruleKey);
    expect(rateKeys).toEqual(['vat.rate_standard_current']);
  });

  it('a US SaaS reverse-charge invoice gets only the standard rate among VAT rate rules', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', supplierCountry: 'US',
        supplierType: 'software_service', transactionType: 'AI_SaaS',
      },
    });
    const rateKeys = result.applicableRules
      .filter((r) => r.topic === 'vat' && r.ruleType === 'rate')
      .map((r) => r.ruleKey);
    expect(rateKeys).toEqual(['vat.rate_standard_current']);
  });

  it('a livestock supply gets only the livestock rate, not the standard/reduced fallbacks', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 500000, currency: 'EUR',
        vatRegistered: true, supplyType: 'goods', description: 'Sale of cattle at the mart',
      },
    });
    const rateKeys = result.applicableRules
      .filter((r) => r.topic === 'vat' && r.ruleType === 'rate')
      .map((r) => r.ruleKey);
    expect(rateKeys).toEqual(['vat.rate_livestock_current']);
  });

  it('a Schedule 2 zero-rated supply gets only the zero-rate item, not the standard/reduced fallbacks', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 5000, currency: 'EUR',
        vatRegistered: true, supplyType: 'goods', description: "Purchase of children's clothing",
      },
    });
    const rateKeys = result.applicableRules
      .filter((r) => r.topic === 'vat' && r.ruleType === 'rate')
      .map((r) => r.ruleKey);
    expect(rateKeys).toEqual(['vat.zero_rate_childrens_clothing_footwear']);
  });

  it('a restaurant meal before 1 July 2026 gets only the dated 13.5% restaurant rule', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-06-15', amountMinor: 4500, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', description: 'Restaurant meal with a client',
      },
    });
    const rateKeys = result.applicableRules
      .filter((r) => r.topic === 'vat' && r.ruleType === 'rate')
      .map((r) => r.ruleKey);
    expect(rateKeys).toEqual(['vat.rate_restaurant_catering_reduced_current']);
    expect(result.possibleTreatment.vat.some((v) => v.includes('13.5%'))).toBe(true);
  });

  it('issue #136 bug 8: a restaurant meal on/after 1 July 2026 flags the unmodelled 9% gap, asserts no rate', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-07-02', amountMinor: 4500, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', description: 'Restaurant meal with a client',
      },
    });
    const rateKeys = result.applicableRules
      .filter((r) => r.topic === 'vat' && r.ruleType === 'rate')
      .map((r) => r.ruleKey);
    expect(rateKeys).toEqual(['vat.rate_hospitality_9pct_not_modelled']);
    expect(result.possibleTreatment.vat.some((v) => v.includes('13.5%') || v.includes('23%'))).toBe(false);
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/not modelled/i);
  });
});

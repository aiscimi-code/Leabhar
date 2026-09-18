import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH } from './irishRules';
import { lookupTransactionRules, identifyTopics } from './transactionLookup';
import { irishTaxRules } from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const markdown = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Lookup Ltd', seedYears: [2025] }));
  ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
  deriveTaxRules(db, { companyId });
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
  it('a Revolut bank charge: identifies topics but invents no treatment the KB does not hold', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 1000, currency: 'EUR',
        entityType: 'Irish_LTD', vatRegistered: true,
        transactionType: 'bank_charge', description: 'REVOLUT bank charge',
        businessUsePercent: 100, invoiceAvailable: false,
      },
    });
    expect(result.identifiedTopics).toEqual(expect.arrayContaining(['banking', 'business_expense']));
    expect(result.applicableRules).toHaveLength(0);
    expect(result.reviewRequired).toBe(true);
    expect(result.reviewReasons.join(' ')).toMatch(/No rule in the ingested knowledge base/);
    // No hallucinated VAT rate or deductibility claim anywhere in the treatment.
    expect(result.possibleTreatment.vat).toHaveLength(0);
    expect(result.possibleTreatment.tax).toHaveLength(0);
  });

  it('an AI SaaS charge from a US supplier: flags vat topic, requires review, invents nothing', () => {
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        entityType: 'Irish_LTD', vatRegistered: true,
        supplierCountry: 'US', supplierType: 'software_service', transactionType: 'AI_SaaS',
        businessUsePercent: 100, invoiceAvailable: true,
      },
    });
    expect(result.identifiedTopics).toContain('vat');
    expect(result.applicableRules).toHaveLength(0);
    expect(result.reviewRequired).toBe(true);
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
    expect(result.applicableRules).toHaveLength(0);
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

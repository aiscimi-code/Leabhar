import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestFinanceAct2024, FINANCE_ACT_2024_MD_PATH } from './irishRules';
import { deriveFinanceAct2024VatThresholds } from './financeAct2024VatThresholdsIngestion';
import { FINANCE_ACT_2024_VAT_THRESHOLD_RULES } from './financeAct2024VatThresholdsCuration';
import { lookupTaxRule } from './irishRules';
import { lookupTransactionRules } from './transactionLookup';
import { irishTaxRules, irishActProvisions, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'VAT Thresholds Ltd', seedYears: [2025] }));
  const markdown = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
  ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
});

describe('deriveFinanceAct2024VatThresholds', () => {
  it('every curated rule\'s statement excerpt is a verbatim substring of s.78\'s stored text', () => {
    const prov = db.select().from(irishActProvisions)
      .where(eq(irishActProvisions.sectionNumber, '78')).get()!;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    for (const rule of FINANCE_ACT_2024_VAT_THRESHOLD_RULES) {
      expect(
        norm(prov.provisionText ?? ''),
        `${rule.ruleKey}: statementExcerpt must be verbatim`,
      ).toContain(norm(rule.statementExcerpt));
    }
  });

  it('s.78 was ingested as not relevant by the mechanical "definitions" default', () => {
    const prov = db.select().from(irishActProvisions)
      .where(eq(irishActProvisions.sectionNumber, '78')).get()!;
    expect(prov.relevant).toBe(false);
    expect(prov.category).toBe('definitions');
  });

  it('creates both threshold rules and corrects s.78\'s relevant flag', () => {
    const result = deriveFinanceAct2024VatThresholds(db, { companyId });
    expect(result.created).toBe(FINANCE_ACT_2024_VAT_THRESHOLD_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);

    const prov = db.select().from(irishActProvisions)
      .where(eq(irishActProvisions.sectionNumber, '78')).get()!;
    expect(prov.relevant).toBe(true);
  });

  it('the goods threshold rule states €85,000 in integer minor units', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.registration_threshold_goods' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(8_500_000); // €85,000 in cents
    expect(rule!.unit).toBe('eur_minor');
    expect(rule!.effectiveFrom).toBe('2025-01-01');
  });

  it('the services threshold rule states €42,500 in integer minor units', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.registration_threshold_services' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(4_250_000); // €42,500 in cents
    expect(rule!.unit).toBe('eur_minor');
  });

  it('every rule starts unreviewed with ai_suggestion provenance', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const rows = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.topic, 'vat'))).all()
      .filter((r) => r.ruleKey.startsWith('vat.registration_threshold_'));
    expect(rows.length).toBe(FINANCE_ACT_2024_VAT_THRESHOLD_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const second = deriveFinanceAct2024VatThresholds(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(FINANCE_ACT_2024_VAT_THRESHOLD_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBeGreaterThanOrEqual(FINANCE_ACT_2024_VAT_THRESHOLD_RULES.length);
  });

  it('a goods-supply transaction with turnover over the threshold surfaces only the goods threshold rule', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 500000,
        description: 'Sale of goods to a new customer',
        supplyType: 'goods',
        vatRegistered: true,
        annualTurnoverCurrentYearMinor: 9_000_000, // €90,000, over the €85,000 goods threshold
        goodsShareOfAnnualTurnoverPercent: 100, // a pure goods retailer
      },
    });
    const keys = result.applicableRules.map((r) => r.ruleKey);
    expect(keys).toContain('vat.registration_threshold_goods');
    expect(keys).not.toContain('vat.registration_threshold_services');
  });

  it('a services-supply transaction with turnover over the threshold surfaces only the services threshold rule', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 500000,
        description: 'Consulting services invoice',
        supplyType: 'services',
        vatRegistered: true,
        annualTurnoverPreviousYearMinor: 5_000_000, // €50,000, over the €42,500 services threshold
      },
    });
    const keys = result.applicableRules.map((r) => r.ruleKey);
    expect(keys).toContain('vat.registration_threshold_services');
    expect(keys).not.toContain('vat.registration_threshold_goods');
  });

  it('issue #136 bug 2: a single low-value invoice with no turnover figure does not match the registration threshold', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 12300, // a single €123 services invoice
        description: 'Small consulting invoice',
        supplyType: 'services',
        vatRegistered: true,
        // annualTurnoverCurrentYearMinor / annualTurnoverPreviousYearMinor deliberately omitted
      },
    });
    const keys = result.applicableRules.map((r) => r.ruleKey);
    expect(keys).not.toContain('vat.registration_threshold_services');
    expect(result.unresolvedFields).toContain('annualTurnoverMaxMinor');
  });

  it('turnover under the threshold in both years does not match the registration threshold', () => {
    deriveFinanceAct2024VatThresholds(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-01-15',
        amountMinor: 500000,
        description: 'Consulting services invoice',
        supplyType: 'services',
        vatRegistered: true,
        annualTurnoverCurrentYearMinor: 3_000_000, // €30,000
        annualTurnoverPreviousYearMinor: 2_000_000, // €20,000, both under €42,500
      },
    });
    const keys = result.applicableRules.map((r) => r.ruleKey);
    expect(keys).not.toContain('vat.registration_threshold_services');
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { irishTaxRules } from '@/db/schema';
import { asIsoDate } from '../dates';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { setRuleReviewStatus } from './review';
import { auditRuleFigures, resolveRuleFigure } from './ruleFigures';
import { CORPORATION_TAX_CURATED_RULES } from './corporationTaxCuration';
import { INCOME_TAX_CURATED_RULES } from './incomeTaxCuration';
import { SI_69_2025_CURATED_RULES } from './si692025Curation';
import { computeCorporationTax, closeCompanySurcharge } from '../corporationTax/computation';
import { computeIncomeTax } from '../incomeTax/computation';
import { cashBasisFindings } from '../vat/cashBasis';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, {
    legalName: 'Figures Ltd', entityType: 'company', vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
  }));
  loadStatutoryKnowledgeBase(db, { companyId });
});

const inForce = (id: string, ruleKey: string, asOfDate: string) => db.select().from(irishTaxRules)
  .where(and(
    eq(irishTaxRules.companyId, id),
    eq(irishTaxRules.ruleKey, ruleKey),
    eq(irishTaxRules.enabled, true),
  )).all()
  .filter((r) => r.effectiveFrom <= asOfDate && (!r.effectiveTo || r.effectiveTo > asOfDate))
  .sort((a, b) => b.ruleVersion - a.ruleVersion)[0];

describe('figure resolution (issue #282 / #437)', () => {
  it('reads an approved rule from the knowledge base with no finding', () => {
    const rule = inForce(companyId, 'ct.rate_standard', '2025-12-31')!;
    setRuleReviewStatus(db, { ruleId: rule.id, status: 'active', reviewedBy: 'Accountant' });
    const resolved = resolveRuleFigure(db, {
      companyId, ruleKey: 'ct.rate_standard', asOfDate: '2025-12-31',
      curated: CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === 'ct.rate_standard')!,
    });
    expect(resolved.status).toBe('approved');
    expect(resolved.numericValue).toBe(1250);
    expect(resolved.finding).toBeNull();
  });

  it('identifies figures resting on a rule no person has reviewed', () => {
    const resolved = resolveRuleFigure(db, {
      companyId, ruleKey: 'ct.rate_higher_passive', asOfDate: '2025-12-31',
      curated: CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === 'ct.rate_higher_passive')!,
    });
    expect(resolved.status).toBe('unreviewed');
    expect(resolved.numericValue).toBe(2500);
    expect(resolved.finding).toContain('no person has reviewed yet');
  });

  it('gives no figure for a rejected rule, and a finding that says who rejected it', () => {
    const rule = inForce(companyId, 'usc.band_2pct', '2025-12-31')!;
    setRuleReviewStatus(db, { ruleId: rule.id, status: 'rejected', reviewedBy: 'Accountant', notes: 'wrong figure' });
    const curated = INCOME_TAX_CURATED_RULES
      .find((r) => r.ruleKey === 'usc.band_2pct' && r.effectiveFrom <= '2025-12-31')!;
    const resolved = resolveRuleFigure(db, { companyId, ruleKey: 'usc.band_2pct', asOfDate: '2025-12-31', curated });
    expect(resolved.status).toBe('rejected');
    expect(resolved.numericValue).toBeNull();
    expect(resolved.finding).toContain('rejected on the rule review screen by Accountant');
    // The shipped constant stays exposed for an explicit fallback, but it is not the value used.
    expect(resolved.curatedValue).toBe(1_537_000);
  });

  it('falls back to the shipped curation constant, flagged, when the book holds no rule', () => {
    const other = createCompany(db, { legalName: 'Other Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    const fresh = resolveRuleFigure(db, {
      companyId: other.companyId, ruleKey: 'vat.cash_accounting_turnover_threshold', asOfDate: '2025-01-01',
      curated: SI_69_2025_CURATED_RULES.find((r) => r.ruleKey === 'vat.cash_accounting_turnover_threshold')!,
    });
    expect(fresh.status).toBe('curation_only');
    expect(fresh.numericValue).toBe(200_000_000);
    expect(fresh.finding).toContain('no person has reviewed here');
  });

  it('fails closed on a date that is not a date', () => {
    const resolved = resolveRuleFigure(db, {
      companyId, ruleKey: 'ct.rate_standard', asOfDate: 'not-a-date',
      curated: CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === 'ct.rate_standard')!,
    });
    expect(resolved.numericValue).toBeNull();
    expect(resolved.finding).toContain('is not a date');
  });

  it('consolidates the findings of a computation worth of figures', () => {
    const audit = auditRuleFigures(db, { companyId, asOfDate: '2025-12-31', curated: CORPORATION_TAX_CURATED_RULES });
    audit.figure('ct.rate_standard');
    audit.figure('ct.rate_higher_passive');
    const findings = audit.findings();
    expect(findings.some((f) => f.includes('ct.rate_higher_passive'))).toBe(true);
    expect(findings.some((f) => f.includes('ct.rate_standard'))).toBe(false); // approved above
  });
});

describe('the computations respect a rule\u2019s review status (issue #282 acceptance)', () => {
  it('rejecting a USC band changes the income tax output: the USC is not computed', () => {
    const c = computeIncomeTax(db, { companyId: soleTraderBook().companyId, year: 2025 });
    const me = c.individuals[0]!;
    expect(me.usc).toEqual([]);
    expect(me.uscMinor).toBe(0);
    expect(c.findings.some((f) => f.includes('usc.band_2pct') && f.includes('rejected'))).toBe(true);
  });

  it('identifies figures resting on unreviewed rules in the income tax output', () => {
    const c = computeIncomeTax(db, { companyId: soleTraderBook().companyId, year: 2025 });
    expect(c.individuals[0]!.incomeTaxMinor).toBeGreaterThan(0);
    expect(c.findings.some((f) => f.includes('no person has reviewed yet'))).toBe(true);
  });

  it('a rejected capital-allowance rate leaves the CT computation working, flagged, on the shipped curation', () => {
    const rule = inForce(companyId, 'ct.wear_and_tear_rate', '2025-12-31')!;
    setRuleReviewStatus(db, { ruleId: rule.id, status: 'rejected', reviewedBy: 'Accountant' });
    const c = computeCorporationTax(db, { companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') });
    expect(c.findings.some((f) => f.includes('ct.wear_and_tear_rate') && f.includes('rejected'))).toBe(true);
    // The standard rate's rule was approved, so it reports nothing.
    expect(c.rates.standardBasisPoints).toBe(1250);
    expect(c.findings.some((f) => f.includes('ct.rate_standard'))).toBe(false);
    // The close company surcharge still computes, on its own resolved figures.
    const surcharge = closeCompanySurcharge(db, {
      companyId, from: '2025-01-01', to: '2025-12-31', status: 'close_trading',
      base: { adjustedMinor: 1_000_000, nonTradingIncomeMinor: 0 }, higherBps: 2500, standardBps: 1250,
    });
    expect(surcharge.surchargeMinor).toBe(0);
  });

  it('the cash-basis turnover test reports the review state of its threshold rule', () => {
    const book = soleTraderBook();
    const findings = cashBasisFindings(db, {
      companyId: cashBasisBook().companyId, periodStart: '2025-01-01', periodEnd: '2025-03-31',
    });
    expect(findings.some((f) => f.code === 'cash_basis_threshold_rule_not_approved')).toBe(true);
    expect(findings.some((f) => f.code === 'cash_basis_not_authorised')).toBe(true);
    expect(book.companyId).toBeTruthy();
  });
});

let soleTrader: ReturnType<typeof createCompany> | null = null;
let cashBasis: ReturnType<typeof createCompany> | null = null;

/** A sole-trader book with the KB loaded and its USC 2% band rejected. */
function soleTraderBook() {
  if (!soleTrader) {
    soleTrader = createCompany(db, {
      legalName: 'Sinead Fee', entityType: 'sole_trader', tradeCommencedOn: '2023-01-01',
      vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025, 2026],
    });
    loadStatutoryKnowledgeBase(db, { companyId: soleTrader.companyId });
    const row = inForce(soleTrader.companyId, 'usc.band_2pct', '2025-12-31')!;
    setRuleReviewStatus(db, { ruleId: row.id, status: 'rejected', reviewedBy: 'Accountant', notes: 'wrong figure' });
    postJournalEntry(db, {
      companyId: soleTrader.companyId, entryDate: asIsoDate('2025-06-01'), narrative: 'Fees 2025', sourceType: 'bank_transaction',
      sourceId: 'fees-2025', baseCurrency: 'EUR',
      lines: [
        { accountId: soleTrader.accountsByKey['bank_control']!, debitMinor: 6_000_000 },
        { accountId: soleTrader.accountsByCode['4020']!, creditMinor: 6_000_000 },
      ],
    });
  }
  return soleTrader;
}

/** A sole-trader book on the cash receipts basis whose KB was loaded (unreviewed threshold). */
function cashBasisBook() {
  if (!cashBasis) {
    cashBasis = createCompany(db, {
      legalName: 'Cash Basis Ltd', entityType: 'sole_trader', tradeCommencedOn: '2023-01-01',
      vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025, 2026],
      vatAccountingBasis: 'cash_receipts',
    });
    loadStatutoryKnowledgeBase(db, { companyId: cashBasis.companyId });
  }
  return cashBasis;
}

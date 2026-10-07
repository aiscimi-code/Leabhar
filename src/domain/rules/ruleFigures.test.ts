import { describe, it, expect, beforeAll, onTestFinished } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { irishTaxRules, visibleTaxRules } from '@/db/schema';
import { attachRulesStoreFromBook } from './rulesStore';
import { attachRulesStore } from './visibleRules';
import { asIsoDate } from '../dates';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { setRuleReviewStatus } from './review';
import { auditRuleFigures, resolveRuleFigure, RejectedRuleError } from './ruleFigures';
import { CORPORATION_TAX_CURATED_RULES } from './corporationTaxCuration';
import { INCOME_TAX_CURATED_RULES } from './incomeTaxCuration';
import { SI_69_2025_CURATED_RULES } from './si692025Curation';
import { computeCorporationTax, closeCompanySurcharge } from '../corporationTax/computation';
import { computeIncomeTax } from '../incomeTax/computation';
import { cashBasisFindings } from '../vat/cashBasis';
import { yearEndPack } from '../reports/yearEnd';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let sqlite: ReturnType<typeof createTestDatabase>['sqlite'];
let companyId: string;

beforeAll(() => {
  ({ db, sqlite } = createTestDatabase());
  ({ companyId } = createCompany(db, {
    legalName: 'Figures Ltd', entityType: 'company', vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
  }));
  deriveStatutoryKnowledgeBase(db, { companyId });
});

const inForce = (id: string, ruleKey: string, asOfDate: string) => db.select().from(visibleTaxRules)
  .where(and(
    eq(visibleTaxRules.companyId, id),
    eq(visibleTaxRules.origin, 'store'),
    eq(visibleTaxRules.ruleKey, ruleKey),
    eq(visibleTaxRules.enabled, true),
  )).all()
  .filter((r) => r.effectiveFrom <= asOfDate && (!r.effectiveTo || r.effectiveTo > asOfDate))
  .sort((a, b) => b.ruleVersion - a.ruleVersion)[0];

/**
 * A book whose store holds no rules: the figures fall back to the shipped
 * curation constants. Every company in a book sees the installed store, so
 * this is a book of its own, reading a store built from no rules.
 */
function bookWithoutRules(input: Parameters<typeof createCompany>[1]) {
  const { db } = createTestDatabase({ rulesStore: false });
  const other = createCompany(db, input);
  attachRulesStoreFromBook(db, { companyId: other.companyId });
  return { db, other };
}

/**
 * Change what a stored rule says, as a later catalogue would: the store is
 * rebuilt from the book's own derived rules with the change, and the
 * installed one is put back when the test ends.
 */
function editStoredRule(bookCompanyId: string, rule: { ruleKey: string; ruleVersion: number }, patch: Partial<typeof irishTaxRules.$inferInsert>) {
  db.update(irishTaxRules).set(patch).where(and(eq(irishTaxRules.companyId, bookCompanyId),
    eq(irishTaxRules.ruleKey, rule.ruleKey), eq(irishTaxRules.ruleVersion, rule.ruleVersion))).run();
  attachRulesStoreFromBook(db, { companyId: bookCompanyId });
  onTestFinished(() => { attachRulesStore(sqlite); });
}

describe('figure resolution (issue #282 / #437)', () => {
  it('reads an approved rule from the knowledge base with no finding', () => {
    const rule = inForce(companyId, 'ct.rate_standard', '2025-12-31')!;
    setRuleReviewStatus(db, { companyId, ruleId: rule.id, status: 'active', reviewedBy: 'Accountant' });
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
    setRuleReviewStatus(db, { companyId, ruleId: rule.id, status: 'rejected', reviewedBy: 'Accountant', notes: 'wrong figure' });
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
    const { db, other } = bookWithoutRules({ legalName: 'Other Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
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

  it('gives no figure for a rule retired on the review screen, with a finding that says retired, not rejected (issue #484)', () => {
    const fresh = createCompany(db, { legalName: 'Retired Ltd', entityType: 'company', vatRegistrationStatus: 'registered', seedYears: [2025] });
    deriveStatutoryKnowledgeBase(db, { companyId: fresh.companyId });
    const rule = inForce(fresh.companyId, 'ct.rate_standard', '2025-12-31')!;
    setRuleReviewStatus(db, { companyId: fresh.companyId, ruleId: rule.id, status: 'superseded', reviewedBy: 'Accountant', notes: 'corrected version being drafted' });
    const resolved = resolveRuleFigure(db, {
      companyId: fresh.companyId, ruleKey: 'ct.rate_standard', asOfDate: '2025-12-31',
      curated: CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === 'ct.rate_standard')!,
    });
    expect(resolved.status).toBe('retired');
    expect(resolved.numericValue).toBeNull();
    expect(resolved.finding).toContain('retired on the rule review screen by Accountant');
    expect(resolved.finding).not.toContain('rejected');
    // And the CT computation refuses the retired rule rather than using it or
    // silently substituting the shipped constant.
    expect(() => computeCorporationTax(db, { companyId: fresh.companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') }))
      .toThrow(RejectedRuleError);
    expect(() => computeCorporationTax(db, { companyId: fresh.companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') }))
      .toThrow(/retired on the rule review screen/);
  });

  it('honours the shipped curation constant\u2019s own effective window: a 2002 period gets no 12.5% (issue #492)', () => {
    // A book with no stored rules at all: the fallback is the shipped constant,
    // and ct.rate_standard is curated from 2003-01-01.
    const { db, other: old } = bookWithoutRules({ legalName: 'Old Books Ltd', entityType: 'company', vatRegistrationStatus: 'registered', seedYears: [2002, 2003] });
    const resolved = resolveRuleFigure(db, {
      companyId: old.companyId, ruleKey: 'ct.rate_standard', asOfDate: '2002-12-31',
      curated: CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === 'ct.rate_standard')!,
    });
    expect(resolved.status).toBe('curation_only');
    expect(resolved.numericValue).toBeNull();
    expect(resolved.curatedInForce).toBe(false);
    expect(resolved.finding).toContain('2003-01-01');
    expect(resolved.finding).toContain('2002-12-31');
    // A period the curation does not cover is refused, not charged at the
    // rate that later applied.
    expect(() => computeCorporationTax(db, { companyId: old.companyId, from: asIsoDate('2002-01-01'), to: asIsoDate('2002-12-31') }))
      .toThrow(/ct\.rate_standard/);
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

  it('a rejected capital-allowance rate stops the CT computation: a rejected figure is never used (#451)', () => {
    const rule = inForce(companyId, 'ct.wear_and_tear_rate', '2025-12-31')!;
    setRuleReviewStatus(db, { companyId, ruleId: rule.id, status: 'rejected', reviewedBy: 'Accountant' });
    expect(() => computeCorporationTax(db, { companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') }))
      .toThrow(RejectedRuleError);
    expect(() => computeCorporationTax(db, { companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') }))
      .toThrow(/ct\.wear_and_tear_rate.*rejected on the rule review screen by Accountant/);
    // The close company surcharge does not need that figure, so it still computes.
    const surcharge = closeCompanySurcharge(db, {
      companyId, from: '2025-01-01', to: '2025-12-31', status: 'close_trading',
      base: { adjustedMinor: 1_000_000, nonTradingIncomeMinor: 0 }, higherBps: 2500, standardBps: 1250,
    });
    expect(surcharge.surchargeMinor).toBe(0);
  });

  it('the year-end pack carries no tax computation after a rejection, and says why', () => {
    // The wear-and-tear rule is still rejected from the test above.
    const pack = yearEndPack(db, { companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') });
    expect(pack.taxComputation).toBeNull();
    const issue = pack.issues.find((i) => i.title.includes('corporation tax computation was not produced'));
    expect(issue?.severity).toBe('blocking');
    expect(issue?.detail).toMatch(/ct\.wear_and_tear_rate/);
  });

  it('preliminary tax follows the rules\u2019 percentages: an edited rule changes the figure, a rejected one stops the part (issue #486)', () => {
    const book = preliminaryTaxBook();
    const run = () => computeIncomeTax(db, { companyId: book.companyId, year: 2025 });
    const prior = () => computeIncomeTax(db, { companyId: book.companyId, year: 2024 }).individuals[0]!.totalMinor;

    // The shipped rules state 90% of this year and 100% of the last: the lower.
    const first = run();
    const expected = Math.min(Math.round(first.individuals[0]!.totalMinor * 0.9), prior());
    expect(first.dates.preliminaryTaxMinor).toBe(expected);
    expect(first.dates.basis).toContain('90%');
    expect(first.dates.basis).toContain('100%');

    // A person edits the stored rule on the review screen: the computation
    // follows the stored value, not the hard-coded percentage.
    const rule = inForce(book.companyId, 'income_tax.preliminary_tax_current_year', '2025-12-31')!;
    editStoredRule(book.companyId, rule, { numericValue: 5000 });
    const edited = run();
    expect(edited.dates.preliminaryTaxMinor).toBe(Math.min(Math.round(edited.individuals[0]!.totalMinor * 0.5), prior()));
    expect(edited.dates.basis).toContain('50%');
    expect(edited.dates.basis).not.toContain('90%');

    // A rejected rule stops that test entirely: only the prior-year one applies.
    setRuleReviewStatus(db, { companyId: book.companyId, ruleId: rule.id, status: 'rejected', reviewedBy: 'Accountant' });
    const rejected = run();
    expect(rejected.dates.preliminaryTaxMinor).toBe(prior());
    expect(rejected.findings.some((f) => f.includes('income_tax.preliminary_tax_current_year') && f.includes('rejected'))).toBe(true);
    expect(rejected.dates.basis).not.toContain('90%');
  });

  it('the close company surcharge working string follows the rules: an edited rate changes the figure and its label (issue #490)', () => {
    const book = surchargeTestBook();
    const compute = (status: 'close_trading' | 'close_service') => closeCompanySurcharge(db, {
      companyId: book.companyId, from: '2025-01-01', to: '2025-12-31', status,
      base: { adjustedMinor: 0, nonTradingIncomeMinor: 1_000_000 },
      higherBps: 2500, standardBps: 1250, distributionsMinor: 0,
    });

    // The shipped rules state 20% (and 15% for a service company): both the
    // figure and the working string print them.
    const first = compute('close_service');
    expect(first.surchargeMinor).toBe(150_000);
    expect(first.working).toContain('at 20%');
    expect(first.working).toContain('at 15%');
    expect(compute('close_trading').working).toContain('20%, limited to 80%');

    // A person edits the stored rule on the review screen: the surcharge and
    // its label follow the stored value, not the hard-coded percentage.
    const rule = inForce(book.companyId, 'ct.close_company_surcharge', '2025-12-31')!;
    editStoredRule(book.companyId, rule, { numericValue: 2500 });
    const edited = compute('close_service');
    expect(edited.surchargeMinor).toBe(187_500);
    expect(edited.working).toContain('at 25%');
    expect(edited.working).not.toContain('at 20%');
    expect(compute('close_trading').working).toContain('25%, limited to 80%');
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

let preliminaryTax: ReturnType<typeof createCompany> | null = null;

/** A sole-trader book with the KB loaded and fee income in 2024 and 2025, so
 *  both preliminary tax tests have a liability to work with (issue #486). */
function preliminaryTaxBook() {
  if (!preliminaryTax) {
    preliminaryTax = createCompany(db, {
      legalName: 'Preliminary Tax Ltd', entityType: 'sole_trader', tradeCommencedOn: '2023-01-01',
      vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025, 2026],
    });
    deriveStatutoryKnowledgeBase(db, { companyId: preliminaryTax.companyId });
    for (const [date, amount] of [['2024-06-01', 4_000_000], ['2025-06-01', 6_000_000]] as const) {
      postJournalEntry(db, {
        companyId: preliminaryTax.companyId, entryDate: asIsoDate(date), narrative: 'Fees', sourceType: 'bank_transaction',
        sourceId: `fees-${date}`, baseCurrency: 'EUR',
        lines: [
          { accountId: preliminaryTax.accountsByKey['bank_control']!, debitMinor: amount },
          { accountId: preliminaryTax.accountsByCode['4020']!, creditMinor: amount },
        ],
      });
    }
  }
  return preliminaryTax;
}

let soleTrader: ReturnType<typeof createCompany> | null = null;
let cashBasis: ReturnType<typeof createCompany> | null = null;
let surcharge: ReturnType<typeof createCompany> | null = null;

/** A company book with the KB loaded, for the surcharge labels (issue #490). */
function surchargeTestBook() {
  if (!surcharge) {
    surcharge = createCompany(db, {
      legalName: 'Surcharge Ltd', entityType: 'company', vatRegistrationStatus: 'registered', seedYears: [2025],
    });
    deriveStatutoryKnowledgeBase(db, { companyId: surcharge.companyId });
  }
  return surcharge;
}

/** A sole-trader book with the KB loaded and its USC 2% band rejected. */
function soleTraderBook() {
  if (!soleTrader) {
    soleTrader = createCompany(db, {
      legalName: 'Sinead Fee', entityType: 'sole_trader', tradeCommencedOn: '2023-01-01',
      vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025, 2026],
    });
    deriveStatutoryKnowledgeBase(db, { companyId: soleTrader.companyId });
    const row = inForce(soleTrader.companyId, 'usc.band_2pct', '2025-12-31')!;
    setRuleReviewStatus(db, { companyId: soleTrader.companyId, ruleId: row.id, status: 'rejected', reviewedBy: 'Accountant', notes: 'wrong figure' });
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
    deriveStatutoryKnowledgeBase(db, { companyId: cashBasis.companyId });
  }
  return cashBasis;
}

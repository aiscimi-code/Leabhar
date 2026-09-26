import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { deriveVatScopeRules } from './vatScopeIngestion';
import { evaluateAllConditions } from './conditionEval';
import { quotedTextWindow } from './lrcAnnotations';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';
import { suggestFromFacts, type SuggestionFacts } from './vatSuggestion';
import type { AppDatabase } from '@/db';

/**
 * Issue #206 part 1: a rule for every Schedule 1 paragraph an invoice line can
 * show (13 and 15 are exemptions at importation, justified not_applicable),
 * each dated from the last LRC amendment to the words it quotes; loan interest
 * flagged, not rated.
 */

const html = readFileSync(new URL('../../../docs/statutes/vatca-2010-revised/schedule-1.html', import.meta.url), 'utf8');

describe('quotedTextWindow: the window of the words a rule quotes', () => {
  it('dates unamended words from the Act\'s commencement, even in a paragraph amended in 2025', () => {
    expect(quotedTextWindow(html, ['operating a current, deposit or savings account'])).toEqual({
      effectiveFrom: '2010-11-01', footnotes: [],
    });
  });

  it('dates words inside an amendment\'s bracket from that amendment', () => {
    const insurance = quotedTextWindow(html, ['Insurance and reinsurance transactions'])!;
    expect(insurance.effectiveFrom).toBe('2012-03-31');
    expect(insurance.footnotes.map((f) => f.ref)).toEqual(['F407']);
    expect(quotedTextWindow(html, ['transferring or otherwise dealing in stocks'])!.effectiveFrom).toBe('2022-12-15');
  });

  it('catches a deletion through the "…" it leaves, and takes the latest of several quotes', () => {
    const deleted = quotedTextWindow(html, ['… transferring or otherwise dealing'])!;
    expect(deleted.footnotes.map((f) => f.ref).sort()).toEqual(['F391', 'F392']);
    expect(deleted.effectiveFrom).toBe('2023-12-18');
    expect(quotedTextWindow(html, ['operating a current', 'Insurance and reinsurance transactions'])!.effectiveFrom)
      .toBe('2012-03-31');
  });

  it('returns null for words not in the text, so the caller can fall back', () => {
    expect(quotedTextWindow(html, ['granting, negotiating or managing credit'])).toBeNull();
  });
});

describe('Schedule 1 rules: what each matches, and each stated exclusion', () => {
  const byKey = new Map(VAT_SCOPE_CURATED_RULES.map((r) => [r.ruleKey, r]));
  const matches = (key: string, description: string, direction = 'purchase') =>
    evaluateAllConditions(byKey.get(key)!.conditions, { description, direction }).allPassed;

  const cases: Array<[string, string[], string[]]> = [
    ['vat.exempt_medical_care', ['GP consultation', 'Dental treatment', 'Physiotherapy session'], ['Contact lenses', 'Botox clinic']],
    ['vat.exempt_nonprofit_membership_and_sport', ['Annual membership, Small Firms Association'], ['Membership, Gym Ltd']],
    ['vat.exempt_education_childcare', ['Course fees, University College Cork', 'Creche fees'], ['Driving lessons tuition', 'Research tuition']],
    ['vat.exempt_live_performances', ['Theatre tickets x2'], ['Dinner theatre tickets', 'Dance tickets']],
    ['vat.exempt_securities_and_fund_management', ['Stockbroker dealing commission', 'FX margin'], ['Custody only']],
    ['vat.exempt_card_scheme_services', ['Stripe fees', 'Merchant service charges'], ['Terminal rental']],
    ['vat.exempt_financial_agency', ['Introducer commission'], ['Consultancy']],
    ['vat.exempt_investment_gold', ['Gold bullion 1oz bar'], ['Gold necklace']],
    ['vat.exempt_betting_and_lotteries', ['Lotto tickets', 'Raffle'], ['Sports advertising']],
    ['vat.exempt_funeral_services', ['Funeral director services'], ['Stone engraving']],
    ['vat.exempt_public_water', ['Uisce Éireann water charges'], ['Bottled mineral drinks']],
    ['vat.exempt_sporting_event_admission', ['Match tickets, Croke Park'], ['Match balls']],
    ['vat.loan_interest_undetermined', ['Loan interest Q3', 'Overdraft interest'], ['Interest in our services', 'Loan repayment']],
  ];

  it('covers every rule added in #206', () => {
    const added = [...byKey.keys()].filter((k) => cases.every((c) => c[0] !== k) && ![
      'vat.exempt_bank_account_and_payment_services', 'vat.exempt_insurance', 'vat.exempt_letting_immovable_goods',
      'vat.exempt_passenger_transport', 'vat.exempt_postal_universal_service', 'vat.outside_scope_employment',
      'vat.outside_scope_tax_payment', 'vat.outside_scope_capital_loans_dividends', 'vat.outside_scope_own_account_transfer',
      'vat.exempt_sale_of_non_deductible_goods', // tested below, by direction
    ].includes(k));
    expect(added).toEqual([]);
  });

  for (const [key, yes, no] of cases) {
    it(key, () => {
      for (const d of yes) expect(matches(key, d), `"${d}" should match`).toBe(true);
      for (const d of no) expect(matches(key, d), `"${d}" should not match`).toBe(false);
    });
  }

  it('the sale of a non-deductible car matches only on a sale', () => {
    expect(matches('vat.exempt_sale_of_non_deductible_goods', 'Sale of motor car 181-D-123', 'sale')).toBe(true);
    expect(matches('vat.exempt_sale_of_non_deductible_goods', 'Sale of motor car 181-D-123', 'purchase')).toBe(false);
  });
});

describe('deriving and applying the Schedule 1 rules', () => {
  let db: AppDatabase;
  let companyId: string;
  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Exempt Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    loadStatutoryKnowledgeBase(db, { companyId });
  });
  const rule = (ruleKey: string) => db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, ruleKey), eq(irishTaxRules.active, true))).get();
  const suggest = (description: string, date = '2026-03-01', direction: 'purchase' | 'sale' = 'purchase') => {
    const facts: SuggestionFacts = {
      transactionDate: date, amountMinor: 10_000, currency: 'EUR', description, vatRegistered: true,
      direction, counterpartyCountry: 'IE',
    };
    return suggestFromFacts(db, { companyId, subjectId: 'line', facts, factSources: {}, bookedTreatmentId: null });
  };

  it('derives every Schedule 1 rule, dated from the amendments to its quoted words', () => {
    for (const r of VAT_SCOPE_CURATED_RULES.filter((x) => x.citation === '2010 Act 31 Sch.1')) {
      expect(rule(r.ruleKey), r.ruleKey).toBeDefined();
    }
    expect(rule('vat.exempt_bank_account_and_payment_services')!.effectiveFrom).toBe('2010-11-01');
    expect(rule('vat.exempt_insurance')!.effectiveFrom).toBe('2012-03-31');
    expect(rule('vat.exempt_insurance')!.sourceNote).toMatch(/F407/);
  });

  it('re-deriving is a no-op; a row with a wrong window is retired and replaced, not left in force', () => {
    expect(deriveVatScopeRules(db, { companyId })).toMatchObject({ created: 0, superseded: 0 });
    const bank = rule('vat.exempt_bank_account_and_payment_services')!;
    db.update(irishTaxRules).set({ effectiveFrom: '2026-09-20' }).where(eq(irishTaxRules.id, bank.id)).run();
    expect(deriveVatScopeRules(db, { companyId })).toMatchObject({ created: 1, superseded: 1 });
    const old = db.select().from(irishTaxRules).where(eq(irishTaxRules.id, bank.id)).get()!;
    expect(old).toMatchObject({ active: false, effectiveTo: '2026-09-20' });
    expect(rule('vat.exempt_bank_account_and_payment_services')).toMatchObject({
      effectiveFrom: '2010-11-01', supersedesRuleId: bank.id,
    });
  });

  it('loan interest is flagged with the reason, never given a treatment', () => {
    const s = suggest('Business loan interest, quarter to June');
    expect(s.status).toBe('no_treatment');
    expect(s.treatment).toBeNull();
    expect(s.decidingRule?.ruleKey).toBe('vat.loan_interest_undetermined');
    expect(s.reviewReasons.join(' ')).toMatch(/Finance \(No\. 2\) Act 2023 s\.63/);
  });

  it('card-scheme fees are exempt; a theatre ticket is exempt; a dinner-theatre ticket is not', () => {
    expect(suggest('Stripe fees').treatment?.code).toBe('IE_EXEMPT');
    expect(suggest('Theatre tickets x2').decidingRule?.ruleKey).toBe('vat.exempt_live_performances');
    expect(suggest('Dinner theatre tickets').decidingRule?.ruleKey).not.toBe('vat.exempt_live_performances');
  });
});

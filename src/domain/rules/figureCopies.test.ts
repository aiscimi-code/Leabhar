/**
 * One source per figure (ADR-0020 §7, issue #686 step 6).
 *
 * A rate or threshold the code holds outside the rules is a copy. Each copy
 * here is held to the rule it copies, so the test fails the moment the rule
 * changes and the copy does not. A figure with no copy reads the rules
 * (resolveRuleFigure); this file lists the ones that cannot. The VAT seed
 * rows are held to the s.46 rules by config/seeds.test.ts. The curation
 * constants resolveRuleFigure falls back on are not copies: they are what the
 * rules are derived from.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_TAX_RATES } from '../config/vatTreatments';
import { KNOWN_RATES } from '../extraction/invoiceParser';
import { DEFAULT_CAPITAL_ALLOWANCE_RATE_BP, DEFAULT_CAPITAL_ALLOWANCE_YEARS } from '../assets/register';
import { TREATMENTS } from '@/browser/books/types';
import { CORPORATION_TAX_CURATED_RULES, CT_RATE_TRADING_RULE_KEY, CT_RATE_HIGHER_RULE_KEY } from './corporationTaxCuration';
import { VATCA_REVISED_CURATED_RULES } from './vatcaRevisedCuration';

const today = new Date().toISOString().slice(0, 10);
const inForce = <T extends { effectiveFrom: string; effectiveTo?: string | null }>(rows: T[], on = today) =>
  rows.filter((r) => r.effectiveFrom <= on && (r.effectiveTo == null || r.effectiveTo > on));
const ctFigure = (ruleKey: string) => {
  const rows = inForce(CORPORATION_TAX_CURATED_RULES.filter((r) => r.ruleKey === ruleKey));
  expect(rows, ruleKey).toHaveLength(1);
  return rows[0]!.numericValue;
};
/** The basis points a VAT rate rule states. */
const vatBp = (ruleKey: string, on = today) => {
  const rows = inForce(VATCA_REVISED_CURATED_RULES.filter((r) => r.ruleKey === ruleKey), on);
  expect(rows, `${ruleKey} on ${on}`).toHaveLength(1);
  return Math.round(rows[0]!.numericValue! * 100);
};
const openSeed = (code: string) => {
  const rows = DEFAULT_TAX_RATES.filter((r) => r.code === code && !r.effectiveTo);
  expect(rows, code).toHaveLength(1);
  return rows[0]!.rateBasisPoints;
};

describe('figures copied outside the rules agree with the rules', () => {
  it('the corporation tax seed rates (CT_TRADING, CT_PASSIVE): TCA 1997 s.21, s.21A', () => {
    expect(openSeed('CT_TRADING')).toBe(ctFigure(CT_RATE_TRADING_RULE_KEY));
    expect(openSeed('CT_PASSIVE')).toBe(ctFigure(CT_RATE_HIGHER_RULE_KEY));
  });

  it("the asset register's default wear and tear: TCA 1997 s.284", () => {
    expect(DEFAULT_CAPITAL_ALLOWANCE_RATE_BP).toBe(ctFigure('ct.wear_and_tear_rate'));
    expect(DEFAULT_CAPITAL_ALLOWANCE_YEARS * DEFAULT_CAPITAL_ALLOWANCE_RATE_BP).toBe(10_000);
  });

  it("the invoice parser knows every rate an s.46 rule has stated", () => {
    const stated = new Set(VATCA_REVISED_CURATED_RULES.filter((r) => r.unit === 'percent' && r.numericValue !== null)
      .map((r) => Math.round(r.numericValue! * 100)));
    expect([...stated].filter((bp) => !KNOWN_RATES.has(bp))).toEqual([]);
  });

  it("the browser books' rates are the s.46 rates in force", () => {
    const rate = (id: string) => TREATMENTS.find((t) => t.id === id)!.rateBps;
    expect(rate('standard')).toBe(vatBp('vat.rate_standard_current'));
    expect(rate('reverse_charge')).toBe(vatBp('vat.rate_standard_current'));
    expect(rate('reduced')).toBe(vatBp('vat.rate_reduced_current'));
    expect(rate('second_reduced')).toBe(openSeed('VAT_SECOND_RED'));
    // The 9% seed is held to every s.46 rule stating the second reduced rate.
    const nine = new Set(VATCA_REVISED_CURATED_RULES.filter((r) => r.numericValue === 9).map((r) => Math.round(r.numericValue! * 100)));
    expect([...nine]).toEqual([openSeed('VAT_SECOND_RED')]);
    expect(rate('zero')).toBe(0);
  });
});

/**
 * Supersession between rule keys (ADR-0020 §3, issue #686 step 8).
 *
 * A new version of the same key is chained by `supersedesRuleId`, one row to
 * the row before it. That shortcut cannot say that one key replaced several
 * (a merge), that several replaced one (a split), that a key was renamed, or
 * that a new rule took part of an old one's ground from a date while the old
 * one stays in force for the rest (a carve-out). Those are declared here, and
 * load as `supersedes` links (ruleLinks.ts), from the new key to the old.
 *
 * A `whole` supersession retires the old key: deriving closes its stored
 * rows with an empty window, never deleting them (the RETIRED_* lists below
 * are read from here). A carve-out retires nothing.
 *
 * This module imports nothing, so every curation and derive step can read it.
 */

export type SupersessionShape = 'merge' | 'split' | 'rename' | 'carve_out';

export interface Supersession {
  shape: SupersessionShape;
  /** The keys that replace. */
  newKeys: string[];
  /** The keys replaced. */
  oldKeys: string[];
  /** For a carve-out: the date the new keys take the ground. Otherwise the old keys' own dates. */
  from: string | null;
  /** True when the old keys stop being derived at all, so deriving retires their rows. */
  whole: boolean;
  note: string;
}

export const SUPERSESSIONS: Supersession[] = [
  {
    shape: 'merge', whole: true, from: null,
    newKeys: ['vat.rate_hospitality'],
    oldKeys: [
      'vat.rate_restaurant_catering_reduced_current',
      'vat.rate_restaurant_catering_reduced_pre_9pct_window',
      'vat.rate_hospitality_9pct_not_modelled',
      'vat.rate_restaurant_catering_9pct_2020_2023',
    ],
    note: 'Issue #205: the hospitality periods are versions of one family. The 13.5% window from 2010 to 2020 is '
      + 'dropped, since s.46(1)(ca) put hospitality at 9% for part of it; the "not modelled" gap is modelled from '
      + 'Finance Act 2025 s.71.',
  },
  {
    shape: 'rename', whole: true, from: null,
    newKeys: ['vat.rate_hairdressing'],
    oldKeys: ['vat.rate_hairdressing_9pct_2020_2023'],
    note: 'Issue #205: the 2020-2023 9% period is a version of the hairdressing family.',
  },
  {
    shape: 'carve_out', whole: false, from: '2026-07-01',
    newKeys: ['vat.rate_hospitality', 'vat.rate_hairdressing'],
    oldKeys: ['vat.rate_reduced_current'],
    note: 'Finance Act 2025 s.71 (issue #129): from 1 July 2026 Schedule 3 paragraphs 3(1), 3(3) and 13(3) bear 9% '
      + 'under the substituted s.46(1)(cb); the reduced rate stays in force for the other paragraphs.',
  },
  {
    shape: 'rename', whole: true, from: null,
    newKeys: ['vat.input_deduction_taxable_use'],
    oldKeys: ['vat.input_deduction_general'],
    note: 'Issue #209: the as-enacted s.59 rule, replaced by the revised one.',
  },
  {
    shape: 'split', whole: true, from: null,
    newKeys: ['vat.blocked_food_drink_accommodation', 'vat.blocked_entertainment', 'vat.blocked_motor_vehicle', 'vat.blocked_petrol'],
    oldKeys: ['vat.deduction_exclusions_entertainment'],
    note: 'Issue #209: the as-enacted s.60(2)(a) rule, split by category from the revised text.',
  },
  {
    shape: 'rename', whole: true, from: null,
    newKeys: ['usc.medical_card_2pct_threshold'],
    oldKeys: ['usc.first_band_threshold'],
    note: 'Issue #199: Finance Act 2024 s.2 states the s.531AN(3) medical card cap, not a band of the Table.',
  },
  {
    shape: 'rename', whole: true, from: null,
    newKeys: ['income_tax.second_earner_band_increase_max'],
    oldKeys: ['income_tax.standard_rate_threshold'],
    note: 'Issue #199: Finance Act 2024 s.3 states the most a second income adds to the band, not the band.',
  },
];

/** The old keys a whole supersession by any of `newKeys` retires, in declared order. */
export function retiredBy(newKeys: readonly string[]): string[] {
  return SUPERSESSIONS.filter((s) => s.whole && s.newKeys.some((k) => newKeys.includes(k))).flatMap((s) => s.oldKeys);
}

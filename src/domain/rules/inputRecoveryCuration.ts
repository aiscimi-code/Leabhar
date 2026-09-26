/**
 * Input VAT recovery (issue #209 part 1), from the revised ss.59-62.
 *
 * s.59(2) allows a deduction for tax on goods and services used for taxable
 * supplies, charged by invoice. s.60(2)(a) then blocks it, category by
 * category, exactly as the statute lists them: food, drink, accommodation
 * and personal services (i), entertainment (iii), motor vehicles (iv) and
 * petrol (v). Diesel is not in the list and is not blocked.
 *
 * A qualifying vehicle (low emissions, at least 60% business use) gives 20%
 * of the tax (s.59(2)(d)); whether a car qualifies turns on its registration
 * and use, which no invoice shows, so the vehicle rule says so. Disposing of
 * one within two years, or its business use falling below 60%, claws part of
 * that 20% back (s.62): `qualifyingVehicleClawback`.
 *
 * These replace the as-enacted s.59/s.60 rules (`vat.input_deduction_general`,
 * `vat.deduction_exclusions_entertainment`), whose stored rows are retired.
 */
import type { IrishRuleCondition } from '@/db/schema';
import type { CuratedVatScopeRule } from './vatScopeCuration';

const VATCA_COMMENCEMENT = '2010-11-01';
const desc = (value: string): IrishRuleCondition => ({ field: 'description', operator: 'matches', value });
const is = (field: string, value: string): IrishRuleCondition => ({ field, operator: 'equals', value });

export const INPUT_DEDUCTION_RULE_KEY = 'vat.input_deduction_taxable_use';
export const BLOCKED_FOOD_RULE_KEY = 'vat.blocked_food_drink_accommodation';
export const BLOCKED_ENTERTAINMENT_RULE_KEY = 'vat.blocked_entertainment';
export const BLOCKED_MOTOR_VEHICLE_RULE_KEY = 'vat.blocked_motor_vehicle';
export const BLOCKED_PETROL_RULE_KEY = 'vat.blocked_petrol';
export const QUALIFYING_VEHICLE_DISPOSAL_RULE_KEY = 'vat.qualifying_vehicle_disposal';
export const INVOICE_PARTICULARS_RULE_KEY = 'vat.invoice_prescribed_particulars';
export const CREDIT_NOTE_RULE_KEY = 'vat.credit_note_reduces_deduction';

/** The s.60(2)(a) blocks: when one matches, the general s.59 deduction does not apply. */
export const BLOCKED_DEDUCTION_RULE_KEYS = [
  BLOCKED_FOOD_RULE_KEY, BLOCKED_ENTERTAINMENT_RULE_KEY, BLOCKED_MOTOR_VEHICLE_RULE_KEY, BLOCKED_PETROL_RULE_KEY,
];

/** The as-enacted rules these replace; deriving retires their stored rows. */
export const RETIRED_INPUT_RECOVERY_RULE_KEYS = ['vat.input_deduction_general', 'vat.deduction_exclusions_entertainment'];

type Rule = Omit<CuratedVatScopeRule, 'ruleType' | 'topic' | 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'effectiveFrom' | 'treatment' | 'exceptions'>
  & Partial<Pick<CuratedVatScopeRule, 'crossReferences' | 'accountingEffect' | 'reportingEffect' | 'exceptions'>>;
const rule = (r: Rule): CuratedVatScopeRule => ({
  ruleType: 'other', topic: 'vat_scope', crossReferences: [], accountingEffect: null, reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT, treatment: null, exceptions: [], ...r,
});
const S60 = { citation: '2010 Act 31 s.60', sectionNumber: '60' } as const;
const purchase = is('direction', 'purchase');

export const INPUT_RECOVERY_CURATED_RULES: CuratedVatScopeRule[] = [
  rule({
    citation: '2010 Act 31 s.59', sectionNumber: '59', ruleKey: INPUT_DEDUCTION_RULE_KEY,
    name: 'Input VAT deductible on goods and services used for taxable supplies, charged by invoice (s.59(2))',
    statementExcerpt: 'services are used by him or her for the purposes of his or her taxable supplies or',
    conditions: [purchase, is('vatRegistered', 'true'), is('invoiceAvailable', 'true')],
    exceptions: [
      { condition: 'the cost is one s.60(2)(a) lists', effect: 'no deduction' },
      { condition: 'the cost is used for both taxable and exempt activities', effect: 'only the s.61 proportion is deductible' },
    ],
    crossReferences: ['VATCA 2010 s.60', 'VATCA 2010 s.61', 'S.I. 639/2010 reg.20 (the invoice)'],
    vatEffect: 'The VAT on the invoice is deductible (T2) in so far as the cost is used for taxable supplies.',
    interpretationNote: 'Whether the cost is used for taxable supplies is the person\'s confirmation on each line.',
  }),
  rule({
    ...S60, ruleKey: BLOCKED_FOOD_RULE_KEY,
    name: 'No deduction: food, drink, accommodation or other personal services (s.60(2)(a)(i))',
    statementExcerpt: 'accountable person on food or drink, or accommodation (other than qualifying',
    conditions: [purchase, desc('\\b(food|drinks?|meals?|lunch|dinner|breakfast|restaurant|cafe|coffee|catering|hotel|'
      + 'accommodation|b&b|bed and breakfast|subsistence|canteen)\\b')],
    exceptions: [
      { condition: 'qualifying accommodation for attending a qualifying conference (s.60(1))', effect: 'the accommodation is deductible' },
      { condition: 'the company itself supplies food, drink or accommodation and charges VAT on it', effect: 'deductible' },
    ],
    vatEffect: 'The VAT is not deductible; it is part of the cost.',
    interpretationNote: 'Read from the invoice line wording.',
  }),
  rule({
    ...S60, ruleKey: BLOCKED_ENTERTAINMENT_RULE_KEY,
    name: 'No deduction: entertainment (s.60(2)(a)(iii))',
    statementExcerpt: 'expenses incurred by the accountable person, his or her agents or his or her',
    conditions: [purchase, desc('\\b(entertainment|entertaining|hospitality|client dinner|staff party|christmas party|'
      + 'corporate box|golf outing|tickets for clients)\\b')],
    vatEffect: 'The VAT is not deductible; it is part of the cost.',
    interpretationNote: 'Read from the invoice line wording.',
  }),
  rule({
    ...S60, ruleKey: BLOCKED_MOTOR_VEHICLE_RULE_KEY,
    name: 'No deduction: purchase or hire of a motor vehicle (car) (s.60(2)(a)(iv)), unless a qualifying vehicle (20%)',
    statementExcerpt: 'acquisition or importation of motor vehicles otherwise than as stock-in-trade or',
    conditions: [purchase, desc('\\b((purchase|lease|leasing|hire|rental) of (a )?(car|motor car|passenger vehicle)|car (lease|leasing|hire|rental|purchase)|'
      + 'new car)\\b')],
    exceptions: [
      { condition: 'a qualifying vehicle: first registered from 2021 with CO2 under 140g/km (2009-2020: under 156g/km), used at '
        + 'least 60% for business (s.59(1), (2)(d))', effect: '20% of the VAT is deductible' },
      { condition: 'bought as stock-in-trade, or for a car-hire or driving-school business', effect: 'deductible in full' },
      { condition: 'a van or other commercial vehicle (not a "motor vehicle" as s.60(1) defines it)', effect: 'deductible in full' },
    ],
    vatEffect: 'The VAT is not deductible, unless the car is a qualifying vehicle (20%).',
    interpretationNote: 'The car\'s registration, emissions and business use are not on the invoice: the 20% case is named '
      + 'in the review reason.',
  }),
  rule({
    ...S60, ruleKey: BLOCKED_PETROL_RULE_KEY,
    name: 'No deduction: petrol (s.60(2)(a)(v)). Diesel is not blocked',
    statementExcerpt: 'intra-Community acquisition or importation of petrol otherwise than as',
    conditions: [purchase, desc('\\b(petrol|unleaded)\\b')],
    exceptions: [{ condition: 'petrol bought as stock-in-trade', effect: 'deductible' }],
    vatEffect: 'The VAT on petrol is not deductible. Diesel, and fuel other than petrol, is deductible in so far as it is '
      + 'used for taxable supplies.',
    interpretationNote: 'Read from the invoice line wording.',
  }),
  rule({
    citation: 'VATCA 2010 s.62', sectionNumber: '62', ruleKey: QUALIFYING_VEHICLE_DISPOSAL_RULE_KEY,
    name: 'A qualifying vehicle sold within 2 years, or used under 60% for business: part of the 20% is repaid (s.62)',
    statementExcerpt: 'TD × (4 — N)',
    conditions: [desc('\\b((sale|disposal|trade[- ]?in) of (the )?(car|vehicle|company car))\\b')],
    vatEffect: 'The deduction taken is reduced by TD x (4 - N) / 4, N being the half-years (182 days) held, at most 4.',
    interpretationNote: 'Advisory: applies only where 20% was deducted under s.59(2)(d).',
  }),
  rule({
    citation: '2010 Act 31 s.66', sectionNumber: '66', ruleKey: INVOICE_PARTICULARS_RULE_KEY,
    name: 'The invoice must carry the particulars specified by regulations (s.66(1), S.I. 639/2010 reg.20(2))',
    statementExcerpt: 'particulars as may be specified by regulations.',
    conditions: [purchase, is('invoiceAvailable', 'true')],
    crossReferences: ['S.I. 639/2010 reg.20(2)', 'VATCA 2010 s.59(2)(a)'],
    vatEffect: 'Input VAT is deducted only on an invoice with the prescribed particulars; posting a confirmed purchase '
      + 'invoice checks them (missingInvoiceParticulars) and holds the VAT back when one is missing.',
    interpretationNote: 'Enforced when a confirmed document is posted, not by matching words.',
  }),
  rule({
    citation: 'VATCA 2010 s.67', sectionNumber: '67', ruleKey: CREDIT_NOTE_RULE_KEY,
    name: 'A credit note received reduces the deduction by the tax shown on it (s.67(1)(b)(ii))',
    statementExcerpt: 'be reduced by the amount of tax shown on that credit',
    conditions: [purchase, desc('\\bcredit note\\b')],
    exceptions: [{ condition: 'the parties agreed the tax stated stays unaltered (s.67(5))', effect: 'the deduction is not reduced' }],
    crossReferences: ['VATCA 2010 s.69(1)(b)', 'S.I. 639/2010 reg.23 (time limits)'],
    vatEffect: 'The input VAT is reduced by the tax on the credit note, in the period the credit note is received.',
    interpretationNote: 'Posting a confirmed credit note links it to its original invoice and flags a credit that exceeds '
      + 'it, credits another rate, or shows no VAT (creditNoteFindings).',
  }),
  rule({
    citation: '2010 Act 31 s.61', sectionNumber: '61', ruleKey: 'vat.dual_use_apportionment',
    name: 'VAT on costs used for both taxable and exempt supplies is deductible in proportion (s.61)',
    statementExcerpt: 'person in a taxable period shall be calculated on the basis of the ratio which the',
    conditions: [],
    crossReferences: ['S.I. 639/2010 reg.17 (review period adjustment)'],
    vatEffect: 'Deductible only in the proportion of deductible supplies, by default on turnover for the accounting year.',
    interpretationNote: 'No conditions: citable, never matched. Validating a VAT period computes the turnover proportion '
      + 'and flags it when the company makes both exempt and taxable supplies (apportionmentFindings).',
  }),
  rule({
    citation: 'VATCA 2010 s.69', sectionNumber: '69', ruleKey: 'vat.invoice_tax_stated_in_error',
    name: 'An invoice stating more tax than is due, or a credit note stating less: the issuer is liable for the difference (s.69(1))',
    statementExcerpt: 'invoice stating a greater amount of tax than that properly attributable to the',
    conditions: [],
    vatEffect: 'The issuer pays the excess stated; the recipient deducts only the tax properly chargeable.',
    interpretationNote: 'No conditions: citable, never matched. The rate charged on each confirmed line is checked '
      + '(lineRateCheck) and a VAT figure the rate does not support is held back from recovery.',
  }),
  rule({
    citation: 'VATCA 2010 s.70', sectionNumber: '70', ruleKey: 'vat.invoice_time_limit',
    name: 'Invoices are issued within 15 days after the end of the month of supply (s.70(1), S.I. 639/2010 reg.23)',
    statementExcerpt: 'to be issued in accordance with this Chapter shall be issued within such time',
    conditions: [],
    vatEffect: 'A sales invoice issued later than 15 days after the month of supply is late; the VAT is still due for the '
      + 'period of the supply.',
    interpretationNote: 'No conditions: citable, never matched. A confirmed sales invoice issued late is flagged '
      + '(invoice_issued_late).',
  }),
];

export const INPUT_RECOVERY_REASONS: Record<string, string> = {
  [BLOCKED_MOTOR_VEHICLE_RULE_KEY]: 'VAT on buying or hiring a car is not deductible (s.60(2)(a)(iv)), unless it is a '
    + 'qualifying vehicle: first registered from 2021 with CO2 under 140g/km, used at least 60% for business. Then 20% '
    + 'of the VAT is deductible (s.59(2)(d)); no treatment models the 20%, so record it with your adviser. A van is '
    + 'not a "motor vehicle" here and is deductible in full.',
  [QUALIFYING_VEHICLE_DISPOSAL_RULE_KEY]: 'If 20% of the VAT on this car was deducted as a qualifying vehicle and it '
    + 'is disposed of within 2 years, part is repaid: TD x (4 - N) / 4, N being the complete 182-day periods held '
    + '(s.62(1)).',
};

/**
 * The reduction when a qualifying vehicle is disposed of within two years, or
 * its business use falls below 60% (s.62): TD x (4 - N) / 4, N being the days
 * held divided by 182 and rounded down, at most 4.
 */
export function qualifyingVehicleClawback(params: { taxDeductedMinor: number; acquiredOn: string; eventOn: string }): {
  n: number; reductionMinor: number;
} {
  const days = Math.round((Date.parse(`${params.eventOn}T00:00:00Z`) - Date.parse(`${params.acquiredOn}T00:00:00Z`)) / 86_400_000);
  if (days < 0) throw new Error('The disposal cannot be before the purchase.');
  const n = Math.min(4, Math.floor(days / 182));
  const numerator = params.taxDeductedMinor * (4 - n);
  // Round half away from zero, once, on the exact product.
  const reductionMinor = Math.sign(numerator) * Math.round(Math.abs(numerator) / 4);
  return { n, reductionMinor };
}

import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { ctDecisions } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';

/**
 * Decision subjects the CT / income-tax computations share (issue #211).
 *
 * Kept in its own module so a new subject (a tax election, a facts test) is a
 * small-file change: `computation.ts` is too large to merge or push as one
 * blob when two batches touch the same union.
 */

export type IncomeCase = 'case_i' | 'case_iii' | 'case_iv' | 'case_v';
export type ExpenseChoice =
  | 'add_back_entertainment' | 'staff_entertainment' | 'add_back_not_wholly_exclusively'
  | 'add_back_private' | 'add_back_capital' | 'deductible';

export const INCOME_CASES: Record<IncomeCase, string> = {
  case_i: 'Case I: trading income (12.5%)',
  case_iii: 'Case III: e.g. deposit interest, foreign income (25%)',
  case_iv: 'Case IV: e.g. royalties, miscellaneous income (25%)',
  case_v: 'Case V: rent from land in the State (25%)',
};

export const EXPENSE_CHOICES: Record<ExpenseChoice, { label: string; addBack: boolean; ruleKey: string | null }> = {
  add_back_entertainment: { label: 'Business entertainment or a gift: add back (s.840)', addBack: true, ruleKey: 'ct.business_entertainment_not_deductible' },
  staff_entertainment: { label: 'Entertainment for staff only: deductible (s.840(1))', addBack: false, ruleKey: 'ct.staff_entertainment_deductible' },
  add_back_not_wholly_exclusively: { label: 'Not wholly and exclusively for the trade: add back (s.81(2)(a))', addBack: true, ruleKey: 'ct.not_wholly_and_exclusively' },
  add_back_private: { label: 'Private or domestic: add back (s.81(2)(b))', addBack: true, ruleKey: 'ct.private_or_domestic' },
  add_back_capital: { label: 'Capital expenditure: add back (s.81(2)(f))', addBack: true, ruleKey: 'ct.capital_expenditure_not_deductible' },
  deductible: { label: 'A deductible trading expense', addBack: false, ruleKey: null },
};

export type CtSubjectType = 'journal_line' | 'income_account' | 'loss_claim' | 'company_status'
  | 'trading_company' | 'basis_election' | 'allowance_loss_election' | 'personal_status' | 'income_tax_loss_claim';
export type LossClaim = 'carry_forward' | 'claim_396a' | 'claim_396a_396b';
export type IncomeTaxLossClaim = 'carry_forward' | 'claim_381';
export type BasisElection = 'elect' | 'decline';
export type AllowanceLossElection = 'elect' | 'decline';
export type CompanyStatus = 'close_trading' | 'close_service' | 'not_close';
export type TradingCompanyStatus = 'trading' | 'not_trading';

export const LOSS_CLAIMS: Record<LossClaim, string> = {
  carry_forward: 'Carry the loss forward against later profits of the trade (s.396(1))',
  claim_396a: 'Set it against trading income of this and the preceding period (s.396A), the rest carried forward',
  claim_396a_396b: 'As s.396A, then the rest against tax on other income at 12.5% (s.396B)',
};

export const COMPANY_STATUSES: Record<CompanyStatus, string> = {
  close_trading: 'A close company (s.430): surcharge on undistributed investment and estate income (s.440)',
  close_service: 'A close service company (s.441): surcharge also on half of undistributed trading income',
  not_close: 'Not a close company: no surcharge',
};

/** Whether the company exists wholly or mainly to trade (s.434(5A)(b)): a facts
 *  test, suggested from the income split but decided by a person (issue #494). */
export const TRADING_COMPANY_STATUSES: Record<TradingCompanyStatus, string> = {
  trading: 'A trading company: the s.434(5A)(b) reduction of distributable investment and estate income applies',
  not_trading: 'Not wholly or mainly a trading company: no s.434(5A)(b) reduction',
};

/** An individual's claim on their own trading loss (TCA Part 12). */
export const INCOME_TAX_LOSS_CLAIMS: Record<IncomeTaxLossClaim, string> = {
  carry_forward: 'Carry the loss forward against later profits of the same trade (s.382), which is done automatically',
  claim_381: 'Claim it against other income of the same year (s.381); the amount set against it is the person\'s own figure',
};

/** The s.66(3) third-year excess relief (issue #485): elective, so a person elects or declines. */
export const BASIS_ELECTIONS: Record<BasisElection, string> = {
  elect: 'Elect to reduce the third year’s assessment by the second year’s excess (s.66(3))',
  decline: 'No election: the third year is assessed without the s.66(3) reduction',
};

/** The s.392 election (issue #467): whether capital allowances that create or increase a
 *  loss are treated as a trading loss the person may set against other income. */
export const ALLOWANCE_LOSS_ELECTIONS: Record<AllowanceLossElection, string> = {
  elect: 'Elect to treat the allowances as creating or increasing a trading loss (s.392)',
  decline: 'No election: unused allowances are carried forward as allowances (s.304(2)), not as a loss',
};

export const SUBJECT_CHOICES: Record<CtSubjectType, string[]> = {
  journal_line: Object.keys(EXPENSE_CHOICES),
  income_account: Object.keys(INCOME_CASES),
  loss_claim: Object.keys(LOSS_CLAIMS),
  company_status: Object.keys(COMPANY_STATUSES),
  trading_company: Object.keys(TRADING_COMPANY_STATUSES),
  basis_election: Object.keys(BASIS_ELECTIONS),
  allowance_loss_election: Object.keys(ALLOWANCE_LOSS_ELECTIONS),
  personal_status: ['single', 'single_parent', 'married_one_income', 'married_two_incomes'],
  income_tax_loss_claim: Object.keys(INCOME_TAX_LOSS_CLAIMS),
};

/** Every subject the year-end action may record. Derived from SUBJECT_CHOICES so a new type cannot be omitted. */
export const CT_SUBJECT_TYPES = Object.keys(SUBJECT_CHOICES) as CtSubjectType[];

export function isCtSubjectType(value: string): value is CtSubjectType {
  return value in SUBJECT_CHOICES;
}

export interface CtPendingDecision {
  subjectType: CtSubjectType;
  subjectId: string;
  description: string;
  amountMinor: number;
  /** The treatment used until a person decides. */
  suggested: string;
  options: Array<{ choice: string; label: string }>;
  reason: string;
  /** The decision on record, if any (then this is not pending). */
  decided: string | null;
  /** The amount recorded with the decision, where the books cannot know it (an s.381 claim). */
  decidedAmountMinor?: number | null;
}

/** The decision on record for a subject: the latest one not superseded. */
export function currentDecision(db: AppDatabase, companyId: string, subjectType: CtSubjectType, subjectId: string, periodEnd?: string) {
  return db.select().from(ctDecisions)
    .where(and(
      eq(ctDecisions.companyId, companyId), eq(ctDecisions.subjectType, subjectType), eq(ctDecisions.subjectId, subjectId),
      isNull(ctDecisions.supersededById),
      ...(periodEnd ? [eq(ctDecisions.periodEnd, periodEnd)] : []),
    )).get();
}

export class CtDecisionError extends Error {}

/** Record a person's choice. Any earlier choice for the same subject is kept and marked superseded. */
export function recordCtDecision(db: AppDatabase, params: {
  companyId: string; subjectType: CtSubjectType; subjectId: string; periodEnd: string;
  choice: string; decidedBy: string; note?: string;
  /**
   * The amount the claim uses, for an income tax loss claimed against other
   * income (s.381): the person's own figure, as their other income is not in
   * these books.
   */
  amountMinor?: number;
}): string {
  if (!params.decidedBy.trim()) throw new CtDecisionError('Say who is deciding: a tax treatment choice is a person\'s decision.');
  const allowed = SUBJECT_CHOICES[params.subjectType];
  if (!allowed.includes(params.choice)) {
    throw new CtDecisionError(`"${params.choice}" is not a choice here. Choose one of: ${allowed.join(', ')}.`);
  }
  let amountMinor = params.amountMinor ?? null;
  if (params.subjectType === 'income_tax_loss_claim' && params.choice === 'claim_381') {
    if (amountMinor === null || !Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new CtDecisionError('Say how much of the loss is set against other income (s.381): '
        + 'a whole number of cents, more than zero.');
    }
  } else {
    amountMinor = null;
  }
  const id = ids.ctDecision();
  db.transaction((tx) => {
    const previous = currentDecision(tx as unknown as AppDatabase, params.companyId, params.subjectType, params.subjectId,
      params.subjectType === 'journal_line' ? undefined : params.periodEnd);
    tx.insert(ctDecisions).values({
      id, companyId: params.companyId, subjectType: params.subjectType, subjectId: params.subjectId,
      periodEnd: params.periodEnd, choice: params.choice, decidedBy: params.decidedBy, decidedAt: nowIso(),
      note: params.note ?? null, amountMinor,
    }).run();
    if (previous) tx.update(ctDecisions).set({ supersededById: id }).where(eq(ctDecisions.id, previous.id)).run();
  });
  return id;
}

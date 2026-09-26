import { and, eq, gte, lte, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, journalLines, journalEntries, fixedAssets, ctDecisions, companies } from '@/db/schema';
import { trialBalance } from '../accounting/ledger';
import { multiplyRational } from '../money';
import { ids } from '@/lib/ids';
import { nowIso, type IsoDate } from '../dates';
import { accountingYearContaining } from '../vat/apportionment';
import {
  CT_RATE_TRADING_RULE_KEY, CT_RATE_HIGHER_RULE_KEY, CORPORATION_TAX_CURATED_RULES,
  corporationTaxRateBasisPoints, nfgCitation,
} from '../rules/corporationTaxCuration';

/**
 * The corporation tax computation for an accounting period (issue #211).
 *
 * Accounting profit, adjusted line by line to taxable profit, then charged at
 * the rates the statutory rules state: 12.5% on trading income (s.21), 25% on
 * Case III, IV and V income (s.21A). Every adjustment names the rule and
 * section behind it and the ledger entries it is made of.
 *
 * Where the books cannot settle a treatment (an expense that reads like
 * entertainment, a fine or a private cost; income that may not be trading
 * income) the computation takes a suggested treatment, says so, and offers
 * the alternatives. A person's choice is recorded with `recordCtDecision` and
 * replaces the suggestion. Nothing here is a filed figure: the findings say
 * what is not yet computed.
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

/** Words that suggest an expense line may not be deductible, with the treatment suggested and the options offered. */
const LINE_PATTERNS: Array<{ pattern: RegExp; suggested: ExpenseChoice; options: ExpenseChoice[]; why: string }> = [
  {
    pattern: /\b(entertain\w*|hospitality|dinner|lunch|restaurant|drinks|hamper|gifts?|christmas party|tickets?)\b/i,
    suggested: 'add_back_entertainment', options: ['add_back_entertainment', 'staff_entertainment', 'deductible'],
    why: 'reads like entertainment or a gift',
  },
  {
    pattern: /\b(fines?|penalt(y|ies)|parking|clamp\w*|speeding)\b/i,
    suggested: 'add_back_not_wholly_exclusively', options: ['add_back_not_wholly_exclusively', 'deductible'],
    why: 'reads like a fine or penalty',
  },
  {
    pattern: /\b(personal|private|domestic)\b/i,
    suggested: 'add_back_private', options: ['add_back_private', 'deductible'],
    why: 'reads like a private or domestic cost',
  },
];

export interface CtSource { entityType: 'account' | 'journal_line' | 'fixed_asset'; entityId: string; label: string; amountMinor: number }
export interface CtCitation { ruleKey: string; citation: string; section: string }

export interface CtLine {
  kind: 'add_back' | 'deduction' | 'income_excluded';
  label: string;
  amountMinor: number;
  citations: CtCitation[];
  sources: CtSource[];
  explanation: string;
}

export interface CtPendingDecision {
  subjectType: 'journal_line' | 'income_account';
  subjectId: string;
  description: string;
  amountMinor: number;
  /** The treatment used until a person decides. */
  suggested: string;
  options: Array<{ choice: string; label: string }>;
  reason: string;
  /** The decision on record, if any (then this is not pending). */
  decided: string | null;
}

export interface CtComputation {
  companyId: string;
  from: IsoDate;
  to: IsoDate;
  accountingProfitMinor: number;
  lines: CtLine[];
  /** Case I: trading profit after adjustments and capital allowances. */
  tradingProfitMinor: number;
  /** A trading loss, when the result is negative (not relieved here). */
  tradingLossMinor: number;
  nonTradingIncome: Array<{ incomeCase: IncomeCase; amountMinor: number; sources: CtSource[] }>;
  nonTradingIncomeMinor: number;
  taxAtStandardRateMinor: number;
  taxAtHigherRateMinor: number;
  corporationTaxMinor: number;
  rates: { standardBasisPoints: number; higherBasisPoints: number; citations: CtCitation[] };
  decisions: CtPendingDecision[];
  findings: string[];
}

const cite = (ruleKey: string): CtCitation => {
  const rule = CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === ruleKey);
  if (rule) return { ruleKey, citation: nfgCitation(rule.part), section: `TCA 1997 s.${rule.sectionNumber}` };
  // Capital allowances are cited from the as-enacted s.284 and FA 2003 s.23 rules.
  return { ruleKey, citation: ruleKey.startsWith('income_tax.wear') ? '1997 Act 39 s.284; 2003 Act 3 s.23' : ruleKey, section: '' };
};

const eur = (minor: number) => (minor / 100).toFixed(2);

/** The decision on record for a subject: the latest one not superseded. */
function currentDecision(db: AppDatabase, companyId: string, subjectType: 'journal_line' | 'income_account', subjectId: string, periodEnd?: string) {
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
  companyId: string; subjectType: 'journal_line' | 'income_account'; subjectId: string; periodEnd: string;
  choice: string; decidedBy: string; note?: string;
}): string {
  if (!params.decidedBy.trim()) throw new CtDecisionError('Say who is deciding: a tax treatment choice is a person\'s decision.');
  const allowed = params.subjectType === 'journal_line' ? Object.keys(EXPENSE_CHOICES) : Object.keys(INCOME_CASES);
  if (!allowed.includes(params.choice)) {
    throw new CtDecisionError(`"${params.choice}" is not a choice here. Choose one of: ${allowed.join(', ')}.`);
  }
  const id = ids.ctDecision();
  db.transaction((tx) => {
    const previous = currentDecision(tx as unknown as AppDatabase, params.companyId, params.subjectType, params.subjectId,
      params.subjectType === 'income_account' ? params.periodEnd : undefined);
    tx.insert(ctDecisions).values({
      id, companyId: params.companyId, subjectType: params.subjectType, subjectId: params.subjectId,
      periodEnd: params.periodEnd, choice: params.choice, decidedBy: params.decidedBy, decidedAt: nowIso(),
      note: params.note ?? null,
    }).run();
    if (previous) tx.update(ctDecisions).set({ supersededById: id }).where(eq(ctDecisions.id, previous.id)).run();
  });
  return id;
}

/** Whole accounting years from the end of the year an asset was bought to `to` (0 in the year of purchase). */
function claimIndex(db: AppDatabase, companyId: string, purchaseDate: string, to: string): number {
  const firstEnd = accountingYearContaining(db, companyId, purchaseDate).end;
  const years = Number(to.slice(0, 4)) - Number(firstEnd.slice(0, 4));
  return to.slice(5) >= firstEnd.slice(5) ? years : years - 1;
}

export function computeCorporationTax(db: AppDatabase, params: { companyId: string; from: IsoDate; to: IsoDate }): CtComputation {
  const { companyId, from, to } = params;
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new Error(`Company ${companyId} not found.`);
  const tb = trialBalance(db, { companyId, asOf: to, from, baseCurrency: company.baseCurrency });
  const pl = tb.rows.filter((r) => r.type === 'income' || r.type === 'expense');
  const accountingProfitMinor = pl.reduce((s, r) => s + (r.type === 'income' ? r.signedMinor : -r.signedMinor), 0);
  const accountRows = new Map(db.select().from(accounts).where(eq(accounts.companyId, companyId)).all().map((a) => [a.id, a]));

  const lines: CtLine[] = [];
  const decisions: CtPendingDecision[] = [];
  const findings: string[] = [];
  const accountSource = (r: (typeof pl)[number]): CtSource => ({ entityType: 'account', entityId: r.accountId, label: `${r.code} ${r.name}`, amountMinor: r.signedMinor });

  // ---- Income: trading, or taxed at the higher rate ----
  const nonTrading = new Map<IncomeCase, { amountMinor: number; sources: CtSource[] }>();
  for (const r of pl.filter((x) => x.type === 'income' && x.signedMinor !== 0)) {
    const account = accountRows.get(r.accountId)!;
    if (r.subtype === 'trading_income' || account.systemKey === 'rounding_difference') continue;
    const text = `${r.name} ${account.description ?? ''}`;
    const suggested: IncomeCase = account.systemKey === 'fx_gain_loss' || /exchange/i.test(r.name) ? 'case_i'
      : /interest|deposit/i.test(text) ? 'case_iii' : /rent/i.test(text) ? 'case_v' : 'case_iv';
    const decided = currentDecision(db, companyId, 'income_account', r.accountId, to)?.choice as IncomeCase | undefined;
    const incomeCase = decided ?? suggested;
    decisions.push({
      subjectType: 'income_account', subjectId: r.accountId, description: `${r.code} ${r.name}`, amountMinor: r.signedMinor,
      suggested, decided: decided ?? null,
      options: (Object.keys(INCOME_CASES) as IncomeCase[]).map((c) => ({ choice: c, label: INCOME_CASES[c] })),
      reason: 'Income outside the trading income accounts: it is trading income taxed at 12.5% only if it arises from '
        + 'the trade; interest, other miscellaneous income and Irish rents are charged at 25% (s.21A).',
    });
    if (incomeCase === 'case_i') continue;
    const bucket = nonTrading.get(incomeCase) ?? { amountMinor: 0, sources: [] };
    bucket.amountMinor += r.signedMinor;
    bucket.sources.push(accountSource(r));
    nonTrading.set(incomeCase, bucket);
    lines.push({
      kind: 'income_excluded', label: `Deduct: ${r.code} ${r.name}, taxed separately under ${incomeCase.replace('_', ' ').toUpperCase()}`,
      amountMinor: -r.signedMinor, citations: [cite(CT_RATE_HIGHER_RULE_KEY), cite('ct.income_tax_principles')],
      sources: [accountSource(r)],
      explanation: 'Taken out of trading profit and charged at the higher rate below. Expenses of earning it are not '
        + 'deducted from it here; check them (for rents, Case V allows certain deductions).',
    });
  }

  // ---- Whole accounts added back ----
  for (const r of pl.filter((x) => x.type === 'expense' && x.signedMinor !== 0)) {
    const account = accountRows.get(r.accountId)!;
    if (account.systemKey === 'depreciation_expense' || /depreciation|amortisation/i.test(r.name)) {
      lines.push({
        kind: 'add_back', label: `Add back: ${r.code} ${r.name}`, amountMinor: r.signedMinor,
        citations: [cite('ct.deduction_only_if_authorised')], sources: [accountSource(r)],
        explanation: 'Depreciation is not a deduction the Tax Acts allow (s.81(1)); capital allowances are given instead.',
      });
    } else if (account.systemKey === 'disposal_of_assets' || /disposal of fixed assets/i.test(r.name)) {
      lines.push({
        kind: 'add_back', label: `Add back: ${r.code} ${r.name}`, amountMinor: r.signedMinor,
        citations: [cite('ct.capital_expenditure_not_deductible')], sources: [accountSource(r)],
        explanation: 'A loss on disposing of a fixed asset is capital (s.81(2)(f)). Any balancing allowance or charge '
          + '(s.288) is not yet computed.',
      });
    } else if (/corporation tax|income tax/i.test(r.name)) {
      lines.push({
        kind: 'add_back', label: `Add back: ${r.code} ${r.name}`, amountMinor: r.signedMinor,
        citations: [cite('ct.taxes_on_income_not_deductible')], sources: [accountSource(r)],
        explanation: 'Taxes on income are not deductible (s.81(2)(p)).',
      });
    } else if (/below capitalisation threshold/i.test(r.name)) {
      findings.push(`${r.code} ${r.name} (${eur(r.signedMinor)}) is deducted as revenue expenditure. An item of capital `
        + 'is not deductible however small (s.81(2)(f)); it may qualify for capital allowances instead. Check the items.');
    }
  }

  // ---- Expense lines that may not be deductible ----
  const wholeAccountKeys = new Set(lines.flatMap((l) => l.sources.filter((s) => s.entityType === 'account').map((s) => s.entityId)));
  const expenseLines = db.select({ line: journalLines, entry: journalEntries, account: accounts })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.companyId, companyId), eq(accounts.type, 'expense'),
      gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
    .all();
  const byChoice = new Map<ExpenseChoice, { amountMinor: number; sources: CtSource[] }>();
  for (const { line, entry, account } of expenseLines) {
    if (wholeAccountKeys.has(account.id)) continue;
    const amount = line.baseDebitMinor - line.baseCreditMinor;
    if (amount === 0) continue;
    const text = `${entry.narrative} ${line.memo ?? ''}`;
    const match = LINE_PATTERNS.find((p) => p.pattern.test(text));
    const decided = currentDecision(db, companyId, 'journal_line', line.id)?.choice as ExpenseChoice | undefined;
    if (!match && !decided) continue;
    const choice = decided ?? match!.suggested;
    const options = match?.options ?? (Object.keys(EXPENSE_CHOICES) as ExpenseChoice[]);
    decisions.push({
      subjectType: 'journal_line', subjectId: line.id, description: `${entry.entryDate} ${account.code} ${account.name}: ${text.trim()}`,
      amountMinor: amount, suggested: match?.suggested ?? 'deductible', decided: decided ?? null,
      options: options.map((c) => ({ choice: c, label: EXPENSE_CHOICES[c].label })),
      reason: match ? `The description ${match.why}.` : 'Decided by a person.',
    });
    if (!EXPENSE_CHOICES[choice].addBack) continue;
    const bucket = byChoice.get(choice) ?? { amountMinor: 0, sources: [] };
    bucket.amountMinor += amount;
    bucket.sources.push({ entityType: 'journal_line', entityId: line.id, label: `${entry.entryDate} ${text.trim()}`, amountMinor: amount });
    byChoice.set(choice, bucket);
  }
  for (const [choice, bucket] of byChoice) {
    const c = EXPENSE_CHOICES[choice];
    lines.push({
      kind: 'add_back', label: `Add back: ${c.label.replace(/: add back.*$/, '')}`, amountMinor: bucket.amountMinor,
      citations: c.ruleKey ? [cite(c.ruleKey)] : [], sources: bucket.sources,
      explanation: 'The lines listed, as suggested or as decided. Each can be changed on the decisions list.',
    });
  }

  // ---- Capital allowances (wear and tear) ----
  const assets = db.select().from(fixedAssets).where(and(eq(fixedAssets.companyId, companyId), lte(fixedAssets.purchaseDate, to))).all();
  const caSources: CtSource[] = [];
  let capitalAllowances = 0;
  for (const asset of assets) {
    if (asset.disposalDate && asset.disposalDate < from) continue;
    if (asset.disposalDate && asset.disposalDate <= to) {
      findings.push(`${asset.name} was disposed of on ${asset.disposalDate}: no wear and tear for the period; the balancing `
        + 'allowance or charge (s.288) is not yet computed.');
      continue;
    }
    const n = claimIndex(db, companyId, asset.purchaseDate, to);
    if (n < 0 || n >= asset.capitalAllowanceYears) continue;
    const annual = multiplyRational(asset.baseCostMinor, asset.capitalAllowanceRateBasisPoints, 10_000);
    const claimed = Math.min(annual, asset.baseCostMinor - multiplyRational(asset.baseCostMinor, asset.capitalAllowanceRateBasisPoints * n, 10_000));
    if (claimed <= 0) continue;
    capitalAllowances += claimed;
    caSources.push({ entityType: 'fixed_asset', entityId: asset.id, label: `${asset.name} (year ${n + 1} of ${asset.capitalAllowanceYears})`, amountMinor: claimed });
    if (/\b(car|van|vehicle|motor)\b/i.test(`${asset.name} ${asset.description ?? ''}`) || asset.assetCategory === 'motor_vehicles') {
      findings.push(`${asset.name} looks like a motor vehicle. Allowances on cars are limited by cost and emissions `
        + '(TCA Part 11, ss.373–380), which is not yet applied: check the claim.');
    }
  }
  if (capitalAllowances) {
    lines.push({
      kind: 'deduction', label: 'Deduct: capital allowances (wear and tear)', amountMinor: -capitalAllowances,
      citations: [cite('income_tax.wear_and_tear_allowance_qualifies'), cite('income_tax.wear_and_tear_rate_current')],
      sources: caSources,
      explanation: 'Each asset\'s configured rate (12.5% over 8 years for plant and machinery) for the years it has left.',
    });
  }

  // ---- Totals and rates ----
  const adjusted = accountingProfitMinor + lines.reduce((s, l) => s + l.amountMinor, 0);
  const tradingProfitMinor = Math.max(adjusted, 0);
  const tradingLossMinor = Math.max(-adjusted, 0);
  if (tradingLossMinor) {
    findings.push(`The trade made a loss of ${eur(tradingLossMinor)} for tax purposes. Loss relief (s.396, s.396A) is not `
      + 'yet computed: the loss is not set against other income here.');
  }
  const standard = corporationTaxRateBasisPoints(CT_RATE_TRADING_RULE_KEY);
  const higher = corporationTaxRateBasisPoints(CT_RATE_HIGHER_RULE_KEY);
  const nonTradingIncome = [...nonTrading].map(([incomeCase, b]) => ({ incomeCase, ...b }));
  const nonTradingIncomeMinor = nonTradingIncome.reduce((s, x) => s + x.amountMinor, 0);
  const taxAtStandardRateMinor = multiplyRational(tradingProfitMinor, standard, 10_000);
  const taxAtHigherRateMinor = multiplyRational(Math.max(nonTradingIncomeMinor, 0), higher, 10_000);

  const pending = decisions.filter((d) => !d.decided);
  if (pending.length) {
    findings.push(`${pending.length} treatment(s) are suggested, not decided: the figures use the suggestion until a person chooses.`);
  }
  findings.push('Not yet computed: balancing allowances and charges, motor vehicle limits, loss relief, close company '
    + 'surcharges and preliminary tax. Chargeable gains are not included.');

  return {
    companyId, from, to, accountingProfitMinor, lines, tradingProfitMinor, tradingLossMinor,
    nonTradingIncome, nonTradingIncomeMinor, taxAtStandardRateMinor, taxAtHigherRateMinor,
    corporationTaxMinor: taxAtStandardRateMinor + taxAtHigherRateMinor,
    rates: { standardBasisPoints: standard, higherBasisPoints: higher, citations: [cite(CT_RATE_TRADING_RULE_KEY), cite(CT_RATE_HIGHER_RULE_KEY)] },
    decisions, findings,
  };
}

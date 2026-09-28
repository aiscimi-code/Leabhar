import { and, eq, gte, lte, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, bankAccounts, companies, journalEntries, journalLines, loans } from '@/db/schema';
import { trialBalance, type AccountBalance } from '../accounting/ledger';
import { addDays, type IsoDate } from '../dates';
import { profitAndLoss } from './financial';

/**
 * Cash flow statement, indirect method (issue #553).
 *
 * Every figure is a balance movement on the ledger, per account, between the
 * two dates. Year-end closing entries are left out of the movements, as they
 * are out of the profit: the close only moves the result into reserves. The
 * statement is then checked against the movement in bank and cash, worked out
 * independently from the balances at each end of the period. A difference is
 * shown, never absorbed into a line.
 *
 * Classification, by account:
 *  - cash: the ledger accounts behind asset-type bank accounts, and the bank
 *    and cash system accounts;
 *  - investing: fixed asset accounts (cost and accumulated depreciation), with
 *    the depreciation charge and the profit or loss on disposal taken back out
 *    of the movement and added back in operating activities;
 *  - financing: equity (share capital, dividends, partners' accounts), loans
 *    (the loan register's accounts, non-current liabilities, loans due within
 *    a year, loan and credit card bank accounts) and the director's current
 *    account;
 *  - operating: every other balance sheet account, as a working capital line.
 */

export interface CashFlowLine {
  label: string;
  accountId?: string;
  /** Positive is cash in, negative cash out. */
  amountMinor: number;
  method: string;
}

export interface CashFlowSection {
  label: string;
  lines: CashFlowLine[];
  totalMinor: number;
}

export interface CashFlowStatement {
  companyId: string;
  from: IsoDate;
  to: IsoDate;
  currency: string;
  profitMinor: number;
  /** Depreciation and the loss (or profit) on disposal, added back. */
  nonCashItems: CashFlowLine[];
  workingCapital: CashFlowLine[];
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netCashFlowMinor: number;
  cash: {
    accounts: Array<{ accountId: string; code: string; name: string; openingMinor: number; closingMinor: number }>;
    openingMinor: number;
    closingMinor: number;
    movementMinor: number;
  };
  /** Net cash flow less the movement in bank and cash. Zero in a correct set of books. */
  differenceMinor: number;
  reconciles: boolean;
  findings: string[];
}

const FINANCING_KEYS = new Set(['directors_current_account', 'share_capital', 'retained_earnings', 'dividends_paid']);
/** Loans due within one year: seeded without a system key, reclassified from 2210 at each year end. */
const LOANS_WITHIN_A_YEAR_CODE = '2215';

export function cashFlowStatement(db: AppDatabase, params: { companyId: string; from: IsoDate; to: IsoDate }): CashFlowStatement {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);
  if (params.from > params.to) throw new Error('The cash flow period starts after it ends.');
  const currency = company.baseCurrency;

  const chart = db.select().from(accounts).where(eq(accounts.companyId, params.companyId)).all();
  const byId = new Map(chart.map((a) => [a.id, a]));
  const keyOf = (id: string) => byId.get(id)?.systemKey ?? null;

  const banks = db.select().from(bankAccounts).where(eq(bankAccounts.companyId, params.companyId)).all();
  const cashIds = new Set<string>();
  const borrowingIds = new Set<string>(db.select({ id: loans.accountId }).from(loans).where(eq(loans.companyId, params.companyId)).all().map((l) => l.id));
  for (const b of banks) {
    if (!b.accountId) continue;
    if (b.accountType === 'loan' || b.accountType === 'credit_card' || byId.get(b.accountId)?.type === 'liability') borrowingIds.add(b.accountId);
    else cashIds.add(b.accountId);
  }
  for (const a of chart) if (a.systemKey === 'bank_control' || a.systemKey === 'cash') cashIds.add(a.id);

  const movement = trialBalance(db, { companyId: params.companyId, from: params.from, asOf: params.to, baseCurrency: currency, excludeYearEndClose: true });
  const profit = profitAndLoss(db, { companyId: params.companyId, from: params.from, to: params.to }).netProfit.valueMinor;
  const label = (r: AccountBalance) => `${r.code} ${r.name}`;
  const moved = (r: AccountBalance) => r.netDebitMinor !== 0;

  const pl = movement.rows.filter((r) => (r.type === 'income' || r.type === 'expense') && moved(r));
  const depreciation = pl.filter((r) => keyOf(r.accountId) === 'depreciation_expense');
  const disposals = pl.filter((r) => keyOf(r.accountId) === 'disposal_of_assets');
  const nonCashItems: CashFlowLine[] = [
    ...depreciation.map((r) => ({ label: `Depreciation (${label(r)})`, accountId: r.accountId, amountMinor: r.netDebitMinor,
      method: 'The depreciation charged in the period. It reduced profit without any cash leaving, so it is added back.' })),
    ...disposals.map((r) => ({ label: r.netDebitMinor >= 0 ? `Loss on disposal (${label(r)})` : `Profit on disposal (${label(r)})`, accountId: r.accountId, amountMinor: r.netDebitMinor,
      method: 'The profit or loss on disposing of fixed assets. The cash received is an investing flow, so the book result is taken out of operating activities.' })),
  ];
  const nonCashTotal = nonCashItems.reduce((s, l) => s + l.amountMinor, 0);

  const findings: string[] = [];
  const workingCapital: CashFlowLine[] = [];
  const financing: CashFlowLine[] = [];
  let fixedAssetMovement = 0;
  const balanceRows = movement.rows.filter((r) => (r.type === 'asset' || r.type === 'liability' || r.type === 'equity') && moved(r) && !cashIds.has(r.accountId));
  for (const r of balanceRows) {
    const key = keyOf(r.accountId);
    const inflow = -r.netDebitMinor;
    if (r.type === 'asset' && (r.reportSection === 'fixed_assets' || r.subtype === 'fixed_asset')) {
      fixedAssetMovement += r.netDebitMinor;
    } else if (r.type === 'equity' || borrowingIds.has(r.accountId) || r.reportSection === 'long_term_liabilities'
      || r.subtype === 'non_current_liability' || r.code === LOANS_WITHIN_A_YEAR_CODE || (key && FINANCING_KEYS.has(key))) {
      financing.push({ label: label(r), accountId: r.accountId, amountMinor: inflow,
        method: r.type === 'equity'
          ? 'The movement on this equity account in the period: money put in by, or paid out to, the owners.'
          : 'The movement on this borrowing in the period: drawn down less repaid.' });
    } else {
      if (key === 'suspense') findings.push(`${label(r)} moved by ${(r.netDebitMinor / 100).toFixed(2)} in the period. Suspense is unclassified money: the cash flow shows it as an operating movement until it is cleared.`);
      workingCapital.push({ label: `${r.type === 'asset' ? '(Increase)/decrease' : 'Increase/(decrease)'} in ${label(r)}`, accountId: r.accountId, amountMinor: inflow,
        method: r.type === 'asset'
          ? 'The fall in this asset balance over the period (a rise is cash tied up, shown negative).'
          : 'The rise in this liability balance over the period (money not yet paid out; a fall is shown negative).' });
    }
  }

  const operatingTotal = profit + nonCashTotal + workingCapital.reduce((s, l) => s + l.amountMinor, 0);
  const operating: CashFlowSection = {
    label: 'Cash flows from operating activities',
    lines: [{ label: 'Profit for the period', amountMinor: profit, method: 'Net profit from the profit and loss account for the same period, before the year-end close.' },
      ...nonCashItems, ...workingCapital],
    totalMinor: operatingTotal,
  };

  // Investing: the fixed asset movement with the non-cash charges taken back
  // out, split into disposal proceeds (the cash debited in disposal journals)
  // and payments for fixed assets (the rest).
  const investingTotal = -fixedAssetMovement - nonCashTotal;
  const proceeds = disposalProceeds(db, params.companyId, params.from, params.to, cashIds);
  const investing: CashFlowSection = {
    label: 'Cash flows from investing activities',
    lines: [
      { label: 'Payments for fixed assets', amountMinor: investingTotal - proceeds,
        method: 'The movement on the fixed asset accounts (cost and accumulated depreciation), less the depreciation charged and the book result on disposals, less the disposal proceeds.' },
      ...(proceeds !== 0 ? [{ label: 'Proceeds from disposals of fixed assets', amountMinor: proceeds,
        method: 'The bank and cash debited by the fixed asset disposal journals in the period, less any of those journals reversed.' }] : []),
    ].filter((l) => l.amountMinor !== 0),
    totalMinor: investingTotal,
  };
  const financingSection: CashFlowSection = {
    label: 'Cash flows from financing activities', lines: financing, totalMinor: financing.reduce((s, l) => s + l.amountMinor, 0),
  };

  const netCashFlowMinor = operating.totalMinor + investing.totalMinor + financingSection.totalMinor;

  // The check: the movement in bank and cash, from the balances at each end.
  const opening = trialBalance(db, { companyId: params.companyId, asOf: addDays(params.from, -1), baseCurrency: currency, includeZeroBalances: true });
  const closing = trialBalance(db, { companyId: params.companyId, asOf: params.to, baseCurrency: currency, includeZeroBalances: true });
  const openingBy = new Map(opening.rows.map((r) => [r.accountId, r.netDebitMinor]));
  const cashAccounts = closing.rows.filter((r) => cashIds.has(r.accountId))
    .map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, openingMinor: openingBy.get(r.accountId) ?? 0, closingMinor: r.netDebitMinor }))
    .filter((r) => r.openingMinor !== 0 || r.closingMinor !== 0);
  const openingMinor = cashAccounts.reduce((s, a) => s + a.openingMinor, 0);
  const closingMinor = cashAccounts.reduce((s, a) => s + a.closingMinor, 0);
  const differenceMinor = netCashFlowMinor - (closingMinor - openingMinor);
  if (differenceMinor !== 0) {
    findings.push('The cash flow does not reconcile to the movement in bank and cash. Look for an entry to a bank or cash account dated in the period but outside the posted ledger, or a year-end closing entry touching a balance sheet account other than reserves.');
  }

  return {
    companyId: params.companyId, from: params.from, to: params.to, currency, profitMinor: profit,
    nonCashItems, workingCapital, operating, investing, financing: financingSection, netCashFlowMinor,
    cash: { accounts: cashAccounts, openingMinor, closingMinor, movementMinor: closingMinor - openingMinor },
    differenceMinor, reconciles: differenceMinor === 0, findings,
  };
}

function disposalProceeds(db: AppDatabase, companyId: string, from: IsoDate, to: IsoDate, cashIds: Set<string>): number {
  if (cashIds.size === 0) return 0;
  const rows = db.select({
    id: journalEntries.id, sourceType: journalEntries.sourceType, reversalOfId: journalEntries.reversalOfId,
    accountId: journalLines.accountId, debit: journalLines.baseDebitMinor, credit: journalLines.baseCreditMinor,
  }).from(journalLines).innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.isPosted, true), gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to),
      inArray(journalLines.accountId, [...cashIds]))).all();
  const reversedIds = rows.filter((r) => r.sourceType === 'reversal' && r.reversalOfId).map((r) => r.reversalOfId!);
  const reversedSources = reversedIds.length === 0 ? new Map<string, string>() : new Map(db.select({ id: journalEntries.id, sourceType: journalEntries.sourceType })
    .from(journalEntries).where(inArray(journalEntries.id, reversedIds)).all().map((e) => [e.id, e.sourceType]));
  let total = 0;
  for (const r of rows) {
    // A disposal journal debits the bank with the proceeds; an acquisition credits it.
    if (r.sourceType === 'fixed_asset') total += r.debit;
    else if (r.sourceType === 'reversal' && r.reversalOfId && reversedSources.get(r.reversalOfId) === 'fixed_asset') total -= r.credit;
  }
  return total;
}

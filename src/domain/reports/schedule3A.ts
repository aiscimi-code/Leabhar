import { and, eq, lte, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, bankAccounts, companies, loans, statementFormatMappings } from '@/db/schema';
import { ids } from '@/lib/ids';
import { trialBalance } from '../accounting/ledger';
import { addDays, isIsoDate, type IsoDate } from '../dates';
import { profitAndLoss, balanceSheet } from './financial';

/**
 * Companies Act 2014 Schedule 3A, Format 1 (issue #554): the balance sheet
 * (items A to H) and the profit and loss account (items 1 to 16) of a company
 * in the small companies regime, laid out from the ledger.
 *
 * Every heading is quoted from docs/statutes/companies-act-2014/schedule-3A.md
 * (a test checks each one). Each account is presented under a default item,
 * worked out from its type and system key, unless a person has mapped it to
 * another item from a date (`statement_format_mappings`, effective-dated).
 * The totals are the ledger's: the balance sheet's capital and reserves equal
 * the ledger's net assets, and item 16 equals the net profit. A difference is
 * shown, never absorbed.
 *
 * This lays out the primary statements only. The notes Schedule 3A requires,
 * and the directors' report, are not prepared here (issue #214).
 */

export class Schedule3AError extends Error {}

type Side = 'asset' | 'liability' | 'equity' | 'income' | 'expense' | 'computed';
interface ItemDef { code: string; heading: string; side: Side }

const bs = (code: string, heading: string): ItemDef => ({
  code, heading,
  side: code === 'D' || code === 'E' ? 'computed' : code.startsWith('A') || code.startsWith('B') ? 'asset' : code.startsWith('H') ? 'equity' : 'liability',
});

const CREDITORS = (letter: 'C' | 'F'): ItemDef[] => [
  bs(`${letter}.1`, 'Debenture loans'), bs(`${letter}.2`, 'Amounts owed to credit institutions'),
  bs(`${letter}.3`, 'Called-up share capital presented as a liability'), bs(`${letter}.4`, 'Payments received on account'),
  bs(`${letter}.5`, 'Trade creditors'), bs(`${letter}.6`, 'Bills of exchange payable'), bs(`${letter}.7`, 'Amounts owed to group undertakings'),
  bs(`${letter}.8`, 'Amounts owed to undertakings with which the company is linked by virtue of participating interests'),
  bs(`${letter}.9`, 'Other creditors including tax and social insurance'), bs(`${letter}.10`, 'Accruals'), bs(`${letter}.11`, 'Deferred income'),
];

/** Balance sheet, Format 1, in the order printed. Sub-headings (A.I, B.II, ...) and letters are headings; the rest take accounts. */
export const BALANCE_SHEET_FORMAT_1: ItemDef[] = [
  bs('A', 'Fixed Assets'),
  bs('A.I', 'Intangible assets'), bs('A.I.1', 'Development costs'), bs('A.I.2', 'Concessions, patents, licences, trade marks and similar rights and assets'),
  bs('A.I.3', 'Goodwill'), bs('A.I.4', 'Payments on account'),
  bs('A.II', 'Tangible assets'), bs('A.II.1', 'Investment property'), bs('A.II.2', 'Land and buildings'), bs('A.II.3', 'Plant and machinery'),
  bs('A.II.4', 'Fixtures, fittings, tools and equipment'), bs('A.II.5', 'Payments on account and assets in course of construction'),
  bs('A.III', 'Financial assets'), bs('A.III.1', 'Shares in group undertakings'), bs('A.III.2', 'Loans to group undertakings'),
  bs('A.III.3', 'Participating interests'), bs('A.III.4', 'Loans to undertakings with which the company is linked by virtue of participating interests'),
  bs('A.III.5', 'Other investments other than loans'), bs('A.III.6', 'Other loans'),
  bs('B', 'Current Assets'),
  bs('B.I', 'Stocks'), bs('B.I.1', 'Raw materials and consumables'), bs('B.I.2', 'Work in progress'), bs('B.I.3', 'Finished goods and goods for resale'),
  bs('B.I.4', 'Payments on account'),
  bs('B.II', 'Debtors'), bs('B.II.1', 'Trade debtors'), bs('B.II.2', 'Amounts owed by group undertakings'),
  bs('B.II.3', 'Amounts owed by undertakings with which the company is linked by virtue of participating interests'),
  bs('B.II.4', 'Other debtors'), bs('B.II.5', 'Called-up share capital not paid'), bs('B.II.6', 'Prepayments'), bs('B.II.7', 'Accrued income'),
  bs('B.III', 'Investments'), bs('B.III.1', 'Shares in group undertakings'), bs('B.III.2', 'Other investments'),
  bs('B.IV', 'Cash at bank and in hand'),
  bs('C', 'Creditors: Amounts falling due within one year'), ...CREDITORS('C'),
  bs('D', 'Net current assets (liabilities)'),
  bs('E', 'Total assets less current liabilities'),
  bs('F', 'Creditors: Amounts falling due after more than one year'), ...CREDITORS('F'),
  bs('G', 'Provisions for liabilities'), bs('G.1', 'Retirement benefit and similar obligations'), bs('G.2', 'Taxation, including deferred taxation'),
  bs('G.3', 'Other provisions for liabilities'),
  bs('H', 'Capital and reserves'), bs('H.I', 'Called-up share capital presented as equity'), bs('H.II', 'Share premium account'),
  bs('H.III', 'Revaluation reserve'),
  bs('H.IV', 'Other reserves'), bs('H.IV.1', 'Other undenominated capital'), bs('H.IV.2', 'Reserve for own shares held'),
  bs('H.IV.3', 'Reserves provided for by the constitution'), bs('H.IV.4', 'Other reserves including the fair value reserve'),
  bs('H.V', 'Profit or loss brought forward'), bs('H.VI', 'Profit or loss for the financial year'),
];

const pl = (code: string, heading: string, side: Side): ItemDef => ({ code, heading, side });

/** Profit and loss account, Format 1. Items 3, 14 and 16 are computed. */
export const PROFIT_AND_LOSS_FORMAT_1: ItemDef[] = [
  pl('1', 'Turnover', 'income'), pl('2', 'Cost of sales', 'expense'), pl('3', 'Gross profit or loss', 'computed'),
  pl('4', 'Distribution costs', 'expense'), pl('5', 'Administrative expenses', 'expense'), pl('6', 'Other operating income', 'income'),
  pl('7', 'Income from shares in group undertakings', 'income'), pl('8', 'Income from participating interests', 'income'),
  pl('9', 'Income from other financial assets', 'income'), pl('10', 'Other interest receivable and similar income', 'income'),
  pl('11', 'Value adjustments in respect of financial assets and investments held as current assets', 'expense'),
  pl('12', 'Interest payable and similar expenses', 'expense'), pl('13', 'Tax on profit or loss', 'expense'),
  pl('14', 'Profit or loss after taxation', 'computed'), pl('15', 'Other taxes not shown under the above items', 'expense'),
  pl('16', 'Profit or loss for the financial year', 'computed'),
];

const BS_BY_CODE = new Map(BALANCE_SHEET_FORMAT_1.map((i) => [i.code, i]));
const PL_BY_CODE = new Map(PROFIT_AND_LOSS_FORMAT_1.map((i) => [i.code, i]));
const hasChildren = (code: string) => BALANCE_SHEET_FORMAT_1.some((i) => i.code.startsWith(`${code}.`));
/** Items an account can be mapped to: not a heading with sub-items, not computed, and not H.VI (the year's result). */
export const MAPPABLE_BALANCE_SHEET_ITEMS = BALANCE_SHEET_FORMAT_1.filter((i) => i.side !== 'computed' && !hasChildren(i.code) && i.code !== 'H.VI').map((i) => i.code);
export const MAPPABLE_PROFIT_AND_LOSS_ITEMS = PROFIT_AND_LOSS_FORMAT_1.filter((i) => i.side !== 'computed').map((i) => i.code);

type AccountRow = typeof accounts.$inferSelect;

interface Classifiers { cashIds: Set<string>; borrowingIds: Set<string>; stockCodes: Set<string> }

function classifiers(db: AppDatabase, companyId: string, chart: AccountRow[]): Classifiers {
  const cashIds = new Set<string>(chart.filter((a) => a.systemKey === 'bank_control' || a.systemKey === 'cash').map((a) => a.id));
  const borrowingIds = new Set<string>(db.select({ id: loans.accountId }).from(loans).where(eq(loans.companyId, companyId)).all().map((l) => l.id));
  for (const b of db.select().from(bankAccounts).where(eq(bankAccounts.companyId, companyId)).all()) {
    if (!b.accountId) continue;
    if (b.accountType === 'loan' || b.accountType === 'credit_card') borrowingIds.add(b.accountId); else cashIds.add(b.accountId);
  }
  return { cashIds, borrowingIds, stockCodes: new Set(['1300', '1330', '1340']) };
}

/** The item an account is presented under when no person has mapped it. */
export function defaultFormatItem(account: AccountRow, c: Classifiers): string {
  const key = account.systemKey;
  const name = account.name.toLowerCase();
  switch (account.type) {
    case 'income':
      if (account.subtype === 'trading_income') return '1';
      if (/interest/.test(name)) return '10';
      return '6';
    case 'expense':
      if (account.subtype === 'cost_of_sales' || account.reportSection === 'cost_of_sales') return '2';
      if (account.subtype === 'finance_cost' || account.reportSection === 'finance_costs') return '12';
      if (/corporation tax|tax on profit/.test(name)) return '13';
      return '5';
    case 'equity':
      if (key === 'share_capital') return 'H.I';
      return 'H.V';
    case 'asset':
      if (account.subtype === 'fixed_asset' || account.reportSection === 'fixed_assets') {
        if (/land|building|slurry/.test(name)) return 'A.II.2';
        if (/plant|machinery|vehicle|motor|tractor/.test(name)) return 'A.II.3';
        return 'A.II.4';
      }
      if (c.cashIds.has(account.id)) return 'B.IV';
      if (key === 'stock_on_hand' || c.stockCodes.has(account.code)) return 'B.I.3';
      if (key === 'debtors') return 'B.II.1';
      if (key === 'prepayments') return 'B.II.6';
      return 'B.II.4';
    case 'liability': {
      const longTerm = account.subtype === 'non_current_liability' || account.reportSection === 'long_term_liabilities';
      const letter = longTerm ? 'F' : 'C';
      if (c.borrowingIds.has(account.id) || account.code === '2210' || account.code === '2215') return `${letter}.2`;
      if (key === 'creditors') return `${letter}.5`;
      if (key === 'accruals') return `${letter}.10`;
      return `${letter}.9`;
    }
    default:
      return 'B.II.4';
  }
}

/** The mapping in force for an account on a date: the latest override on or before it, if any. */
function overrideOn(db: AppDatabase, companyId: string, accountId: string, date: string) {
  return db.select().from(statementFormatMappings).where(and(
    eq(statementFormatMappings.companyId, companyId), eq(statementFormatMappings.accountId, accountId),
    lte(statementFormatMappings.effectiveFrom, date),
  )).orderBy(desc(statementFormatMappings.effectiveFrom), desc(statementFormatMappings.createdAt)).get();
}

/** Map an account to a Format 1 item from a date (issue #554). Earlier mappings are kept, and still apply before it. */
export function mapAccountToFormatItem(db: AppDatabase, params: {
  companyId: string; accountId: string; itemCode: string; effectiveFrom: string; note?: string | null; recordedBy: string;
}): { id: string } {
  if (!params.recordedBy.trim()) throw new Schedule3AError('Say who is mapping the account.');
  if (!isIsoDate(params.effectiveFrom)) throw new Schedule3AError('The mapping applies from a YYYY-MM-DD date.');
  const account = db.select().from(accounts).where(and(eq(accounts.id, params.accountId), eq(accounts.companyId, params.companyId))).get();
  if (!account) throw new Schedule3AError(`Account ${params.accountId} not found.`);
  const isPl = account.type === 'income' || account.type === 'expense';
  const allowed = isPl ? MAPPABLE_PROFIT_AND_LOSS_ITEMS : MAPPABLE_BALANCE_SHEET_ITEMS;
  if (!allowed.includes(params.itemCode)) {
    throw new Schedule3AError(`${params.itemCode} is not a ${isPl ? 'profit and loss' : 'balance sheet'} item an account can be mapped to. `
      + `Choose one of: ${allowed.join(', ')}.`);
  }
  const id = ids.statementFormatMapping();
  db.insert(statementFormatMappings).values({
    id, companyId: params.companyId, accountId: account.id, itemCode: params.itemCode, effectiveFrom: params.effectiveFrom,
    note: params.note ?? null, recordedBy: params.recordedBy,
  }).run();
  return { id };
}

export interface FormatAccount {
  accountId: string; code: string; name: string; amountMinor: number;
  source: 'default' | 'mapped';
  /** Set when the balance's sign put it under an item on the other side (a bank overdraft, say). */
  reclassifiedFrom?: string;
}

export interface FormatLine {
  code: string;
  heading: string;
  depth: number;
  amountMinor: number;
  /** Headings with sub-items and computed totals. */
  isTotal: boolean;
  accounts: FormatAccount[];
}

export interface Schedule3ABalanceSheet {
  companyId: string; currency: string; asOf: IsoDate; financialYearStart: IsoDate;
  lines: FormatLine[];
  totals: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H', number>;
  /** Fixed and current assets (A + B): the "balance sheet total" the size tests use. */
  balanceSheetTotalMinor: number;
  ledgerNetAssetsMinor: number;
  /** E − F − G less H. Zero when the layout holds together. */
  differenceMinor: number;
  reconciles: boolean;
  notes: string[];
}

export interface Schedule3AProfitAndLoss {
  companyId: string; currency: string; from: IsoDate; to: IsoDate;
  lines: FormatLine[];
  profitMinor: number;
  ledgerProfitMinor: number;
  differenceMinor: number;
  reconciles: boolean;
  notes: string[];
}

function context(db: AppDatabase, companyId: string) {
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new Schedule3AError(`Company ${companyId} not found.`);
  const chart = db.select().from(accounts).where(eq(accounts.companyId, companyId)).all();
  return { company, chart, byId: new Map(chart.map((a) => [a.id, a])), c: classifiers(db, companyId, chart) };
}

function notes(company: typeof companies.$inferSelect): string[] {
  const out = ['Laid out under Schedule 3A, Format 1, from the posted ledger. The notes to the financial statements are not prepared here.'];
  if (company.entityType !== 'company') out.unshift(`Schedule 3A applies to companies; this book is a ${company.entityType.replace('_', ' ')}. The layout is shown for reference only.`);
  return out;
}

export function schedule3ABalanceSheet(db: AppDatabase, params: { companyId: string; asOf: IsoDate; financialYearStart: IsoDate }): Schedule3ABalanceSheet {
  const { company, byId, c } = context(db, params.companyId);
  const currency = company.baseCurrency;
  // Balances without the year-end close: income and expense accounts then
  // hold every year's result, split below into brought forward and this year.
  const tb = trialBalance(db, { companyId: params.companyId, asOf: params.asOf, baseCurrency: currency, excludeYearEndClose: true });
  const byItem = new Map<string, FormatAccount[]>();
  const put = (code: string, a: FormatAccount) => byItem.set(code, [...(byItem.get(code) ?? []), a]);
  let pnlBefore = 0;
  for (const row of tb.rows) {
    const account = byId.get(row.accountId);
    if (!account || row.netDebitMinor === 0) continue;
    if (account.type === 'income' || account.type === 'expense') continue;
    const mapped = overrideOn(db, params.companyId, account.id, params.asOf);
    let code = mapped?.itemCode ?? defaultFormatItem(account, c);
    let side = BS_BY_CODE.get(code)!.side;
    let amount = side === 'asset' ? row.netDebitMinor : -row.netDebitMinor;
    let reclassifiedFrom: string | undefined;
    // No offsetting across the balance sheet: a current balance on the wrong
    // side is shown on the other side (an overdrawn bank is owed to the bank;
    // a director who owes the company is a debtor). Fixed assets keep their
    // accumulated depreciation, and equity stays equity.
    if (amount < 0 && (code.startsWith('B') || code.startsWith('C') || code.startsWith('F'))) {
      reclassifiedFrom = code;
      code = code.startsWith('B') ? (code === 'B.IV' ? 'C.2' : 'C.9') : 'B.II.4';
      side = BS_BY_CODE.get(code)!.side;
      amount = -amount;
    }
    put(code, { accountId: account.id, code: account.code, name: account.name, amountMinor: amount, source: mapped ? 'mapped' : 'default', ...(reclassifiedFrom ? { reclassifiedFrom } : {}) });
  }
  // The year's result and what came before it.
  const yearProfit = profitAndLoss(db, { companyId: params.companyId, from: params.financialYearStart, to: params.asOf }).netProfit.valueMinor;
  const before = trialBalance(db, { companyId: params.companyId, asOf: addDays(params.financialYearStart, -1), baseCurrency: currency, excludeYearEndClose: true });
  for (const row of before.rows) {
    const account = byId.get(row.accountId);
    if (account && (account.type === 'income' || account.type === 'expense')) pnlBefore -= row.netDebitMinor;
  }
  if (pnlBefore !== 0) put('H.V', { accountId: '', code: '', name: 'Results of earlier years not closed to reserves', amountMinor: pnlBefore, source: 'default' });
  const lines = layout(BALANCE_SHEET_FORMAT_1, byItem, { 'H.VI': yearProfit });
  const total = (code: string) => lines.find((l) => l.code === code)?.amountMinor ?? 0;
  const A = total('A'), B = total('B'), C = total('C'), F = total('F'), G = total('G'), H = total('H');
  const D = B - C, E = A + D;
  for (const l of lines) { if (l.code === 'D') l.amountMinor = D; if (l.code === 'E') l.amountMinor = E; }
  const ledger = balanceSheet(db, { companyId: params.companyId, asOf: params.asOf, financialYearStart: params.financialYearStart });
  const differenceMinor = (E - F - G) - H;
  const out = notes(company);
  if (ledger.netAssets.valueMinor !== E - F - G) out.push(`Net assets on this layout differ from the ledger balance sheet by ${((E - F - G - ledger.netAssets.valueMinor) / 100).toFixed(2)}.`);
  return {
    companyId: params.companyId, currency, asOf: params.asOf, financialYearStart: params.financialYearStart, lines,
    totals: { A, B, C, D, E, F, G, H }, balanceSheetTotalMinor: A + B, ledgerNetAssetsMinor: ledger.netAssets.valueMinor,
    differenceMinor, reconciles: differenceMinor === 0 && ledger.netAssets.valueMinor === E - F - G, notes: out,
  };
}

export function schedule3AProfitAndLoss(db: AppDatabase, params: { companyId: string; from: IsoDate; to: IsoDate }): Schedule3AProfitAndLoss {
  const { company, byId, c } = context(db, params.companyId);
  const currency = company.baseCurrency;
  const tb = trialBalance(db, { companyId: params.companyId, from: params.from, asOf: params.to, baseCurrency: currency, excludeYearEndClose: true });
  const byItem = new Map<string, FormatAccount[]>();
  for (const row of tb.rows) {
    const account = byId.get(row.accountId);
    if (!account || row.netDebitMinor === 0 || (account.type !== 'income' && account.type !== 'expense')) continue;
    const mapped = overrideOn(db, params.companyId, account.id, params.to);
    const code = mapped?.itemCode ?? defaultFormatItem(account, c);
    const side = PL_BY_CODE.get(code)!.side;
    const amount = side === 'income' ? -row.netDebitMinor : row.netDebitMinor;
    byItem.set(code, [...(byItem.get(code) ?? []), { accountId: account.id, code: account.code, name: account.name, amountMinor: amount, source: mapped ? 'mapped' : 'default' }]);
  }
  const v = (code: string) => (byItem.get(code) ?? []).reduce((s, a) => s + a.amountMinor, 0);
  const item3 = v('1') - v('2');
  const item14 = item3 - v('4') - v('5') + v('6') + v('7') + v('8') + v('9') + v('10') - v('11') - v('12') - v('13');
  const item16 = item14 - v('15');
  const lines = layout(PROFIT_AND_LOSS_FORMAT_1, byItem, { '3': item3, '14': item14, '16': item16 });
  const ledgerProfitMinor = profitAndLoss(db, { companyId: params.companyId, from: params.from, to: params.to }).netProfit.valueMinor;
  const differenceMinor = item16 - ledgerProfitMinor;
  return {
    companyId: params.companyId, currency, from: params.from, to: params.to, lines, profitMinor: item16, ledgerProfitMinor,
    differenceMinor, reconciles: differenceMinor === 0, notes: notes(company),
  };
}

/** Lines in format order: every letter heading, and any other item with a balance. */
function layout(items: ItemDef[], byItem: Map<string, FormatAccount[]>, computed: Record<string, number>): FormatLine[] {
  const sum = (code: string): number => {
    if (code in computed) return computed[code]!;
    const own = (byItem.get(code) ?? []).reduce((s, a) => s + a.amountMinor, 0);
    const children = items.filter((i) => i.code.startsWith(`${code}.`) && i.code.split('.').length === code.split('.').length + 1);
    return own + children.reduce((s, ch) => s + sum(ch.code), 0);
  };
  const lines: FormatLine[] = [];
  for (const item of items) {
    const depth = item.code.includes('.') ? item.code.split('.').length - 1 : 0;
    const isHeading = !/^\d+$/.test(item.code) && (depth === 0 || hasChildren(item.code));
    const amount = item.code in computed ? computed[item.code]! : sum(item.code);
    const accountsHere = byItem.get(item.code) ?? [];
    const alwaysShown = item.side === 'computed' || (depth === 0 && !/^\d+$/.test(item.code)) || item.code === '1' || item.code === '16';
    if (!alwaysShown && amount === 0 && accountsHere.length === 0) continue;
    lines.push({ code: item.code, heading: item.heading, depth, amountMinor: amount, isTotal: isHeading || item.side === 'computed', accounts: accountsHere });
  }
  return lines;
}

import { and, eq, sql, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, journalEntries, journalLines, companies } from '@/db/schema';
import { trialBalance, type AccountBalance } from '../accounting/ledger';
import { signedBalance } from '../config/chartOfAccounts';
import type { IsoDate } from '../dates';
import { explained, sumExplained, type Explained, type ExplainedSource } from './explain';

/**
 * Profit and loss, and balance sheet (README §33, §37).
 *
 * Both are derived entirely from journal lines, and both return `Explained`
 * trees rather than bare numbers, so README §53's chain works from any figure
 * downward without the UI needing report-specific drill-down code.
 */

export interface ProfitAndLoss {
  companyId: string;
  from: IsoDate;
  to: IsoDate;
  currency: string;
  revenue: Explained;
  costOfSales: Explained;
  grossProfit: Explained;
  operatingExpenses: Explained;
  operatingProfit: Explained;
  otherIncome: Explained;
  netProfit: Explained;
}

export function profitAndLoss(
  db: AppDatabase,
  params: { companyId: string; from: IsoDate; to: IsoDate },
): ProfitAndLoss {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);
  const currency = company.baseCurrency;

  const tb = trialBalance(db, {
    companyId: params.companyId, asOf: params.to, from: params.from, baseCurrency: currency,
  });

  const accountFigure = (row: AccountBalance): Explained => explained({
    label: `${row.code} ${row.name}`,
    valueMinor: row.signedMinor,
    currency,
    method: `Net of ${row.lineCount} journal line${row.lineCount === 1 ? '' : 's'} `
      + `posted to this account between ${params.from} and ${params.to}.`,
    sources: [{
      entityType: 'account', entityId: row.accountId,
      label: `${row.code} ${row.name}`, amountMinor: row.signedMinor,
    }],
    asOf: params.to,
  });

  const bySection = (section: string): Explained[] =>
    tb.rows.filter((r) => r.reportSection === section).map(accountFigure);

  const trading = tb.rows
    .filter((r) => r.type === 'income' && r.subtype === 'trading_income')
    .map(accountFigure);
  const other = tb.rows
    .filter((r) => r.type === 'income' && r.subtype !== 'trading_income')
    .map(accountFigure);

  const revenue = sumExplained({
    label: 'Revenue', currency, components: trading, asOf: params.to,
    method: 'The total credited to trading income accounts in the period.',
  });

  const costOfSales = sumExplained({
    label: 'Cost of sales', currency, components: bySection('cost_of_sales'), asOf: params.to,
    method: 'The total charged to cost-of-sales accounts in the period.',
  });

  const grossProfit = explained({
    label: 'Gross profit',
    valueMinor: revenue.valueMinor - costOfSales.valueMinor,
    currency, asOf: params.to,
    method: 'Revenue less cost of sales.',
    components: [revenue, costOfSales],
  });

  const operatingExpenses = sumExplained({
    label: 'Operating expenses', currency,
    components: bySection('operating_expenses'), asOf: params.to,
    method: 'The total charged to operating expense accounts in the period.',
  });

  const operatingProfit = explained({
    label: 'Operating profit',
    valueMinor: grossProfit.valueMinor - operatingExpenses.valueMinor,
    currency, asOf: params.to,
    method: 'Gross profit less operating expenses.',
    components: [grossProfit, operatingExpenses],
  });

  const otherIncome = sumExplained({
    label: 'Other income', currency, components: other, asOf: params.to,
    method: 'Income not arising from trading, including foreign exchange differences.',
  });

  const netProfit = explained({
    label: 'Net profit',
    valueMinor: operatingProfit.valueMinor + otherIncome.valueMinor,
    currency, asOf: params.to,
    method: 'Operating profit plus other income. This is the accounting profit, which '
      + 'is not the same as taxable profit — see the tax computation for the bridge '
      + 'between them.',
    components: [operatingProfit, otherIncome],
  });

  return {
    companyId: params.companyId, from: params.from, to: params.to, currency,
    revenue, costOfSales, grossProfit, operatingExpenses, operatingProfit,
    otherIncome, netProfit,
  };
}

export interface BalanceSheet {
  companyId: string;
  asOf: IsoDate;
  currency: string;
  fixedAssets: Explained;
  currentAssets: Explained;
  totalAssets: Explained;
  currentLiabilities: Explained;
  totalLiabilities: Explained;
  netAssets: Explained;
  shareCapital: Explained;
  retainedEarnings: Explained;
  profitForPeriod: Explained;
  totalEquity: Explained;
  /** Zero in a correct set of books. Anything else is a defect to investigate. */
  differenceMinor: number;
  balances: boolean;
}

/**
 * Balance sheet.
 *
 * Retained earnings are computed from accumulated profits rather than read from
 * the account, because income and expense accounts are not closed off into
 * reserves until year end. Presenting the raw account balance mid-year would
 * show a balance sheet that does not balance, and the user would have no way to
 * tell whether that was a bug or an accounting truth.
 */
export function balanceSheet(
  db: AppDatabase,
  params: { companyId: string; asOf: IsoDate; financialYearStart: IsoDate },
): BalanceSheet {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);
  const currency = company.baseCurrency;

  const tb = trialBalance(db, {
    companyId: params.companyId, asOf: params.asOf, baseCurrency: currency,
  });

  const figure = (row: AccountBalance): Explained => explained({
    label: `${row.code} ${row.name}`,
    valueMinor: row.signedMinor,
    currency,
    method: `The balance on this account at ${params.asOf}, from `
      + `${row.lineCount} journal line${row.lineCount === 1 ? '' : 's'}.`,
    sources: [{
      entityType: 'account', entityId: row.accountId,
      label: `${row.code} ${row.name}`, amountMinor: row.signedMinor,
    }],
    asOf: params.asOf,
  });

  const section = (name: string): Explained[] =>
    tb.rows.filter((r) => r.reportSection === name).map(figure);

  const fixedAssets = sumExplained({
    label: 'Fixed assets', currency, components: section('fixed_assets'), asOf: params.asOf,
    method: 'Cost less accumulated depreciation for each category of fixed asset.',
  });

  const currentAssets = sumExplained({
    label: 'Current assets', currency, components: section('current_assets'), asOf: params.asOf,
    method: 'Bank, cash, amounts owed by customers, VAT recoverable and prepayments.',
  });

  const totalAssets = explained({
    label: 'Total assets',
    valueMinor: fixedAssets.valueMinor + currentAssets.valueMinor,
    currency, asOf: params.asOf,
    method: 'Fixed assets plus current assets.',
    components: [fixedAssets, currentAssets],
  });

  const currentLiabilities = sumExplained({
    label: 'Current liabilities', currency,
    components: section('current_liabilities'), asOf: params.asOf,
    method: 'Amounts owed to suppliers, VAT, tax, and the director’s current account.',
  });

  const totalLiabilities = explained({
    label: 'Total liabilities',
    valueMinor: currentLiabilities.valueMinor,
    currency, asOf: params.asOf,
    method: 'Current liabilities.',
    components: [currentLiabilities],
  });

  const netAssets = explained({
    label: 'Net assets',
    valueMinor: totalAssets.valueMinor - totalLiabilities.valueMinor,
    currency, asOf: params.asOf,
    method: 'Total assets less total liabilities. This must equal total equity.',
    components: [totalAssets, totalLiabilities],
  });

  // ---- Equity ----
  const equityRows = tb.rows.filter((r) => r.type === 'equity');
  const shareCapitalRows = equityRows.filter((r) => r.reportSection === 'equity'
    && r.code.startsWith('30'));
  const retainedRows = equityRows.filter((r) => r.code.startsWith('31') || r.code.startsWith('32'));

  const shareCapital = sumExplained({
    label: 'Share capital', currency, components: shareCapitalRows.map(figure),
    asOf: params.asOf, method: 'Amounts subscribed by shareholders for their shares.',
  });

  const broughtForward = sumExplained({
    label: 'Retained earnings brought forward', currency,
    components: retainedRows.map(figure), asOf: params.asOf,
    method: 'Accumulated profits from prior years, as posted to reserves.',
  });

  // Profit earned since the start of the financial year, which is still sitting
  // in income and expense accounts rather than in reserves.
  const periodPl = profitAndLoss(db, {
    companyId: params.companyId, from: params.financialYearStart, to: params.asOf,
  });

  const profitForPeriod = explained({
    label: 'Profit for the period',
    valueMinor: periodPl.netProfit.valueMinor,
    currency, asOf: params.asOf,
    method: `Profit earned between ${params.financialYearStart} and ${params.asOf}, which `
      + 'sits in income and expense accounts until it is transferred to reserves at year end.',
    components: [periodPl.netProfit],
  });

  // Profits from years before this one that have not yet been journalled to
  // reserves; on a correctly closed set of books this is zero.
  const priorPeriodPl = profitAndLoss(db, {
    companyId: params.companyId, from: '1900-01-01' as IsoDate,
    to: previousDay(params.financialYearStart),
  });

  const retainedEarnings = explained({
    label: 'Retained earnings',
    valueMinor: broughtForward.valueMinor + priorPeriodPl.netProfit.valueMinor,
    currency, asOf: params.asOf,
    method: 'Reserves brought forward, plus any prior-year profit not yet transferred '
      + 'into reserves.',
    components: priorPeriodPl.netProfit.valueMinor === 0
      ? [broughtForward]
      : [broughtForward, priorPeriodPl.netProfit],
    notes: priorPeriodPl.netProfit.valueMinor !== 0
      ? ['Some prior-year profit has not been journalled into reserves. Run the year-end '
         + 'close for those years to tidy this up.']
      : [],
  });

  const totalEquity = explained({
    label: 'Total equity',
    valueMinor: shareCapital.valueMinor + retainedEarnings.valueMinor + profitForPeriod.valueMinor,
    currency, asOf: params.asOf,
    method: 'Share capital plus retained earnings plus profit for the period.',
    components: [shareCapital, retainedEarnings, profitForPeriod],
  });

  const differenceMinor = netAssets.valueMinor - totalEquity.valueMinor;

  return {
    companyId: params.companyId, asOf: params.asOf, currency,
    fixedAssets, currentAssets, totalAssets,
    currentLiabilities, totalLiabilities, netAssets,
    shareCapital, retainedEarnings, profitForPeriod, totalEquity,
    differenceMinor,
    balances: differenceMinor === 0,
  };
}

function previousDay(date: IsoDate): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10) as IsoDate;
}

/**
 * Drill from an account figure to the journal lines behind it, each carrying
 * enough identity for the UI to reach the transaction and its document.
 */
export function explainAccount(
  db: AppDatabase,
  params: { companyId: string; accountId: string; from?: IsoDate; to: IsoDate },
): Explained {
  const account = db.select().from(accounts)
    .where(and(eq(accounts.id, params.accountId), eq(accounts.companyId, params.companyId)))
    .get();
  if (!account) throw new Error(`Account ${params.accountId} not found.`);

  const company = db.select({ c: companies.baseCurrency }).from(companies)
    .where(eq(companies.id, params.companyId)).get();
  const currency = company?.c ?? 'EUR';

  const conditions = [
    eq(journalLines.accountId, params.accountId),
    eq(journalLines.companyId, params.companyId),
    eq(journalEntries.isPosted, true),
    lte(journalEntries.entryDate, params.to),
  ];
  if (params.from) conditions.push(gte(journalEntries.entryDate, params.from));

  const rows = db.select({
    lineId: journalLines.id,
    entryId: journalEntries.id,
    entryNumber: journalEntries.entryNumber,
    entryDate: journalEntries.entryDate,
    narrative: journalEntries.narrative,
    sourceType: journalEntries.sourceType,
    sourceId: journalEntries.sourceId,
    debit: journalLines.baseDebitMinor,
    credit: journalLines.baseCreditMinor,
  })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(journalEntries.entryDate, journalEntries.entryNumber)
    .all();

  const sources: ExplainedSource[] = rows.map((row) => ({
    entityType: row.sourceType === 'bank_transaction' ? 'bank_transaction'
      : row.sourceType === 'sales_invoice' || row.sourceType === 'purchase_invoice' ? 'invoice'
      : 'journal_entry',
    entityId: row.sourceId ?? row.entryId,
    label: `#${row.entryNumber} ${row.narrative}`,
    amountMinor: signedBalance(account.type, row.debit, row.credit),
    date: row.entryDate,
  }));

  const total = rows.reduce(
    (sum, row) => sum + signedBalance(account.type, row.debit, row.credit), 0,
  );

  return explained({
    label: `${account.code} ${account.name}`,
    valueMinor: total,
    currency,
    method: `The sum of ${rows.length} journal line${rows.length === 1 ? '' : 's'} posted `
      + `to this account${params.from ? ` between ${params.from} and ${params.to}` : ` up to ${params.to}`}.`,
    sources,
    asOf: params.to,
  });
}

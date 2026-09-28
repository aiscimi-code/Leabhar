import type { Explained } from '@/domain/reports/explain';
import type { ProfitAndLoss, BalanceSheet } from '@/domain/reports/financial';
import type { CashFlowStatement } from '@/domain/reports/cashFlow';
import type { ComparativeRow } from '@/domain/reports/analysis';
import type { TrialBalance } from '@/domain/accounting/ledger';

/**
 * The statements as printable lines (issue #553), shared by the spreadsheet
 * and PDF exports so the two lay out the same figures in the same order.
 * Every value is taken from what the domain returned; nothing is added up here.
 */

export interface StatementLine {
  label: string;
  depth: number;
  /** One value per column; null prints blank. */
  values: Array<number | null>;
  isTotal: boolean;
}

export interface StatementBlock {
  title: string;
  subtitle: string;
  columns: string[];
  lines: StatementLine[];
  notes: string[];
}

const line = (label: string, depth: number, value: number | null, isTotal = false): StatementLine => ({ label, depth, values: [value], isTotal });

function flatten(figure: Explained, depth = 0): StatementLine[] {
  return [
    line(figure.label, depth, figure.valueMinor),
    ...figure.components.filter((c) => c.components.length === 0).map((c) => line(c.label, depth + 1, c.valueMinor)),
  ];
}

export function profitAndLossBlock(pl: ProfitAndLoss): StatementBlock {
  return {
    title: 'Profit and loss account', subtitle: `${pl.from} to ${pl.to}`, columns: [`Amount (${pl.currency})`],
    lines: [
      ...flatten(pl.revenue), ...flatten(pl.costOfSales),
      line('Gross profit', 0, pl.grossProfit.valueMinor, true),
      ...flatten(pl.operatingExpenses),
      line('Operating profit', 0, pl.operatingProfit.valueMinor, true),
      ...(pl.otherIncome.components.length > 0 ? flatten(pl.otherIncome) : []),
      ...(pl.financeCosts.components.length > 0 ? flatten(pl.financeCosts) : []),
      line('Net profit', 0, pl.netProfit.valueMinor, true),
    ],
    notes: ['This is accounting profit. Taxable profit is a different figure; the year-end pack shows the bridge between them.'],
  };
}

export function balanceSheetBlock(bs: BalanceSheet): StatementBlock {
  return {
    title: 'Balance sheet', subtitle: `As at ${bs.asOf}`, columns: [`Amount (${bs.currency})`],
    lines: [
      ...flatten(bs.fixedAssets), ...flatten(bs.currentAssets),
      line('Total assets', 0, bs.totalAssets.valueMinor, true),
      ...flatten(bs.currentLiabilities),
      ...(bs.longTermLiabilities.components.length > 0 ? flatten(bs.longTermLiabilities) : []),
      line('Net assets', 0, bs.netAssets.valueMinor, true),
      line('Share capital', 0, bs.shareCapital.valueMinor),
      line('Retained earnings', 0, bs.retainedEarnings.valueMinor),
      line('Profit for the period', 0, bs.profitForPeriod.valueMinor),
      line('Total equity', 0, bs.totalEquity.valueMinor, true),
    ],
    notes: bs.balances ? ['Net assets equal total equity.']
      : [`THE BALANCE SHEET DOES NOT BALANCE. Difference: ${(bs.differenceMinor / 100).toFixed(2)}. This is a defect in the underlying entries; do not rely on these figures.`],
  };
}

export function cashFlowBlock(cf: CashFlowStatement): StatementBlock {
  const section = (s: CashFlowStatement['operating'], totalLabel: string): StatementLine[] => [
    line(s.label, 0, null),
    ...s.lines.map((l) => line(l.label, 1, l.amountMinor)),
    line(totalLabel, 0, s.totalMinor, true),
  ];
  return {
    title: 'Cash flow statement', subtitle: `${cf.from} to ${cf.to} (indirect method)`, columns: [`Amount (${cf.currency})`],
    lines: [
      ...section(cf.operating, 'Net cash from operating activities'),
      ...section(cf.investing, 'Net cash from investing activities'),
      ...section(cf.financing, 'Net cash from financing activities'),
      line('Net increase/(decrease) in cash', 0, cf.netCashFlowMinor, true),
      line('Cash and bank at the start of the period', 0, cf.cash.openingMinor),
      line('Cash and bank at the end of the period', 0, cf.cash.closingMinor, true),
    ],
    notes: [
      cf.reconciles ? 'The net cash flow equals the movement in bank and cash.'
        : `THE CASH FLOW DOES NOT RECONCILE to the movement in bank and cash. Difference: ${(cf.differenceMinor / 100).toFixed(2)}.`,
      ...cf.findings,
    ],
  };
}

export function comparativeBlock(title: string, rows: ComparativeRow[], current: string, prior: string, currency: string): StatementBlock {
  return {
    title, subtitle: `${current}, compared with ${prior}`, columns: [`Current (${currency})`, `Prior (${currency})`, 'Change'],
    lines: rows.map((r) => ({ label: r.label, depth: r.depth, values: [r.currentMinor, r.priorMinor, r.changeMinor], isTotal: r.isTotal })),
    notes: [],
  };
}

export function trialBalanceBlock(tb: TrialBalance, currency: string): StatementBlock {
  return {
    title: 'Trial balance', subtitle: `As at ${tb.asOf}`, columns: [`Debit (${currency})`, `Credit (${currency})`],
    lines: [
      ...tb.rows.map((r) => ({ label: `${r.code} ${r.name}`, depth: 0,
        values: [r.netDebitMinor > 0 ? r.netDebitMinor : null, r.netDebitMinor < 0 ? -r.netDebitMinor : null], isTotal: false })),
      { label: 'Total', depth: 0, values: [tb.netTotalDebitMinor, tb.netTotalCreditMinor], isTotal: true },
    ],
    notes: [tb.balanced ? 'Net debits equal net credits.' : 'NET DEBITS DO NOT EQUAL NET CREDITS.'],
  };
}

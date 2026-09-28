/**
 * Shared types for the cash flow forecast (epic #333, issues #565–#570).
 *
 * A forecast is a view beside the ledger. It never writes journals and never
 * changes an invoice or bank line. Every line carries its source, and says
 * whether it is an estimate and how it was worked out.
 *
 * Money is always in base-currency minor units (integers).
 */

import type { IsoDate } from '../dates';

/** Who produced the value on a forecast line. */
export type ForecastLineSource =
  /** An open invoice, a recurring invoice or bill, a purchase order, a posted payroll balance: facts in the books. */
  | 'ledger'
  /** A tax or payroll payment dated by a curated due-date rule. */
  | 'rule'
  /** A person's input: a scenario adjustment or a manual recurring item. */
  | 'assumption'
  /** A detected bank pattern that a person has confirmed. */
  | 'ai_suggestion';

/** What a line is, for the scenario adjustments and the page's grouping. */
export type ForecastCategory = 'receipt' | 'payment' | 'tax' | 'payroll' | 'recurring' | 'scenario';

export type ForecastGranularity = 'daily' | 'weekly' | 'monthly';
export type ReceiptBasis = 'due_date' | 'customer_history';
export type DueDateBasis = 'statutory' | 'ros';

/** Options for one forecast. The company's settings supply the defaults (settings.ts). */
export interface ForecastOptions {
  companyId: string;
  /** The date the forecast starts from. */
  asOf: IsoDate;
  horizonEnd: IsoDate;
  granularity: ForecastGranularity;
  receiptBasis: ReceiptBasis;
  /** Per-customer receipt delay in days, overriding the basis for that customer. */
  customerDelayDays?: Record<string, number>;
  includePurchaseOrders: boolean;
  /** Draft invoices, shown separately with their own running balance. */
  includeUnconfirmed: boolean;
  /** Sole traders: include the owner's income tax. */
  includeOwnerTax: boolean;
  /** Ledger account ids counted as cash; empty or null for the default bank and cash accounts. */
  cashAccountIds?: string[] | null;
  minimumCashMinor: number;
  dueDateBasis: DueDateBasis;
  /** Apply a scenario's adjustments over the base forecast. */
  scenarioId?: string | null;
}

export interface ForecastLine {
  /** Unique within the forecast. */
  key: string;
  /** When the cash is expected to move. Null for a payment with no curated due date (listed, never placed). */
  date: IsoDate | null;
  /** Positive is cash in; negative is cash out. Base minor units. */
  amountMinor: number;
  description: string;
  category: ForecastCategory;
  source: ForecastLineSource;
  isEstimate: boolean;
  /** How the date or the amount was worked out, when it is not a plain fact. */
  estimateBasis?: string;
  /** The rule a due date comes from. */
  ruleKey?: string;
  /** The customer or supplier, for scenario targeting. */
  partyId?: string | null;
  /** Due before the forecast date and not yet settled: shown on the forecast date. */
  overdue?: boolean;
  /** The date it was due, where the line is shown on another date. */
  dueDate?: IsoDate;
  /** A draft invoice: kept out of the main running balance. */
  isUnconfirmed?: boolean;
  entityRef?: { kind: string; id: string };
  /** The scenario that produced or changed this line. */
  scenarioName?: string;
}

export interface ForecastBucket {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  label: string;
  inflows: ForecastLine[];
  outflows: ForecastLine[];
  inflowMinor: number;
  outflowMinor: number;
  netMinor: number;
  closingBalanceMinor: number;
  /** The closing balance counting draft invoices too, when they are included. */
  closingBalanceWithUnconfirmedMinor: number | null;
}

export interface ForecastResult {
  companyId: string;
  currency: string;
  /** The options the forecast was built with, so two forecasts can always be told apart. */
  options: ForecastOptions;
  scenarioName: string | null;
  openingCash: {
    accounts: Array<{ accountId: string; code: string; name: string; balanceMinor: number }>;
    totalMinor: number;
  };
  buckets: ForecastBucket[];
  /** Payments with no curated due date: shown, totalled, and kept out of the running balance. */
  undated: ForecastLine[];
  undatedTotalMinor: number;
  /** Draft invoices, when included. */
  unconfirmed: ForecastLine[];
  closingBalanceMinor: number;
  lowestPointMinor: number;
  lowestPointDate: IsoDate;
  belowMinimum: boolean;
  findings: string[];
}

export class ForecastError extends Error {}

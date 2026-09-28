/**
 * Shared types for the cash flow forecast (epic #333, issues #565–#570).
 *
 * A forecast is a view beside the ledger. It never writes journals and never
 * changes an invoice or bank line. Every line carries its source and provenance.
 *
 * Money is always in base minor units (integers). Never a float, never bare.
 */

import type { IsoDate } from '../dates';

/** Who produced the value on a forecast line. */
export type ForecastLineSource =
  /** Open invoice, recurring invoice/bill, or purchase order — a ledger fact */
  | 'ledger'
  /** Statutory due date (VAT, CT, income tax, payroll remittance, RCT) */
  | 'rule'
  /** A user-entered scenario adjustment or budget line */
  | 'assumption'
  /** A detected bank pattern that a person has confirmed */
  | 'ai_suggestion';

/** Horizon granularity for bucketed views. */
export type ForecastGranularity = 'daily' | 'weekly' | 'monthly';

/** Options that control a forecast run. */
export interface ForecastOptions {
  companyId: string;
  /** The date the forecast is computed from (today). */
  asOf: IsoDate;
  /** The last date the horizon covers. */
  horizonEnd: IsoDate;
  granularity: ForecastGranularity;
  /**
   * 'due_date': use the invoice due date as the expected receipt date.
   * 'customer_history': adjust by each customer's average days late.
   */
  receiptBasis: 'due_date' | 'customer_history';
  /** Whether to include open purchase orders as outflows. */
  includePurchaseOrders: boolean;
  /** Whether to include unconfirmed items (separately flagged). */
  includeUnconfirmed: boolean;
  /** Which bank/cash account IDs count as cash for the opening balance. */
  cashAccountIds?: string[] | null;
  /** Minimum cash threshold for low-point warning (base minor units). */
  minimumCashMinor: number;
  /**
   * 'statutory': use the statutory Revenue due date.
   * 'ros_extended': use the ROS extended date where collected.
   */
  dueDateBasis: 'statutory' | 'ros_extended';
  /** Optional scenario ID to apply on top of the base forecast. */
  scenarioId?: string | null;
}

/** A single line in the raw (unbucketed) forecast. */
export interface ForecastLine {
  /** Unique key within the forecast, for stable deduplication. */
  key: string;
  /** ISO date this flow is expected. */
  date: IsoDate;
  /** Positive: cash in. Negative: cash out. Base minor units. */
  amountMinor: number;
  description: string;
  source: ForecastLineSource;
  /** Whether this figure is an estimate (e.g. a projected payslip or open VAT period). */
  isEstimate: boolean;
  /** If an estimate, a short note on how it was derived. */
  estimateBasis?: string;
  /** Link to the entity, e.g. { kind: 'invoice', id: 'inv_...' } */
  entityRef?: { kind: string; id: string };
  /** Whether this line comes from an unconfirmed item (quote, draft invoice). */
  isUnconfirmed?: boolean;
  /** Scenario name that produced this line, if applicable. */
  scenarioName?: string;
}

/** A bucketed period in the running-balance output. */
export interface ForecastBucket {
  /** ISO date of the period start. */
  periodStart: IsoDate;
  /** ISO date of the period end. */
  periodEnd: IsoDate;
  label: string;
  inflows: ForecastLine[];
  outflows: ForecastLine[];
  netMinor: number;
  closingBalanceMinor: number;
}

/** The full forecast result. */
export interface ForecastResult {
  companyId: string;
  asOf: IsoDate;
  horizonEnd: IsoDate;
  granularity: ForecastGranularity;
  receiptBasis: 'due_date' | 'customer_history';
  dueDateBasis: 'statutory' | 'ros_extended';
  /** The bank and cash balance as of asOf, by account. */
  openingCash: {
    accounts: Array<{ accountId: string; code: string; name: string; balanceMinor: number }>;
    totalMinor: number;
  };
  buckets: ForecastBucket[];
  /** The lowest closing balance anywhere in the horizon. */
  lowestPointMinor: number;
  lowestPointDate: IsoDate;
  /** Whether the lowest point falls below the minimum cash threshold. */
  belowMinimum: boolean;
  /** Findings: missing due-date rules, ROS option unavailable, etc. */
  findings: string[];
}

export class ForecastError extends Error {}

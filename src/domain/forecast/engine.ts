/**
 * Core forecast engine: cash position, committed flows, 30/90/365-day horizons
 * (issue #565, epic #333).
 *
 * Reads open invoices, recurring invoices, recurring bills, purchase orders and
 * confirmed recurring forecast items to build a running cash balance from today.
 * Nothing is written; nothing posts.
 *
 * Provenance on every line — 'ledger' for open documents, 'ai_suggestion' for
 * confirmed recurring items from bank patterns. Money is always base minor units.
 */

import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  invoices, customers, recurringInvoices, recurringInvoiceLines as recurringInvLines,
  recurringBills, expectedBills, purchaseOrders, purchaseOrderLines,
  bankAccounts, accounts, companies, recurringForecastItems,
  payments, paymentAllocations, forecastSnapshots,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import {
  addDays, asIsoDate, daysBetween, endOfMonth, parts, type IsoDate,
} from '../dates';
import { trialBalance } from '../accounting/ledger';
import { dueOccurrenceDates, type RecurringFrequency } from '../accounting/recurring';
import type {
  ForecastBucket, ForecastGranularity, ForecastLine, ForecastOptions, ForecastResult,
} from './types';
import { ForecastError } from './types';

// ---------------------------------------------------------------------------
// Opening cash balance
// ---------------------------------------------------------------------------

function resolveCashAccountIds(db: AppDatabase, companyId: string, provided?: string[] | null): string[] {
  if (provided && provided.length > 0) return provided;
  // Default: asset-type bank accounts (not loan / credit card) + bank_control + cash system accounts
  const banks = db.select().from(bankAccounts).where(eq(bankAccounts.companyId, companyId)).all();
  const chart = db.select().from(accounts).where(eq(accounts.companyId, companyId)).all();
  const byId = new Map(chart.map((a) => [a.id, a]));
  const ids = new Set<string>();
  for (const b of banks) {
    if (!b.accountId) continue;
    if (b.accountType === 'loan' || b.accountType === 'credit_card') continue;
    if (byId.get(b.accountId)?.type === 'liability') continue;
    ids.add(b.accountId);
  }
  for (const a of chart) {
    if (a.systemKey === 'bank_control' || a.systemKey === 'cash') ids.add(a.id);
  }
  return [...ids];
}

function openingCash(
  db: AppDatabase, params: { companyId: string; asOf: IsoDate; cashAccountIds: string[]; currency: string },
): ForecastResult['openingCash'] {
  const tb = trialBalance(db, { companyId: params.companyId, asOf: params.asOf, baseCurrency: params.currency, includeZeroBalances: true });
  const chart = db.select().from(accounts).where(eq(accounts.companyId, params.companyId)).all();
  const byId = new Map(chart.map((a) => [a.id, a]));
  const cashSet = new Set(params.cashAccountIds);
  const rows = tb.rows.filter((r) => cashSet.has(r.accountId)).map((r) => ({
    accountId: r.accountId,
    code: r.code,
    name: r.name,
    balanceMinor: r.signedMinor,
  }));
  // Include accounts with zero balance that are in cashSet but not in tb
  for (const id of cashSet) {
    if (!rows.find((r) => r.accountId === id)) {
      const a = byId.get(id);
      if (a) rows.push({ accountId: id, code: a.code, name: a.name, balanceMinor: 0 });
    }
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return { accounts: rows, totalMinor: rows.reduce((s, r) => s + r.balanceMinor, 0) };
}

// ---------------------------------------------------------------------------
// Inflow lines: open sales invoices, recurring invoices
// ---------------------------------------------------------------------------

/** Average days late per customer from their payment history. */
function avgDaysLateByCustomer(db: AppDatabase, companyId: string): Map<string, number> {
  const paid = db.select().from(invoices)
    .where(and(
      eq(invoices.companyId, companyId),
      eq(invoices.direction, 'sales'),
      eq(invoices.status, 'paid'),
    )).all();
  const sums = new Map<string, { total: number; count: number }>();
  for (const inv of paid) {
    if (!inv.customerId || !inv.dueDate) continue;
    // Get the latest payment date for this invoice
    const latest = db.select({ d: payments.paymentDate }).from(paymentAllocations)
      .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
      .where(eq(paymentAllocations.invoiceId, inv.id))
      .orderBy(payments.paymentDate)
      .all();
    if (latest.length === 0) continue;
    const lastPayDate = latest[latest.length - 1]!.d;
    const days = daysBetween(asIsoDate(inv.dueDate), asIsoDate(lastPayDate));
    if (days < -365 || days > 365) continue; // ignore outliers
    const e = sums.get(inv.customerId) ?? { total: 0, count: 0 };
    e.total += days; e.count++;
    sums.set(inv.customerId, e);
  }
  return new Map([...sums.entries()].map(([id, s]) => [id, Math.round(s.total / s.count)]));
}

function openSalesInvoiceLines(
  db: AppDatabase, params: ForecastOptions & { horizonEnd: IsoDate },
): ForecastLine[] {
  const open = db.select({ invoice: invoices, customerName: customers.name })
    .from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(
      eq(invoices.companyId, params.companyId),
      eq(invoices.direction, 'sales'),
      ne(invoices.status, 'void'),
      ne(invoices.status, 'written_off'),
      ne(invoices.status, 'paid'),
    )).all()
    .filter((r) => r.invoice.outstandingMinor > 0);

  const avgLate = params.receiptBasis === 'customer_history'
    ? avgDaysLateByCustomer(db, params.companyId) : new Map<string, number>();

  const lines: ForecastLine[] = [];
  for (const { invoice: inv, customerName } of open) {
    const dueDate = asIsoDate(inv.dueDate ?? inv.invoiceDate);
    let expectedDate = dueDate;
    let estimateBasis: string | undefined;
    if (params.receiptBasis === 'customer_history' && inv.customerId) {
      const avg = avgLate.get(inv.customerId);
      if (avg !== undefined && avg !== 0) {
        expectedDate = addDays(dueDate, avg);
        estimateBasis = `Due ${dueDate}; this customer pays on average ${Math.abs(avg)} day${Math.abs(avg) !== 1 ? 's' : ''} ${avg > 0 ? 'late' : 'early'}.`;
      }
    }
    if (expectedDate > params.horizonEnd) continue;
    const label = customerName ? ` — ${customerName}` : '';
    const isUnconfirmed = inv.status === 'draft';
    if (isUnconfirmed && !params.includeUnconfirmed) continue;
    lines.push({
      key: `sales:${inv.id}`,
      date: expectedDate < params.asOf ? params.asOf : expectedDate,
      amountMinor: inv.outstandingMinor,
      description: `Receipt: ${inv.invoiceNumber ?? inv.id}${label}`,
      source: 'ledger',
      isEstimate: !!estimateBasis,
      estimateBasis,
      entityRef: { kind: 'invoice', id: inv.id },
      isUnconfirmed,
    });
  }
  return lines;
}

function recurringInvoiceForecastLines(
  db: AppDatabase, params: ForecastOptions & { horizonEnd: IsoDate },
): ForecastLine[] {
  const templates = db.select({ t: recurringInvoices, name: customers.name })
    .from(recurringInvoices)
    .leftJoin(customers, eq(recurringInvoices.customerId, customers.id))
    .where(and(
      eq(recurringInvoices.companyId, params.companyId),
      eq(recurringInvoices.active, true),
    )).all();

  const lines: ForecastLine[] = [];
  for (const { t: tpl, name: customerName } of templates) {
    if (tpl.endDate && tpl.endDate < params.asOf) continue;
    const schedule = {
      frequency: tpl.frequency as RecurringFrequency,
      startDate: asIsoDate(tpl.startDate),
      endDate: tpl.endDate ? asIsoDate(tpl.endDate) : null,
    };
    // Fetch already-raised invoice dates for this template
    const raised = new Set(
      db.select({ d: invoices.recurringDate }).from(invoices)
        .where(and(
          eq(invoices.recurringInvoiceId, tpl.id),
          eq(invoices.companyId, params.companyId),
        )).all().map((r) => r.d).filter((d): d is string => !!d),
    );
    // Compute the net of the template lines
    const templateLines = db.select({ net: recurringInvLines.netMinor })
      .from(recurringInvLines)
      .where(eq(recurringInvLines.recurringInvoiceId, tpl.id))
      .all();
    const netMinor = templateLines.reduce((s, l) => s + l.net, 0);

    for (const date of dueOccurrenceDates(schedule, params.horizonEnd)) {
      if (date <= params.asOf || raised.has(date)) continue;
      if (date > params.horizonEnd) break;
      const label = customerName ? ` — ${customerName}` : '';
      lines.push({
        key: `recurring_inv:${tpl.id}:${date}`,
        date,
        amountMinor: netMinor,
        description: `Recurring invoice: ${tpl.name}${label}`,
        source: 'ledger',
        isEstimate: true,
        estimateBasis: `Recurring at ${tpl.frequency} from ${tpl.startDate}.`,
        entityRef: { kind: 'recurring_invoice', id: tpl.id },
      });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Outflow lines: open purchase invoices, recurring bills, purchase orders
// ---------------------------------------------------------------------------

function openPurchaseInvoiceLines(
  db: AppDatabase, params: ForecastOptions & { horizonEnd: IsoDate },
): ForecastLine[] {
  const open = db.select().from(invoices)
    .where(and(
      eq(invoices.companyId, params.companyId),
      eq(invoices.direction, 'purchase'),
      ne(invoices.status, 'void'),
      ne(invoices.status, 'written_off'),
      ne(invoices.status, 'paid'),
    )).all()
    .filter((inv) => inv.outstandingMinor > 0 && !inv.isCreditNote);

  const lines: ForecastLine[] = [];
  for (const inv of open) {
    const dueDate = asIsoDate(inv.dueDate ?? inv.invoiceDate);
    const date = dueDate < params.asOf ? params.asOf : dueDate;
    if (date > params.horizonEnd) continue;
    lines.push({
      key: `purchase:${inv.id}`,
      date,
      amountMinor: -inv.outstandingMinor,
      description: `Payment: ${inv.invoiceNumber ?? inv.id}`,
      source: 'ledger',
      isEstimate: false,
      entityRef: { kind: 'invoice', id: inv.id },
    });
  }
  return lines;
}

function expectedBillLines(
  db: AppDatabase, params: ForecastOptions & { horizonEnd: IsoDate },
): ForecastLine[] {
  const templates = db.select().from(recurringBills)
    .where(and(
      eq(recurringBills.companyId, params.companyId),
      eq(recurringBills.active, true),
    )).all();

  const lines: ForecastLine[] = [];
  for (const tpl of templates) {
    if (tpl.endDate && tpl.endDate < params.asOf) continue;
    const schedule = {
      frequency: tpl.frequency as RecurringFrequency,
      startDate: asIsoDate(tpl.startDate),
      endDate: tpl.endDate ? asIsoDate(tpl.endDate) : null,
    };
    // Dates already raised as expected bills
    const raised = new Set(
      db.select({ d: expectedBills.expectedDate }).from(expectedBills)
        .where(eq(expectedBills.recurringBillId, tpl.id)).all().map((r) => r.d),
    );
    // Also include already-raised expected bills that are still pending
    const pending = db.select().from(expectedBills)
      .where(and(
        eq(expectedBills.recurringBillId, tpl.id),
        eq(expectedBills.status, 'expected'),
      )).all();

    // Future occurrences
    for (const date of dueOccurrenceDates(schedule, params.horizonEnd)) {
      if (date <= params.asOf) continue;
      if (raised.has(date)) continue;
      if (date > params.horizonEnd) break;
      lines.push({
        key: `recurring_bill:${tpl.id}:${date}`,
        date,
        amountMinor: -tpl.expectedNetMinor,
        description: `Expected bill: ${tpl.name}`,
        source: 'ledger',
        isEstimate: true,
        estimateBasis: `Recurring at ${tpl.frequency} from ${tpl.startDate}. Expected net: ${tpl.expectedNetMinor / 100}.`,
        entityRef: { kind: 'recurring_bill', id: tpl.id },
      });
    }
    // Pending expected bills within horizon
    for (const eb of pending) {
      const date = asIsoDate(eb.expectedDate);
      if (date > params.horizonEnd) continue;
      const payDate = date < params.asOf ? params.asOf : date;
      lines.push({
        key: `expected_bill:${eb.id}`,
        date: payDate,
        amountMinor: -eb.expectedNetMinor,
        description: `Expected bill: ${tpl.name} (${eb.expectedDate})`,
        source: 'ledger',
        isEstimate: false,
        entityRef: { kind: 'expected_bill', id: eb.id },
      });
    }
  }
  return lines;
}

function purchaseOrderOutflowLines(
  db: AppDatabase, params: ForecastOptions & { horizonEnd: IsoDate },
): ForecastLine[] {
  if (!params.includePurchaseOrders) return [];
  const orders = db.select().from(purchaseOrders)
    .where(and(
      eq(purchaseOrders.companyId, params.companyId),
      eq(purchaseOrders.status, 'open'),
    )).all();

  const lines: ForecastLine[] = [];
  for (const po of orders) {
    const date = po.expectedDate
      ? (asIsoDate(po.expectedDate) < params.asOf ? params.asOf : asIsoDate(po.expectedDate))
      : params.asOf;
    if (date > params.horizonEnd) continue;
    const poLines = db.select().from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, po.id)).all();
    const netMinor = poLines.reduce((s, l) => s + l.netMinor, 0);
    lines.push({
      key: `po:${po.id}`,
      date,
      amountMinor: -netMinor,
      description: `Purchase order: ${po.number}`,
      source: 'ledger',
      isEstimate: true,
      estimateBasis: 'Purchase order — not yet a bill.',
      entityRef: { kind: 'purchase_order', id: po.id },
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Confirmed recurring forecast items (from bank patterns or manual)
// ---------------------------------------------------------------------------

function recurringForecastItemLines(
  db: AppDatabase, params: ForecastOptions & { horizonEnd: IsoDate },
): ForecastLine[] {
  const items = db.select().from(recurringForecastItems)
    .where(and(
      eq(recurringForecastItems.companyId, params.companyId),
      eq(recurringForecastItems.status, 'confirmed'),
    )).all();

  const lines: ForecastLine[] = [];
  for (const item of items) {
    if (item.endDate && item.endDate < params.asOf) continue;
    const startDate = asIsoDate(item.startDate);
    const freq = item.frequency as RecurringFrequency;
    const schedule = {
      frequency: freq,
      startDate,
      endDate: item.endDate ? asIsoDate(item.endDate) : null,
    };
    for (const date of dueOccurrenceDates(schedule, params.horizonEnd)) {
      if (date <= params.asOf) continue;
      if (date > params.horizonEnd) break;
      lines.push({
        key: `rfi:${item.id}:${date}`,
        date,
        amountMinor: item.direction === 'inflow' ? item.amountMinor : -item.amountMinor,
        description: item.description,
        source: item.source === 'detected' ? 'ai_suggestion' : 'ledger',
        isEstimate: item.source === 'detected',
        estimateBasis: item.source === 'detected' ? `Detected recurring pattern (${item.frequency}): ${item.payeePattern ?? ''}` : undefined,
        entityRef: { kind: 'recurring_forecast_item', id: item.id },
      });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

function bucketLabel(granularity: ForecastGranularity, start: IsoDate, end: IsoDate): string {
  const { year, month, day } = parts(start);
  if (granularity === 'daily') return start;
  if (granularity === 'weekly') return `${start} – ${end}`;
  return `${String(month).padStart(2, '0')}/${year}`;
}

function buildBuckets(
  granularity: ForecastGranularity,
  asOf: IsoDate,
  horizonEnd: IsoDate,
): Array<{ start: IsoDate; end: IsoDate }> {
  const buckets: Array<{ start: IsoDate; end: IsoDate }> = [];
  let cursor = asOf;
  while (cursor <= horizonEnd) {
    let end: IsoDate;
    if (granularity === 'daily') {
      end = cursor;
    } else if (granularity === 'weekly') {
      end = addDays(cursor, 6);
      if (end > horizonEnd) end = horizonEnd;
    } else {
      end = endOfMonth(cursor);
      if (end > horizonEnd) end = horizonEnd;
    }
    buckets.push({ start: cursor, end });
    cursor = addDays(end, 1);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

export function buildForecast(db: AppDatabase, options: ForecastOptions): ForecastResult {
  if (options.horizonEnd < options.asOf) throw new ForecastError('The horizon end is before the forecast date.');
  const company = db.select().from(companies).where(eq(companies.id, options.companyId)).get();
  if (!company) throw new ForecastError(`Company ${options.companyId} not found.`);

  const cashIds = resolveCashAccountIds(db, options.companyId, options.cashAccountIds);
  const opening = openingCash(db, {
    companyId: options.companyId, asOf: options.asOf, cashAccountIds: cashIds, currency: company.baseCurrency,
  });

  const forecastParams = { ...options, horizonEnd: options.horizonEnd };

  // Gather all raw forecast lines
  const rawLines: ForecastLine[] = [
    ...openSalesInvoiceLines(db, forecastParams),
    ...recurringInvoiceForecastLines(db, forecastParams),
    ...openPurchaseInvoiceLines(db, forecastParams),
    ...expectedBillLines(db, forecastParams),
    ...purchaseOrderOutflowLines(db, forecastParams),
    ...recurringForecastItemLines(db, forecastParams),
  ];

  // Sort by date ascending
  rawLines.sort((a, b) => a.date.localeCompare(b.date));

  // Build buckets and assign lines
  const bucketDefs = buildBuckets(options.granularity, options.asOf, options.horizonEnd);
  let runningBalance = opening.totalMinor;
  let lowestPoint = runningBalance;
  let lowestDate = options.asOf;

  const buckets: ForecastBucket[] = bucketDefs.map(({ start, end }) => {
    const inPeriod = rawLines.filter((l) => l.date >= start && l.date <= end);
    const inflows = inPeriod.filter((l) => l.amountMinor >= 0);
    const outflows = inPeriod.filter((l) => l.amountMinor < 0);
    const net = inPeriod.reduce((s, l) => s + l.amountMinor, 0);
    runningBalance += net;
    if (runningBalance < lowestPoint) {
      lowestPoint = runningBalance;
      lowestDate = end;
    }
    return {
      periodStart: start,
      periodEnd: end,
      label: bucketLabel(options.granularity, start, end),
      inflows,
      outflows,
      netMinor: net,
      closingBalanceMinor: runningBalance,
    };
  });

  return {
    companyId: options.companyId,
    asOf: options.asOf,
    horizonEnd: options.horizonEnd,
    granularity: options.granularity,
    receiptBasis: options.receiptBasis,
    dueDateBasis: options.dueDateBasis,
    openingCash: opening,
    buckets,
    lowestPointMinor: lowestPoint,
    lowestPointDate: lowestDate,
    belowMinimum: lowestPoint < options.minimumCashMinor,
    findings: [],
  };
}

/**
 * Save an immutable snapshot of a forecast.
 * Returns the snapshot id.
 */
export function saveForecastSnapshot(
  db: AppDatabase,
  params: {
    companyId: string;
    name: string;
    forecast: ForecastResult;
    savedBy: string;
  },
): string {
  const { forecastSnapshots } = require('@/db/schema');
  const { ids } = require('@/lib/ids');
  const id = ids.forecastSnapshot();
  db.insert(forecastSnapshots).values({
    id,
    companyId: params.companyId,
    name: params.name.trim(),
    asOf: params.forecast.asOf,
    horizonEnd: params.forecast.horizonEnd,
    granularity: params.forecast.granularity,
    receiptBasis: params.forecast.receiptBasis,
    dueDateBasis: params.forecast.dueDateBasis,
    includePurchaseOrders: params.forecast.buckets.length > 0,
    snapshotJson: JSON.stringify(params.forecast),
    savedBy: params.savedBy,
  }).run();
  return id;
}

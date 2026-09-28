/**
 * The cash forecast (issue #565, epic #333).
 *
 * Starts from the bank and cash balance on the forecast date and adds what is
 * expected in and out: open sales and purchase invoices, recurring invoices and
 * bills, purchase orders (an option), confirmed recurring items (#567), tax and
 * statutory payments (#566) and payroll (#568), then a scenario's adjustments
 * (#570). Nothing is written and nothing posts.
 *
 * - Amounts are base-currency minor units. An invoice in another currency is
 *   converted at its own booked rate; a bill or order in another currency with
 *   no rate is left out, with a finding, never converted at a guess.
 * - Cash moves gross: an invoice's outstanding amount includes its VAT, and a
 *   recurring invoice is forecast with the VAT its treatment charges. A
 *   recurring bill or purchase order records only a net: it is forecast at the
 *   net, marked as an estimate that excludes the VAT not yet known.
 * - Anything due before the forecast date and still open is shown on the
 *   forecast date, marked overdue with the date it was due.
 * - A payment with no curated due date is listed apart, totalled, and kept out
 *   of the running balance (#566): never placed on a guessed date.
 */

import { and, eq, isNull, notInArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accounts, bankAccounts, companies, customers, expectedBills, forecastScenarios, invoices, paymentAllocations, payments,
  purchaseOrderLines, purchaseOrders, recurringBills, recurringForecastItems, recurringInvoiceLines, recurringInvoices, suppliers,
} from '@/db/schema';
import { multiplyRational, vatFromNet } from '../money';
import { addDays, addMonths, daysBetween, endOfMonth, type IsoDate } from '../dates';
import { trialBalance } from '../accounting/ledger';
import { lineDiscount } from '../invoicing/invoices';
import { resolveTreatment } from '../vat/engine';
import { statutoryOutflowLines } from './taxOutflows';
import { payrollForecastLines } from './payrollForecast';
import { applyScenario } from './scenarios';
import { validateCashAccounts } from './settings';
import { ForecastError, type ForecastBucket, type ForecastLine, type ForecastOptions, type ForecastResult } from './types';

export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly';
const MONTHS: Record<Exclude<Frequency, 'weekly'>, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/** Occurrence dates of a schedule after `after` and up to `upTo`, stepped by the calendar from the start. */
export function occurrences(frequency: Frequency, start: IsoDate, end: IsoDate | null, after: IsoDate, upTo: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  for (let k = 0; k < 5_000; k++) {
    const date = frequency === 'weekly' ? addDays(start, 7 * k) : addMonths(start, MONTHS[frequency] * k);
    if (date > upTo || (end && date > end)) break;
    if (date > after) out.push(date);
  }
  return out;
}

export const eur = (minor: number) => (minor / 100).toFixed(2);

// ---------------------------------------------------------------------------
// Opening position
// ---------------------------------------------------------------------------

export function defaultCashAccountIds(db: AppDatabase, companyId: string): string[] {
  const chart = db.select().from(accounts).where(eq(accounts.companyId, companyId)).all();
  const byId = new Map(chart.map((a) => [a.id, a]));
  const set = new Set<string>();
  for (const b of db.select().from(bankAccounts).where(eq(bankAccounts.companyId, companyId)).all()) {
    if (!b.accountId || b.accountType === 'loan' || b.accountType === 'credit_card') continue;
    if (byId.get(b.accountId)?.type === 'asset') set.add(b.accountId);
  }
  for (const a of chart) if (a.systemKey === 'bank_control' || a.systemKey === 'cash') set.add(a.id);
  return [...set];
}

function openingCash(db: AppDatabase, companyId: string, asOf: IsoDate, currency: string, cashIds: string[]): ForecastResult['openingCash'] {
  const tb = trialBalance(db, { companyId, asOf, baseCurrency: currency, includeZeroBalances: true });
  const rows = tb.rows.filter((r) => cashIds.includes(r.accountId))
    .map((r) => ({ accountId: r.accountId, code: r.code, name: r.name, balanceMinor: r.netDebitMinor }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return { accounts: rows, totalMinor: rows.reduce((s, r) => s + r.balanceMinor, 0) };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/** An invoice's outstanding amount in base currency, at the invoice's own booked rate. */
function outstandingBase(inv: typeof invoices.$inferSelect): number {
  if (inv.currency === inv.baseCurrency) return Math.abs(inv.outstandingMinor);
  if (inv.grossMinor === 0) return 0;
  return multiplyRational(Math.abs(inv.outstandingMinor), Math.abs(inv.baseGrossMinor), Math.abs(inv.grossMinor));
}

/** Each customer's average days late (negative is early) over their paid invoices, by the last payment's date. */
export function averageDaysLate(db: AppDatabase, companyId: string): Map<string, { days: number; invoices: number }> {
  const rows = db.select({ id: invoices.id, customerId: invoices.customerId, dueDate: invoices.dueDate, paidOn: payments.paymentDate })
    .from(invoices)
    .innerJoin(paymentAllocations, eq(paymentAllocations.invoiceId, invoices.id))
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(and(eq(invoices.companyId, companyId), eq(invoices.direction, 'sales'), eq(invoices.status, 'paid'), eq(invoices.isCreditNote, false)))
    .all();
  const lastPaid = new Map<string, { customerId: string; dueDate: string; paidOn: string }>();
  for (const r of rows) {
    if (!r.customerId || !r.dueDate) continue;
    const seen = lastPaid.get(r.id);
    if (!seen || r.paidOn > seen.paidOn) lastPaid.set(r.id, { customerId: r.customerId, dueDate: r.dueDate, paidOn: r.paidOn });
  }
  const sums = new Map<string, { total: number; count: number }>();
  for (const v of lastPaid.values()) {
    const e = sums.get(v.customerId) ?? { total: 0, count: 0 };
    e.total += daysBetween(v.dueDate as IsoDate, v.paidOn as IsoDate);
    e.count += 1;
    sums.set(v.customerId, e);
  }
  return new Map([...sums].map(([id, s]) => [id, { days: Math.round(s.total / s.count), invoices: s.count }]));
}

interface Ctx {
  db: AppDatabase;
  o: ForecastOptions;
  currency: string;
  findings: string[];
  history: Map<string, { days: number; invoices: number }> | null;
}

/** When a customer is expected to pay something due on `due`, by the options chosen. */
function receiptDate(ctx: Ctx, customerId: string | null, due: IsoDate): { date: IsoDate; basis?: string } {
  const override = customerId ? ctx.o.customerDelayDays?.[customerId] : undefined;
  if (override !== undefined) {
    return { date: addDays(due, override), basis: `Due ${due}; this customer is set to pay ${Math.abs(override)} day(s) ${override >= 0 ? 'late' : 'early'}.` };
  }
  if (ctx.o.receiptBasis === 'customer_history' && customerId) {
    const h = ctx.history?.get(customerId);
    if (!h) return { date: due, basis: `Due ${due}; no paid invoices to learn from, so the due date is used.` };
    if (h.days !== 0) {
      return { date: addDays(due, h.days), basis: `Due ${due}; this customer has paid on average ${Math.abs(h.days)} day(s) ${h.days > 0 ? 'late' : 'early'} over ${h.invoices} invoice(s).` };
    }
  }
  return { date: due };
}

/** Inside the horizon, with anything already due moved to the forecast date and marked overdue. */
function place(ctx: Ctx, line: ForecastLine, due: IsoDate): ForecastLine | null {
  if (line.date === null) return line;
  if (line.date > ctx.o.horizonEnd) return null;
  if (line.date < ctx.o.asOf) return { ...line, date: ctx.o.asOf, overdue: true, dueDate: due };
  return line;
}

const NO_DUE_DATE = 'No due date is recorded on the invoice, so it is shown as due on its date.';

function salesInvoiceLines(ctx: Ctx): ForecastLine[] {
  const rows = ctx.db.select({ inv: invoices, name: customers.name }).from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(eq(invoices.companyId, ctx.o.companyId), eq(invoices.direction, 'sales'),
      notInArray(invoices.status, ['void', 'paid', 'written_off']))).all();
  const out: ForecastLine[] = [];
  let credits = 0;
  for (const { inv, name } of rows) {
    if (inv.outstandingMinor === 0) continue;
    if (inv.isCreditNote) { credits += outstandingBase(inv); continue; }
    const draft = inv.status === 'draft';
    if (draft && !ctx.o.includeUnconfirmed) continue;
    const due = (inv.dueDate ?? inv.invoiceDate) as IsoDate;
    const r = receiptDate(ctx, inv.customerId, due);
    const fx = inv.currency !== inv.baseCurrency ? `Converted from ${inv.currency} at the invoice's booked rate.` : '';
    const basis = [inv.dueDate ? '' : NO_DUE_DATE, r.basis, fx].filter(Boolean).join(' ');
    const line = place(ctx, {
      key: `sales:${inv.id}`, date: r.date, amountMinor: outstandingBase(inv),
      description: `${inv.invoiceNumber ?? 'Draft invoice'}${name ? ` — ${name}` : ''}`,
      category: 'receipt', source: 'ledger', isEstimate: !!basis, estimateBasis: basis || undefined, partyId: inv.customerId,
      isUnconfirmed: draft, entityRef: { kind: 'invoice', id: inv.id },
    }, due);
    if (line) out.push(line);
  }
  if (credits) ctx.findings.push(`Unallocated sales credit notes of ${eur(credits)} are not forecast: whether they are refunded or set against later invoices is not known.`);
  return out;
}

function purchaseInvoiceLines(ctx: Ctx): ForecastLine[] {
  const rows = ctx.db.select({ inv: invoices, name: suppliers.name }).from(invoices)
    .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
    .where(and(eq(invoices.companyId, ctx.o.companyId), eq(invoices.direction, 'purchase'),
      notInArray(invoices.status, ['void', 'paid', 'written_off', 'draft']))).all();
  const out: ForecastLine[] = [];
  let credits = 0;
  for (const { inv, name } of rows) {
    if (inv.outstandingMinor === 0) continue;
    if (inv.isCreditNote) { credits += outstandingBase(inv); continue; }
    const due = (inv.dueDate ?? inv.invoiceDate) as IsoDate;
    const basis = [inv.dueDate ? '' : NO_DUE_DATE, inv.currency !== inv.baseCurrency ? `Converted from ${inv.currency} at the invoice's booked rate.` : '']
      .filter(Boolean).join(' ');
    const line = place(ctx, {
      key: `purchase:${inv.id}`, date: due, amountMinor: -outstandingBase(inv),
      description: `${inv.invoiceNumber ?? 'Bill'}${name ? ` — ${name}` : ''}`,
      category: 'payment', source: 'ledger', isEstimate: !!basis,
      estimateBasis: basis || undefined,
      partyId: inv.supplierId, entityRef: { kind: 'invoice', id: inv.id },
    }, due);
    if (line) out.push(line);
  }
  if (credits) ctx.findings.push(`Unallocated supplier credit notes of ${eur(credits)} are not forecast: whether they are refunded or set against later bills is not known.`);
  return out;
}

function recurringInvoiceForecastLines(ctx: Ctx): ForecastLine[] {
  const templates = ctx.db.select({ t: recurringInvoices, c: customers }).from(recurringInvoices)
    .innerJoin(customers, eq(recurringInvoices.customerId, customers.id))
    .where(and(eq(recurringInvoices.companyId, ctx.o.companyId), eq(recurringInvoices.active, true))).all();
  const out: ForecastLine[] = [];
  for (const { t, c } of templates) {
    const lines = ctx.db.select().from(recurringInvoiceLines).where(eq(recurringInvoiceLines.recurringInvoiceId, t.id))
      .orderBy(recurringInvoiceLines.lineNumber).all();
    const raised = new Set(ctx.db.select({ d: invoices.recurringDate }).from(invoices)
      .where(eq(invoices.recurringInvoiceId, t.id)).all().map((r) => r.d));
    // An occurrence is raised on its date, due after the customer's terms, and paid by the receipt basis.
    const terms = c.defaultPaymentTermsDays;
    for (const date of occurrences(t.frequency, t.startDate as IsoDate, t.endDate as IsoDate | null, addDays(ctx.o.asOf, -1), ctx.o.horizonEnd)) {
      if (raised.has(date)) continue;
      let gross = 0;
      for (const l of lines) {
        const net = l.netMinor - lineDiscount(l.netMinor, { discountBasisPoints: l.discountBasisPoints ?? undefined }, l.lineNumber).minor;
        const r = resolveTreatment(ctx.db, { companyId: ctx.o.companyId, treatmentId: l.vatTreatmentId, onDate: date });
        const vat = r.treatment.appliesRate && !r.treatment.isReverseCharge ? vatFromNet(net, r.rateBasisPoints) : 0;
        gross += net + vat;
      }
      const due = addDays(date, terms);
      const r = receiptDate(ctx, c.id, due);
      const line = place(ctx, {
        key: `recurring_invoice:${t.id}:${date}`, date: r.date, amountMinor: gross,
        description: `${t.name} — ${c.name}`, category: 'receipt', source: 'ledger', isEstimate: true,
        estimateBasis: `To be raised ${date} by the recurring invoice, with VAT at the rate in force then; due ${due} on ${terms} day terms.${r.basis ? ` ${r.basis}` : ''}`,
        partyId: c.id, entityRef: { kind: 'recurring_invoice', id: t.id },
      }, due);
      if (line) out.push(line);
    }
  }
  return out;
}

function recurringBillLines(ctx: Ctx): ForecastLine[] {
  const templates = ctx.db.select().from(recurringBills)
    .where(and(eq(recurringBills.companyId, ctx.o.companyId), eq(recurringBills.active, true))).all();
  const out: ForecastLine[] = [];
  const basis = 'The recurring bill records a net only: its VAT is known when the bill arrives, so this excludes it.';
  for (const t of templates) {
    if (t.currency !== ctx.currency) {
      ctx.findings.push(`The recurring bill "${t.name}" is in ${t.currency}, with no rate to convert it: it is not forecast.`);
      continue;
    }
    const raised = ctx.db.select().from(expectedBills).where(eq(expectedBills.recurringBillId, t.id)).all();
    const raisedDates = new Set(raised.map((e) => e.expectedDate));
    for (const e of raised.filter((x) => x.status === 'expected')) {
      const line = place(ctx, {
        key: `expected_bill:${e.id}`, date: e.expectedDate as IsoDate, amountMinor: -e.expectedNetMinor,
        description: `${t.name} (expected ${e.expectedDate})`, category: 'payment', source: 'ledger', isEstimate: true,
        estimateBasis: basis, partyId: t.supplierId, entityRef: { kind: 'expected_bill', id: e.id },
      }, e.expectedDate as IsoDate);
      if (line) out.push(line);
    }
    for (const date of occurrences(t.frequency, t.startDate as IsoDate, t.endDate as IsoDate | null, addDays(ctx.o.asOf, -1), ctx.o.horizonEnd)) {
      if (raisedDates.has(date)) continue;
      out.push({
        key: `recurring_bill:${t.id}:${date}`, date, amountMinor: -t.expectedNetMinor,
        description: t.name, category: 'payment', source: 'ledger', isEstimate: true, estimateBasis: basis,
        partyId: t.supplierId, entityRef: { kind: 'recurring_bill', id: t.id },
      });
    }
  }
  return out;
}

function purchaseOrderForecastLines(ctx: Ctx): ForecastLine[] {
  if (!ctx.o.includePurchaseOrders) return [];
  const orders = ctx.db.select().from(purchaseOrders)
    .where(and(eq(purchaseOrders.companyId, ctx.o.companyId), eq(purchaseOrders.status, 'open'))).all();
  const out: ForecastLine[] = [];
  for (const po of orders) {
    if (po.currency !== ctx.currency) {
      ctx.findings.push(`Purchase order ${po.number} is in ${po.currency}, with no rate to convert it: it is not forecast.`);
      continue;
    }
    const net = ctx.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id)).all()
      .reduce((s, l) => s + l.netMinor, 0);
    const base = {
      key: `po:${po.id}`, amountMinor: -net, description: `Purchase order ${po.number}`, category: 'payment' as const,
      source: 'ledger' as const, isEstimate: true, partyId: po.supplierId, entityRef: { kind: 'purchase_order', id: po.id },
    };
    if (!po.expectedDate) {
      out.push({ ...base, date: null, estimateBasis: 'Ordered, not yet billed, with no expected date: net of VAT.' });
      continue;
    }
    const line = place(ctx, { ...base, date: po.expectedDate as IsoDate, estimateBasis: 'Ordered, not yet billed: net of VAT, on the expected date.' }, po.expectedDate as IsoDate);
    if (line) out.push(line);
  }
  return out;
}

/** Confirmed recurring items (#567): the current version of each. */
function recurringItemLines(ctx: Ctx): ForecastLine[] {
  const items = ctx.db.select().from(recurringForecastItems).where(and(
    eq(recurringForecastItems.companyId, ctx.o.companyId), eq(recurringForecastItems.status, 'confirmed'),
    isNull(recurringForecastItems.supersededById),
  )).all();
  const out: ForecastLine[] = [];
  for (const i of items) {
    const detected = i.source === 'detected';
    for (const date of occurrences(i.frequency, i.startDate as IsoDate, i.endDate as IsoDate | null, addDays(ctx.o.asOf, -1), ctx.o.horizonEnd)) {
      out.push({
        key: `recurring_item:${i.id}:${date}`, date, amountMinor: i.direction === 'inflow' ? i.amountMinor : -i.amountMinor,
        description: i.description, category: 'recurring', source: detected ? 'ai_suggestion' : 'assumption', isEstimate: true,
        estimateBasis: detected
          ? `A recurring ${i.frequency} pattern in the bank history${i.payeePattern ? ` (${i.payeePattern})` : ''}, confirmed by ${i.confirmedBy}.`
          : `Entered by ${i.recordedBy} as recurring ${i.frequency}.`,
        entityRef: { kind: 'recurring_forecast_item', id: i.id },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Buckets and the running balance
// ---------------------------------------------------------------------------

function bucketRanges(o: ForecastOptions): Array<{ start: IsoDate; end: IsoDate; label: string }> {
  const out: Array<{ start: IsoDate; end: IsoDate; label: string }> = [];
  for (let cursor = o.asOf; cursor <= o.horizonEnd;) {
    let end = o.granularity === 'daily' ? cursor : o.granularity === 'weekly' ? addDays(cursor, 6) : endOfMonth(cursor);
    if (end > o.horizonEnd) end = o.horizonEnd;
    out.push({ start: cursor, end, label: o.granularity === 'daily' ? cursor : o.granularity === 'weekly' ? `${cursor} to ${end}` : cursor.slice(0, 7) });
    cursor = addDays(end, 1);
  }
  return out;
}

export function assembleForecast(params: {
  o: ForecastOptions; currency: string; opening: ForecastResult['openingCash']; lines: ForecastLine[]; findings: string[]; scenarioName: string | null;
}): ForecastResult {
  const { o } = params;
  const inHorizon = (l: ForecastLine) => l.date !== null && l.date >= o.asOf && l.date <= o.horizonEnd;
  const dated = params.lines.filter((l) => inHorizon(l) && !l.isUnconfirmed);
  const unconfirmed = params.lines.filter((l) => inHorizon(l) && l.isUnconfirmed);
  const undated = params.lines.filter((l) => l.date === null);
  let running = params.opening.totalMinor;
  let runningWith = running;
  let lowest = running;
  let lowestDate = o.asOf;
  const buckets: ForecastBucket[] = bucketRanges(o).map(({ start, end, label }) => {
    const within = (l: ForecastLine) => l.date! >= start && l.date! <= end;
    const inPeriod = dated.filter(within).sort((a, b) => a.date!.localeCompare(b.date!) || a.key.localeCompare(b.key));
    const inflows = inPeriod.filter((l) => l.amountMinor > 0);
    const outflows = inPeriod.filter((l) => l.amountMinor < 0);
    const inflowMinor = inflows.reduce((s, l) => s + l.amountMinor, 0);
    const outflowMinor = outflows.reduce((s, l) => s + l.amountMinor, 0);
    running += inflowMinor + outflowMinor;
    runningWith += inflowMinor + outflowMinor + unconfirmed.filter(within).reduce((s, l) => s + l.amountMinor, 0);
    if (running < lowest) { lowest = running; lowestDate = end; }
    return {
      periodStart: start, periodEnd: end, label, inflows, outflows, inflowMinor, outflowMinor,
      netMinor: inflowMinor + outflowMinor, closingBalanceMinor: running,
      closingBalanceWithUnconfirmedMinor: o.includeUnconfirmed ? runningWith : null,
    };
  });
  const undatedTotalMinor = undated.reduce((s, l) => s + l.amountMinor, 0);
  const findings = [...params.findings];
  if (undated.length) {
    findings.push(`${undated.length} item(s) totalling ${eur(undatedTotalMinor)} have no date to place them on and are not in the running balance. `
      + 'They are listed under "Not dated" so they are not forgotten.');
  }
  return {
    companyId: o.companyId, currency: params.currency, options: o, scenarioName: params.scenarioName,
    openingCash: params.opening, buckets, undated, undatedTotalMinor, unconfirmed,
    closingBalanceMinor: running, lowestPointMinor: lowest, lowestPointDate: lowestDate,
    belowMinimum: lowest < o.minimumCashMinor, findings,
  };
}

/** The base lines of a forecast, before any scenario. */
export function baseForecastLines(db: AppDatabase, o: ForecastOptions, currency: string, findings: string[]): ForecastLine[] {
  const ctx: Ctx = { db, o, currency, findings, history: o.receiptBasis === 'customer_history' ? averageDaysLate(db, o.companyId) : null };
  const statutory = statutoryOutflowLines(db, o);
  const payroll = payrollForecastLines(db, o);
  const lines = [
    ...salesInvoiceLines(ctx), ...recurringInvoiceForecastLines(ctx),
    ...purchaseInvoiceLines(ctx), ...recurringBillLines(ctx), ...purchaseOrderForecastLines(ctx),
    ...recurringItemLines(ctx), ...statutory.lines, ...payroll.lines,
  ];
  findings.push(...statutory.findings, ...payroll.findings);
  return lines;
}

export function buildForecast(db: AppDatabase, o: ForecastOptions): ForecastResult {
  if (o.horizonEnd < o.asOf) throw new ForecastError('The horizon ends before the forecast date.');
  const company = db.select().from(companies).where(eq(companies.id, o.companyId)).get();
  if (!company) throw new ForecastError(`Company ${o.companyId} not found.`);
  let cashIds = o.cashAccountIds && o.cashAccountIds.length ? o.cashAccountIds : null;
  if (cashIds) validateCashAccounts(db, o.companyId, cashIds);
  cashIds ??= defaultCashAccountIds(db, o.companyId);
  const findings: string[] = [];
  let lines = baseForecastLines(db, o, company.baseCurrency, findings);
  let scenarioName: string | null = null;
  if (o.scenarioId) {
    const scenario = db.select().from(forecastScenarios)
      .where(and(eq(forecastScenarios.id, o.scenarioId), eq(forecastScenarios.companyId, o.companyId))).get();
    if (!scenario) throw new ForecastError(`Scenario ${o.scenarioId} not found.`);
    scenarioName = scenario.name;
    lines = applyScenario(db, { o, scenario, lines, findings });
  }
  return assembleForecast({
    o, currency: company.baseCurrency, opening: openingCash(db, o.companyId, o.asOf, company.baseCurrency, cashIds),
    lines, findings, scenarioName,
  });
}

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { capitalGoods, capitalGoodIntervals, companies, invoices, accounts, vatTreatments, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, isIsoDate, asIsoDate } from '../dates';
import { createAdjustment } from '../accounting/adjustments';
import {
  intervalSchedule, initialIntervalAdjustment, laterIntervalAdjustment, disposalAdjustment, adjustmentDate, FULL_BP,
  type IntervalDates,
} from './capitalGoodsMath';

/**
 * The capital goods scheme record (VATCA ss.63-64, issue #208).
 *
 * A person registers each capital good from the confirmed invoices its tax
 * rests on, and at the end of each interval records the proportion of
 * deductible use. The adjustment is calculated here, never typed, and posted
 * by a person as a VAT adjustment in the taxable period after the interval
 * (T1 when payable, T2 when deductible). Records are written once.
 */

export class CapitalGoodsError extends Error {}

type Good = typeof capitalGoods.$inferSelect;
type IntervalRow = typeof capitalGoodIntervals.$inferSelect;

function requirePerson(who: string): string {
  const name = who?.trim();
  if (!name) throw new CapitalGoodsError('Say who is recording this: a capital goods record is a person\'s statement.');
  return name;
}

function requireProportion(bp: number): number {
  if (!Number.isInteger(bp) || bp < 0 || bp > FULL_BP) {
    throw new CapitalGoodsError('The proportion of deductible use must be between 0% and 100% (0 to 10000 basis points).');
  }
  return bp;
}

function loadGood(db: AppDatabase, companyId: string, capitalGoodId: string): Good {
  const good = db.select().from(capitalGoods)
    .where(and(eq(capitalGoods.id, capitalGoodId), eq(capitalGoods.companyId, companyId))).get();
  if (!good) throw new CapitalGoodsError(`Capital good ${capitalGoodId} not found.`);
  return good;
}

export function scheduleFor(db: AppDatabase, good: Good): IntervalDates[] {
  const company = db.select().from(companies).where(eq(companies.id, good.companyId)).get()!;
  return intervalSchedule({
    initialIntervalStart: good.initialIntervalStart, intervalCount: good.intervalCount,
    yearEndDay: company.financialYearEndDay, yearEndMonth: company.financialYearEndMonth,
  });
}

export function registerCapitalGood(db: AppDatabase, params: {
  companyId: string; description: string; kind: 'acquisition_or_development' | 'refurbishment';
  initialIntervalStart: string; sourceInvoiceIds: string[]; deductedMinor: number; registeredBy: string; notes?: string;
}): string {
  const who = requirePerson(params.registeredBy);
  if (!params.description?.trim()) throw new CapitalGoodsError('Describe the capital good (the property, or the refurbishment).');
  if (!isIsoDate(params.initialIntervalStart)) {
    throw new CapitalGoodsError('The initial interval starts on completion, or on the date the good was supplied to you (YYYY-MM-DD).');
  }
  if (params.sourceInvoiceIds.length === 0) {
    throw new CapitalGoodsError('Name the purchase invoices the tax rests on: the total tax incurred comes from them, not a typed figure.');
  }
  const rows = db.select().from(invoices)
    .where(and(eq(invoices.companyId, params.companyId), inArray(invoices.id, params.sourceInvoiceIds))).all();
  if (rows.length !== new Set(params.sourceInvoiceIds).size) throw new CapitalGoodsError('One of the invoices was not found.');
  if (rows.some((r) => r.direction !== 'purchase' || r.status === 'void')) {
    throw new CapitalGoodsError('The tax incurred comes from purchase invoices that are not void.');
  }
  const total = rows.reduce((s, r) => s + r.baseVatMinor, 0);
  if (!Number.isInteger(params.deductedMinor) || params.deductedMinor < 0 || params.deductedMinor > total) {
    throw new CapitalGoodsError(`The tax deducted must be between €0.00 and the total tax incurred, €${(total / 100).toFixed(2)}.`);
  }
  const id = ids.capitalGood();
  const at = nowIso();
  db.transaction((tx) => {
    tx.insert(capitalGoods).values({
      id, companyId: params.companyId, description: params.description.trim(), kind: params.kind,
      intervalCount: params.kind === 'refurbishment' ? 10 : 20,
      initialIntervalStart: params.initialIntervalStart, totalTaxIncurredMinor: total, deductedMinor: params.deductedMinor,
      sourceInvoiceIds: params.sourceInvoiceIds, registeredBy: who, registeredAt: at, notes: params.notes ?? null,
    }).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: at, entityType: 'capital_good', entityId: id,
      action: 'user_confirmed', field: 'registered', newValue: JSON.stringify({ total, deducted: params.deductedMinor, kind: params.kind }),
      source: 'user', actor: who,
    }).run();
  });
  return id;
}

export function recordedIntervals(db: AppDatabase, capitalGoodId: string): IntervalRow[] {
  return db.select().from(capitalGoodIntervals).where(eq(capitalGoodIntervals.capitalGoodId, capitalGoodId))
    .orderBy(asc(capitalGoodIntervals.intervalNumber)).all();
}

/**
 * Record the proportion of deductible use for the next interval, after it has
 * ended, and calculate its adjustment. Intervals are recorded in order.
 */
export function recordIntervalUse(db: AppDatabase, params: {
  companyId: string; capitalGoodId: string; intervalNumber: number;
  /** Basis points; ignored when `notUsed` (the previous interval's applies, s.64(3)(c)). */
  proportionBp?: number; notUsed?: boolean; recordedBy: string; today?: string;
}): IntervalRow {
  const who = requirePerson(params.recordedBy);
  const good = loadGood(db, params.companyId, params.capitalGoodId);
  const schedule = scheduleFor(db, good);
  const interval = schedule.find((i) => i.number === params.intervalNumber);
  if (!interval) throw new CapitalGoodsError(`Interval ${params.intervalNumber} is outside the ${good.intervalCount}-interval adjustment period.`);
  const today = params.today ?? nowIso().slice(0, 10);
  if (interval.end >= today) throw new CapitalGoodsError(`Interval ${interval.number} ends on ${interval.end}; record its use after it ends.`);
  if (good.disposedOn && interval.end >= good.disposedOn) {
    throw new CapitalGoodsError(`The adjustment period ended on ${good.disposedOn}, when the good was supplied.`);
  }
  const done = recordedIntervals(db, good.id);
  if (done.some((r) => r.intervalNumber === interval.number)) {
    throw new CapitalGoodsError(`Interval ${interval.number} is already recorded; a record is never edited.`);
  }
  const expected = (done.at(-1)?.intervalNumber ?? 0) + 1;
  if (interval.number !== expected) throw new CapitalGoodsError(`Record interval ${expected} first.`);

  const previous = done.at(-1);
  const proportion = params.notUsed
    ? (interval.number === 1
      ? Math.round((good.deductedMinor * FULL_BP) / Math.max(1, good.totalTaxIncurredMinor)) // s.64(2)(c)
      : previous!.proportionBp) // s.64(3)(c)
    : requireProportion(params.proportionBp ?? Number.NaN);

  const adj = interval.number === 1
    ? initialIntervalAdjustment({ totalTaxIncurredMinor: good.totalTaxIncurredMinor, deductedMinor: good.deductedMinor, initialProportionBp: proportion })
    : laterIntervalAdjustment({
      totalTaxIncurredMinor: good.totalTaxIncurredMinor, intervalCount: good.intervalCount, intervalNumber: interval.number,
      baselineBp: currentBaseline(done),
      intervalProportionBp: proportion,
    });

  const row: typeof capitalGoodIntervals.$inferInsert = {
    id: ids.capitalGoodInterval(), companyId: params.companyId, capitalGoodId: good.id, intervalNumber: interval.number,
    startDate: interval.start, endDate: interval.end, proportionBp: proportion, notUsed: params.notUsed ?? false,
    baselineBp: adj.newBaselineBp, adjustmentMinor: adj.adjustmentMinor, provision: adj.provision,
    working: (params.notUsed ? 'Not used in the interval: the previous proportion applies. ' : '') + adj.working,
    recordedBy: who, recordedAt: nowIso(),
  };
  db.insert(capitalGoodIntervals).values(row).run();
  return db.select().from(capitalGoodIntervals).where(eq(capitalGoodIntervals.id, row.id!)).get()!;
}

/** The initial-interval proportion in force: the initial interval's, or the last s.64(4) reset. */
function currentBaseline(done: IntervalRow[]): number {
  return done.at(-1)!.baselineBp;
}

/** A supply of the good in its adjustment period (s.64(6)): the period ends, and one last adjustment arises. */
export function recordCapitalGoodDisposal(db: AppDatabase, params: {
  companyId: string; capitalGoodId: string; disposedOn: string; taxable: boolean; recordedBy: string;
}): { adjustmentMinor: number; working: string } {
  const who = requirePerson(params.recordedBy);
  const good = loadGood(db, params.companyId, params.capitalGoodId);
  if (good.disposedOn) throw new CapitalGoodsError(`The disposal on ${good.disposedOn} is already recorded.`);
  if (!isIsoDate(params.disposedOn)) throw new CapitalGoodsError('The date of the supply must be a date (YYYY-MM-DD).');
  const schedule = scheduleFor(db, good);
  const interval = schedule.find((i) => i.start <= params.disposedOn && params.disposedOn <= i.end);
  if (!interval) throw new CapitalGoodsError('The supply is outside the adjustment period: no adjustment arises.');
  const done = recordedIntervals(db, good.id);
  if (done.length < interval.number - 1) {
    throw new CapitalGoodsError(`Record intervals 1 to ${interval.number - 1} first: the adjustment on the supply rests on them.`);
  }
  const baseline = done.length ? currentBaseline(done) : null;
  const result = disposalAdjustment({
    totalTaxIncurredMinor: good.totalTaxIncurredMinor, deductedMinor: good.deductedMinor, intervalCount: good.intervalCount,
    intervalNumber: interval.number, baselineBp: interval.number === 1 ? null : baseline, taxable: params.taxable,
  });
  db.update(capitalGoods).set({
    disposedOn: params.disposedOn, disposalTaxable: params.taxable, disposalAdjustmentMinor: result.adjustmentMinor,
    disposalRecordedBy: who, updatedAt: nowIso(),
  }).where(eq(capitalGoods.id, good.id)).run();
  return result;
}

/** Post a capital goods adjustment as a VAT adjustment: payable to T1, deductible to T2. */
function postAdjustment(db: AppDatabase, params: {
  companyId: string; accountId: string; who: string; adjustmentMinor: number; date: string; description: string; reason: string;
}): string {
  const vatControl = db.select().from(accounts)
    .where(and(eq(accounts.companyId, params.companyId), eq(accounts.systemKey, 'vat_control'))).get();
  if (!vatControl) throw new CapitalGoodsError('The VAT control account is missing.');
  const std = db.select().from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, params.companyId), eq(vatTreatments.code, 'IE_STD'))).get();
  if (!std) throw new CapitalGoodsError('The standard-rate treatment is missing.');
  const amount = Math.abs(params.adjustmentMinor);
  const payable = params.adjustmentMinor > 0;
  const date = asIsoDate(params.date);
  return createAdjustment(db, {
    companyId: params.companyId, date, description: params.description, reason: params.reason,
    lines: payable
      ? [{ accountId: params.accountId, debitMinor: amount }, { accountId: vatControl.id, creditMinor: amount }]
      : [{ accountId: vatControl.id, debitMinor: amount }, { accountId: params.accountId, creditMinor: amount }],
    vat: { treatmentId: std.id, direction: payable ? 'sales' : 'purchases', netMinor: 0, statedVatMinor: amount, taxPointDate: date },
    actor: params.who,
  }).journalEntryId;
}

/**
 * Post an interval's adjustment in the taxable period after the interval
 * (s.64(2)(b), (3)(b)). The other side of the journal is the account the
 * person names.
 */
export function postCapitalGoodAdjustment(db: AppDatabase, params: {
  companyId: string; intervalId: string; accountId: string; postedBy: string;
}): { journalEntryId: string } {
  const who = requirePerson(params.postedBy);
  const row = db.select().from(capitalGoodIntervals)
    .where(and(eq(capitalGoodIntervals.id, params.intervalId), eq(capitalGoodIntervals.companyId, params.companyId))).get();
  if (!row) throw new CapitalGoodsError(`Interval record ${params.intervalId} not found.`);
  if (row.journalEntryId) throw new CapitalGoodsError('This adjustment is already posted.');
  if (row.adjustmentMinor === 0) throw new CapitalGoodsError('This interval has no adjustment to post.');
  const good = loadGood(db, params.companyId, row.capitalGoodId);
  const journalEntryId = postAdjustment(db, {
    companyId: params.companyId, accountId: params.accountId, who, adjustmentMinor: row.adjustmentMinor,
    date: adjustmentDate(row.endDate),
    description: `Capital goods scheme ${row.provision}: ${good.description}, interval ${row.intervalNumber}`,
    reason: `${row.working}. Recorded by ${row.recordedBy}; posted by ${who}.`,
  });
  db.update(capitalGoodIntervals).set({ journalEntryId, updatedAt: nowIso() }).where(eq(capitalGoodIntervals.id, row.id)).run();
  return { journalEntryId };
}

/** Post the adjustment on a supply of the good, in the taxable period of the supply (s.64(6)). */
export function postCapitalGoodDisposalAdjustment(db: AppDatabase, params: {
  companyId: string; capitalGoodId: string; accountId: string; postedBy: string;
}): { journalEntryId: string } {
  const who = requirePerson(params.postedBy);
  const good = loadGood(db, params.companyId, params.capitalGoodId);
  if (!good.disposedOn || good.disposalAdjustmentMinor == null) throw new CapitalGoodsError('No supply of this good is recorded.');
  if (good.disposalJournalEntryId) throw new CapitalGoodsError('The disposal adjustment is already posted.');
  if (good.disposalAdjustmentMinor === 0) throw new CapitalGoodsError('The supply gives no adjustment to post.');
  const journalEntryId = postAdjustment(db, {
    companyId: params.companyId, accountId: params.accountId, who, adjustmentMinor: good.disposalAdjustmentMinor,
    date: good.disposedOn,
    description: `Capital goods scheme s.64(6): ${good.description}, ${good.disposalTaxable ? 'taxable' : 'exempt'} supply`,
    reason: `Supply on ${good.disposedOn} recorded by ${good.disposalRecordedBy}; posted by ${who}.`,
  });
  db.update(capitalGoods).set({ disposalJournalEntryId: journalEntryId, updatedAt: nowIso() }).where(eq(capitalGoods.id, good.id)).run();
  return { journalEntryId };
}

export interface DueInterval { capitalGoodId: string; description: string; interval: IntervalDates }

/** Intervals that have ended by a date and whose use is not recorded. */
export function dueCapitalGoodIntervals(db: AppDatabase, params: { companyId: string; asOf: string }): DueInterval[] {
  const due: DueInterval[] = [];
  for (const good of db.select().from(capitalGoods).where(eq(capitalGoods.companyId, params.companyId)).all()) {
    const recorded = new Set(recordedIntervals(db, good.id).map((r) => r.intervalNumber));
    for (const interval of scheduleFor(db, good)) {
      if (interval.end >= params.asOf) break;
      // The adjustment period ends on the supply (s.64(1)(b)): the interval it falls in is never completed.
      if (good.disposedOn && interval.end >= good.disposedOn) break;
      if (!recorded.has(interval.number)) { due.push({ capitalGoodId: good.id, description: good.description, interval }); break; }
    }
  }
  return due;
}

export interface CapitalGoodsFinding {
  code: 'cgs_interval_due' | 'cgs_adjustment_unposted';
  title: string;
  detail: string;
  entityIds: string[];
}

/**
 * For a VAT period: intervals that ended before it whose use is not recorded,
 * and recorded adjustments that belong in it but are not posted.
 */
export function capitalGoodsFindings(db: AppDatabase, params: {
  companyId: string; periodStart: string; periodEnd: string;
}): CapitalGoodsFinding[] {
  const findings: CapitalGoodsFinding[] = [];
  const due = dueCapitalGoodIntervals(db, { companyId: params.companyId, asOf: params.periodEnd });
  if (due.length) {
    findings.push({
      code: 'cgs_interval_due',
      title: `${due.length} capital good interval${due.length === 1 ? '' : 's'} ended without the use recorded`,
      detail: due.map((d) => `${d.description}: interval ${d.interval.number} (${d.interval.start} to ${d.interval.end})`).join('; ')
        + '. Record the proportion of deductible use; any adjustment falls in the taxable period after the interval (VATCA s.64).',
      entityIds: due.map((d) => d.capitalGoodId),
    });
  }
  const unposted: string[] = [];
  const entityIds: string[] = [];
  for (const good of db.select().from(capitalGoods).where(eq(capitalGoods.companyId, params.companyId)).all()) {
    for (const row of recordedIntervals(db, good.id)) {
      const on = adjustmentDate(row.endDate);
      if (row.adjustmentMinor !== 0 && !row.journalEntryId && on >= params.periodStart && on <= params.periodEnd) {
        unposted.push(`${good.description}, interval ${row.intervalNumber}: €${(row.adjustmentMinor / 100).toFixed(2)}`);
        entityIds.push(good.id);
      }
    }
    if (good.disposedOn && good.disposalAdjustmentMinor && !good.disposalJournalEntryId
        && good.disposedOn >= params.periodStart && good.disposedOn <= params.periodEnd) {
      unposted.push(`${good.description}, supply on ${good.disposedOn}: €${(good.disposalAdjustmentMinor / 100).toFixed(2)}`);
      entityIds.push(good.id);
    }
  }
  if (unposted.length) {
    findings.push({
      code: 'cgs_adjustment_unposted',
      title: `${unposted.length} capital goods adjustment${unposted.length === 1 ? '' : 's'} for this period not posted`,
      detail: `${unposted.join('; ')} (positive: payable, T1; negative: deductible, T2).`,
      entityIds,
    });
  }
  return findings;
}

export interface CapitalGoodOverview {
  good: Good;
  intervals: Array<IntervalDates & { record: IntervalRow | null; adjustmentOn: string }>;
  nextDue: IntervalDates | null;
}

/** Each capital good with its full schedule and what has been recorded against it. */
export function capitalGoodsOverview(db: AppDatabase, params: { companyId: string; asOf?: string }): CapitalGoodOverview[] {
  const asOf = params.asOf ?? nowIso().slice(0, 10);
  const due = new Map(dueCapitalGoodIntervals(db, { companyId: params.companyId, asOf }).map((d) => [d.capitalGoodId, d.interval]));
  return db.select().from(capitalGoods).where(eq(capitalGoods.companyId, params.companyId)).all().map((good) => {
    const records = new Map(recordedIntervals(db, good.id).map((r) => [r.intervalNumber, r]));
    return {
      good,
      intervals: scheduleFor(db, good).map((i) => ({ ...i, record: records.get(i.number) ?? null, adjustmentOn: adjustmentDate(i.end) })),
      nextDue: due.get(good.id) ?? null,
    };
  });
}

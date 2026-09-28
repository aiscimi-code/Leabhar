/**
 * Recurring items for the forecast (issue #567, epic #333).
 *
 * Detection reads the bank history and suggests payees paid or received on a
 * regular schedule. A suggestion is not used until a person confirms it; a
 * dismissed one is not suggested again. A person can also enter a recurring
 * item by hand. A change to an item is a new version; the old one stays
 * readable and points at its replacement.
 *
 * Amounts are base-currency minor units: a bank line in another currency is
 * read at its base amount, and one with no base amount is left out.
 */

import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { bankTransactions, companies, recurringBankPatterns, recurringForecastItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, addMonths, daysBetween, isIsoDate, nowIso, type IsoDate } from '../dates';
import { atomically } from '../accounting/journal';
import { normaliseDescription } from '../banking/fingerprint';
import type { Frequency } from './engine';
import { ForecastError } from './types';

export type RecurringBankPattern = typeof recurringBankPatterns.$inferSelect;
export type RecurringForecastItem = typeof recurringForecastItems.$inferSelect;

/** The interval bands a schedule is recognised in, in days. */
const BANDS: Array<{ frequency: Frequency; min: number; max: number }> = [
  { frequency: 'weekly', min: 6, max: 8 },
  { frequency: 'monthly', min: 27, max: 34 },
  { frequency: 'quarterly', min: 84, max: 98 },
  { frequency: 'yearly', min: 350, max: 380 },
];

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

export function nextOccurrence(frequency: Frequency, from: IsoDate): IsoDate {
  return frequency === 'weekly' ? addDays(from, 7) : addMonths(from, frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12);
}

export interface DetectionResult {
  suggested: RecurringBankPattern[];
  /** Payees already confirmed or dismissed: left as they are. */
  alreadyReviewed: number;
  /** Bank lines in another currency with no base amount, left out. */
  unconverted: number;
}

/**
 * Detect recurring payees in the bank history up to `asOf`, over `lookbackDays`.
 * A payee needs `minOccurrences` lines at least, most of whose intervals fall in one band.
 */
export function detectRecurringPatterns(db: AppDatabase, params: {
  companyId: string; asOf: IsoDate; lookbackDays?: number; minOccurrences?: number;
}): DetectionResult {
  const lookback = params.lookbackDays ?? 400;
  const minOccurrences = params.minOccurrences ?? 3;
  if (!isIsoDate(params.asOf)) throw new ForecastError('The detection date is a YYYY-MM-DD date.');
  const company = db.select({ baseCurrency: companies.baseCurrency }).from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new ForecastError(`Company ${params.companyId} not found.`);
  const rows = db.select().from(bankTransactions).where(and(
    eq(bankTransactions.companyId, params.companyId),
    gte(bankTransactions.transactionDate, addDays(params.asOf, -lookback)),
    lte(bankTransactions.transactionDate, params.asOf),
  )).orderBy(asc(bankTransactions.transactionDate)).all();

  let unconverted = 0;
  const groups = new Map<string, { payee: string; direction: 'inflow' | 'outflow'; lines: Array<{ date: IsoDate; amount: number }> }>();
  for (const r of rows) {
    if (r.amountMinor === 0) continue;
    const base = r.currency === company.baseCurrency ? r.amountMinor : r.baseAmountMinor ?? null;
    if (base === null) { unconverted += 1; continue; }
    const payee = (r.counterpartyName?.trim() || r.description).trim();
    const name = normaliseDescription(payee).replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const direction = r.amountMinor > 0 ? 'inflow' : 'outflow';
    const key = `${direction}:${name}`;
    const g = groups.get(key) ?? { payee, direction, lines: [] };
    g.lines.push({ date: r.transactionDate as IsoDate, amount: Math.abs(base) });
    groups.set(key, g);
  }

  const suggested: RecurringBankPattern[] = [];
  let alreadyReviewed = 0;
  atomically(db, () => {
    for (const [patternKey, g] of groups) {
      if (g.lines.length < minOccurrences) continue;
      const intervals = g.lines.slice(1).map((l, i) => daysBetween(g.lines[i]!.date, l.date));
      const band = BANDS.find((b) => {
        const hits = intervals.filter((d) => d >= b.min && d <= b.max).length;
        return hits * 3 >= intervals.length * 2;
      });
      if (!band) continue;
      const amounts = g.lines.map((l) => l.amount);
      const values = {
        payeePattern: g.payee, direction: g.direction, medianAmountMinor: median(amounts),
        amountMinMinor: Math.min(...amounts), amountMaxMinor: Math.max(...amounts), detectedFrequency: band.frequency,
        occurrenceCount: g.lines.length, firstSeenDate: g.lines[0]!.date, lastSeenDate: g.lines[g.lines.length - 1]!.date,
      };
      const existing = db.select().from(recurringBankPatterns).where(and(
        eq(recurringBankPatterns.companyId, params.companyId), eq(recurringBankPatterns.patternKey, patternKey),
      )).get();
      if (existing && existing.status !== 'suggested') { alreadyReviewed += 1; continue; }
      if (existing) {
        db.update(recurringBankPatterns).set({ ...values, updatedAt: nowIso() }).where(eq(recurringBankPatterns.id, existing.id)).run();
        suggested.push(db.select().from(recurringBankPatterns).where(eq(recurringBankPatterns.id, existing.id)).get()!);
      } else {
        const id = ids.recurringBankPattern();
        db.insert(recurringBankPatterns).values({ id, companyId: params.companyId, patternKey, status: 'suggested', ...values }).run();
        suggested.push(db.select().from(recurringBankPatterns).where(eq(recurringBankPatterns.id, id)).get()!);
      }
    }
  });
  return { suggested, alreadyReviewed, unconverted };
}

function patternOf(db: AppDatabase, companyId: string, patternId: string): RecurringBankPattern {
  const p = db.select().from(recurringBankPatterns)
    .where(and(eq(recurringBankPatterns.id, patternId), eq(recurringBankPatterns.companyId, companyId))).get();
  if (!p) throw new ForecastError(`Pattern ${patternId} not found.`);
  if (p.status !== 'suggested') throw new ForecastError(`That pattern is already ${p.status}.`);
  return p;
}

/**
 * Confirm a suggestion as a recurring item. The person may correct the
 * amount, the frequency or the first date; the median and the next date after
 * the last one seen are the defaults.
 */
export function confirmRecurringPattern(db: AppDatabase, params: {
  companyId: string; patternId: string; confirmedBy: string;
  description?: string; amountMinor?: number; frequency?: Frequency; startDate?: string; endDate?: string | null;
}): RecurringForecastItem {
  if (!params.confirmedBy.trim()) throw new ForecastError('Say who is confirming the pattern.');
  const p = patternOf(db, params.companyId, params.patternId);
  const frequency = params.frequency ?? p.detectedFrequency;
  const item = validateItem({
    description: params.description ?? p.payeePattern, direction: p.direction, amountMinor: params.amountMinor ?? p.medianAmountMinor,
    frequency, startDate: params.startDate ?? nextOccurrence(frequency, p.lastSeenDate as IsoDate), endDate: params.endDate ?? null,
  });
  const id = ids.recurringForecastItem();
  const now = nowIso();
  atomically(db, () => {
    db.insert(recurringForecastItems).values({
      id, companyId: params.companyId, ...item, amountMaxMinor: p.amountMaxMinor !== p.amountMinMinor ? p.amountMaxMinor : null,
      status: 'confirmed', payeePattern: p.payeePattern, source: 'detected', confirmedBy: params.confirmedBy, confirmedAt: now,
      recordedBy: params.confirmedBy,
    }).run();
    db.update(recurringBankPatterns).set({
      status: 'confirmed', confirmedItemId: id, reviewedBy: params.confirmedBy, reviewedAt: now, updatedAt: now,
    }).where(eq(recurringBankPatterns.id, p.id)).run();
  });
  return db.select().from(recurringForecastItems).where(eq(recurringForecastItems.id, id)).get()!;
}

export function dismissRecurringPattern(db: AppDatabase, params: { companyId: string; patternId: string; dismissedBy: string }): RecurringBankPattern {
  if (!params.dismissedBy.trim()) throw new ForecastError('Say who is dismissing the pattern.');
  const p = patternOf(db, params.companyId, params.patternId);
  const now = nowIso();
  db.update(recurringBankPatterns).set({ status: 'dismissed', reviewedBy: params.dismissedBy, reviewedAt: now, updatedAt: now })
    .where(eq(recurringBankPatterns.id, p.id)).run();
  return db.select().from(recurringBankPatterns).where(eq(recurringBankPatterns.id, p.id)).get()!;
}

interface ItemFields {
  description: string; direction: 'inflow' | 'outflow'; amountMinor: number; frequency: Frequency;
  startDate: string; endDate: string | null;
}

function validateItem(i: ItemFields): ItemFields {
  if (!i.description.trim()) throw new ForecastError('Describe the recurring item.');
  if (!Number.isInteger(i.amountMinor) || i.amountMinor <= 0) throw new ForecastError('The amount is a positive whole number of cents.');
  if (!isIsoDate(i.startDate)) throw new ForecastError('The first date is a YYYY-MM-DD date.');
  if (i.endDate !== null && (!isIsoDate(i.endDate) || i.endDate < i.startDate)) {
    throw new ForecastError('The last date is a YYYY-MM-DD date on or after the first.');
  }
  return { ...i, description: i.description.trim() };
}

/** A recurring item a person enters (rent, a loan repayment, a subscription). */
export function createRecurringItem(db: AppDatabase, params: ItemFields & { companyId: string; recordedBy: string; notes?: string | null }): RecurringForecastItem {
  if (!params.recordedBy.trim()) throw new ForecastError('Say who is recording the item.');
  const item = validateItem(params);
  const id = ids.recurringForecastItem();
  db.insert(recurringForecastItems).values({
    id, companyId: params.companyId, ...item, status: 'confirmed', source: 'manual',
    confirmedBy: params.recordedBy, confirmedAt: nowIso(), notes: params.notes ?? null, recordedBy: params.recordedBy,
  }).run();
  return db.select().from(recurringForecastItems).where(eq(recurringForecastItems.id, id)).get()!;
}

/**
 * Change a recurring item: a new version carries the change and the old one
 * points at it. Stopping an item is a change too (`status: 'dismissed'`, or an end date).
 */
export function updateRecurringItem(db: AppDatabase, params: {
  companyId: string; itemId: string; recordedBy: string;
  changes: Partial<ItemFields> & { status?: 'confirmed' | 'dismissed'; notes?: string | null };
}): RecurringForecastItem {
  if (!params.recordedBy.trim()) throw new ForecastError('Say who is changing the item.');
  const old = db.select().from(recurringForecastItems)
    .where(and(eq(recurringForecastItems.id, params.itemId), eq(recurringForecastItems.companyId, params.companyId))).get();
  if (!old) throw new ForecastError(`Recurring item ${params.itemId} not found.`);
  if (old.supersededById) throw new ForecastError('That version has been replaced: change the current one.');
  const item = validateItem({
    description: params.changes.description ?? old.description, direction: params.changes.direction ?? old.direction,
    amountMinor: params.changes.amountMinor ?? old.amountMinor, frequency: params.changes.frequency ?? old.frequency,
    startDate: params.changes.startDate ?? old.startDate,
    endDate: params.changes.endDate !== undefined ? params.changes.endDate : old.endDate,
  });
  const id = ids.recurringForecastItem();
  atomically(db, () => {
    db.insert(recurringForecastItems).values({
      id, companyId: params.companyId, ...item, amountMaxMinor: old.amountMaxMinor,
      status: params.changes.status ?? old.status, payeePattern: old.payeePattern, source: old.source,
      confirmedBy: old.confirmedBy, confirmedAt: old.confirmedAt,
      notes: params.changes.notes !== undefined ? params.changes.notes : old.notes, recordedBy: params.recordedBy,
    }).run();
    db.update(recurringForecastItems).set({ supersededById: id, updatedAt: nowIso() }).where(eq(recurringForecastItems.id, old.id)).run();
  });
  return db.select().from(recurringForecastItems).where(eq(recurringForecastItems.id, id)).get()!;
}

/** The current version of each recurring item. */
export function listRecurringItems(db: AppDatabase, companyId: string): RecurringForecastItem[] {
  return db.select().from(recurringForecastItems)
    .where(and(eq(recurringForecastItems.companyId, companyId), isNull(recurringForecastItems.supersededById)))
    .orderBy(asc(recurringForecastItems.description)).all();
}

export function listRecurringPatterns(db: AppDatabase, companyId: string, status?: RecurringBankPattern['status']): RecurringBankPattern[] {
  return db.select().from(recurringBankPatterns)
    .where(status ? and(eq(recurringBankPatterns.companyId, companyId), eq(recurringBankPatterns.status, status)) : eq(recurringBankPatterns.companyId, companyId))
    .orderBy(asc(recurringBankPatterns.payeePattern)).all();
}

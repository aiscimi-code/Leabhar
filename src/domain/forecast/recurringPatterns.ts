/**
 * Recurring transaction model: detect patterns in bank history, confirm them
 * as forecast items (issue #567, epic #333).
 *
 * Detection: same payee or description, an amount within a band, a regular
 * interval. Patterns are suggestions only — never used until confirmed.
 *
 * Confirmed items: effective-dated. Changes are new versions. A dismissed
 * pattern is not re-suggested.
 *
 * Matching: when a bank transaction arrives that fulfils a forecast item,
 * it is linked so it isn't double-counted.
 *
 * Provenance: a suggestion never overwrites a confirmed item (AGENTS.md #8).
 */

import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, recurringBankPatterns, recurringForecastItems, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, daysBetween, nowIso, type IsoDate } from '../dates';
import { ForecastError } from './types';

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

interface TransactionGroup {
  payee: string;
  direction: 'inflow' | 'outflow';
  amounts: number[];
  dates: string[];
}

const FREQ_DAYS: Record<string, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 91,
  yearly: 365,
};

function detectFrequency(sortedDates: string[]): 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null {
  if (sortedDates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    gaps.push(daysBetween(asIsoDate(sortedDates[i - 1]!), asIsoDate(sortedDates[i]!)));
  }
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const maxVariance = avg * 0.3; // 30% variance tolerance
  const consistent = gaps.every((g) => Math.abs(g - avg) <= maxVariance);
  if (!consistent) return null;
  // Match to known frequencies
  const best = Object.entries(FREQ_DAYS).sort((a, b) => Math.abs(a[1] - avg) - Math.abs(b[1] - avg))[0];
  if (!best || Math.abs(best[1] - avg) > maxVariance) return null;
  return best[0] as 'weekly' | 'monthly' | 'quarterly' | 'yearly';
}

/** Normalise a payee string for grouping: lowercase, strip extra spaces and common noise words. */
function normalisePayee(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/\b(ltd|limited|plc|co)\b/g, '').trim();
}

/**
 * Scan the last 18 months of bank history to detect recurring patterns.
 * Returns the number of new patterns suggested.
 * Patterns already in the database (any status) are not re-suggested.
 */
export function detectRecurringPatterns(
  db: AppDatabase,
  params: { companyId: string; asOf: IsoDate },
): number {
  // Pull bank transactions from the last 18 months
  const cutoff = new Date(Date.parse(`${params.asOf}T00:00:00Z`) - 18 * 30 * 86_400_000).toISOString().slice(0, 10);
  const txs = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.companyId, params.companyId),
      // Only classified/reconciled transactions (not raw imports)
    )).all()
    .filter((t) => t.transactionDate >= cutoff && t.description);

  // Existing patterns (any status) — dedupe by payee to avoid re-suggestion
  const existing = new Set(
    db.select().from(recurringBankPatterns)
      .where(eq(recurringBankPatterns.companyId, params.companyId))
      .all().map((r) => normalisePayee(r.payeePattern)),
  );

  // Group transactions by normalised payee
  const groups = new Map<string, TransactionGroup>();
  for (const tx of txs) {
    const payee = tx.counterpartyName ?? tx.description ?? '';
    if (!payee) continue;
    const norm = normalisePayee(payee);
    if (!groups.has(norm)) {
      groups.set(norm, {
        payee: payee,
        direction: tx.amountMinor >= 0 ? 'inflow' : 'outflow',
        amounts: [],
        dates: [],
      });
    }
    const g = groups.get(norm)!;
    g.amounts.push(Math.abs(tx.amountMinor));
    g.dates.push(tx.transactionDate);
  }

  let suggested = 0;
  for (const [norm, g] of groups) {
    if (g.dates.length < 3) continue; // need at least 3 occurrences
    if (existing.has(norm)) continue;

    const sorted = [...g.dates].sort();
    const freq = detectFrequency(sorted);
    if (!freq) continue;

    const amounts = g.amounts.slice().sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)]!;
    const amountMin = amounts[0]!;
    const amountMax = amounts[amounts.length - 1]!;
    // Only suggest if amounts are within 50% of median
    if (amountMax > median * 1.5 || amountMin < median * 0.5) continue;

    const id = ids.recurringBankPattern();
    db.insert(recurringBankPatterns).values({
      id,
      companyId: params.companyId,
      payeePattern: g.payee,
      direction: g.direction,
      medianAmountMinor: median,
      amountMinMinor: amountMin,
      amountMaxMinor: amountMax,
      detectedFrequency: freq,
      occurrenceCount: g.dates.length,
      firstSeenDate: sorted[0]!,
      lastSeenDate: sorted[sorted.length - 1]!,
      status: 'suggested',
    }).run();
    suggested++;
  }
  return suggested;
}

// ---------------------------------------------------------------------------
// Confirm a pattern into a recurring forecast item
// ---------------------------------------------------------------------------

export function confirmRecurringPattern(
  db: AppDatabase,
  params: {
    companyId: string;
    patternId: string;
    description: string;
    amountMinor: number;
    startDate: IsoDate;
    endDate?: IsoDate | null;
    confirmedBy: string;
  },
): string {
  const pattern = db.select().from(recurringBankPatterns)
    .where(and(
      eq(recurringBankPatterns.id, params.patternId),
      eq(recurringBankPatterns.companyId, params.companyId),
    )).get();
  if (!pattern) throw new ForecastError(`Pattern ${params.patternId} not found.`);
  if (pattern.status === 'dismissed') throw new ForecastError('This pattern has been dismissed and cannot be confirmed.');
  if (pattern.status === 'confirmed') throw new ForecastError('This pattern is already confirmed.');

  if (!params.description.trim()) throw new ForecastError('A confirmed item needs a description.');
  if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) {
    throw new ForecastError('The amount is a positive integer in minor units.');
  }
  if (!params.confirmedBy.trim()) throw new ForecastError('Say who is confirming this pattern.');

  const itemId = ids.recurringForecastItem();
  db.transaction(() => {
    db.insert(recurringForecastItems).values({
      id: itemId,
      companyId: params.companyId,
      description: params.description.trim(),
      direction: pattern.direction,
      amountMinor: params.amountMinor,
      frequency: pattern.detectedFrequency,
      startDate: params.startDate,
      endDate: params.endDate ?? null,
      nextDate: params.startDate,
      status: 'confirmed',
      payeePattern: pattern.payeePattern,
      source: 'detected',
      confirmedBy: params.confirmedBy,
      confirmedAt: nowIso(),
      recordedBy: params.confirmedBy,
    }).run();
    db.update(recurringBankPatterns).set({
      status: 'confirmed', confirmedItemId: itemId, reviewedBy: params.confirmedBy, reviewedAt: nowIso(), updatedAt: nowIso(),
    }).where(eq(recurringBankPatterns.id, params.patternId)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'recurring_forecast_item', entityId: itemId, action: 'created',
      newValue: JSON.stringify({ patternId: params.patternId, description: params.description }),
      source: 'user', actor: params.confirmedBy,
    }).run();
  });
  return itemId;
}

// ---------------------------------------------------------------------------
// Dismiss a pattern
// ---------------------------------------------------------------------------

export function dismissRecurringPattern(
  db: AppDatabase,
  params: { companyId: string; patternId: string; dismissedBy: string },
): void {
  const pattern = db.select().from(recurringBankPatterns)
    .where(and(
      eq(recurringBankPatterns.id, params.patternId),
      eq(recurringBankPatterns.companyId, params.companyId),
    )).get();
  if (!pattern) throw new ForecastError(`Pattern ${params.patternId} not found.`);
  if (!params.dismissedBy.trim()) throw new ForecastError('Say who is dismissing this pattern.');
  db.update(recurringBankPatterns).set({
    status: 'dismissed', reviewedBy: params.dismissedBy, reviewedAt: nowIso(), updatedAt: nowIso(),
  }).where(eq(recurringBankPatterns.id, params.patternId)).run();
}

// ---------------------------------------------------------------------------
// Create a manual recurring forecast item
// ---------------------------------------------------------------------------

export function createRecurringForecastItem(
  db: AppDatabase,
  params: {
    companyId: string;
    description: string;
    direction: 'inflow' | 'outflow';
    amountMinor: number;
    frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
    startDate: IsoDate;
    endDate?: IsoDate | null;
    notes?: string | null;
    recordedBy: string;
  },
): string {
  if (!params.description.trim()) throw new ForecastError('A forecast item needs a description.');
  if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) {
    throw new ForecastError('The amount is a positive integer in minor units.');
  }
  if (!params.recordedBy.trim()) throw new ForecastError('Say who is recording this item.');
  if (params.endDate && params.endDate < params.startDate) throw new ForecastError('The end date is before the start date.');

  const id = ids.recurringForecastItem();
  db.transaction(() => {
    db.insert(recurringForecastItems).values({
      id, companyId: params.companyId, description: params.description.trim(),
      direction: params.direction, amountMinor: params.amountMinor, frequency: params.frequency,
      startDate: params.startDate, endDate: params.endDate ?? null, nextDate: params.startDate,
      status: 'confirmed', source: 'manual',
      confirmedBy: params.recordedBy, confirmedAt: nowIso(),
      notes: params.notes ?? null, recordedBy: params.recordedBy,
    }).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'recurring_forecast_item', entityId: id, action: 'created',
      newValue: JSON.stringify({ description: params.description, direction: params.direction, frequency: params.frequency }),
      source: 'user', actor: params.recordedBy,
    }).run();
  });
  return id;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface RecurringPatternSummary {
  id: string;
  payeePattern: string;
  direction: 'inflow' | 'outflow';
  medianAmountMinor: number;
  detectedFrequency: string;
  occurrenceCount: number;
  firstSeenDate: string;
  lastSeenDate: string;
  status: 'suggested' | 'confirmed' | 'dismissed';
}

export function listRecurringPatterns(
  db: AppDatabase, params: { companyId: string },
): RecurringPatternSummary[] {
  return db.select().from(recurringBankPatterns)
    .where(eq(recurringBankPatterns.companyId, params.companyId))
    .all()
    .map((r) => ({
      id: r.id,
      payeePattern: r.payeePattern,
      direction: r.direction,
      medianAmountMinor: r.medianAmountMinor,
      detectedFrequency: r.detectedFrequency,
      occurrenceCount: r.occurrenceCount,
      firstSeenDate: r.firstSeenDate,
      lastSeenDate: r.lastSeenDate,
      status: r.status,
    }));
}

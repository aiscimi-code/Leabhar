import { and, eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { reviewItems } from '@/db/schema';
import { scanForAnomalies, syncAnomaliesToReviewQueue, type AnomalyScan } from '@/domain/review/anomalies';
import { asIsoDate } from '@/domain/dates';
import type { ScanAnomaliesCliInput, ListReviewQueueInput } from './schema';

/**
 * CLI access to the anomaly-detection and review-queue layer (issues #145–151
 * built a mature, well-tested `scanForAnomalies` — duplicate invoices,
 * hospitality-rate mismatches, an unidentified supplier, and more — but
 * nothing surfaced it outside the web UI; an agent had to read the database
 * directly to see what it found.
 */

export interface ScanAnomaliesResult extends AnomalyScan {
  /** Set only when --sync was passed: how many findings were written to the review queue. */
  syncedToReviewQueue: number | null;
}

export function scanAnomaliesCli(db: AppDatabase, input: ScanAnomaliesCliInput): ScanAnomaliesResult {
  const scan = scanForAnomalies(db, {
    companyId: input.companyId,
    from: input.from ? asIsoDate(input.from) : undefined,
    to: input.to ? asIsoDate(input.to) : undefined,
  });
  const syncedToReviewQueue = input.sync
    ? syncAnomaliesToReviewQueue(db, { companyId: input.companyId, scan })
    : null;
  return { ...scan, syncedToReviewQueue };
}

/** Same severity ordering the web UI's review queue uses (src/lib/queries.ts). */
const SEVERITY_ORDER: Record<string, number> = { blocking: 0, error: 1, warning: 2, info: 3 };

/**
 * List the review queue. Defaults to open items only — matching the web UI's
 * own `reviewQueue()` — since "everything ever raised, including what was
 * already resolved" is rarely what an agent checking in on the books wants;
 * pass `--status all` to see every status.
 */
export function listReviewQueueCli(db: AppDatabase, input: ListReviewQueueInput) {
  const conditions = [eq(reviewItems.companyId, input.companyId)];
  if (input.status && input.status !== 'all') conditions.push(eq(reviewItems.status, input.status));
  if (input.severity) conditions.push(eq(reviewItems.severity, input.severity));
  if (input.kind) conditions.push(eq(reviewItems.kind, input.kind));

  const items = db.select().from(reviewItems)
    .where(and(...conditions))
    .orderBy(desc(reviewItems.createdAt))
    .all();

  return [...items].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
}

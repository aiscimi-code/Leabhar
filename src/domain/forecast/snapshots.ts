/**
 * Saved forecasts (issue #565, decisions on #333: saved on request).
 *
 * A snapshot keeps a forecast exactly as it was computed, with the options it
 * was built from, so a later forecast can be compared with it. A snapshot is
 * never changed after it is saved: there is no update path.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { forecastSnapshots } from '@/db/schema';
import { ids } from '@/lib/ids';
import { ForecastError, type ForecastLine, type ForecastResult } from './types';

export interface ForecastSnapshot {
  id: string;
  companyId: string;
  name: string;
  asOf: string;
  horizonEnd: string;
  scenarioId: string | null;
  savedBy: string;
  createdAt: string;
  result: ForecastResult;
}

function toSnapshot(row: typeof forecastSnapshots.$inferSelect): ForecastSnapshot {
  return {
    id: row.id, companyId: row.companyId, name: row.name, asOf: row.asOf, horizonEnd: row.horizonEnd,
    scenarioId: row.scenarioId, savedBy: row.savedBy, createdAt: row.createdAt,
    result: row.resultJson as unknown as ForecastResult,
  };
}

export function saveForecastSnapshot(db: AppDatabase, params: { name: string; savedBy: string; result: ForecastResult }): ForecastSnapshot {
  if (!params.name.trim()) throw new ForecastError('Name the saved forecast.');
  if (!params.savedBy.trim()) throw new ForecastError('Say who is saving the forecast.');
  const r = params.result;
  const id = ids.forecastSnapshot();
  db.insert(forecastSnapshots).values({
    id, companyId: r.companyId, name: params.name.trim(), asOf: r.options.asOf, horizonEnd: r.options.horizonEnd,
    scenarioId: r.options.scenarioId ?? null,
    optionsJson: JSON.parse(JSON.stringify(r.options)) as Record<string, unknown>,
    resultJson: JSON.parse(JSON.stringify(r)) as Record<string, unknown>,
    savedBy: params.savedBy,
  }).run();
  return getForecastSnapshot(db, { companyId: r.companyId, snapshotId: id });
}

export function getForecastSnapshot(db: AppDatabase, params: { companyId: string; snapshotId: string }): ForecastSnapshot {
  const row = db.select().from(forecastSnapshots)
    .where(and(eq(forecastSnapshots.id, params.snapshotId), eq(forecastSnapshots.companyId, params.companyId))).get();
  if (!row) throw new ForecastError(`Saved forecast ${params.snapshotId} not found.`);
  return toSnapshot(row);
}

export function listForecastSnapshots(db: AppDatabase, companyId: string): Array<Omit<ForecastSnapshot, 'result'> & { closingBalanceMinor: number; lowestPointMinor: number }> {
  return db.select().from(forecastSnapshots).where(eq(forecastSnapshots.companyId, companyId))
    .orderBy(desc(forecastSnapshots.createdAt)).all()
    .map((row) => {
      const { result, ...rest } = toSnapshot(row);
      return { ...rest, closingBalanceMinor: result.closingBalanceMinor, lowestPointMinor: result.lowestPointMinor };
    });
}

export interface SnapshotComparison {
  snapshot: Omit<ForecastSnapshot, 'result'>;
  closing: { savedMinor: number; currentMinor: number; differenceMinor: number };
  lowestPoint: { savedMinor: number; currentMinor: number; differenceMinor: number };
  /** Lines in the current forecast and not in the saved one. */
  added: ForecastLine[];
  /** Lines in the saved forecast and no longer in the current one. */
  removed: ForecastLine[];
  /** Lines in both whose amount or date moved. */
  changed: Array<{ key: string; description: string; saved: { date: string | null; amountMinor: number }; current: { date: string | null; amountMinor: number } }>;
}

function allLines(r: ForecastResult): Map<string, ForecastLine> {
  const lines = [...r.buckets.flatMap((b) => [...b.inflows, ...b.outflows]), ...r.undated, ...r.unconfirmed];
  return new Map(lines.map((l) => [l.key, l]));
}

/** A saved forecast against a current one: what moved, line by line. */
export function compareWithSnapshot(db: AppDatabase, params: { companyId: string; snapshotId: string; current: ForecastResult }): SnapshotComparison {
  const { result: saved, ...snapshot } = getForecastSnapshot(db, params);
  const before = allLines(saved);
  const after = allLines(params.current);
  const changed: SnapshotComparison['changed'] = [];
  for (const [key, now] of after) {
    const was = before.get(key);
    if (was && (was.date !== now.date || was.amountMinor !== now.amountMinor)) {
      changed.push({ key, description: now.description, saved: { date: was.date, amountMinor: was.amountMinor }, current: { date: now.date, amountMinor: now.amountMinor } });
    }
  }
  const diff = (a: number, b: number) => ({ savedMinor: a, currentMinor: b, differenceMinor: b - a });
  return {
    snapshot,
    closing: diff(saved.closingBalanceMinor, params.current.closingBalanceMinor),
    lowestPoint: diff(saved.lowestPointMinor, params.current.lowestPointMinor),
    added: [...after.values()].filter((l) => !before.has(l.key)),
    removed: [...before.values()].filter((l) => !after.has(l.key)),
    changed,
  };
}

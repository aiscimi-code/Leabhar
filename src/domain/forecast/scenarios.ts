/**
 * Forecast scenarios: named what-if adjustments over the base forecast
 * (issue #570, epic #333).
 *
 * A scenario is a named, saved set of adjustments layered over the base
 * forecast. It never changes the base, the ledger or a budget.
 *
 * Adjustment types:
 *   'customer_payment_delay' — customers pay N days late
 *   'revenue_change' — revenue up/down by a percentage
 *   'cost_change' — costs up/down by a percentage (per account or overall)
 *   'one_off' — a single inflow or outflow
 *   'new_hire' — a new hire from a date at a salary
 *   'recurring_item' — a new recurring flow
 *
 * Provenance: each adjusted line carries 'assumption' and the scenario name.
 */

import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  forecastScenarios, scenarioAdjustments, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, asIsoDate, nowIso, type IsoDate } from '../dates';
import type { ForecastLine, ForecastOptions, ForecastResult } from './types';
import { ForecastError } from './types';
import { buildForecast } from './engine';

// ---------------------------------------------------------------------------
// CRUD for scenarios and adjustments
// ---------------------------------------------------------------------------

export interface ScenarioAdjustmentInput {
  kind: 'customer_payment_delay' | 'revenue_change' | 'cost_change' | 'one_off' | 'new_hire' | 'recurring_item';
  targetId?: string | null;
  delayDays?: number | null;
  changeBasisPoints?: number | null;
  amountMinor?: number | null;
  frequency?: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null;
  fromDate: string;
  toDate?: string | null;
  description: string;
}

export function createScenario(
  db: AppDatabase,
  params: {
    companyId: string;
    name: string;
    description?: string | null;
    adjustments: ScenarioAdjustmentInput[];
    recordedBy: string;
  },
): string {
  if (!params.name.trim()) throw new ForecastError('A scenario needs a name.');
  if (!params.recordedBy.trim()) throw new ForecastError('Say who is recording this scenario.');
  if (params.adjustments.length === 0) throw new ForecastError('A scenario needs at least one adjustment.');

  const id = ids.forecastScenario();
  db.transaction(() => {
    db.insert(forecastScenarios).values({
      id, companyId: params.companyId, name: params.name.trim(),
      description: params.description ?? null, recordedBy: params.recordedBy,
    }).run();

    for (const adj of params.adjustments) {
      if (!adj.description.trim()) throw new ForecastError('Each adjustment needs a description.');
      db.insert(scenarioAdjustments).values({
        id: ids.scenarioAdjustment(), scenarioId: id, companyId: params.companyId,
        kind: adj.kind, targetId: adj.targetId ?? null, delayDays: adj.delayDays ?? null,
        changeBasisPoints: adj.changeBasisPoints ?? null, amountMinor: adj.amountMinor ?? null,
        frequency: adj.frequency ?? null, fromDate: adj.fromDate, toDate: adj.toDate ?? null,
        description: adj.description.trim(),
      }).run();
    }

    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'forecast_scenario', entityId: id, action: 'created',
      newValue: JSON.stringify({ name: params.name, adjustments: params.adjustments.length }),
      source: 'user', actor: params.recordedBy,
    }).run();
  });
  return id;
}

export function addScenarioAdjustment(
  db: AppDatabase,
  params: { companyId: string; scenarioId: string; adjustment: ScenarioAdjustmentInput; recordedBy: string },
): string {
  const scenario = db.select().from(forecastScenarios)
    .where(and(eq(forecastScenarios.id, params.scenarioId), eq(forecastScenarios.companyId, params.companyId))).get();
  if (!scenario) throw new ForecastError(`Scenario ${params.scenarioId} not found.`);

  const adjId = ids.scenarioAdjustment();
  const adj = params.adjustment;
  db.insert(scenarioAdjustments).values({
    id: adjId, scenarioId: params.scenarioId, companyId: params.companyId,
    kind: adj.kind, targetId: adj.targetId ?? null, delayDays: adj.delayDays ?? null,
    changeBasisPoints: adj.changeBasisPoints ?? null, amountMinor: adj.amountMinor ?? null,
    frequency: adj.frequency ?? null, fromDate: adj.fromDate, toDate: adj.toDate ?? null,
    description: adj.description.trim(),
  }).run();
  return adjId;
}

// ---------------------------------------------------------------------------
// Apply a scenario to a base forecast
// ---------------------------------------------------------------------------

/**
 * Build a scenario forecast by layering the scenario's adjustments over the
 * base forecast. Returns a new ForecastResult with adjusted lines.
 * Removing all adjustments gives exactly the base forecast.
 */
export function buildScenarioForecast(
  db: AppDatabase,
  options: ForecastOptions & { scenarioId: string },
): ForecastResult {
  const scenario = db.select().from(forecastScenarios)
    .where(and(eq(forecastScenarios.id, options.scenarioId), eq(forecastScenarios.companyId, options.companyId))).get();
  if (!scenario) throw new ForecastError(`Scenario ${options.scenarioId} not found.`);

  // Build the base forecast
  const base = buildForecast(db, { ...options, scenarioId: null });

  const adjustments = db.select().from(scenarioAdjustments)
    .where(eq(scenarioAdjustments.scenarioId, options.scenarioId)).all();

  if (adjustments.length === 0) return base;

  // Deep-clone buckets for mutation
  const cloned = JSON.parse(JSON.stringify(base)) as ForecastResult;

  const extraLines: ForecastLine[] = [];

  for (const adj of adjustments) {
    const fromDate = asIsoDate(adj.fromDate);
    const toDate = adj.toDate ? asIsoDate(adj.toDate) : options.horizonEnd;

    switch (adj.kind) {
      case 'customer_payment_delay': {
        // Shift all sales-invoice inflow lines by delayDays within range
        if (!adj.delayDays) break;
        for (const bucket of cloned.buckets) {
          for (const line of bucket.inflows) {
            if (line.entityRef?.kind !== 'invoice') continue;
            if (!adj.targetId || line.description.includes(adj.targetId)) {
              if (line.date >= fromDate && line.date <= toDate) {
                const newDate = addDays(line.date, adj.delayDays);
                line.date = newDate > options.horizonEnd ? options.horizonEnd : newDate;
                line.description += ` [${scenario.name}: +${adj.delayDays}d delay]`;
                line.source = 'assumption';
                line.scenarioName = scenario.name;
              }
            }
          }
        }
        break;
      }
      case 'revenue_change': {
        if (!adj.changeBasisPoints) break;
        for (const bucket of cloned.buckets) {
          for (const line of bucket.inflows) {
            if (line.date >= fromDate && line.date <= toDate) {
              const delta = Math.round(line.amountMinor * adj.changeBasisPoints / 10_000);
              extraLines.push({
                key: `scenario:${adj.id}:${line.key}`,
                date: line.date,
                amountMinor: delta,
                description: `${scenario.name}: revenue ${adj.changeBasisPoints > 0 ? '+' : ''}${adj.changeBasisPoints / 100}% — ${line.description}`,
                source: 'assumption',
                isEstimate: true,
                estimateBasis: adj.description,
                scenarioName: scenario.name,
              });
            }
          }
        }
        break;
      }
      case 'cost_change': {
        if (!adj.changeBasisPoints) break;
        for (const bucket of cloned.buckets) {
          for (const line of bucket.outflows) {
            if (line.date >= fromDate && line.date <= toDate) {
              if (adj.targetId && line.entityRef?.id !== adj.targetId) continue;
              const delta = Math.round(line.amountMinor * adj.changeBasisPoints / 10_000);
              extraLines.push({
                key: `scenario:${adj.id}:${line.key}`,
                date: line.date,
                amountMinor: delta,
                description: `${scenario.name}: cost ${adj.changeBasisPoints > 0 ? '+' : ''}${adj.changeBasisPoints / 100}% — ${line.description}`,
                source: 'assumption',
                isEstimate: true,
                estimateBasis: adj.description,
                scenarioName: scenario.name,
              });
            }
          }
        }
        break;
      }
      case 'one_off': {
        if (!adj.amountMinor) break;
        if (fromDate > options.horizonEnd) break;
        extraLines.push({
          key: `scenario:${adj.id}:one_off`,
          date: fromDate,
          amountMinor: adj.amountMinor,
          description: `${scenario.name}: ${adj.description}`,
          source: 'assumption',
          isEstimate: false,
          scenarioName: scenario.name,
        });
        break;
      }
      case 'new_hire': {
        if (!adj.amountMinor || !adj.fromDate) break;
        // Recurring monthly net wage outflow from fromDate
        let payDate = fromDate;
        while (payDate <= options.horizonEnd) {
          if (!adj.toDate || payDate <= asIsoDate(adj.toDate)) {
            extraLines.push({
              key: `scenario:${adj.id}:hire:${payDate}`,
              date: payDate,
              amountMinor: -adj.amountMinor,
              description: `${scenario.name}: new hire — ${adj.description}`,
              source: 'assumption',
              isEstimate: true,
              estimateBasis: 'Projected net wages at stated salary. Adjust for actual deductions.',
              scenarioName: scenario.name,
            });
          }
          payDate = addDays(payDate, 30); // Approximate monthly
        }
        break;
      }
      case 'recurring_item': {
        if (!adj.amountMinor || !adj.frequency) break;
        let itemDate = fromDate;
        const stepDays: Record<string, number> = { weekly: 7, monthly: 30, quarterly: 91, yearly: 365 };
        const step = stepDays[adj.frequency] ?? 30;
        while (itemDate <= options.horizonEnd) {
          if (!adj.toDate || itemDate <= asIsoDate(adj.toDate)) {
            extraLines.push({
              key: `scenario:${adj.id}:rec:${itemDate}`,
              date: itemDate,
              amountMinor: adj.amountMinor,
              description: `${scenario.name}: ${adj.description}`,
              source: 'assumption',
              isEstimate: false,
              scenarioName: scenario.name,
            });
          }
          itemDate = addDays(itemDate, step);
        }
        break;
      }
    }
  }

  // Inject extra lines into appropriate buckets
  for (const line of extraLines) {
    const bucket = cloned.buckets.find((b) => line.date >= b.periodStart && line.date <= b.periodEnd);
    if (bucket) {
      if (line.amountMinor >= 0) bucket.inflows.push(line);
      else bucket.outflows.push(line);
      bucket.netMinor += line.amountMinor;
    }
  }

  // Recompute running balance and lowest point
  let runningBalance = cloned.openingCash.totalMinor;
  let lowestPoint = runningBalance;
  let lowestDate = options.asOf;
  for (const bucket of cloned.buckets) {
    runningBalance += bucket.netMinor;
    bucket.closingBalanceMinor = runningBalance;
    if (runningBalance < lowestPoint) {
      lowestPoint = runningBalance;
      lowestDate = bucket.periodEnd;
    }
  }

  cloned.lowestPointMinor = lowestPoint;
  cloned.lowestPointDate = lowestDate;
  cloned.belowMinimum = lowestPoint < (options.minimumCashMinor ?? 0);

  return cloned;
}

// ---------------------------------------------------------------------------
// Compare scenarios
// ---------------------------------------------------------------------------

export interface ScenarioComparison {
  base: ForecastResult;
  scenarios: Array<{ scenarioId: string; name: string; forecast: ForecastResult }>;
}

export function compareScenarios(
  db: AppDatabase,
  options: ForecastOptions,
  scenarioIds: string[],
): ScenarioComparison {
  const base = buildForecast(db, options);
  const scenarios = scenarioIds.map((scenarioId) => {
    const scenario = db.select().from(forecastScenarios)
      .where(and(eq(forecastScenarios.id, scenarioId), eq(forecastScenarios.companyId, options.companyId))).get();
    if (!scenario) throw new ForecastError(`Scenario ${scenarioId} not found.`);
    const forecast = buildScenarioForecast(db, { ...options, scenarioId });
    return { scenarioId, name: scenario.name, forecast };
  });
  return { base, scenarios };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function listScenarios(
  db: AppDatabase, params: { companyId: string },
): Array<{ id: string; name: string; description: string | null; adjustmentCount: number }> {
  const rows = db.select().from(forecastScenarios)
    .where(eq(forecastScenarios.companyId, params.companyId))
    .all();
  return rows.map((s) => {
    const count = db.select().from(scenarioAdjustments)
      .where(eq(scenarioAdjustments.scenarioId, s.id)).all().length;
    return { id: s.id, name: s.name, description: s.description, adjustmentCount: count };
  });
}

/**
 * Forecast scenarios (issue #570, epic #333).
 *
 * A scenario is a named set of assumptions over the base forecast: customers
 * paying later, revenue or costs changing by a percentage, a one-off payment,
 * a new hire, or a new recurring flow. The base forecast is never changed;
 * a scenario's forecast is the base lines with the adjustments applied, and
 * every line an adjustment adds or changes names the scenario.
 *
 * Scenario amounts are assumptions a person entered, in base minor units.
 */

import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { customers, forecastScenarios, scenarioAdjustments, suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import { multiplyRational } from '../money';
import { atomically } from '../accounting/journal';
import { addDays, isIsoDate, type IsoDate } from '../dates';
import { buildForecast, occurrences, type Frequency } from './engine';
import { ForecastError, type ForecastLine, type ForecastOptions } from './types';

export type ScenarioAdjustmentKind = (typeof scenarioAdjustments.$inferSelect)['kind'];
export type Scenario = typeof forecastScenarios.$inferSelect;
export type ScenarioAdjustment = typeof scenarioAdjustments.$inferSelect;

export interface ScenarioAdjustmentInput {
  kind: ScenarioAdjustmentKind;
  description: string;
  fromDate: string;
  toDate?: string | null;
  /** A customer (payment delay, revenue change) or supplier (cost change). */
  targetId?: string | null;
  delayDays?: number | null;
  changeBasisPoints?: number | null;
  amountMinor?: number | null;
  frequency?: Frequency | null;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

function validateAdjustment(db: AppDatabase, companyId: string, a: ScenarioAdjustmentInput): void {
  if (!a.description?.trim()) throw new ForecastError('Describe the adjustment.');
  if (!isIsoDate(a.fromDate)) throw new ForecastError('The adjustment\'s start is a YYYY-MM-DD date.');
  if (a.toDate != null && (!isIsoDate(a.toDate) || a.toDate < a.fromDate)) {
    throw new ForecastError('The adjustment\'s end is a YYYY-MM-DD date on or after its start.');
  }
  if (a.targetId) {
    const table = a.kind === 'cost_change' ? suppliers : customers;
    if (a.kind !== 'cost_change' && a.kind !== 'revenue_change' && a.kind !== 'customer_payment_delay') {
      throw new ForecastError('Only a payment delay, a revenue change or a cost change is limited to one party.');
    }
    const found = db.select({ id: table.id }).from(table).where(and(eq(table.id, a.targetId), eq(table.companyId, companyId))).get();
    if (!found) throw new ForecastError(`${a.kind === 'cost_change' ? 'Supplier' : 'Customer'} ${a.targetId} is not this company's.`);
  }
  switch (a.kind) {
    case 'customer_payment_delay':
      if (!isInt(a.delayDays) || a.delayDays === 0) throw new ForecastError('A payment delay is a whole number of days, not zero.');
      break;
    case 'revenue_change':
    case 'cost_change':
      if (!isInt(a.changeBasisPoints) || a.changeBasisPoints === 0 || a.changeBasisPoints < -10_000) {
        throw new ForecastError('A change is a whole number of basis points, not zero and not below -100%.');
      }
      break;
    case 'one_off':
      if (!isInt(a.amountMinor) || a.amountMinor === 0) throw new ForecastError('A one-off is a whole number of cents, not zero: negative is money out.');
      break;
    case 'new_hire':
      if (!isInt(a.amountMinor) || a.amountMinor <= 0) throw new ForecastError('A new hire\'s monthly cost is a positive whole number of cents.');
      break;
    case 'recurring_item':
      if (!isInt(a.amountMinor) || a.amountMinor === 0) throw new ForecastError('A recurring amount is a whole number of cents, not zero: negative is money out.');
      if (!a.frequency) throw new ForecastError('Say how often the recurring amount falls.');
      break;
  }
}

export function createScenario(db: AppDatabase, params: {
  companyId: string; name: string; description?: string | null; recordedBy: string; adjustments?: ScenarioAdjustmentInput[];
}): Scenario {
  if (!params.name.trim()) throw new ForecastError('Name the scenario.');
  if (!params.recordedBy.trim()) throw new ForecastError('Say who is recording the scenario.');
  for (const a of params.adjustments ?? []) validateAdjustment(db, params.companyId, a);
  const id = ids.forecastScenario();
  atomically(db, () => {
    db.insert(forecastScenarios).values({
      id, companyId: params.companyId, name: params.name.trim(), description: params.description ?? null, recordedBy: params.recordedBy,
    }).run();
    for (const a of params.adjustments ?? []) insertAdjustment(db, params.companyId, id, a);
  });
  return db.select().from(forecastScenarios).where(eq(forecastScenarios.id, id)).get()!;
}

function insertAdjustment(db: AppDatabase, companyId: string, scenarioId: string, a: ScenarioAdjustmentInput): ScenarioAdjustment {
  const id = ids.scenarioAdjustment();
  db.insert(scenarioAdjustments).values({
    id, scenarioId, companyId, kind: a.kind, description: a.description.trim(), fromDate: a.fromDate, toDate: a.toDate ?? null,
    targetId: a.targetId ?? null, delayDays: a.delayDays ?? null, changeBasisPoints: a.changeBasisPoints ?? null,
    amountMinor: a.amountMinor ?? null, frequency: a.frequency ?? null,
  }).run();
  return db.select().from(scenarioAdjustments).where(eq(scenarioAdjustments.id, id)).get()!;
}

function scenarioOf(db: AppDatabase, companyId: string, scenarioId: string): Scenario {
  const s = db.select().from(forecastScenarios)
    .where(and(eq(forecastScenarios.id, scenarioId), eq(forecastScenarios.companyId, companyId))).get();
  if (!s) throw new ForecastError(`Scenario ${scenarioId} not found.`);
  return s;
}

export function addScenarioAdjustment(db: AppDatabase, params: { companyId: string; scenarioId: string; adjustment: ScenarioAdjustmentInput }): ScenarioAdjustment {
  scenarioOf(db, params.companyId, params.scenarioId);
  validateAdjustment(db, params.companyId, params.adjustment);
  return insertAdjustment(db, params.companyId, params.scenarioId, params.adjustment);
}

/** Scenarios are a person's assumptions, not records: an adjustment can be taken out. */
export function removeScenarioAdjustment(db: AppDatabase, params: { companyId: string; adjustmentId: string }): void {
  const a = db.select().from(scenarioAdjustments)
    .where(and(eq(scenarioAdjustments.id, params.adjustmentId), eq(scenarioAdjustments.companyId, params.companyId))).get();
  if (!a) throw new ForecastError(`Adjustment ${params.adjustmentId} not found.`);
  db.delete(scenarioAdjustments).where(eq(scenarioAdjustments.id, a.id)).run();
}

export function scenarioAdjustmentsOf(db: AppDatabase, scenarioId: string): ScenarioAdjustment[] {
  return db.select().from(scenarioAdjustments).where(eq(scenarioAdjustments.scenarioId, scenarioId))
    .orderBy(asc(scenarioAdjustments.fromDate), asc(scenarioAdjustments.id)).all();
}

export function listScenarios(db: AppDatabase, companyId: string): Array<Scenario & { adjustments: ScenarioAdjustment[] }> {
  return db.select().from(forecastScenarios).where(eq(forecastScenarios.companyId, companyId))
    .orderBy(asc(forecastScenarios.name)).all()
    .map((s) => ({ ...s, adjustments: scenarioAdjustmentsOf(db, s.id) }));
}

const inWindow = (a: ScenarioAdjustment, date: IsoDate | null) =>
  date !== null && date >= a.fromDate && (a.toDate === null || date <= a.toDate);

const pct = (bp: number) => `${bp > 0 ? '+' : ''}${bp / 100}%`;

/** The base lines with a scenario's adjustments applied. The base lines are not changed. */
export function applyScenario(db: AppDatabase, params: {
  o: ForecastOptions; scenario: Scenario; lines: ForecastLine[]; findings: string[];
}): ForecastLine[] {
  const { o, scenario } = params;
  const adjustments = scenarioAdjustmentsOf(db, scenario.id);
  const tag = (l: ForecastLine, note: string): ForecastLine => ({
    ...l, isEstimate: true, scenarioName: scenario.name,
    estimateBasis: [l.estimateBasis, `Scenario "${scenario.name}": ${note}`].filter(Boolean).join(' '),
  });
  let lines = params.lines.map((l) => ({ ...l }));

  // Percentage changes first, on the dates the base forecast gives.
  for (const a of adjustments.filter((x) => x.kind === 'revenue_change' || x.kind === 'cost_change')) {
    const category = a.kind === 'revenue_change' ? 'receipt' : 'payment';
    lines = lines.map((l) => {
      if (l.category !== category || !inWindow(a, l.date) || (a.targetId && l.partyId !== a.targetId)) return l;
      const amountMinor = multiplyRational(l.amountMinor, 10_000 + a.changeBasisPoints!, 10_000);
      return tag({ ...l, amountMinor }, `${a.description} (${pct(a.changeBasisPoints!)}).`);
    });
  }
  // Then delays: a receipt due in the window moves later (or earlier).
  let pushedOut = 0;
  for (const a of adjustments.filter((x) => x.kind === 'customer_payment_delay')) {
    lines = lines.flatMap((l) => {
      if (l.category !== 'receipt' || !inWindow(a, l.date) || (a.targetId && l.partyId !== a.targetId)) return [l];
      let date = addDays(l.date!, a.delayDays!);
      if (date < o.asOf) date = o.asOf;
      if (date > o.horizonEnd) { pushedOut += 1; return []; }
      return [tag({ ...l, date }, `${a.description} (${a.delayDays} day(s)).`)];
    });
  }
  if (pushedOut) params.findings.push(`Scenario "${scenario.name}" moves ${pushedOut} receipt(s) past the end of the forecast.`);

  // Then new lines.
  const added: ForecastLine[] = [];
  const upTo = (a: ScenarioAdjustment) => (a.toDate && a.toDate < o.horizonEnd ? a.toDate : o.horizonEnd) as IsoDate;
  const newLine = (a: ScenarioAdjustment, date: IsoDate, amountMinor: number, basis: string): ForecastLine => ({
    key: `scenario:${a.id}:${date}`, date, amountMinor, description: a.description, category: 'scenario', source: 'assumption',
    isEstimate: true, estimateBasis: `Scenario "${scenario.name}": ${basis}`, scenarioName: scenario.name,
    entityRef: { kind: 'scenario_adjustment', id: a.id },
  });
  for (const a of adjustments) {
    if (a.kind === 'one_off') {
      if (a.fromDate >= o.asOf && a.fromDate <= o.horizonEnd) added.push(newLine(a, a.fromDate as IsoDate, a.amountMinor!, 'a one-off amount.'));
    } else if (a.kind === 'new_hire') {
      for (const date of occurrences('monthly', a.fromDate as IsoDate, upTo(a), addDays(o.asOf, -1), o.horizonEnd)) {
        added.push(newLine(a, date, -a.amountMinor!, 'the monthly cost of a new hire, as entered.'));
      }
    } else if (a.kind === 'recurring_item') {
      for (const date of occurrences(a.frequency!, a.fromDate as IsoDate, upTo(a), addDays(o.asOf, -1), o.horizonEnd)) {
        added.push(newLine(a, date, a.amountMinor!, `a ${a.frequency} amount.`));
      }
    }
  }
  if (adjustments.length === 0) params.findings.push(`Scenario "${scenario.name}" has no adjustments: it equals the base forecast.`);
  return [...lines, ...added];
}

export interface ScenarioComparison {
  asOf: IsoDate;
  horizonEnd: IsoDate;
  rows: Array<{
    scenarioId: string | null;
    name: string;
    closingBalanceMinor: number;
    lowestPointMinor: number;
    lowestPointDate: IsoDate;
    belowMinimum: boolean;
    /** Against the base forecast. */
    closingDifferenceMinor: number;
  }>;
}

/** The base forecast beside each scenario's, on the same options. */
export function compareScenarios(db: AppDatabase, params: { options: ForecastOptions; scenarioIds: string[] }): ScenarioComparison {
  const base = buildForecast(db, { ...params.options, scenarioId: null });
  const row = (scenarioId: string | null) => {
    const f = scenarioId ? buildForecast(db, { ...params.options, scenarioId }) : base;
    return {
      scenarioId, name: f.scenarioName ?? 'Base forecast', closingBalanceMinor: f.closingBalanceMinor,
      lowestPointMinor: f.lowestPointMinor, lowestPointDate: f.lowestPointDate, belowMinimum: f.belowMinimum,
      closingDifferenceMinor: f.closingBalanceMinor - base.closingBalanceMinor,
    };
  };
  return { asOf: params.options.asOf, horizonEnd: params.options.horizonEnd, rows: [row(null), ...params.scenarioIds.map(row)] };
}

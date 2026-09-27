import { and, desc, eq, lte, isNull, or, gt } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { expenseRates, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, nowIso, type IsoDate } from '../dates';
import { multiplyRational, asMinor } from '../money';
import { AccountingError } from '../accounting/errors';

/**
 * Civil service mileage and subsistence rates (issue #306).
 *
 * Revenue accepts these allowances as the tax-free ceiling for reimbursing an
 * employee's or director's travel and subsistence (TDM Part 05-01-06), so they
 * are the rates a small business reimburses at in practice.
 *
 * They are seeded, not hard-coded: every row is effective-dated configuration
 * with its source, so a later revision supersedes rather than overwrites, and
 * a historical claim resolves the rate in force on its own date (invariant #6).
 * The user is expected to review them (README §48) — an allowance is a
 * starting point, and an employer may reimburse less.
 *
 * A mileage rate is fractional cents per kilometre (41.80c/km), which has no
 * exact representation in minor units, so it is stored as the amount per 100 km
 * (`amountMinor` per `perUnits` = 100) and multiplied out with rational
 * arithmetic. Subsistence allowances are whole amounts per absence or night.
 */

export class ExpenseRateError extends AccountingError {}

export interface ExpenseRateSeed {
  category: 'mileage' | 'subsistence_day' | 'subsistence_overnight';
  code: string;
  name: string;
  unit: 'km' | 'absence' | 'night';
  amountMinor: number;
  perUnits: number;
  effectiveFrom: IsoDate;
  sourceNote: string;
  sourceUrl: string;
}

/**
 * Source: revenue.ie, "Civil service rates" (Travel and subsistence),
 * published 09 June 2026, checked 2026-09-27.
 * - Motor travel rates: Circular 16/2022, in force since 1 September 2022.
 * - Domestic subsistence rates: Circular 04/2025, in force since 29 January 2025.
 * - Motorcycle rates: in force since 5 March 2009; bicycle since 1 February 2007.
 */
const REVENUE_SOURCE = {
  sourceNote: 'Civil service rates, Revenue (Circular 16/2022 mileage; Circular 04/2025 subsistence)',
  sourceUrl: 'https://www.revenue.ie/en/employing-people/employee-expenses/travel-and-subsistence/civil-service-rates.aspx',
} as const;

const MILEAGE_FROM = asIsoDate('2022-09-01');
const SUBSISTENCE_FROM = asIsoDate('2025-01-29');

/** Car rates per 100 km by engine capacity and annual distance band. */
const CAR_MILEAGE: Array<{ code: string; engine: string; band: string; minorPer100km: number }> = [
  { code: 'car_upto_1200cc_band1', engine: 'up to 1200cc', band: 'first 1,500 km', minorPer100km: 4180 },
  { code: 'car_upto_1200cc_band2', engine: 'up to 1200cc', band: '1,501 to 5,500 km', minorPer100km: 7264 },
  { code: 'car_upto_1200cc_band3', engine: 'up to 1200cc', band: '5,501 to 25,000 km', minorPer100km: 3178 },
  { code: 'car_upto_1200cc_band4', engine: 'up to 1200cc', band: 'over 25,000 km', minorPer100km: 2056 },
  { code: 'car_1201_1500cc_band1', engine: '1201cc to 1500cc', band: 'first 1,500 km', minorPer100km: 4340 },
  { code: 'car_1201_1500cc_band2', engine: '1201cc to 1500cc', band: '1,501 to 5,500 km', minorPer100km: 7918 },
  { code: 'car_1201_1500cc_band3', engine: '1201cc to 1500cc', band: '5,501 to 25,000 km', minorPer100km: 3179 },
  { code: 'car_1201_1500cc_band4', engine: '1201cc to 1500cc', band: 'over 25,000 km', minorPer100km: 2385 },
  { code: 'car_over_1500cc_band1', engine: 'over 1500cc', band: 'first 1,500 km', minorPer100km: 5182 },
  { code: 'car_over_1500cc_band2', engine: 'over 1500cc', band: '1,501 to 5,500 km', minorPer100km: 9063 },
  { code: 'car_over_1500cc_band3', engine: 'over 1500cc', band: '5,501 to 25,000 km', minorPer100km: 3922 },
  { code: 'car_over_1500cc_band4', engine: 'over 1500cc', band: 'over 25,000 km', minorPer100km: 2587 },
];

/** Reduced car rates, for travel associated with the job but not solely for performing it. */
const CAR_MILEAGE_REDUCED: Array<{ code: string; engine: string; minorPer100km: number }> = [
  { code: 'car_upto_1200cc_reduced', engine: 'up to 1200cc', minorPer100km: 2123 },
  { code: 'car_1201_1500cc_reduced', engine: '1201cc to 1500cc', minorPer100km: 2380 },
  { code: 'car_over_1500cc_reduced', engine: 'over 1500cc', minorPer100km: 2596 },
];

/** Motorcycle rates per 100 km by engine capacity and annual distance band. */
const MOTORCYCLE_MILEAGE: Array<{ code: string; engine: string; over6437: boolean; minorPer100km: number }> = [
  { code: 'motorcycle_upto_150cc_band1', engine: 'up to 150cc', over6437: false, minorPer100km: 1448 },
  { code: 'motorcycle_upto_150cc_band2', engine: 'up to 150cc', over6437: true, minorPer100km: 937 },
  { code: 'motorcycle_151_250cc_band1', engine: '151cc to 250cc', over6437: false, minorPer100km: 2010 },
  { code: 'motorcycle_151_250cc_band2', engine: '151cc to 250cc', over6437: true, minorPer100km: 1331 },
  { code: 'motorcycle_251_600cc_band1', engine: '251cc to 600cc', over6437: false, minorPer100km: 2372 },
  { code: 'motorcycle_251_600cc_band2', engine: '251cc to 600cc', over6437: true, minorPer100km: 1529 },
  { code: 'motorcycle_over_600cc_band1', engine: 'over 600cc', over6437: false, minorPer100km: 2859 },
  { code: 'motorcycle_over_600cc_band2', engine: 'over 600cc', over6437: true, minorPer100km: 1760 },
];

/** Domestic day subsistence, per absence (Circular 04/2025). */
const DAY_SUBSISTENCE: Array<{ code: string; name: string; amountMinor: number }> = [
  { code: 'day_5_to_10_hours', name: 'Day subsistence, absence of five to ten hours', amountMinor: 1925 },
  { code: 'day_10_hours_or_more', name: 'Day subsistence, absence of ten hours or more', amountMinor: 4617 },
];

/** Domestic overnight subsistence, per night (Circular 04/2025). */
const OVERNIGHT_SUBSISTENCE: Array<{ code: string; name: string; amountMinor: number }> = [
  { code: 'overnight_normal', name: 'Overnight allowance, normal rate (first 14 nights)', amountMinor: 20553 },
  { code: 'overnight_reduced', name: 'Overnight allowance, reduced rate (next 14 nights)', amountMinor: 18498 },
  { code: 'overnight_detention', name: 'Overnight allowance, detention rate (next 28 nights)', amountMinor: 10276 },
];

export const DEFAULT_EXPENSE_RATES: ExpenseRateSeed[] = [
  ...CAR_MILEAGE.map((r) => ({
    category: 'mileage' as const,
    code: r.code,
    name: `Car ${r.engine}, ${r.band}`,
    unit: 'km' as const,
    amountMinor: r.minorPer100km,
    perUnits: 100,
    effectiveFrom: MILEAGE_FROM,
    ...REVENUE_SOURCE,
  })),
  ...CAR_MILEAGE_REDUCED.map((r) => ({
    category: 'mileage' as const,
    code: r.code,
    name: `Car ${r.engine}, reduced rate (travel associated with the job, not solely for performing it)`,
    unit: 'km' as const,
    amountMinor: r.minorPer100km,
    perUnits: 100,
    effectiveFrom: MILEAGE_FROM,
    ...REVENUE_SOURCE,
  })),
  ...MOTORCYCLE_MILEAGE.map((r) => ({
    category: 'mileage' as const,
    code: r.code,
    name: `Motorcycle ${r.engine}, ${r.over6437 ? 'over' : 'up to'} 6,437 km`,
    unit: 'km' as const,
    amountMinor: r.minorPer100km,
    perUnits: 100,
    effectiveFrom: asIsoDate('2009-03-05'),
    ...REVENUE_SOURCE,
  })),
  {
    category: 'mileage',
    code: 'bicycle',
    name: 'Bicycle, per kilometre',
    unit: 'km',
    amountMinor: 800,
    perUnits: 100,
    effectiveFrom: asIsoDate('2007-02-01'),
    ...REVENUE_SOURCE,
  },
  ...DAY_SUBSISTENCE.map((r) => ({
    category: 'subsistence_day' as const,
    code: r.code,
    name: r.name,
    unit: 'absence' as const,
    amountMinor: r.amountMinor,
    perUnits: 1,
    effectiveFrom: SUBSISTENCE_FROM,
    ...REVENUE_SOURCE,
  })),
  ...OVERNIGHT_SUBSISTENCE.map((r) => ({
    category: 'subsistence_overnight' as const,
    code: r.code,
    name: r.name,
    unit: 'night' as const,
    amountMinor: r.amountMinor,
    perUnits: 1,
    effectiveFrom: SUBSISTENCE_FROM,
    ...REVENUE_SOURCE,
  })),
];

/**
 * The rate in force for a code on a date: the row whose effective window covers
 * the date, preferring the latest one to have started. Superseded rows (an
 * earlier `effectiveFrom` closed by a later row's arrival) still resolve for
 * the dates they applied to.
 */
export function resolveExpenseRate(
  db: AppDatabase, input: { companyId: string; rateId: string; onDate: IsoDate },
): typeof expenseRates.$inferSelect {
  const rate = db.select().from(expenseRates)
    .where(and(
      eq(expenseRates.companyId, input.companyId),
      eq(expenseRates.id, input.rateId),
    )).get();
  if (!rate) throw new ExpenseRateError(`Expense rate ${input.rateId} not found.`);

  const date = input.onDate;
  if (date < rate.effectiveFrom || (rate.effectiveTo !== null && date > rate.effectiveTo)) {
    throw new ExpenseRateError(
      `The rate "${rate.name}" is not in force on ${date} (it applies from ${rate.effectiveFrom}`
        + `${rate.effectiveTo ? ` to ${rate.effectiveTo}` : ''}). Choose the rate that was in force, `
        + 'or add it to the expense rates configuration — a claim resolves the rate as of its own date.',
      { rateId: rate.id, onDate: date },
    );
  }
  return rate;
}

/** Every rate available for a claim line dated `onDate`, grouped for the claim screen. */
export function expenseRatesActiveOn(
  db: AppDatabase, companyId: string, onDate: IsoDate,
): Array<typeof expenseRates.$inferSelect> {
  return db.select().from(expenseRates)
    .where(and(
      eq(expenseRates.companyId, companyId),
      eq(expenseRates.active, true),
      lte(expenseRates.effectiveFrom, onDate),
      or(isNull(expenseRates.effectiveTo), gt(expenseRates.effectiveTo, onDate)),
    )).orderBy(expenseRates.category, desc(expenseRates.effectiveFrom), expenseRates.code).all();
}

/**
 * The exact amount a rate-calculated line is worth: units times the rate, with
 * the same rational rounding the VAT engine uses, so a figure can never depend
 * on the order the multiplication happened in.
 */
export function calculateRateAmount(units: number, rate: Pick<typeof expenseRates.$inferSelect, 'amountMinor' | 'perUnits'>): number {
  const whole = asMinor(units);
  if (rate.perUnits === 1) return whole * rate.amountMinor;
  return multiplyRational(whole * rate.amountMinor, 1, rate.perUnits);
}

/**
 * Install the default expense rates for a company created before they existed
 * (the `ensureDefault*` pattern). Idempotent by (code, effectiveFrom): it
 * never touches a rate the user has since edited or superseded.
 */
export function ensureDefaultExpenseRates(
  db: AppDatabase, companyId: string, actor?: string,
): { added: string[] } {
  const existing = new Set(
    db.select({ code: expenseRates.code, effectiveFrom: expenseRates.effectiveFrom })
      .from(expenseRates).where(eq(expenseRates.companyId, companyId)).all()
      .map((r) => `${r.code}@${r.effectiveFrom}`),
  );
  const missing = DEFAULT_EXPENSE_RATES.filter((seed) => !existing.has(`${seed.code}@${seed.effectiveFrom}`));
  if (missing.length === 0) return { added: [] };

  db.transaction((tx) => {
    for (const seed of missing) {
      tx.insert(expenseRates).values({
        id: ids.expenseRate(),
        companyId,
        category: seed.category,
        code: seed.code,
        name: seed.name,
        unit: seed.unit,
        amountMinor: seed.amountMinor,
        perUnits: seed.perUnits,
        effectiveFrom: seed.effectiveFrom,
        sourceNote: seed.sourceNote,
        sourceUrl: seed.sourceUrl,
      }).run();
    }
    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId,
      occurredAt: nowIso(),
      entityType: 'expense_rate',
      entityId: companyId,
      action: 'created',
      newValue: JSON.stringify({ addedCodes: missing.map((r) => r.code) }),
      source: 'system',
      actor: actor ?? 'system',
      reason: 'Added default civil service expense rates introduced since this company was created',
    }).run();
  });

  return { added: missing.map((r) => r.code) };
}

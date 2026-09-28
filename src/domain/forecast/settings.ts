/**
 * The company's forecast defaults (decisions on #333): every choice the user
 * can make for one forecast has a company default here. A change is a new
 * version, never an overwrite (AGENTS.md #6).
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, companies, forecastSettings } from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, isIsoDate, type IsoDate } from '../dates';
import { ForecastError, type DueDateBasis, type ForecastGranularity, type ForecastOptions, type ReceiptBasis } from './types';

export interface ForecastDefaults {
  receiptBasis: ReceiptBasis;
  horizonDays: number;
  granularity: ForecastGranularity;
  minimumCashMinor: number;
  cashAccountIds: string[] | null;
  includePurchaseOrders: boolean;
  includeUnconfirmed: boolean;
  includeOwnerTax: boolean;
  dueDateBasis: DueDateBasis;
  /** The version in force, or 0 for the built-in defaults. */
  version: number;
}

const BUILT_IN: ForecastDefaults = {
  receiptBasis: 'due_date', horizonDays: 90, granularity: 'weekly', minimumCashMinor: 0, cashAccountIds: null,
  includePurchaseOrders: false, includeUnconfirmed: false, includeOwnerTax: true, dueDateBasis: 'statutory', version: 0,
};

export function forecastDefaults(db: AppDatabase, companyId: string): ForecastDefaults {
  const row = db.select().from(forecastSettings).where(eq(forecastSettings.companyId, companyId))
    .orderBy(desc(forecastSettings.version)).get();
  if (!row) return { ...BUILT_IN };
  return {
    receiptBasis: row.receiptBasis, horizonDays: row.horizonDays, granularity: row.granularity,
    minimumCashMinor: row.minimumCashMinor, cashAccountIds: row.cashAccountIds ?? null,
    includePurchaseOrders: row.includePurchaseOrders, includeUnconfirmed: row.includeUnconfirmed,
    includeOwnerTax: row.includeOwnerTax, dueDateBasis: row.dueDateBasis, version: row.version,
  };
}

/** Record new company defaults as the next version. Unset fields keep their current value. */
export function setForecastDefaults(db: AppDatabase, params: {
  companyId: string; recordedBy: string; changes: Partial<Omit<ForecastDefaults, 'version'>>;
}): ForecastDefaults {
  if (!params.recordedBy.trim()) throw new ForecastError('Say who is changing the forecast defaults.');
  const company = db.select({ id: companies.id }).from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new ForecastError(`Company ${params.companyId} not found.`);
  const next = { ...forecastDefaults(db, params.companyId), ...params.changes };
  if (!Number.isInteger(next.horizonDays) || next.horizonDays < 1 || next.horizonDays > 731) {
    throw new ForecastError('The horizon is a whole number of days, from 1 to 731.');
  }
  if (!Number.isInteger(next.minimumCashMinor)) throw new ForecastError('The minimum cash is a whole number of cents.');
  if (next.cashAccountIds && next.cashAccountIds.length > 0) validateCashAccounts(db, params.companyId, next.cashAccountIds);
  const version = next.version + 1;
  db.insert(forecastSettings).values({
    id: ids.forecastSettings(), companyId: params.companyId, version,
    receiptBasis: next.receiptBasis, horizonDays: next.horizonDays, granularity: next.granularity,
    minimumCashMinor: next.minimumCashMinor, cashAccountIds: next.cashAccountIds && next.cashAccountIds.length ? next.cashAccountIds : null,
    includePurchaseOrders: next.includePurchaseOrders, includeUnconfirmed: next.includeUnconfirmed,
    includeOwnerTax: next.includeOwnerTax, dueDateBasis: next.dueDateBasis, recordedBy: params.recordedBy,
  }).run();
  return { ...next, version };
}

export function validateCashAccounts(db: AppDatabase, companyId: string, accountIds: string[]): void {
  const found = db.select({ id: accounts.id, type: accounts.type }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), inArray(accounts.id, accountIds))).all();
  const missing = accountIds.filter((id) => !found.some((a) => a.id === id));
  if (missing.length) throw new ForecastError(`These accounts are not this company's: ${missing.join(', ')}.`);
  const notAssets = found.filter((a) => a.type !== 'asset');
  if (notAssets.length) throw new ForecastError('Only asset accounts can count as cash.');
}

/** A forecast's options: the company defaults, with whatever the user chose for this forecast. */
export function forecastOptions(db: AppDatabase, params: {
  companyId: string; asOf: IsoDate; overrides?: Partial<Omit<ForecastOptions, 'companyId' | 'asOf'>> & { horizonDays?: number };
}): ForecastOptions {
  if (!isIsoDate(params.asOf)) throw new ForecastError('The forecast date is a YYYY-MM-DD date.');
  const d = forecastDefaults(db, params.companyId);
  const o = params.overrides ?? {};
  const horizonEnd = o.horizonEnd ?? addDays(params.asOf, (o.horizonDays ?? d.horizonDays) - 1);
  if (!isIsoDate(horizonEnd) || horizonEnd < params.asOf) throw new ForecastError('The horizon ends before the forecast date.');
  return {
    companyId: params.companyId, asOf: params.asOf, horizonEnd,
    granularity: o.granularity ?? d.granularity,
    receiptBasis: o.receiptBasis ?? d.receiptBasis,
    customerDelayDays: o.customerDelayDays,
    includePurchaseOrders: o.includePurchaseOrders ?? d.includePurchaseOrders,
    includeUnconfirmed: o.includeUnconfirmed ?? d.includeUnconfirmed,
    includeOwnerTax: o.includeOwnerTax ?? d.includeOwnerTax,
    cashAccountIds: o.cashAccountIds ?? d.cashAccountIds,
    minimumCashMinor: o.minimumCashMinor ?? d.minimumCashMinor,
    dueDateBasis: o.dueDateBasis ?? d.dueDateBasis,
    scenarioId: o.scenarioId ?? null,
  };
}

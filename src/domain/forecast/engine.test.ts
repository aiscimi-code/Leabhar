import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { buildForecast, saveForecastSnapshot } from './engine';
import { makeDate, asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';
import type { ForecastOptions } from './types';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Test Company Limited',
    financialYearEndDay: 31,
    financialYearEndMonth: 12,
    seedYears: [2024, 2025],
  });
  companyId = created.companyId;
});

const baseOptions = (companyId: string): ForecastOptions => ({
  companyId,
  asOf: asIsoDate(makeDate(2025, 3, 15)),
  horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
  granularity: 'daily' as const,
  receiptBasis: 'due_date' as const,
  includePurchaseOrders: false,
  includeUnconfirmed: false,
  cashAccountIds: [],
  minimumCashMinor: 10_000_000,
  dueDateBasis: 'statutory' as const,
});

describe('buildForecast', () => {
  it('builds a forecast for a given company and horizon', () => {
    const options = baseOptions(companyId);
    const forecast = buildForecast(db, options);

    expect(forecast.companyId).toBe(companyId);
    expect(forecast.asOf).toBe(options.asOf);
    expect(forecast.horizonEnd).toBe(options.horizonEnd);
    expect(forecast.granularity).toBe('daily');
  });

  it('returns opening cash balance from bank accounts', () => {
    const options = baseOptions(companyId);
    const forecast = buildForecast(db, options);

    expect(forecast.openingCash).toBeDefined();
    expect(forecast.openingCash.accounts).toBeDefined();
  });

  it('has a lowest point date within the horizon', () => {
    const options = baseOptions(companyId);
    const forecast = buildForecast(db, options);

    expect(forecast.lowestPointDate).toBeDefined();
    expect(forecast.lowestPointDate >= options.asOf).toBe(true);
    expect(forecast.lowestPointDate <= options.horizonEnd).toBe(true);
  });
});

describe('saveForecastSnapshot', () => {
  it('saves a forecast snapshot to the database', () => {
    const options = baseOptions(companyId);
    const forecast = buildForecast(db, options);
    const snapshotId = saveForecastSnapshot(db, {
      companyId,
      name: 'Test Snapshot',
      forecast,
      savedBy: 'test-user',
    });

    expect(snapshotId).toBeDefined();
    expect(snapshotId.length).toBeGreaterThan(0);
  });
});

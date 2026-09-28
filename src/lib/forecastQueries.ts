import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, customers } from '@/db/schema';
import { asIsoDate, isIsoDate } from '@/domain/dates';
import {
  budgetLines, budgetMonths, budgetVsActual, buildForecast, compareWithSnapshot, forecastDefaults, forecastOptions, listBudgets,
  listForecastSnapshots, listRecurringItems, listRecurringPatterns, listScenarios, type ForecastOptions,
} from '@/domain/forecast';
import { requireCompany } from './queries';

/** The options a person chose on the page, as search parameters. Anything left out takes the company default. */
export interface ForecastParams {
  asOf?: string; days?: string; granularity?: string; receipts?: string; dueDates?: string; scenario?: string;
  orders?: string; drafts?: string; ownerTax?: string; compare?: string;
}

/** Read model for the forecast screen (EPIC 29). Every figure is the domain's. */
export function forecastPage(params: ForecastParams, today: string) {
  const db = getDb();
  const company = requireCompany();
  const asOf = asIsoDate(params.asOf && isIsoDate(params.asOf) ? params.asOf : today);
  const overrides: NonNullable<Parameters<typeof forecastOptions>[1]['overrides']> = {};
  if (params.days && /^\d+$/.test(params.days)) overrides.horizonDays = Number(params.days);
  if (params.granularity) overrides.granularity = params.granularity as ForecastOptions['granularity'];
  if (params.receipts) overrides.receiptBasis = params.receipts as ForecastOptions['receiptBasis'];
  if (params.dueDates) overrides.dueDateBasis = params.dueDates as ForecastOptions['dueDateBasis'];
  if (params.scenario) overrides.scenarioId = params.scenario;
  if (params.orders) overrides.includePurchaseOrders = params.orders === 'yes';
  if (params.drafts) overrides.includeUnconfirmed = params.drafts === 'yes';
  if (params.ownerTax) overrides.includeOwnerTax = params.ownerTax === 'yes';
  const options = forecastOptions(db, { companyId: company.id, asOf, overrides });
  const forecast = buildForecast(db, options);
  return {
    company,
    defaults: forecastDefaults(db, company.id),
    forecast,
    comparison: params.compare ? compareWithSnapshot(db, { companyId: company.id, snapshotId: params.compare, current: forecast }) : null,
    snapshots: listForecastSnapshots(db, company.id),
    scenarios: listScenarios(db, company.id),
    items: listRecurringItems(db, company.id),
    suggestions: listRecurringPatterns(db, company.id, 'suggested'),
    customers: db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.companyId, company.id)).orderBy(asc(customers.name)).all(),
    cashAccounts: db.select({ id: accounts.id, code: accounts.code, name: accounts.name }).from(accounts)
      .where(and(eq(accounts.companyId, company.id), eq(accounts.type, 'asset'))).orderBy(asc(accounts.code)).all(),
  };
}

/** Read model for the budget screen (issue #569). */
export function budgetPage(yearEnd: string, today: string) {
  const db = getDb();
  const company = requireCompany();
  const budgets = listBudgets(db, company.id);
  const current = budgets.find((b) => b.financialYearEnd === yearEnd && b.status === 'current') ?? null;
  const chart = db.select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type }).from(accounts)
    .where(and(eq(accounts.companyId, company.id), inArray(accounts.type, ['income', 'expense']))).orderBy(asc(accounts.code)).all();
  const valid = isIsoDate(yearEnd);
  return {
    company,
    yearEnd,
    months: valid ? budgetMonths(asIsoDate(yearEnd)) : [],
    budgets,
    current,
    currentLines: current ? budgetLines(db, current.id) : [],
    comparison: current ? budgetVsActual(db, { companyId: company.id, budgetId: current.id, asOf: asIsoDate(today) }) : null,
    chart,
  };
}

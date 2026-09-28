'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { parseAmount, parsePercentBasisPoints } from '@/domain/money';
import { asIsoDate } from '@/domain/dates';
import {
  addScenarioAdjustment, buildForecast, confirmRecurringPattern, copyBudget, createBudget, createRecurringItem, createScenario,
  detectRecurringPatterns, dismissRecurringPattern, forecastOptions, importBudgetCsv, removeScenarioAdjustment, saveForecastSnapshot,
  setForecastDefaults, updateRecurringItem, type BudgetLineInput, type ForecastDefaults, type Frequency, type ScenarioAdjustmentKind,
} from '@/domain/forecast';
import type { ActionResult } from '@/app/settings-actions';

/** Forecast mutations (EPIC 29, issues #565–#570). The domain owns every figure; nothing here posts. */

const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (message: string, path = '/forecast'): ActionResult => {
  revalidatePath(path);
  return { ok: true, message };
};

/** Signed amounts and percentages as typed: "-2,500", "+5", "-10.5". */
function signedAmount(value: string, currency: string): number {
  const amount = parseAmount(value.replace(/^[+-]/, ''), currency);
  return value.startsWith('-') ? -amount : amount;
}
function signedPercent(value: string): number {
  const bp = parsePercentBasisPoints(value.replace(/^[+-]/, ''));
  if (bp === null) throw new Error(`"${value}" is not a percentage (up to two decimal places).`);
  return value.startsWith('-') ? -bp : bp;
}

export async function setForecastDefaultsAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const company = requireCompany();
    const cash = f.getAll('cashAccountIds').map(String).filter(Boolean);
    const changes: Partial<Omit<ForecastDefaults, 'version'>> = {
      receiptBasis: text(f, 'receiptBasis') as ForecastDefaults['receiptBasis'],
      horizonDays: Number(text(f, 'horizonDays')),
      granularity: text(f, 'granularity') as ForecastDefaults['granularity'],
      dueDateBasis: text(f, 'dueDateBasis') as ForecastDefaults['dueDateBasis'],
      minimumCashMinor: parseAmount(text(f, 'minimumCash') || '0', company.baseCurrency),
      cashAccountIds: cash.length ? cash : null,
      includePurchaseOrders: f.get('includePurchaseOrders') === 'on',
      includeUnconfirmed: f.get('includeUnconfirmed') === 'on',
      includeOwnerTax: f.get('includeOwnerTax') === 'on',
    };
    const v = setForecastDefaults(getDb(), { companyId: company.id, recordedBy: await actorName(), changes });
    return done(`Defaults saved as version ${v.version}.`);
  } catch (e) { return fail(e); }
}

export async function saveForecastAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const db = getDb();
    const companyId = requireCompany().id;
    // The options the page was showing, recomputed here: a saved forecast is always the domain's own figures.
    const { companyId: owner, asOf, ...overrides } = JSON.parse(text(f, 'options')) as ReturnType<typeof forecastOptions>;
    if (owner !== companyId) throw new Error('That forecast is not this company\'s.');
    const result = buildForecast(db, forecastOptions(db, { companyId, asOf: asIsoDate(asOf), overrides }));
    saveForecastSnapshot(db, { name: text(f, 'name'), savedBy: await actorName(), result });
    return done('Forecast saved.');
  } catch (e) { return fail(e); }
}

export async function createScenarioAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    createScenario(getDb(), { companyId: requireCompany().id, name: text(f, 'name'), description: text(f, 'description') || null, recordedBy: await actorName() });
    return done('Scenario added.');
  } catch (e) { return fail(e); }
}

export async function addScenarioAdjustmentAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const company = requireCompany();
    const kind = text(f, 'kind') as ScenarioAdjustmentKind;
    const value = text(f, 'value');
    addScenarioAdjustment(getDb(), {
      companyId: company.id, scenarioId: text(f, 'scenarioId'), adjustment: {
        kind, description: text(f, 'description'), fromDate: text(f, 'fromDate'), toDate: text(f, 'toDate') || null,
        targetId: text(f, 'targetId') || null,
        delayDays: kind === 'customer_payment_delay' ? Number(value) : null,
        changeBasisPoints: kind === 'revenue_change' || kind === 'cost_change' ? signedPercent(value) : null,
        amountMinor: kind === 'one_off' || kind === 'new_hire' || kind === 'recurring_item' ? signedAmount(value, company.baseCurrency) : null,
        frequency: kind === 'recurring_item' ? (text(f, 'frequency') as Frequency) : null,
      },
    });
    return done('Adjustment added.');
  } catch (e) { return fail(e); }
}

export async function removeScenarioAdjustmentAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    removeScenarioAdjustment(getDb(), { companyId: requireCompany().id, adjustmentId: text(f, 'adjustmentId') });
    return done('Adjustment removed.');
  } catch (e) { return fail(e); }
}

export async function detectRecurringAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const r = detectRecurringPatterns(getDb(), { companyId: requireCompany().id, asOf: asIsoDate(text(f, 'asOf')) });
    return done(`${r.suggested.length} suggestion(s) to review.${r.unconverted ? ` ${r.unconverted} bank line(s) in another currency with no base amount were left out.` : ''}`);
  } catch (e) { return fail(e); }
}

export async function confirmRecurringAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const company = requireCompany();
    const amount = text(f, 'amount');
    confirmRecurringPattern(getDb(), {
      companyId: company.id, patternId: text(f, 'patternId'), confirmedBy: await actorName(),
      amountMinor: amount ? parseAmount(amount, company.baseCurrency) : undefined, startDate: text(f, 'startDate') || undefined,
    });
    return done('Confirmed: it is now in the forecast.');
  } catch (e) { return fail(e); }
}

export async function dismissRecurringAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    dismissRecurringPattern(getDb(), { companyId: requireCompany().id, patternId: text(f, 'patternId'), dismissedBy: await actorName() });
    return done('Dismissed: it will not be suggested again.');
  } catch (e) { return fail(e); }
}

export async function addRecurringItemAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const company = requireCompany();
    createRecurringItem(getDb(), {
      companyId: company.id, recordedBy: await actorName(), description: text(f, 'description'),
      direction: text(f, 'direction') as 'inflow' | 'outflow', amountMinor: parseAmount(text(f, 'amount'), company.baseCurrency),
      frequency: text(f, 'frequency') as Frequency, startDate: text(f, 'startDate'), endDate: text(f, 'endDate') || null,
    });
    return done('Recurring item added.');
  } catch (e) { return fail(e); }
}

export async function changeRecurringItemAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const company = requireCompany();
    const amount = text(f, 'amount');
    const endDate = text(f, 'endDate');
    updateRecurringItem(getDb(), {
      companyId: company.id, itemId: text(f, 'itemId'), recordedBy: await actorName(), changes: {
        amountMinor: amount ? parseAmount(amount, company.baseCurrency) : undefined, endDate: endDate || undefined,
        status: f.get('stop') === 'on' ? 'dismissed' : undefined,
      },
    });
    return done('Recorded as a new version.');
  } catch (e) { return fail(e); }
}

export async function enterBudgetAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const company = requireCompany();
    const lines: BudgetLineInput[] = [];
    for (const [key, raw] of f.entries()) {
      const m = /^cell:([^:]+):(\d{4}-\d{2}-01)$/.exec(key);
      const value = String(raw).trim();
      if (!m || !value) continue;
      lines.push({ accountId: m[1]!, monthStart: m[2]!, amountMinor: parseAmount(value, company.baseCurrency) });
    }
    createBudget(getDb(), {
      companyId: company.id, financialYearEnd: text(f, 'yearEnd'), name: text(f, 'name'), reason: text(f, 'reason') || null,
      recordedBy: await actorName(), lines,
    });
    return done('Budget saved as a new version.', '/forecast/budget');
  } catch (e) { return fail(e); }
}

export async function importBudgetAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const file = f.get('file');
    const csv = file instanceof File && file.size > 0 ? await file.text() : text(f, 'csv');
    importBudgetCsv(getDb(), {
      companyId: requireCompany().id, financialYearEnd: text(f, 'yearEnd'), name: text(f, 'name'), reason: text(f, 'reason') || null,
      recordedBy: await actorName(), csv,
    });
    return done('Budget imported as a new version.', '/forecast/budget');
  } catch (e) { return fail(e); }
}

export async function copyBudgetAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('forecast.manage');
    const from = text(f, 'from');
    const pct = text(f, 'percent');
    copyBudget(getDb(), {
      companyId: requireCompany().id, financialYearEnd: text(f, 'yearEnd'), name: text(f, 'name'), reason: text(f, 'reason') || null,
      recordedBy: await actorName(), from: from === 'actuals' ? { kind: 'actuals' } : { kind: 'budget', budgetId: from },
      adjustments: pct ? { allBasisPoints: signedPercent(pct) } : undefined,
    });
    return done('Budget copied as a new version.', '/forecast/budget');
  } catch (e) { return fail(e); }
}

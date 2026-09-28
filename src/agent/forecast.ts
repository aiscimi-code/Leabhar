import { readFileSync } from 'node:fs';
import type { AppDatabase } from '@/db';
import { getFlag } from '@/cli/args';
import { parseAmount, parsePercentBasisPoints } from '@/domain/money';
import { asIsoDate } from '@/domain/dates';
import {
  addScenarioAdjustment, budgetVsActual, buildForecast, compareScenarios, compareWithSnapshot, confirmRecurringPattern, copyBudget,
  createRecurringItem, createScenario, detectRecurringPatterns, dismissRecurringPattern, forecastDefaults, forecastOptions,
  importBudgetCsv, listBudgets, listForecastSnapshots, listRecurringItems, listRecurringPatterns, listScenarios,
  removeScenarioAdjustment, saveForecastSnapshot, setForecastDefaults, updateRecurringItem,
  type ForecastDefaults, type ForecastOptions, type Frequency, type ScenarioAdjustmentKind,
} from '@/domain/forecast';

/** Cash forecast commands (EPIC 29, issues #565–#570): the same domain functions the forecast screen calls. */

const OPTIONS = '[--days <n> | --to <date>] [--granularity daily|weekly|monthly] [--receipts due_date|customer_history]\n'
  + '           [--due-dates statutory|ros] [--scenario <id>] [--include-orders] [--include-drafts] [--no-owner-tax]\n'
  + '           [--minimum <euro>] [--cash-accounts <id,id>] [--delay <customerId>=<days>,...]';

export const FORECAST_USAGE = `
Cash forecast (EPIC 29, issues #565–#570). Nothing here posts; every option overrides the company default for one forecast:
  forecast --as-of <date> ${OPTIONS}
  forecast-defaults
  set-forecast-defaults [--receipts ...] [--days <n>] [--granularity ...] [--due-dates ...] [--minimum <euro>]
           [--cash-accounts <id,id>|default] [--include-orders true|false] [--include-drafts true|false] [--owner-tax true|false] --by <name>
  save-forecast --name <text> --as-of <date> [options] --by <name>
  list-saved-forecasts
  compare-saved-forecast --id <saved id> --as-of <date> [options]
  add-scenario --name <text> [--description <text>] --by <name>
  scenario-adjust --scenario <id> --kind customer_payment_delay|revenue_change|cost_change|one_off|new_hire|recurring_item
           --description <text> --from <date> [--to <date>] [--target <customer or supplier id>]
           [--days <n>] [--percent <±n>] [--amount <±euro>] [--frequency weekly|monthly|quarterly|yearly]
  remove-scenario-adjustment --id <adjustment id>
  list-scenarios
  compare-scenarios --scenarios <id,id> --as-of <date> [options]
  detect-recurring --as-of <date> [--lookback <days>]
  list-recurring-suggestions [--status suggested|confirmed|dismissed]
  confirm-recurring --pattern <id> [--description <text>] [--amount <euro>] [--frequency ...] [--from <date>] [--to <date>] --by <name>
  dismiss-recurring --pattern <id> --by <name>
  add-recurring-item --description <text> --direction inflow|outflow --amount <euro> --frequency ... --from <date> [--to <date>] --by <name>
  change-recurring-item --id <id> [--description <text>] [--amount <euro>] [--frequency ...] [--from <date>] [--to <date>|none] [--stop] --by <name>
  list-recurring-items
  import-budget --year-end <date> --name <text> --file <csv> [--reason <text>] --by <name>
           (CSV: an "account" column of codes or names, then one column per month headed YYYY-MM)
  copy-budget --year-end <date> --name <text> --from actuals|<budget id> [--percent <±n>] [--reason <text>] --by <name>
  list-budgets
  budget-vs-actual --budget <id> --as-of <date>
`;

export const FORECAST_COMMANDS = [
  'forecast', 'forecast-defaults', 'set-forecast-defaults', 'save-forecast', 'list-saved-forecasts', 'compare-saved-forecast',
  'add-scenario', 'scenario-adjust', 'remove-scenario-adjustment', 'list-scenarios', 'compare-scenarios',
  'detect-recurring', 'list-recurring-suggestions', 'confirm-recurring', 'dismiss-recurring', 'add-recurring-item',
  'change-recurring-item', 'list-recurring-items', 'import-budget', 'copy-budget', 'list-budgets', 'budget-vs-actual',
] as const;

type Flags = Record<string, string | boolean>;
function need(flags: Flags, name: string): string {
  const v = getFlag(flags, name);
  if (v === undefined) throw new Error(`Missing required flag: --${name}`);
  return v;
}

/** A signed percentage as typed ("-10", "+2.5") in basis points. */
export function signedPercent(text: string): number {
  const t = text.trim();
  const negative = t.startsWith('-');
  const bp = parsePercentBasisPoints(t.replace(/^[+-]/, ''));
  if (bp === null) throw new Error(`"${text}" is not a percentage (up to two decimal places).`);
  return negative ? -bp : bp;
}

function signedEuro(text: string): number {
  const t = text.trim();
  const amount = parseAmount(t.replace(/^[+-]/, ''), 'EUR');
  return t.startsWith('-') ? -amount : amount;
}

const bool = (flags: Flags, name: string): boolean | undefined => {
  const v = getFlag(flags, name);
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`--${name} is true or false.`);
};

function overrides(flags: Flags): NonNullable<Parameters<typeof forecastOptions>[1]['overrides']> {
  const o: NonNullable<Parameters<typeof forecastOptions>[1]['overrides']> = {};
  const days = getFlag(flags, 'days');
  if (days !== undefined) o.horizonDays = Number(days);
  const to = getFlag(flags, 'to');
  if (to !== undefined) o.horizonEnd = asIsoDate(to);
  const g = getFlag(flags, 'granularity');
  if (g !== undefined) o.granularity = g as ForecastOptions['granularity'];
  const r = getFlag(flags, 'receipts');
  if (r !== undefined) o.receiptBasis = r as ForecastOptions['receiptBasis'];
  const due = getFlag(flags, 'due-dates');
  if (due !== undefined) o.dueDateBasis = due as ForecastOptions['dueDateBasis'];
  const scenario = getFlag(flags, 'scenario');
  if (scenario !== undefined) o.scenarioId = scenario;
  if (flags.includeOrders === true) o.includePurchaseOrders = true;
  if (flags.includeDrafts === true) o.includeUnconfirmed = true;
  if (flags.noOwnerTax === true) o.includeOwnerTax = false;
  const min = getFlag(flags, 'minimum');
  if (min !== undefined) o.minimumCashMinor = signedEuro(min);
  const cash = getFlag(flags, 'cash-accounts');
  if (cash !== undefined) o.cashAccountIds = cash.split(',').map((s) => s.trim()).filter(Boolean);
  const delay = getFlag(flags, 'delay');
  if (delay !== undefined) {
    o.customerDelayDays = Object.fromEntries(delay.split(',').map((pair) => {
      const [id, n] = pair.split('=');
      if (!id || n === undefined || !/^-?\d+$/.test(n.trim())) throw new Error(`--delay takes <customerId>=<days>, not "${pair}".`);
      return [id.trim(), Number(n)];
    }));
  }
  return o;
}

export function runForecastCommand(db: AppDatabase, companyId: string, command: string, flags: Flags): unknown {
  const options = () => forecastOptions(db, { companyId, asOf: asIsoDate(need(flags, 'as-of')), overrides: overrides(flags) });
  const frequency = () => getFlag(flags, 'frequency') as Frequency | undefined;
  switch (command) {
    case 'forecast': return buildForecast(db, options());
    case 'forecast-defaults': return forecastDefaults(db, companyId);
    case 'set-forecast-defaults': {
      const changes: Partial<Omit<ForecastDefaults, 'version'>> = {};
      const o = overrides(flags);
      if (o.receiptBasis) changes.receiptBasis = o.receiptBasis;
      if (o.horizonDays !== undefined) changes.horizonDays = o.horizonDays;
      if (o.granularity) changes.granularity = o.granularity;
      if (o.dueDateBasis) changes.dueDateBasis = o.dueDateBasis;
      if (o.minimumCashMinor !== undefined) changes.minimumCashMinor = o.minimumCashMinor;
      if (getFlag(flags, 'cash-accounts') === 'default') changes.cashAccountIds = null;
      else if (o.cashAccountIds) changes.cashAccountIds = o.cashAccountIds;
      const orders = bool(flags, 'include-orders');
      if (orders !== undefined) changes.includePurchaseOrders = orders;
      const drafts = bool(flags, 'include-drafts');
      if (drafts !== undefined) changes.includeUnconfirmed = drafts;
      const ownerTax = bool(flags, 'owner-tax');
      if (ownerTax !== undefined) changes.includeOwnerTax = ownerTax;
      return setForecastDefaults(db, { companyId, recordedBy: need(flags, 'by'), changes });
    }
    case 'save-forecast': {
      const snapshot = saveForecastSnapshot(db, { name: need(flags, 'name'), savedBy: need(flags, 'by'), result: buildForecast(db, options()) });
      const { result, ...rest } = snapshot;
      return { ...rest, closingBalanceMinor: result.closingBalanceMinor, lowestPointMinor: result.lowestPointMinor };
    }
    case 'list-saved-forecasts': return listForecastSnapshots(db, companyId);
    case 'compare-saved-forecast':
      return compareWithSnapshot(db, { companyId, snapshotId: need(flags, 'id'), current: buildForecast(db, options()) });
    case 'add-scenario':
      return createScenario(db, { companyId, name: need(flags, 'name'), description: getFlag(flags, 'description') ?? null, recordedBy: need(flags, 'by') });
    case 'scenario-adjust': {
      const pct = getFlag(flags, 'percent');
      const amount = getFlag(flags, 'amount');
      const days = getFlag(flags, 'days');
      return addScenarioAdjustment(db, {
        companyId, scenarioId: need(flags, 'scenario'), adjustment: {
          kind: need(flags, 'kind') as ScenarioAdjustmentKind, description: need(flags, 'description'), fromDate: need(flags, 'from'),
          toDate: getFlag(flags, 'to') ?? null, targetId: getFlag(flags, 'target') ?? null,
          delayDays: days === undefined ? null : Number(days), changeBasisPoints: pct === undefined ? null : signedPercent(pct),
          amountMinor: amount === undefined ? null : signedEuro(amount), frequency: frequency() ?? null,
        },
      });
    }
    case 'remove-scenario-adjustment':
      removeScenarioAdjustment(db, { companyId, adjustmentId: need(flags, 'id') });
      return { removed: need(flags, 'id') };
    case 'list-scenarios': return listScenarios(db, companyId);
    case 'compare-scenarios':
      return compareScenarios(db, { options: options(), scenarioIds: need(flags, 'scenarios').split(',').map((s) => s.trim()).filter(Boolean) });
    case 'detect-recurring': {
      const lookback = getFlag(flags, 'lookback');
      return detectRecurringPatterns(db, { companyId, asOf: asIsoDate(need(flags, 'as-of')), lookbackDays: lookback === undefined ? undefined : Number(lookback) });
    }
    case 'list-recurring-suggestions':
      return listRecurringPatterns(db, companyId, getFlag(flags, 'status') as 'suggested' | 'confirmed' | 'dismissed' | undefined);
    case 'confirm-recurring': {
      const amount = getFlag(flags, 'amount');
      return confirmRecurringPattern(db, {
        companyId, patternId: need(flags, 'pattern'), confirmedBy: need(flags, 'by'), description: getFlag(flags, 'description'),
        amountMinor: amount === undefined ? undefined : parseAmount(amount, 'EUR'), frequency: frequency(),
        startDate: getFlag(flags, 'from'), endDate: getFlag(flags, 'to') ?? null,
      });
    }
    case 'dismiss-recurring': return dismissRecurringPattern(db, { companyId, patternId: need(flags, 'pattern'), dismissedBy: need(flags, 'by') });
    case 'add-recurring-item':
      return createRecurringItem(db, {
        companyId, recordedBy: need(flags, 'by'), description: need(flags, 'description'),
        direction: need(flags, 'direction') as 'inflow' | 'outflow', amountMinor: parseAmount(need(flags, 'amount'), 'EUR'),
        frequency: need(flags, 'frequency') as Frequency, startDate: need(flags, 'from'), endDate: getFlag(flags, 'to') ?? null,
      });
    case 'change-recurring-item': {
      const amount = getFlag(flags, 'amount');
      const to = getFlag(flags, 'to');
      return updateRecurringItem(db, {
        companyId, itemId: need(flags, 'id'), recordedBy: need(flags, 'by'), changes: {
          description: getFlag(flags, 'description'), amountMinor: amount === undefined ? undefined : parseAmount(amount, 'EUR'),
          frequency: frequency(), startDate: getFlag(flags, 'from'), endDate: to === undefined ? undefined : to === 'none' ? null : to,
          status: flags.stop === true ? 'dismissed' : undefined,
        },
      });
    }
    case 'list-recurring-items': return listRecurringItems(db, companyId);
    case 'import-budget':
      return importBudgetCsv(db, {
        companyId, financialYearEnd: need(flags, 'year-end'), name: need(flags, 'name'), recordedBy: need(flags, 'by'),
        reason: getFlag(flags, 'reason') ?? null, csv: readFileSync(need(flags, 'file'), 'utf8'),
      });
    case 'copy-budget': {
      const from = need(flags, 'from');
      const pct = getFlag(flags, 'percent');
      return copyBudget(db, {
        companyId, financialYearEnd: need(flags, 'year-end'), name: need(flags, 'name'), recordedBy: need(flags, 'by'),
        reason: getFlag(flags, 'reason') ?? null, from: from === 'actuals' ? { kind: 'actuals' } : { kind: 'budget', budgetId: from },
        adjustments: pct === undefined ? undefined : { allBasisPoints: signedPercent(pct) },
      });
    }
    case 'list-budgets': return listBudgets(db, companyId);
    case 'budget-vs-actual': return budgetVsActual(db, { companyId, budgetId: need(flags, 'budget'), asOf: asIsoDate(need(flags, 'as-of')) });
    default: throw new Error(`Unknown forecast command: ${command}`);
  }
}

import { and, eq, or } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts } from '@/db/schema';
import { getFlag } from '@/cli/args';
import { asIsoDate } from '@/domain/dates';
import { cashFlowStatement } from '@/domain/reports/cashFlow';
import { comparativeStatements, incomeExpenseByMonth, invoicesByParty } from '@/domain/reports/analysis';
import { companySize, recordCompanySizeDecision } from '@/domain/reports/companySize';
import { schedule3ABalanceSheet, schedule3AProfitAndLoss, mapAccountToFormatItem } from '@/domain/reports/schedule3A';
import type { COMPANY_SIZE_DECISION_KINDS } from '@/db/schema';

/** Financial reporting commands (EPIC 28, issues #553, #554): the same domain functions the reports screens call. */

export const REPORT_USAGE = `
Financial reporting (EPIC 28, issue #553). Figures are the ledger's; nothing here posts:
  cash-flow --from <date> --to <date>              cash flow statement, indirect method, reconciled to bank and cash
  comparatives --from <date> --to <date>           P&L and balance sheet beside the same period a year earlier
  income-expense --from <date> --to <date>         income and expense by account by month
  income-by-customer | expense-by-supplier --from <date> --to <date>

Company size and Schedule 3A formats (issue #554). Decisions the books cannot make are recorded by a person:
  company-size --year-end <date>
  size-decision --year-end <date> --kind exclusion|prior_year_size|prior_year_conditions|size_criteria_election --choice <value> [--note <text>] --by <name>
           (size_criteria_election: fy_from_2024 | fy_from_2023, the s.280I election)
  size-decision --year-end <date> --kind average_employees --count <n> --note <how> --by <name>
  schedule-3a --from <date> --to <date>          Format 1 balance sheet (at --to) and profit and loss account
  map-format-item --account <id|code> --item <code> --from <date> [--note <text>] --by <name>
`;

export const REPORT_COMMANDS = [
  'cash-flow', 'comparatives', 'income-expense', 'income-by-customer', 'expense-by-supplier',
  'company-size', 'size-decision', 'schedule-3a', 'map-format-item',
] as const;

type Flags = Record<string, string | boolean>;
function need(flags: Flags, name: string): string {
  const v = getFlag(flags, name);
  if (v === undefined) throw new Error(`Missing required flag: --${name}`);
  return v;
}

export function runReportCommand(db: AppDatabase, companyId: string, command: string, flags: Flags): unknown {
  switch (command) {
    case 'company-size': return companySize(db, { companyId, financialYearEnd: need(flags, 'year-end') });
    case 'size-decision': {
      const count = getFlag(flags, 'count');
      return recordCompanySizeDecision(db, {
        companyId, financialYearEnd: need(flags, 'year-end'), kind: need(flags, 'kind') as (typeof COMPANY_SIZE_DECISION_KINDS)[number],
        choice: getFlag(flags, 'choice') ?? null, count: count === undefined ? null : Number(count), note: getFlag(flags, 'note') ?? null, decidedBy: need(flags, 'by'),
      });
    }
    case 'map-format-item': {
      const ref = need(flags, 'account');
      const account = db.select().from(accounts).where(and(eq(accounts.companyId, companyId), or(eq(accounts.id, ref), eq(accounts.code, ref)))).get();
      if (!account) throw new Error(`No account ${ref}.`);
      return mapAccountToFormatItem(db, { companyId, accountId: account.id, itemCode: need(flags, 'item'), effectiveFrom: need(flags, 'from'), note: getFlag(flags, 'note') ?? null, recordedBy: need(flags, 'by') });
    }
    default: break;
  }
  const from = asIsoDate(need(flags, 'from'));
  const to = asIsoDate(need(flags, 'to'));
  switch (command) {
    case 'schedule-3a': return {
      balanceSheet: schedule3ABalanceSheet(db, { companyId, asOf: to, financialYearStart: from }),
      profitAndLoss: schedule3AProfitAndLoss(db, { companyId, from, to }),
    };
    case 'cash-flow': return cashFlowStatement(db, { companyId, from, to });
    case 'comparatives': return comparativeStatements(db, { companyId, from, to });
    case 'income-expense': return incomeExpenseByMonth(db, { companyId, from, to });
    case 'income-by-customer': return invoicesByParty(db, { companyId, direction: 'sales', from, to });
    case 'expense-by-supplier': return invoicesByParty(db, { companyId, direction: 'purchase', from, to });
    default: throw new Error(`Unknown report command: ${command}`);
  }
}

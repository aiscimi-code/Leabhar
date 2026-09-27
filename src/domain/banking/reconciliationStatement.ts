import { and, eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { reconciliations } from '@/db/schema';
import type { IsoDate } from '../dates';
import { reconcileBankAccount, type ReconciliationResult } from './reconciliation';

/**
 * The bank reconciliation statement (issue #387): what an accountant files
 * against a bank account for a period. It runs from the statement balance,
 * through each reconciling item, to the ledger balance, and ends with any
 * difference nothing explains. Every figure comes from `reconcileBankAccount`;
 * this only arranges them, so the export and the screen cannot disagree.
 */

export interface StatementRow {
  section: string;
  date: string | null;
  description: string;
  explanation: string;
  /** Base currency; null for a line that carries no figure. */
  amountMinor: number | null;
}

export interface ReconciliationSignOff {
  status: string;
  completedAt: string | null;
  completedBy: string | null;
  notes: string | null;
}

export interface ReconciliationStatement {
  result: ReconciliationResult;
  /** Statement balance, less what the books have not got, plus what the statement has not got. */
  adjustedStatementBalanceMinor: number;
  rows: StatementRow[];
  signOff: ReconciliationSignOff | null;
}

const SOURCE: Record<ReconciliationResult['statementBalanceSource'], string> = {
  supplied: 'as entered from the paper statement',
  statement_closing_balance: 'the closing balance the imported statement states',
  statement_running_balance: 'the running balance on the last imported line',
  derived_from_movements: 'derived from the opening balance and imported lines — the statement gave no balance',
};

export function reconciliationStatement(
  db: AppDatabase,
  params: {
    companyId: string; bankAccountId: string; periodStart: IsoDate; periodEnd: IsoDate;
    statementClosingBalanceMinor?: number;
  },
): ReconciliationStatement {
  const result = reconcileBankAccount(db, params);
  const notInBooks = result.items.filter((i) => i.kind === 'statement_not_in_ledger');
  const notOnStatement = result.items.filter((i) => i.kind === 'ledger_not_on_statement');
  const duplicates = result.items.filter((i) => i.kind === 'suspected_duplicate');

  const rows: StatementRow[] = [];
  rows.push({
    section: 'Balance per bank statement', date: result.periodEnd,
    description: `Source: ${SOURCE[result.statementBalanceSource]}`, explanation: '',
    amountMinor: result.statementBalanceMinor,
  });
  // A line the bank has and the books do not: taken off the statement balance
  // to reach the books.
  for (const item of notInBooks) {
    rows.push({
      section: 'Less: on the statement, not in the books', date: item.date,
      description: item.description, explanation: item.explanation, amountMinor: -item.amountMinor,
    });
  }
  // A movement the books have and the statement does not: added.
  for (const item of notOnStatement) {
    rows.push({
      section: 'Add: in the books, not on the statement', date: item.date,
      description: item.description, explanation: item.explanation, amountMinor: item.amountMinor,
    });
  }
  const adjustedStatementBalanceMinor = result.statementBalanceMinor
    - notInBooks.reduce((s, i) => s + i.amountMinor, 0)
    + notOnStatement.reduce((s, i) => s + i.amountMinor, 0);
  rows.push({
    section: 'Adjusted statement balance', date: result.periodEnd, description: '', explanation: '',
    amountMinor: adjustedStatementBalanceMinor,
  });
  rows.push({
    section: 'Balance per ledger', date: result.periodEnd,
    description: 'Opening balance plus posted movements', explanation: '', amountMinor: result.ledgerBalanceMinor,
  });
  rows.push({
    section: 'Ledger: opening balance', date: result.periodStart, description: '', explanation: '',
    amountMinor: result.openingBalanceMinor,
  });
  rows.push({
    section: 'Ledger: posted movements', date: null, description: '', explanation: '',
    amountMinor: result.movementsMinor,
  });
  rows.push({
    section: 'Unexplained difference', date: null,
    description: result.unexplainedMinor === 0 ? 'None: every difference is accounted for' : 'NOT RECONCILED',
    explanation: result.summary, amountMinor: result.unexplainedMinor,
  });
  for (const item of duplicates) {
    rows.push({
      section: 'For attention: possible duplicate (not part of the difference)', date: item.date,
      description: item.description, explanation: item.explanation, amountMinor: item.amountMinor,
    });
  }
  for (const warning of result.warnings) {
    rows.push({ section: 'Warning', date: null, description: warning, explanation: '', amountMinor: null });
  }

  const signed = db.select().from(reconciliations).where(and(
    eq(reconciliations.companyId, params.companyId),
    eq(reconciliations.bankAccountId, params.bankAccountId),
    eq(reconciliations.periodStart, params.periodStart),
    eq(reconciliations.periodEnd, params.periodEnd),
  )).orderBy(desc(reconciliations.createdAt)).get();
  const signOff = signed
    ? { status: signed.status, completedAt: signed.completedAt, completedBy: signed.completedBy, notes: signed.notes }
    : null;
  rows.push(signOff
    ? {
        section: 'Sign-off', date: signOff.completedAt?.slice(0, 10) ?? null,
        description: `${signOff.status}${signOff.completedBy ? ` by ${signOff.completedBy}` : ''}`,
        explanation: signOff.notes ?? '', amountMinor: null,
      }
    : { section: 'Sign-off', date: null, description: 'Not signed off', explanation: '', amountMinor: null });

  return { result, adjustedStatementBalanceMinor, rows, signOff };
}

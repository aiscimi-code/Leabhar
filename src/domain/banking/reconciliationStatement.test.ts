import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from './import';
import { classifyTransaction } from './classify';
import { completeReconciliation } from './reconciliation';
import { reconciliationStatement } from './reconciliationStatement';
import { postJournalEntry } from '../accounting/journal';
import { makeDate } from '../dates';
import { bankTransactions } from '@/db/schema';

const PERIOD = { periodStart: makeDate(2025, 1, 1), periodEnd: makeDate(2025, 1, 31) };

async function books() {
  const { db } = createTestDatabase();
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
  const { companyId, accountsByKey: acc, accountsByCode: byCode, treatmentsByCode: tr } = created;
  const bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01', accountId: acc['bank_control'],
  });
  await importStatement(db, {
    companyId, bankAccountId, filename: 'jan.csv', fileFormat: 'csv',
    content: [
      'Date,Description,Amount,Balance',
      '05/01/2025,OPENING TRANSFER,1000.00,1000.00',
      '15/01/2025,VERCEL INC,-42.17,957.83',
      '20/01/2025,BYRNE ACCOUNTANCY,-615.00,342.83',
    ].join('\n'),
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount', Balance: 'balance' },
  });
  // Only the first line is in the books; the other two are not yet classified.
  const first = db.select().from(bankTransactions).where(eq(bankTransactions.description, 'OPENING TRANSFER')).get()!;
  classifyTransaction(db, { companyId, bankTransactionId: first.id, accountId: byCode['4000']!, vatTreatmentId: tr['OUT_OF_SCOPE']! });
  // A payment recorded in the books before it cleared the bank.
  postJournalEntry(db, {
    companyId, entryDate: makeDate(2025, 1, 28), narrative: 'Cheque 104 not yet cleared',
    sourceType: 'manual_adjustment', baseCurrency: 'EUR',
    lines: [{ accountId: byCode['6070']!, debitMinor: 20_000 }, { accountId: acc['bank_control']!, creditMinor: 20_000 }],
  });
  return { db, companyId, bankAccountId };
}

describe('reconciliationStatement (#387)', () => {
  it('runs from the statement balance, through each item, to the ledger balance', async () => {
    const { db, companyId, bankAccountId } = await books();
    const statement = reconciliationStatement(db, { companyId, bankAccountId, ...PERIOD });
    const amounts = (prefix: string) => statement.rows.filter((r) => r.section.startsWith(prefix))
      .map((r) => [r.description, r.amountMinor]);

    expect(amounts('Balance per bank statement')).toEqual([[expect.stringContaining('running balance'), 34_283]]);
    // Lines the bank has and the books do not come off the statement balance.
    expect(amounts('Less')).toEqual([['VERCEL INC', 4_217], ['BYRNE ACCOUNTANCY', 61_500]]);
    // A movement the books have and the bank does not is added (here, money out).
    expect(amounts('Add')).toEqual([['Cheque 104 not yet cleared', -20_000]]);
    expect(statement.adjustedStatementBalanceMinor).toBe(34_283 + 4_217 + 61_500 - 20_000);
    expect(amounts('Balance per ledger')).toEqual([[expect.any(String), 80_000]]);
    expect(amounts('Unexplained difference')).toEqual([['None: every difference is accounted for', 0]]);
    // The same arithmetic as the reconciliation itself.
    expect(statement.adjustedStatementBalanceMinor - statement.result.ledgerBalanceMinor)
      .toBe(statement.result.unexplainedMinor);
    expect(statement.rows.at(-1)).toMatchObject({ section: 'Sign-off', description: 'Not signed off' });
  });

  it('shows an unexplained difference and the sign-off', async () => {
    const { db, companyId, bankAccountId } = await books();
    // The paper statement says 10.00 more than the import.
    const params = { companyId, bankAccountId, ...PERIOD, statementClosingBalanceMinor: 35_283 };
    const statement = reconciliationStatement(db, params);
    expect(statement.rows.find((r) => r.section === 'Unexplained difference'))
      .toMatchObject({ description: 'NOT RECONCILED', amountMinor: 1_000 });

    completeReconciliation(db, { ...params, actor: 'Joe', acceptDifference: { reason: 'Bank to confirm' } });
    const signed = reconciliationStatement(db, params);
    expect(signed.signOff).toMatchObject({ completedBy: 'Joe' });
    expect(signed.rows.at(-1)!.description).toContain('by Joe');
  });
});

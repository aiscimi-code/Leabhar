import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement, rollbackStatementImport, listStatementImports, ImportRollbackError } from './import';
import { classifyTransaction } from './classify';
import { reconcileBankAccount } from './reconciliation';
import { auditEvents, bankTransactions, statementImports } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

const STATEMENT = [
  'Date,Description,Amount',
  '03/03/2025,Eircom broadband,-123.00',
  '10/03/2025,Client Ltd,1500.00',
  '10/03/2025,Client Ltd,1500.00',
].join('\n');

let db: AppDatabase;
let companyId: string;
let current: string;
let savings: string;
let byCode: Record<string, string>;
let treatments: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  treatments = created.treatmentsByCode;
  current = addBankAccount(db, { companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2025-01-01' });
  savings = addBankAccount(db, { companyId, bankName: 'AIB', accountName: 'Saver', accountType: 'savings', openingDate: '2025-01-01' });
});

const importInto = (bankAccountId: string, content = STATEMENT) => importStatement(db, {
  companyId, bankAccountId, filename: 'march.csv', content, fileFormat: 'csv',
});
const lines = (importId: string) => db.select().from(bankTransactions)
  .where(eq(bankTransactions.statementImportId, importId)).all();

describe('undoing a statement import (#379)', () => {
  it('keeps the lines as rolled back, marks the import reversed and audits the reason', async () => {
    const wrong = await importInto(savings);
    const result = rollbackStatementImport(db, {
      companyId, importId: wrong.importId, reason: 'Imported into the saver by mistake', actor: 'joseph',
    });
    expect(result).toMatchObject({ linesRolledBack: 3 });
    expect(lines(wrong.importId).map((l) => l.status)).toEqual(['rolled_back', 'rolled_back', 'rolled_back']);
    expect(db.select().from(statementImports).where(eq(statementImports.id, wrong.importId)).get()!.status)
      .toBe('reversed');
    const audit = db.select().from(auditEvents).where(and(
      eq(auditEvents.action, 'import_reversed'), eq(auditEvents.entityId, wrong.importId),
    )).get()!;
    expect(audit).toMatchObject({ actor: 'joseph', reason: 'Imported into the saver by mistake' });
    expect(listStatementImports(db, companyId)[0]).toMatchObject({ id: wrong.importId, status: 'reversed' });
  });

  it('lets the same file be imported again once undone — including into the same account', async () => {
    const first = await importInto(current);
    rollbackStatementImport(db, { companyId, importId: first.importId, reason: 'Wrong mapping', actor: 'joseph' });

    const again = await importInto(current);
    expect(again).toMatchObject({ imported: 3, duplicates: 0 });
    // The two identical lines keep distinct occurrence numbers, clear of the rolled-back ones.
    const live = lines(again.importId);
    expect(new Set(live.map((l) => `${l.fingerprint}#${l.occurrenceIndex}`)).size).toBe(3);

    // A third import of the same file finds everything already there.
    const third = await importStatement(db, {
      companyId, bankAccountId: current, filename: 'march.csv', content: STATEMENT,
      fileFormat: 'csv', allowReimport: true,
    });
    expect(third).toMatchObject({ imported: 0, duplicates: 3 });
  });

  it('leaves rolled-back lines out of reconciliation and refuses to classify them', async () => {
    const wrong = await importInto(current);
    rollbackStatementImport(db, { companyId, importId: wrong.importId, reason: 'Wrong file', actor: 'joseph' });

    const rec = reconcileBankAccount(db, {
      companyId, bankAccountId: current, periodStart: makeDate(2025, 3, 1), periodEnd: makeDate(2025, 3, 31),
    });
    expect(rec.counts.transactionsInPeriod).toBe(0);
    expect(() => classifyTransaction(db, {
      companyId, bankTransactionId: lines(wrong.importId)[0]!.id,
      accountId: byCode['6010']!, vatTreatmentId: treatments['OUT_OF_SCOPE']!,
    })).toThrow(/undone/);
  });

  it('refuses while the books rest on a line, and changes nothing', async () => {
    const run = await importInto(current);
    classifyTransaction(db, {
      companyId, bankTransactionId: lines(run.importId)[0]!.id,
      accountId: byCode['6010']!, vatTreatmentId: treatments['OUT_OF_SCOPE']!,
    });
    expect(() => rollbackStatementImport(db, {
      companyId, importId: run.importId, reason: 'Wrong file', actor: 'joseph',
    })).toThrow(ImportRollbackError);
    expect(lines(run.importId).some((l) => l.status === 'rolled_back')).toBe(false);
    expect(db.select().from(statementImports).where(eq(statementImports.id, run.importId)).get()!.status)
      .not.toBe('reversed');
  });

  it('needs a reason and a person, and cannot be undone twice', async () => {
    const run = await importInto(current);
    expect(() => rollbackStatementImport(db, { companyId, importId: run.importId, reason: ' ', actor: 'joseph' }))
      .toThrow(/why/);
    expect(() => rollbackStatementImport(db, { companyId, importId: run.importId, reason: 'x', actor: '' }))
      .toThrow(/who/);
    rollbackStatementImport(db, { companyId, importId: run.importId, reason: 'Wrong file', actor: 'joseph' });
    expect(() => rollbackStatementImport(db, { companyId, importId: run.importId, reason: 'Again', actor: 'joseph' }))
      .toThrow(/already been undone/);
  });
});

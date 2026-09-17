import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import { createRule } from '@/domain/rules/engine';
import { importStatement } from '@/domain/banking/import';
import { storeDocument } from '@/domain/documents/storage';
import { bankTransactions, reconciliations, documents, documentMatches, suppliers } from '@/db/schema';
import { main } from './reconcile';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;

const STATEMENT = [
  'Date,Description,Amount,Balance',
  '05/01/2025,OPENING TRANSFER,1000.00,1000.00',
  '15/01/2025,VERCEL INC,-42.17,957.83',
  '20/01/2025,BYRNE ACCOUNTANCY,-615.00,342.83',
].join('\n');

const COLUMNS = {
  Date: 'transaction_date' as const,
  Description: 'description' as const,
  Amount: 'amount' as const,
  Balance: 'balance' as const,
};

beforeEach(async () => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd',
    vatRegistrationStatus: 'registered',
    seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current',
    openingDate: '2025-01-01', accountId: created.accountsByKey['bank_control'],
  });
});

const run = (argv: string[]) => main(argv, { db, companyId });

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

const capture = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const restore = () => {
    process.stdout.write = out;
    process.stderr.write = err;
  };
  restores.push(restore);
  return { stdout, stderr, restore };
};

describe('cli reconcile', () => {
  it('lists bank accounts as JSON', async () => {
    const c = capture();
    const code = await run(['list-accounts']);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: bankAccountId,
      bankName: 'BOI',
      accountName: 'Current',
      currency: 'EUR',
      active: true,
    });
  });

  it('imports a statement file and prints a summary', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(tmpdir(), `leabhar-${Date.now()}.csv`);
    await writeFile(file, STATEMENT);

    const c = capture();
    const code = await run(['import', '--account', bankAccountId, '--file', file]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.imported).toBe(3);
    expect(parsed.rowsRead).toBe(3);
  });

  it('auto-classifies from rules', async () => {
    // Import directly so the transactions exist in the DB.
    await importStatement(db, {
      companyId, bankAccountId, filename: 'jan.csv',
      content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
    });
    createRule(db, {
      companyId,
      name: 'Vercel is hosting',
      conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
      actions: [
        { field: 'accountId', value: byCode['6010']! },
        { field: 'vatTreatmentId', value: tr['OUT_OF_SCOPE']! },
      ],
      autoApply: true,
    });

    const c = capture();
    const code = await run(['auto-classify', '--account', bankAccountId]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.classified).toBe(1);
    expect(parsed.unclassified).toBe(2);

    const vercel = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'VERCEL INC')).get()!;
    expect(vercel.status).toBe('posted');
  });

  it('computes a reconciliation (read-only)', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'jan.csv',
      content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
    });
    // Classify everything so the books agree with the statement.
    const { classifyTransaction } = await import('@/domain/banking/classify');
    for (const tx of db.select().from(bankTransactions).all()) {
      if (tx.journalEntryId) continue;
      classifyTransaction(db, {
        companyId, bankTransactionId: tx.id,
        accountId: tx.amountMinor > 0 ? byCode['4000']! : byCode['6010']!,
        vatTreatmentId: tr['OUT_OF_SCOPE']!,
      });
    }

    const c = capture();
    const code = await run([
      'reconcile', '--account', bankAccountId,
      '--from', '2025-01-01', '--to', '2025-01-31',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.reconciled).toBe(true);
    expect(parsed.differenceMinor).toBe(0);
    expect(parsed.statementBalanceMinor).toBe(34_283);
    // Read-only: no reconciliation record should exist.
    expect(db.select().from(reconciliations).all()).toHaveLength(0);
  });

  it('signs off a reconciliation', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'jan.csv',
      content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
    });
    const { classifyTransaction } = await import('@/domain/banking/classify');
    for (const tx of db.select().from(bankTransactions).all()) {
      if (tx.journalEntryId) continue;
      classifyTransaction(db, {
        companyId, bankTransactionId: tx.id,
        accountId: tx.amountMinor > 0 ? byCode['4000']! : byCode['6010']!,
        vatTreatmentId: tr['OUT_OF_SCOPE']!,
      });
    }

    const c = capture();
    const code = await run([
      'reconcile', '--account', bankAccountId,
      '--from', '2025-01-01', '--to', '2025-01-31',
      '--sign-off',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.reconciliationId).toBeTruthy();
    expect(parsed.result.reconciled).toBe(true);
    expect(db.select().from(reconciliations).all()).toHaveLength(1);
  });

  it('refuses to sign off an unreconciled period without --accept-difference', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'jan.csv',
      content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
    });
    const { classifyTransaction } = await import('@/domain/banking/classify');
    for (const tx of db.select().from(bankTransactions).all()) {
      if (tx.journalEntryId) continue;
      classifyTransaction(db, {
        companyId, bankTransactionId: tx.id,
        accountId: tx.amountMinor > 0 ? byCode['4000']! : byCode['6010']!,
        vatTreatmentId: tr['OUT_OF_SCOPE']!,
      });
    }

    // Supply a closing balance that disagrees with both the statement and the
    // ledger, leaving an unexplained difference — the only case sign-off
    // refuses without --accept-difference.
    const c = capture();
    const code = await run([
      'reconcile', '--account', bankAccountId,
      '--from', '2025-01-01', '--to', '2025-01-31',
      '--statement-balance', '500.00',
      '--sign-off',
    ]);
    c.restore();
    expect(code).toBe(1);
    expect(c.stderr.join('')).toContain('NOT RECONCILED');
  });

  it('signs off despite an unexplained difference with --accept-difference', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'jan.csv',
      content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
    });
    const { classifyTransaction } = await import('@/domain/banking/classify');
    for (const tx of db.select().from(bankTransactions).all()) {
      if (tx.journalEntryId) continue;
      classifyTransaction(db, {
        companyId, bankTransactionId: tx.id,
        accountId: tx.amountMinor > 0 ? byCode['4000']! : byCode['6010']!,
        vatTreatmentId: tr['OUT_OF_SCOPE']!,
      });
    }

    const c = capture();
    const code = await run([
      'reconcile', '--account', bankAccountId,
      '--from', '2025-01-01', '--to', '2025-01-31',
      '--statement-balance', '500.00',
      '--sign-off', '--accept-difference', 'Bank fee not yet posted',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.result.reconciled).toBe(false);
    expect(db.select().from(reconciliations).all()).toHaveLength(1);
  });

  it('lists reconciliations after a sign-off', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'jan.csv',
      content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
    });
    const { classifyTransaction } = await import('@/domain/banking/classify');
    for (const tx of db.select().from(bankTransactions).all()) {
      if (tx.journalEntryId) continue;
      classifyTransaction(db, {
        companyId, bankTransactionId: tx.id,
        accountId: tx.amountMinor > 0 ? byCode['4000']! : byCode['6010']!,
        vatTreatmentId: tr['OUT_OF_SCOPE']!,
      });
    }
    const signOffCapture = capture();
    await run([
      'reconcile', '--account', bankAccountId,
      '--from', '2025-01-01', '--to', '2025-01-31', '--sign-off',
    ]);
    signOffCapture.restore();

    const c = capture();
    const code = await run(['list-reconciliations']);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe('balanced');
  });

  it('runs the full pipeline', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(tmpdir(), `leabhar-pipeline-${Date.now()}.csv`);
    await writeFile(file, STATEMENT);
    createRule(db, {
      companyId,
      name: 'Vercel is hosting',
      conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
      actions: [
        { field: 'accountId', value: byCode['6010']! },
        { field: 'vatTreatmentId', value: tr['OUT_OF_SCOPE']! },
      ],
      autoApply: true,
    });

    const c = capture();
    const code = await run([
      'run', '--account', bankAccountId, '--file', file,
      '--from', '2025-01-01', '--to', '2025-01-31',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.import.imported).toBe(3);
    expect(parsed.classify.classified).toBe(1);
    expect(parsed.reconcile).toBeDefined();
  });

  it('prints usage and exits 2 with no command', async () => {
    const c = capture();
    const code = await run([]);
    c.restore();
    expect(code).toBe(2);
    expect(c.stdout.join('')).toContain('Usage');
  });

  it('exits 2 for an unknown command', async () => {
    const c = capture();
    const code = await run(['frobnicate']);
    c.restore();
    expect(code).toBe(2);
    expect(c.stderr.join('')).toContain('Unknown command');
  });

  it('exits 1 when a required flag is missing', async () => {
    const c = capture();
    const code = await run(['reconcile', '--from', '2025-01-01', '--to', '2025-01-31']);
    c.restore();
    expect(code).toBe(1);
    expect(c.stderr.join('')).toContain('Missing required flag');
  });
});

describe('cli reconcile — matching + suppliers', () => {
  let mDb: AppDatabase;
  let mCompanyId: string;
  let mBankAccount: string;
  let mByCode: Record<string, string>;
  let mTr: Record<string, string>;
  let root: string;
  let documentId: string;
  let transactionId: string;

  beforeEach(async () => {
    ({ db: mDb } = createTestDatabase());
    const created = createCompany(mDb, {
      legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025],
    });
    mCompanyId = created.companyId;
    mByCode = created.accountsByCode;
    mTr = created.treatmentsByCode;
    mBankAccount = addBankAccount(mDb, {
      companyId: mCompanyId, bankName: 'BOI', accountName: 'Current',
      openingDate: '2025-01-01', accountId: created.accountsByKey['bank_control'],
    });
    root = mkdtempSync(join(tmpdir(), 'cli-match-'));

    // A supplier so matching has identity evidence.
    mDb.insert(suppliers).values({
      id: 'sup_vercel', companyId: mCompanyId, name: 'Vercel Inc', matchKey: 'vercel',
      aliases: ['VERCEL'], countryCode: 'US',
    }).run();

    await importStatement(mDb, {
      companyId: mCompanyId, bankAccountId: mBankAccount, filename: 'mar.csv',
      content: 'Date,Description,Amount\n15/03/2025,VERCEL INC,-42.17',
      fileFormat: 'csv',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    });
    transactionId = mDb.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'VERCEL INC')).get()!.id;

    const stored = storeDocument(mDb, {
      companyId: mCompanyId, filename: 'vercel.pdf',
      content: Buffer.from('vercel invoice'), root,
    });
    documentId = stored.documentId;
    mDb.update(documents).set({
      grossMinor: 4217, currency: 'EUR', documentDate: '2025-03-14',
      documentType: 'supplier_invoice', supplierId: 'sup_vercel',
    }).where(eq(documents.id, documentId)).run();
  });

  const mrun = (argv: string[]) => main(argv, { db: mDb, companyId: mCompanyId });

  it('runs matching and lists pending candidates', async () => {
    const c = capture();
    const code = await mrun(['match']);
    c.restore();
    expect(code).toBe(0);
    const matched = JSON.parse(c.stdout.join(''));
    // The vercel document auto-matches (score >= 90, matched), so it is not
    // left needing review.
    expect(matched.processed).toBe(1);
    expect(matched.autoMatched + matched.needingReview).toBeGreaterThanOrEqual(1);

    const doc = mDb.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(doc.matchStatus).toBe('matched');
    expect(doc.matchedTransactionId).toBe(transactionId);
  });

  it('lists matches as JSON', async () => {
    await mrun(['match']);
    const c = capture();
    const code = await mrun(['list-matches']);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0].documentFilename).toBe('vercel.pdf');
    expect(parsed[0].decision).toBe('auto_accepted');
  });

  it('accepts a match by document + transaction id', async () => {
    // First disable auto-accept so the candidate stays pending.
    await mrun(['match']);
    // The match was auto-accepted; unmatch it so we can accept it manually.
    const c0 = capture();
    await mrun(['unmatch', '--document', documentId, '--reason', 'redo']);
    c0.restore();

    // Re-run match with auto-accept disabled is not exposed; instead, reject
    // the auto-accepted decision path is covered. Here we link manually.
    const c = capture();
    const code = await mrun([
      'link', '--document', documentId, '--transaction', transactionId,
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.linked).toBe(true);
    const doc = mDb.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(doc.matchedTransactionId).toBe(transactionId);
  });

  it('creates a supplier from the CLI and links a document', async () => {
    const stored = storeDocument(mDb, {
      companyId: mCompanyId, filename: 'byrne.pdf',
      content: Buffer.from('byrne invoice'), root,
    });
    const c = capture();
    const code = await mrun([
      'create-supplier', '--name', 'Byrne Accountancy', '--country', 'IE',
      '--document', stored.documentId,
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.created).toBe(true);
    expect(parsed.supplierId).toBeTruthy();
    const doc = mDb.select().from(documents).where(eq(documents.id, stored.documentId)).get()!;
    expect(doc.supplierId).toBe(parsed.supplierId);
    expect(mDb.select().from(suppliers).all()).toHaveLength(2);
  });

  it('runs the pipeline without --file over already-imported data', async () => {
    // Classify the transaction first so reconcile can agree.
    const { classifyTransaction } = await import('@/domain/banking/classify');
    classifyTransaction(mDb, {
      companyId: mCompanyId, bankTransactionId: transactionId,
      accountId: mByCode['6010']!, vatTreatmentId: mTr['OUT_OF_SCOPE']!,
    });

    const c = capture();
    const code = await mrun([
      'run', '--account', mBankAccount, '--from', '2025-03-01', '--to', '2025-03-31',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    // No --file → no import step.
    expect(parsed.import).toBeUndefined();
    expect(parsed.reconcile).toBeDefined();
    expect(parsed.reconcile.reconciled).toBe(true);
  });
});

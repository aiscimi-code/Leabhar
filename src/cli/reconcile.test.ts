import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import { createRule } from '@/domain/rules/engine';
import { importStatement } from '@/domain/banking/import';
import { storeDocument } from '@/domain/documents/storage';
import { bankTransactions, reconciliations, documents, documentMatches, suppliers, accounts, invoices, companies } from '@/db/schema';
import { makeDate } from '@/domain/dates';
import { main } from './reconcile';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
      documentType: 'supplier_invoice', supplierId: 'sup_vercel', reviewStatus: 'confirmed',
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

describe('cli reconcile — classify, create-rule, set-fx', () => {
  let cDb: AppDatabase;
  let cCompanyId: string;
  let cBankAccount: string;
  let cByCode: Record<string, string>;
  let cTr: Record<string, string>;
  let cTxId: string;
  let cFxTxId: string;

  beforeEach(async () => {
    ({ db: cDb } = createTestDatabase());
    const created = createCompany(cDb, {
      legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025],
    });
    cCompanyId = created.companyId;
    cByCode = created.accountsByCode;
    cTr = created.treatmentsByCode;
    cBankAccount = addBankAccount(cDb, {
      companyId: cCompanyId, bankName: 'BOI', accountName: 'Current',
      openingDate: '2025-01-01', accountId: created.accountsByKey['bank_control'],
    });

    // A domestic transaction and a foreign one with no base amount.
    await importStatement(cDb, {
      companyId: cCompanyId, bankAccountId: cBankAccount, filename: 'mixed.csv',
      content: [
        'Date,Description,Amount,Balance,Currency',
        '15/01/2025,IRISH SUPPLIER,-100.00,-100.00,EUR',
        '20/01/2025,USD SUPPLIER,-50.00,-150.00,USD',
      ].join('\n'),
      fileFormat: 'csv',
      columnMap: {
        Date: 'transaction_date', Description: 'description',
        Amount: 'amount', Balance: 'balance', Currency: 'currency',
      },
    });
    const txs = cDb.select().from(bankTransactions).all();
    cTxId = txs.find((t) => t.description === 'IRISH SUPPLIER')!.id;
    cFxTxId = txs.find((t) => t.description === 'USD SUPPLIER')!.id;
  });

  const crun = (argv: string[]) => main(argv, { db: cDb, companyId: cCompanyId });

  it('lists chart of accounts', async () => {
    const c = capture();
    const code = await crun(['list-chart']);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.find((a: { code: string }) => a.code === '6010')).toBeTruthy();
  });

  it('lists VAT treatments', async () => {
    const c = capture();
    const code = await crun(['list-vat-treatments']);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.find((t: { code: string }) => t.code === 'OUT_OF_SCOPE')).toBeTruthy();
  });

  it('manually classifies a domestic transaction by account code', async () => {
    const c = capture();
    const code = await crun([
      'classify', '--transaction', cTxId,
      '--account', '6010', '--vat-treatment', 'OUT_OF_SCOPE',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.posted).toBe(true);
    expect(parsed.journalEntryId).toBeTruthy();

    const tx = cDb.select().from(bankTransactions).where(eq(bankTransactions.id, cTxId)).get()!;
    expect(tx.status).toBe('posted');
    expect(tx.source).toBe('user');
    expect(tx.provenanceStatus).toBe('manually_entered');
  });

  it('classifies a foreign transaction with --fx-rate', async () => {
    const c = capture();
    const code = await crun([
      'classify', '--transaction', cFxTxId,
      '--account', '6010', '--vat-treatment', 'OUT_OF_SCOPE',
      '--fx-rate', '113/100',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.posted).toBe(true);

    const tx = cDb.select().from(bankTransactions).where(eq(bankTransactions.id, cFxTxId)).get()!;
    expect(tx.status).toBe('posted');
    expect(tx.baseAmountMinor).not.toBeNull();
    // -5000 USD * 113/100 = -5650 EUR
    expect(tx.baseAmountMinor).toBe(-5650);
  });

  it('refuses to classify a foreign transaction without --fx-rate', async () => {
    const c = capture();
    const code = await crun([
      'classify', '--transaction', cFxTxId,
      '--account', '6010', '--vat-treatment', 'OUT_OF_SCOPE',
    ]);
    c.restore();
    expect(code).toBe(1);
    expect(c.stderr.join('')).toContain('exchange rate');
  });

  it('creates a rule with autoApply from JSON', async () => {
    const conditions = JSON.stringify([
      { field: 'description', operator: 'contains', value: 'IRISH' },
    ]);
    const actions = JSON.stringify([
      { field: 'accountId', value: '6010' },
      { field: 'vatTreatmentId', value: 'OUT_OF_SCOPE' },
    ]);
    const c = capture();
    const code = await crun([
      'create-rule', '--name', 'Irish supplier rule',
      '--conditions', conditions, '--actions', actions,
      '--auto-apply',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.created).toBe(true);
    expect(parsed.ruleId).toBeTruthy();

    // Verify the rule resolved account/treatment codes to IDs.
    const { rules } = await import('@/db/schema');
    const rule = cDb.select().from(rules).where(eq(rules.id, parsed.ruleId)).get()!;
    expect(rule.autoApply).toBe(true);
    expect(rule.conditions).toHaveLength(1);
    const ruleActions = rule.actions as Array<{ field: string; value: string }>;
    expect(ruleActions.find((a) => a.field === 'accountId')!.value).toBe(cByCode['6010']);
    expect(ruleActions.find((a) => a.field === 'vatTreatmentId')!.value).toBe(cTr['OUT_OF_SCOPE']);
  });

  it('sets FX on a foreign transaction via --base-amount', async () => {
    const c = capture();
    const code = await crun([
      'set-fx', '--transaction', cFxTxId, '--base-amount', '-56.50',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.baseAmountMinor).toBe(-5650);
    expect(parsed.fxRateSource).toBe('bank_statement');

    const tx = cDb.select().from(bankTransactions).where(eq(bankTransactions.id, cFxTxId)).get()!;
    expect(tx.baseAmountMinor).toBe(-5650);
    expect(tx.fxRateSource).toBe('bank_statement');
    // The imported evidence is untouched.
    expect(tx.amountMinor).toBe(-5000);
    expect(tx.currency).toBe('USD');
  });

  it('sets FX on a foreign transaction via --fx-rate', async () => {
    const c = capture();
    const code = await crun([
      'set-fx', '--transaction', cFxTxId, '--fx-rate', '110/100',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.baseAmountMinor).toBe(-5500);

    const tx = cDb.select().from(bankTransactions).where(eq(bankTransactions.id, cFxTxId)).get()!;
    expect(tx.baseAmountMinor).toBe(-5500);
    expect(tx.fxRateNumerator).toBe(110);
    expect(tx.fxRateDenominator).toBe(100);
  });

  it('refuses set-fx on a base-currency transaction', async () => {
    const c = capture();
    const code = await crun([
      'set-fx', '--transaction', cTxId, '--fx-rate', '100/100',
    ]);
    c.restore();
    expect(code).toBe(1);
    expect(c.stderr.join('')).toContain('already in the base currency');
  });

  it('after set-fx + classify, reconcile agrees on a mixed-currency account', async () => {
    // Set FX on the USD line, then classify it so it posts to the ledger.
    await crun(['set-fx', '--transaction', cFxTxId, '--base-amount', '-50.00']);
    await crun([
      'classify', '--transaction', cFxTxId,
      '--account', '6010', '--vat-treatment', 'OUT_OF_SCOPE',
    ]);
    // Classify the domestic line too.
    await crun([
      'classify', '--transaction', cTxId,
      '--account', '6010', '--vat-treatment', 'OUT_OF_SCOPE',
    ]);

    const c = capture();
    const code = await crun([
      'reconcile', '--account', cBankAccount,
      '--from', '2025-01-01', '--to', '2025-01-31',
      // The running balance mixes currencies; supply the closing balance in
      // minor units (statement-balance takes integer minor units, not decimal).
      '--statement-balance', '-15000',
    ]);
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.counts.unposted).toBe(0);
    expect(parsed.unexplainedMinor).toBe(0);
    expect(parsed.reconciled).toBe(true);
  });
});

// Issue #153: an agent can load a non-demo company end-to-end from the CLI
// alone — induction (company, bank with a posted opening balance, an extra
// chart account, a customer) through books (invoices from CSV, payments,
// a manual journal) to inspection (transactions, an invoice, year-end, VAT).
describe('cli reconcile — induction and books (issue #153)', () => {
  it('init-company creates a company with no company existing yet', async () => {
    const { db: freshDb } = createTestDatabase();
    const c = capture();
    const code = await main([
      'init-company', '--name', 'Wild Atlantic Woodcraft Ltd',
      '--vat-basis', 'invoice', '--vat-frequency', 'bi_monthly',
      '--year-end', '12-31', '--seed-years', '2025',
    ], { db: freshDb });
    c.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout.join(''));
    expect(parsed.companyId).toBeTruthy();
    expect(parsed.accountsByKey.bank_control).toBeTruthy();
    expect(parsed.treatmentsByCode.IE_STD).toBeTruthy();
  });

  describe('a freshly induced company', () => {
    let iDb: AppDatabase;
    let iCompanyId: string;
    let iRun: (argv: string[]) => Promise<number>;
    let iCapture: () => ReturnType<typeof capture>;

    beforeEach(async () => {
      ({ db: iDb } = createTestDatabase());
      iRun = (argv) => main(argv, { db: iDb, companyId: iCompanyId });
      iCapture = capture;

      let c = iCapture();
      await main([
        'init-company', '--name', 'Wild Atlantic Woodcraft Ltd',
        '--vat-basis', 'invoice', '--seed-years', '2025',
      ], { db: iDb });
      iCompanyId = JSON.parse(c.stdout.join('')).companyId;
      c.restore();
    });

    it('add-bank --opening posts the balance and reconcile agrees exactly', async () => {
      let c = iCapture();
      await iRun([
        'add-bank', '--name', 'AIB Current', '--opening', '14250.00',
        '--opening-date', '2025-01-01',
      ]);
      const bank = JSON.parse(c.stdout.join(''));
      c.restore();
      expect(bank.openingBalancePosted).toBe(true);

      c = iCapture();
      const code = await iRun([
        'reconcile', '--account', bank.bankAccountId,
        '--from', '2025-01-01', '--to', '2025-01-31',
        '--statement-balance', '1425000',
      ]);
      c.restore();
      expect(code).toBe(0);
      const reconciled = JSON.parse(c.stdout.join(''));
      expect(reconciled.items).toEqual([]);
      expect(reconciled.unexplainedMinor).toBe(0);
      expect(reconciled.reconciled).toBe(true);
    });

    it('add-bank without --opening posts nothing', async () => {
      const c = iCapture();
      await iRun(['add-bank', '--name', 'Savings', '--opening-date', '2025-01-01']);
      c.restore();
      const bank = JSON.parse(c.stdout.join(''));
      expect(bank.openingBalancePosted).toBe(false);
    });

    it('add-account adds a chart account with a defaulted report section', async () => {
      const c = iCapture();
      const code = await iRun(['add-account', '--code', '7000', '--name', 'Freight and carriage', '--type', 'expense']);
      c.restore();
      expect(code).toBe(0);
      const parsed = JSON.parse(c.stdout.join(''));
      expect(parsed.accountId).toBeTruthy();

      const chart = iCapture();
      await iRun(['list-chart']);
      chart.restore();
      const accounts = JSON.parse(chart.stdout.join(''));
      expect(accounts.some((a: { code: string }) => a.code === '7000')).toBe(true);
    });

    // Issue #159: wages, materials, a term loan, rent, a second bank
    // account — no longer need add-account first, unlike 7000 above.
    it('the default chart already has 6180/6190/5030/2210/1020 without add-account', async () => {
      const c = iCapture();
      await iRun(['list-chart']);
      c.restore();
      const accounts: Array<{ code: string; name: string }> = JSON.parse(c.stdout.join(''));
      const byCode = new Map(accounts.map((a) => [a.code, a.name]));
      expect(byCode.get('6180')).toBe('Wages and salaries');
      expect(byCode.get('6190')).toBe('Employer PRSI');
      expect(byCode.get('5030')).toBe('Materials');
      expect(byCode.get('2210')).toBe('Bank loans');
      expect(byCode.get('1020')).toBe('Bank deposit / saver account');
      // 6160 stays reserved for actual directors' remuneration, not payroll.
      expect(byCode.get('6160')).toBe('Directors remuneration');
    });

    it('ensure-default-accounts adds back a code missing from a company induced earlier', async () => {
      // Simulate a company created before 6180 existed in DEFAULT_ACCOUNTS.
      const row = iDb.select().from(accounts)
        .where(and(eq(accounts.companyId, iCompanyId), eq(accounts.code, '6180'))).get()!;
      iDb.delete(accounts).where(eq(accounts.id, row.id)).run();

      const c = iCapture();
      const code = await iRun(['ensure-default-accounts']);
      c.restore();
      expect(code).toBe(0);
      expect(JSON.parse(c.stdout.join(''))).toEqual({ added: ['6180'], addedRates: [], addedTreatments: [] });
    });

    it('install-rule-pack posts a salary and a rent line to the right accounts via auto-classify', async () => {
      let c = iCapture();
      await iRun(['add-bank', '--name', 'AIB Current', '--opening-date', '2025-01-01']);
      const bankAccountId = JSON.parse(c.stdout.join('')).bankAccountId;
      c.restore();

      c = iCapture();
      const packCode = await iRun(['install-rule-pack', '--employee', 'Finn O\'Reilly']);
      c.restore();
      expect(packCode).toBe(0);
      const rules: Array<{ name: string }> = JSON.parse(c.stdout.join(''));
      expect(rules.map((r) => r.name)).toContain('Salary payment — Finn O\'Reilly');

      const root = mkdtempSync(join(tmpdir(), 'rule-pack-'));
      const csv = join(root, 'wages.csv');
      writeFileSync(csv, [
        'Date,Description,Amount',
        '28/03/2025,SALARY - FINN OREILLY,-2200.00',
        '01/04/2025,RENT STANDING ORDER,-1500.00',
      ].join('\n'));
      await iRun(['import', '--account', bankAccountId, '--file', csv]);
      await iRun(['auto-classify', '--account', bankAccountId]);

      c = iCapture();
      await iRun(['list-transactions']);
      c.restore();
      const posted: Array<{ description: string; status: string }> = JSON.parse(c.stdout.join(''));
      expect(posted.every((t) => t.status === 'posted')).toBe(true);

      const wagesAccount = iDb.select().from(accounts)
        .where(and(eq(accounts.companyId, iCompanyId), eq(accounts.code, '6180'))).get()!;
      const rentAccount = iDb.select().from(accounts)
        .where(and(eq(accounts.companyId, iCompanyId), eq(accounts.code, '6200'))).get()!;
      const posted6180 = iDb.select().from(bankTransactions)
        .where(and(
          eq(bankTransactions.companyId, iCompanyId), eq(bankTransactions.accountId, wagesAccount.id),
        )).all();
      const posted6200 = iDb.select().from(bankTransactions)
        .where(and(
          eq(bankTransactions.companyId, iCompanyId), eq(bankTransactions.accountId, rentAccount.id),
        )).all();
      expect(posted6180).toHaveLength(1);
      expect(posted6180[0]!.description).toBe('SALARY - FINN OREILLY');
      expect(posted6200).toHaveLength(1);
      expect(posted6200[0]!.description).toBe('RENT STANDING ORDER');
    });

    // Issue #160: create-invoice --file posts the invoice alone; import-invoices
    // also creates matchable evidence, so a bank line referencing the invoice
    // number in its narrative can actually be found by match().
    it('import-invoices creates both the invoice and a document match() can find', async () => {
      let c = iCapture();
      await iRun(['add-bank', '--name', 'AIB Current', '--opening-date', '2025-01-01']);
      const bankAccountId = JSON.parse(c.stdout.join('')).bankAccountId;
      c.restore();

      await iRun(['add-account', '--code', '4020', '--name', 'Consulting income', '--type', 'income']);

      const root = mkdtempSync(join(tmpdir(), 'import-invoices-'));
      const salesCsv = join(root, 'sales.csv');
      writeFileSync(salesCsv, [
        'invoiceNumber,date,party,net,vat,gross,due',
        'INV-2025-010,2025-02-20,Mulligan Digital Limited,100.00,23.00,123.00,2025-03-22',
      ].join('\n'));

      c = iCapture();
      const code = await iRun([
        'import-invoices', '--direction', 'sales', '--file', salesCsv,
        '--account', '4020', '--vat-treatment', 'IE_STD',
      ]);
      c.restore();
      expect(code).toBe(0);
      const parsed = JSON.parse(c.stdout.join(''));
      expect(parsed.created).toBe(1);
      expect(parsed.failed).toBe(0);
      expect(parsed.results[0].documentId).toBeTruthy();

      const doc = iDb.select().from(documents)
        .where(eq(documents.id, parsed.results[0].documentId)).get()!;
      expect(doc.invoiceNumber).toBe('INV-2025-010');
      expect(doc.grossMinor).toBe(12_300);
      expect(doc.currency).toBe('EUR');
      expect(doc.customerId).toBeTruthy();
      expect(doc.invoiceId).toBe(parsed.results[0].invoiceId);

      const invoiceRow = iDb.select().from(invoices)
        .where(eq(invoices.id, parsed.results[0].invoiceId)).get()!;
      expect(invoiceRow.documentId).toBe(doc.id);

      // A bank line referencing the invoice number, close in amount and date.
      const bankCsv = join(root, 'bank.csv');
      writeFileSync(bankCsv, [
        'Date,Description,Amount',
        '01/03/2025,PAYMENT REF INV-2025-010,123.00',
      ].join('\n'));
      await iRun(['import', '--account', bankAccountId, '--file', bankCsv]);

      c = iCapture();
      const matchCode = await iRun(['match']);
      c.restore();
      expect(matchCode).toBe(0);
      const matchResult = JSON.parse(c.stdout.join(''));
      expect(matchResult.autoMatched + matchResult.needingReview).toBeGreaterThanOrEqual(1);

      const afterMatch = iDb.select().from(documents).where(eq(documents.id, doc.id)).get()!;
      expect(afterMatch.matchedTransactionId).toBeTruthy();
    });

    it('import-invoices treats a CN- number as a credit note with positive line amounts', async () => {
      let c = iCapture();
      await iRun(['add-bank', '--name', 'AIB Current', '--opening-date', '2025-01-01']);
      c.restore();
      await iRun(['add-account', '--code', '4020', '--name', 'Consulting income', '--type', 'income']);

      const root = mkdtempSync(join(tmpdir(), 'import-invoices-cn-'));
      const csv = join(root, 'credit.csv');
      writeFileSync(csv, [
        'invoiceNumber,date,party,net,vat,gross',
        'CN-0001,2025-05-06,Mulligan Digital Limited,280.00,64.40,344.40',
      ].join('\n'));

      c = iCapture();
      const code = await iRun([
        'import-invoices', '--direction', 'sales', '--file', csv,
        '--account', '4020', '--vat-treatment', 'IE_STD',
      ]);
      c.restore();
      expect(code).toBe(0);
      const parsed = JSON.parse(c.stdout.join(''));
      expect(parsed.created).toBe(1);
      expect(parsed.results[0].warning).toBeUndefined();

      const invoiceRow = iDb.select().from(invoices)
        .where(eq(invoices.id, parsed.results[0].invoiceId)).get()!;
      expect(invoiceRow.isCreditNote).toBe(true);
      expect(invoiceRow.grossMinor).toBe(-34_440);
    });

    it('add-account refuses a report section neither report reads', async () => {
      const c = iCapture();
      const code = await iRun([
        'add-account', '--code', '9999', '--name', 'Nonsense', '--type', 'liability',
        '--report-section', 'not_a_real_section',
      ]);
      c.restore();
      expect(code).toBe(1);
      expect(c.stderr.join('')).toContain('not a report section');
    });

    it('add-customer creates a customer usable by name in create-invoice', async () => {
      const c = iCapture();
      const code = await iRun(['add-customer', '--name', 'Mulligan Digital Limited', '--country', 'IE']);
      c.restore();
      expect(code).toBe(0);
      expect(JSON.parse(c.stdout.join('')).customerId).toBeTruthy();
    });

    describe('with a customer and a supplier on file', () => {
      let root: string;

      beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'induction-'));
        await iRun(['add-customer', '--name', 'Mulligan Digital Limited', '--country', 'IE']);
        await iRun(['create-supplier', '--name', 'Byrne Accountancy', '--country', 'IE']);
      });

      it('create-invoice posts every row of a CSV, sales and purchase alike', async () => {
        const salesCsv = join(root, 'sales.csv');
        writeFileSync(salesCsv, [
          'invoiceNumber,date,party,description,net,account,vatTreatment',
          'INV-2025-001,2025-02-20,Mulligan Digital Limited,Consulting,1000.00,4020,IE_STD',
        ].join('\n'));

        let c = iCapture();
        let code = await iRun(['create-invoice', '--direction', 'sales', '--file', salesCsv]);
        c.restore();
        expect(code).toBe(0);
        let parsed = JSON.parse(c.stdout.join(''));
        expect(parsed.created).toBe(1);
        expect(parsed.failed).toBe(0);

        const purchaseCsv = join(root, 'purchase.csv');
        writeFileSync(purchaseCsv, [
          'invoiceNumber,date,party,description,net,account,vatTreatment',
          'BAS-0044,2025-02-20,Byrne Accountancy,Accountancy,500.00,6070,IE_STD',
        ].join('\n'));

        c = iCapture();
        code = await iRun(['create-invoice', '--direction', 'purchase', '--file', purchaseCsv]);
        c.restore();
        expect(code).toBe(0);
        parsed = JSON.parse(c.stdout.join(''));
        expect(parsed.created).toBe(1);
        expect(parsed.failed).toBe(0);
      });

      it('create-invoice reports a row-level error without aborting the rest of the file', async () => {
        const csv = join(root, 'mixed.csv');
        writeFileSync(csv, [
          'invoiceNumber,date,party,description,net,account,vatTreatment',
          'INV-BAD,2025-02-20,Nobody At All,Consulting,1000.00,4020,IE_STD',
          'INV-GOOD,2025-02-21,Mulligan Digital Limited,Consulting,500.00,4020,IE_STD',
        ].join('\n'));

        const c = iCapture();
        const code = await iRun(['create-invoice', '--direction', 'sales', '--file', csv]);
        c.restore();
        expect(code).toBe(0);
        const parsed = JSON.parse(c.stdout.join(''));
        expect(parsed.created).toBe(1);
        expect(parsed.failed).toBe(1);
        expect(parsed.results[0].error).toMatch(/Nobody At All/);
        expect(parsed.results[1].invoiceId).toBeTruthy();
      });

      describe('with a sales invoice posted', () => {
        beforeEach(async () => {
          const csv = join(root, 'sales.csv');
          writeFileSync(csv, [
            'invoiceNumber,date,party,description,net,account,vatTreatment',
            'INV-2025-001,2025-02-20,Mulligan Digital Limited,Consulting,1000.00,4020,IE_STD',
          ].join('\n'));
          await iRun(['create-invoice', '--direction', 'sales', '--file', csv]);
        });

        it('show-invoice returns the invoice, its line and its account/treatment', async () => {
          const c = iCapture();
          const code = await iRun(['show-invoice', 'INV-2025-001']);
          c.restore();
          expect(code).toBe(0);
          const parsed = JSON.parse(c.stdout.join(''));
          expect(parsed.invoice.grossMinor).toBe(123_000);
          expect(parsed.party.name).toBe('Mulligan Digital Limited');
          expect(parsed.lines[0]).toMatchObject({ accountCode: '4020', treatmentCode: 'IE_STD' });
        });

        it('record-payment pays an invoice in full with no --amount (the exact case)', async () => {
          const c = iCapture();
          const code = await iRun(['record-payment', '--invoices', 'INV-2025-001', '--date', '2025-03-01']);
          c.restore();
          expect(code).toBe(0);
          const parsed = JSON.parse(c.stdout.join(''));
          expect(parsed.allocatedMinor).toBe(123_000);
          expect(parsed.unallocatedMinor).toBe(0);
          expect(parsed.invoiceStatuses[0]).toMatchObject({ status: 'paid', outstandingMinor: 0 });
        });

        it('record-payment --unallocated leaves the payment on account on purpose', async () => {
          const c = iCapture();
          const code = await iRun([
            'record-payment', '--amount', '50.00', '--date', '2025-03-01',
            '--unallocated', '--direction', 'received',
          ]);
          c.restore();
          expect(code).toBe(0);
          const parsed = JSON.parse(c.stdout.join(''));
          expect(parsed.allocatedMinor).toBe(0);
          expect(parsed.unallocatedMinor).toBe(5_000);
        });

        it('record-payment allocates a part-payment below the outstanding balance', async () => {
          const c = iCapture();
          await iRun(['record-payment', '--invoices', 'INV-2025-001', '--amount', '100.00', '--date', '2025-03-01']);
          c.restore();

          const show = iCapture();
          await iRun(['show-invoice', 'INV-2025-001']);
          show.restore();
          const invoice = JSON.parse(show.stdout.join('')).invoice;
          expect(invoice.outstandingMinor).toBe(123_000 - 10_000);
          expect(invoice.status).not.toBe('paid');
        });

        // Issue #157: a sales credit note's cash flow runs the opposite way
        // from its own direction — record-payment must infer 'made' for it,
        // not 'received', even when the direction is inferred from --invoices
        // rather than given explicitly.
        it('record-payment refunds a sales credit note with an inferred direction', async () => {
          const csv = join(root, 'credit-note.csv');
          writeFileSync(csv, [
            'invoiceNumber,date,party,description,net,account,vatTreatment,creditNote',
            'CN-0001,2025-05-06,Mulligan Digital Limited,Damaged table,280.00,4020,IE_STD,true',
          ].join('\n'));
          await iRun(['create-invoice', '--direction', 'sales', '--file', csv]);

          const c = iCapture();
          const code = await iRun(['record-payment', '--invoices', 'CN-0001', '--date', '2025-05-06']);
          c.restore();
          expect(code).toBe(0);
          const parsed = JSON.parse(c.stdout.join(''));
          expect(parsed.invoiceStatuses[0]).toMatchObject({ status: 'paid', outstandingMinor: 0 });

          const show = iCapture();
          await iRun(['show-invoice', 'CN-0001']);
          show.restore();
          expect(JSON.parse(show.stdout.join('')).invoice.outstandingMinor).toBe(0);
        });

        it('journal posts a balanced multi-line manual adjustment', async () => {
          const c = iCapture();
          const code = await iRun([
            'journal', '--date', '2025-03-15', '--narrative', 'Stripe payout Mar 15',
            '--lines', JSON.stringify([
              { account: '1010', debit: '98.50' },
              { account: '6100', debit: '1.50' },
              { account: '4020', credit: '100.00' },
            ]),
          ]);
          c.restore();
          expect(code).toBe(0);
          const parsed = JSON.parse(c.stdout.join(''));
          expect(parsed.journalEntryId).toBeTruthy();
          expect(parsed.totalMinor).toBe(10_000);
        });

        it('journal refuses an unbalanced set of lines', async () => {
          const c = iCapture();
          const code = await iRun([
            'journal', '--date', '2025-03-15', '--narrative', 'Bad entry',
            '--lines', JSON.stringify([
              { account: '1010', debit: '10.00' },
              { account: '4020', credit: '5.00' },
            ]),
          ]);
          c.restore();
          expect(code).toBe(1);
          expect(c.stderr.join('')).toContain('does not balance');
        });

        it('year-end reflects the posted invoice in revenue', async () => {
          const c = iCapture();
          const code = await iRun(['year-end', '--from', '2025-01-01', '--to', '2025-12-31']);
          c.restore();
          expect(code).toBe(0);
          const parsed = JSON.parse(c.stdout.join(''));
          expect(parsed.profitAndLoss.revenue.valueMinor).toBe(100_000);
        });

        it('vat-return by period name reports the invoice\'s output VAT', async () => {
          const c = iCapture();
          const code = await iRun(['vat-return', '--period', 'Jan–Feb 2025']);
          c.restore();
          expect(code).toBe(0);
          const parsed = JSON.parse(c.stdout.join(''));
          expect(parsed.T1.amountMinor).toBe(23_000);
        });

        it('list-transactions --unposted excludes the invoice (it has no bank transaction)', async () => {
          const c = iCapture();
          const code = await iRun(['list-transactions', '--unposted']);
          c.restore();
          expect(code).toBe(0);
          expect(JSON.parse(c.stdout.join(''))).toEqual([]);
        });

        // Issue #158: today a caller must post then UPDATE the bank_transactions
        // row itself to link it — journal --transaction does both in one call.
        it('journal --transaction posts a split for one statement line and links it', async () => {
          let c = iCapture();
          await iRun(['add-bank', '--name', 'AIB Current', '--opening-date', '2025-01-01']);
          const bankAccountId = JSON.parse(c.stdout.join('')).bankAccountId;
          c.restore();

          const stripeCsv = join(root, 'stripe.csv');
          writeFileSync(stripeCsv, [
            'Date,Description,Amount,Notes',
            '15/03/2025,STRIPE PAYOUT,2107.34,gross card sales 2146.28 less processing fees 38.94',
          ].join('\n'));
          await iRun(['import', '--account', bankAccountId, '--file', stripeCsv]);

          c = iCapture();
          await iRun(['list-transactions']);
          const [tx] = JSON.parse(c.stdout.join(''));
          c.restore();
          expect(tx.description).toBe('STRIPE PAYOUT');

          c = iCapture();
          const code = await iRun([
            'journal', '--transaction', tx.id,
            '--lines', JSON.stringify([
              { account: '1010', debit: '2107.34', memo: 'Stripe net payout' },
              { account: '6100', debit: '38.94', memo: 'Stripe processing fees' },
              { account: '4020', credit: '2146.28', memo: 'Card sales' },
            ]),
          ]);
          c.restore();
          expect(code).toBe(0);
          const parsed = JSON.parse(c.stdout.join(''));
          expect(parsed.journalEntryId).toBeTruthy();
          expect(parsed.bankTransactionId).toBe(tx.id);

          const posted = iCapture();
          await iRun(['list-transactions', '--unposted']);
          posted.restore();
          expect(JSON.parse(posted.stdout.join(''))).toEqual([]);
        });
      });
    });
  });
});

// Issue #155: the anomaly-detection/review-queue layer, void-invoice /
// reverse-journal corrections, and list-suppliers/list-customers — each a
// thin CLI wrapper around an existing, already-tested domain layer.
describe('cli reconcile — review queue and corrections (issue #155)', () => {
  let rDb: AppDatabase;
  let rCompanyId: string;
  let rBankAccount: string;
  let rByCode: Record<string, string>;
  let rTr: Record<string, string>;
  let rRun: (argv: string[]) => Promise<number>;

  beforeEach(async () => {
    ({ db: rDb } = createTestDatabase());
    const created = createCompany(rDb, {
      legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice',
      seedYears: [2025],
    });
    rCompanyId = created.companyId;
    rByCode = created.accountsByCode;
    rTr = created.treatmentsByCode;
    rBankAccount = addBankAccount(rDb, {
      companyId: rCompanyId, bankName: 'BOI', accountName: 'Current',
      openingDate: '2025-01-01', accountId: created.accountsByKey['bank_control'],
    });
    rRun = (argv) => main(argv, { db: rDb, companyId: rCompanyId });
  });

  it('list-suppliers and list-customers return what was created, and nothing before that', async () => {
    let c = capture();
    let code = await rRun(['list-suppliers']);
    c.restore();
    expect(code).toBe(0);
    expect(JSON.parse(c.stdout.join(''))).toEqual([]);

    await rRun(['create-supplier', '--name', 'Byrne Accountancy', '--country', 'IE']);
    await rRun(['add-customer', '--name', 'Mulligan Digital Limited', '--country', 'IE']);

    c = capture();
    code = await rRun(['list-suppliers']);
    c.restore();
    expect(code).toBe(0);
    const suppliersOut = JSON.parse(c.stdout.join(''));
    expect(suppliersOut).toHaveLength(1);
    expect(suppliersOut[0]).toMatchObject({ name: 'Byrne Accountancy', countryCode: 'IE' });

    c = capture();
    code = await rRun(['list-customers']);
    c.restore();
    expect(code).toBe(0);
    const customersOut = JSON.parse(c.stdout.join(''));
    expect(customersOut).toHaveLength(1);
    expect(customersOut[0]).toMatchObject({ name: 'Mulligan Digital Limited', countryCode: 'IE' });
  });

  describe('with an invoice, and a journal entry, already posted', () => {
    let invoiceId: string;
    let journalEntryId: string;

    beforeEach(async () => {
      const { createInvoice } = await import('@/domain/invoicing/invoices');
      const { ids } = await import('@/lib/ids');
      const customerId = ids.customer();
      const { customers } = await import('@/db/schema');
      rDb.insert(customers).values({
        id: customerId, companyId: rCompanyId, name: 'Mulligan Digital', matchKey: 'mulligan digital',
      }).run();

      const invoice = createInvoice(rDb, {
        companyId: rCompanyId, direction: 'sales', invoiceDate: makeDate(2025, 2, 20), customerId,
        invoiceNumber: 'INV-2025-001',
        lines: [{
          description: 'Consulting', netMinor: 100_000,
          accountId: rByCode['4020']!, vatTreatmentId: rTr['IE_STD']!,
        }],
      });
      invoiceId = invoice.invoiceId;
      journalEntryId = invoice.journalEntryId;
    });

    it('void-invoice reverses the journal entry and marks the invoice void', async () => {
      const c = capture();
      const code = await rRun(['void-invoice', 'INV-2025-001', '--date', '2025-03-01', '--reason', 'entered in error']);
      c.restore();
      expect(code).toBe(0);
      const parsed = JSON.parse(c.stdout.join(''));
      expect(parsed.reversalJournalEntryId).toBeTruthy();
      expect(parsed.reversedVatEntryIds).toHaveLength(1);

      const show = capture();
      await rRun(['show-invoice', 'INV-2025-001']);
      show.restore();
      const invoice = JSON.parse(show.stdout.join('')).invoice;
      expect(invoice.status).toBe('void');
      expect(invoice.outstandingMinor).toBe(0);
    });

    it('void-invoice refuses an invoice that is already void', async () => {
      await rRun(['void-invoice', 'INV-2025-001', '--date', '2025-03-01', '--reason', 'first']);
      const c = capture();
      const code = await rRun(['void-invoice', 'INV-2025-001', '--date', '2025-03-02', '--reason', 'second']);
      c.restore();
      expect(code).toBe(1);
      expect(c.stderr.join('')).toContain('already void');
    });

    it('reverse-journal reverses any entry, netting its accounts to zero', async () => {
      const c = capture();
      const code = await rRun(['reverse-journal', journalEntryId, '--date', '2025-03-01', '--reason', 'wrong account']);
      c.restore();
      expect(code).toBe(0);
      const parsed = JSON.parse(c.stdout.join(''));
      expect(parsed.id).toBeTruthy();
      expect(parsed.lines).toHaveLength(3);
    });

    it('reverse-journal refuses to reverse the same entry twice', async () => {
      await rRun(['reverse-journal', journalEntryId, '--date', '2025-03-01', '--reason', 'first']);
      const c = capture();
      const code = await rRun(['reverse-journal', journalEntryId, '--date', '2025-03-02', '--reason', 'second']);
      c.restore();
      expect(code).toBe(1);
      expect(c.stderr.join('')).toContain('already been reversed');
    });

    it('scan-anomalies reports the long-overdue invoice without --sync writing anything', async () => {
      let c = capture();
      let code = await rRun(['scan-anomalies']);
      c.restore();
      expect(code).toBe(0);
      const scan = JSON.parse(c.stdout.join(''));
      expect(scan.anomalies.some((a: { code: string }) => a.code === 'long_overdue_invoice')).toBe(true);
      expect(scan.syncedToReviewQueue).toBeNull();

      c = capture();
      code = await rRun(['list-review-queue']);
      c.restore();
      expect(code).toBe(0);
      expect(JSON.parse(c.stdout.join(''))).toEqual([]);
    });

    it('scan-anomalies --sync writes findings into the review queue', async () => {
      let c = capture();
      const code = await rRun(['scan-anomalies', '--sync']);
      c.restore();
      expect(code).toBe(0);
      const scan = JSON.parse(c.stdout.join(''));
      expect(scan.syncedToReviewQueue).toBeGreaterThan(0);

      c = capture();
      await rRun(['list-review-queue']);
      c.restore();
      const queue = JSON.parse(c.stdout.join(''));
      expect(queue.length).toBe(scan.syncedToReviewQueue);
      expect(queue[0].status).toBe('open');
    });

    it('list-review-queue filters by severity', async () => {
      await rRun(['scan-anomalies', '--sync']);
      const c = capture();
      const code = await rRun(['list-review-queue', '--severity', 'info']);
      c.restore();
      expect(code).toBe(0);
      const queue = JSON.parse(c.stdout.join(''));
      expect(queue.length).toBeGreaterThan(0);
      expect(queue.every((item: { severity: string }) => item.severity === 'info')).toBe(true);
    });
  });
});

// Issue #222: the invoice-led workflow from the terminal — confirm (by a named
// person), see the line choices, post, settle and trace — through the same
// domain functions as the web screens.
describe('cli reconcile — confirm, post, settle, trace (issue #222)', () => {
  let root: string;
  let documentId: string;
  let transactionId: string;

  const VALUES = {
    documentType: 'supplier_invoice', invoiceNumber: 'BAS-2025-0044', documentDate: '2025-01-20',
    dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: 'Byrne Accountancy Services Limited', supplierAddress: '14 Fitzwilliam Square, Dublin 2',
    supplierVatNumber: 'IE9876543W', supplierCountry: 'IE',
    customerNameStated: 'Acme Ltd', customerAddress: null, customerVatNumber: null, customerCountry: 'IE',
    vatLegends: [], paymentTerms: null, originalDocumentNumber: null,
    netMinor: 50_000, vatMinor: 11_500, grossMinor: 61_500,
    lines: [{
      description: 'Annual accounts and CT1 preparation', quantity: null, unitPriceMinor: null,
      netMinor: 50_000, vatRateBasisPoints: 2300, vatMinor: 11_500, grossMinor: 61_500,
    }],
    vatTotals: [],
  };

  const json = async (argv: string[]) => {
    const c = capture();
    const code = await run(argv);
    c.restore();
    return { code, out: c.stdout.join(''), err: c.stderr.join('') };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cli-222-'));
    await importStatement(db, {
      companyId, bankAccountId, filename: 's.csv', content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
    });
    transactionId = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'BYRNE ACCOUNTANCY')).get()!.id;
    documentId = storeDocument(db, {
      companyId, filename: 'byrne.pdf', content: Buffer.from('byrne invoice'), root,
    }).documentId;
  });

  it('refuses to confirm without the name of the person who checked it', async () => {
    const r = await json(['confirm-document', documentId, '--values', JSON.stringify(VALUES), '--create-supplier']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/confirmed-by/);
    expect(db.select().from(documents).where(eq(documents.id, documentId)).get()!.reviewStatus).toBe('unreviewed');
  });

  it('confirms, posts line by line, settles and traces', async () => {
    const shown = await json(['show-document', documentId]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({ documentId, reviewStatus: 'unreviewed', invoiceId: null });

    const confirmed = await json([
      'confirm-document', documentId, '--confirmed-by', 'Joe Reviewer',
      '--values', JSON.stringify(VALUES), '--create-supplier',
    ]);
    expect(confirmed.err).toBe('');
    expect(confirmed.code).toBe(0);
    const doc = db.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(doc).toMatchObject({ reviewStatus: 'confirmed', reviewedBy: 'Joe Reviewer', grossMinor: 61_500 });

    const choices = JSON.parse((await json(['line-choices', documentId])).out);
    expect(choices).toMatchObject({ direction: 'purchase', lines: [{ index: 0, netMinor: 50_000, vatMinor: 11_500 }] });

    // A wrong number of coding entries is refused before anything is posted.
    expect((await json(['post-document', documentId, '--coding', '[]'])).code).not.toBe(0);

    const posted = await json(['post-document', documentId, '--coding', '[{"account":"6070","treatment":"IE_STD"}]']);
    expect(posted.err).toBe('');
    expect(JSON.parse(posted.out)).toMatchObject({ netMinor: 50_000, vatMinor: 11_500, grossMinor: 61_500 });

    const settled = await json([
      'settle', transactionId, '--allocations', '[{"invoice":"BAS-2025-0044","amount":"615.00"}]',
    ]);
    expect(settled.err).toBe('');
    expect(JSON.parse(settled.out)).toMatchObject({ allocatedMinor: 61_500, unallocatedMinor: 0 });
    expect(db.select().from(invoices).where(eq(invoices.invoiceNumber, 'BAS-2025-0044')).get()!.status).toBe('paid');

    const trace = JSON.parse((await json(['trace', transactionId])).out);
    expect(trace.kind).toBe('settled');
    expect(trace.invoices[0]).toMatchObject({ invoiceNumber: 'BAS-2025-0044' });
  });

  it('asks for a choice when the sources do not agree, and for an account when none is suggested', async () => {
    // No VAT printed on the line and no VAT number: nothing settles the treatment.
    const unclear = {
      ...VALUES, supplierVatNumber: null, vatMinor: null, grossMinor: 50_000,
      lines: [{ ...VALUES.lines[0], vatRateBasisPoints: null, vatMinor: null, grossMinor: 50_000 }],
    };
    const shown = JSON.parse((await json(['show-document', documentId])).out);
    expect(shown.reviewStatus).toBe('unreviewed');
    const { checkDocumentValues } = await import('@/domain/documents/checks');
    const warnings = checkDocumentValues(unclear as never).filter((c) => c.severity !== 'error').map((c) => c.code);
    const confirmed = await json([
      'confirm-document', documentId, '--confirmed-by', 'Joe Reviewer',
      '--values', JSON.stringify(unclear), '--ack', warnings.join(','), '--create-supplier',
    ]);
    expect(confirmed.err).toBe('');

    const line = JSON.parse((await json(['line-choices', documentId])).out).lines[0];
    expect(line.suggestedTreatment).toBeNull();
    expect(line.suggestedAccount).toBeNull();

    const noTreatment = await json(['post-document', documentId, '--coding', '[{"account":"6070"}]']);
    expect(noTreatment.code).not.toBe(0);
    expect(noTreatment.err).toMatch(/choose one/);
    const noAccount = await json(['post-document', documentId, '--coding', '[{"treatment":"IE_STD"}]']);
    expect(noAccount.code).not.toBe(0);
    expect(noAccount.err).toMatch(/needs an account/);
    expect(db.select().from(invoices).all()).toHaveLength(0);
  });
});

describe('supplier and customer VAT status (issue #207)', () => {
  const json = async (argv: string[]) => {
    const io = capture();
    const code = await run([...argv, '--format', 'json']);
    io.restore();
    return { code, out: io.stdout.join(''), err: io.stderr.join('') };
  };

  it('confirm-establishment requires the name of the person, and records it', async () => {
    const id = 'sup_cli_est';
    db.insert(suppliers).values({ id, companyId, name: 'Vercel Inc', matchKey: 'vercel inc', countryCode: 'US' }).run();
    const refused = await json(['confirm-establishment', '--supplier', id, '--establishment', 'outside_state', '--basis', 'US seat']);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/confirmed-by/);
    const ok = await json([
      'confirm-establishment', '--supplier', id, '--establishment', 'outside_state',
      '--basis', 'Seat in the US; no branch in Ireland', '--confirmed-by', 'Joe Reviewer',
    ]);
    expect(ok.code).toBe(0);
    expect(db.select().from(suppliers).where(eq(suppliers.id, id)).get()).toMatchObject({
      establishment: 'outside_state', establishmentConfirmedBy: 'Joe Reviewer',
    });
  });

  it('confirm-rct-principal and record-cash-basis record the company\'s VAT status by name (#208)', async () => {
    expect((await json(['confirm-rct-principal', '--status', 'principal', '--basis', 'main contractor'])).err).toMatch(/confirmed-by/);
    expect((await json([
      'confirm-rct-principal', '--status', 'principal', '--from', '2026-01-01', '--basis', 'main contractor', '--confirmed-by', 'Joe Reviewer',
    ])).code).toBe(0);
    expect((await json([
      'record-cash-basis', '--eligibility', 'turnover_threshold', '--from', '2025-01-01', '--reference', 'ROS 991', '--confirmed-by', 'Joe Reviewer',
    ])).code).toBe(0);
    expect(db.select().from(companies).where(eq(companies.id, companyId)).get()).toMatchObject({
      rctPrincipal: 'principal', rctPrincipalFrom: '2026-01-01', cashBasisAuthorisedFrom: '2025-01-01', cashBasisConfirmedBy: 'Joe Reviewer',
    });
  });
});

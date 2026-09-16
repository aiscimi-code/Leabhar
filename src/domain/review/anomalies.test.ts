import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { scanForAnomalies, syncAnomaliesToReviewQueue } from './anomalies';
import { importStatement } from '../banking/import';
import { classifyTransaction } from '../banking/classify';
import { postJournalEntry } from '../accounting/journal';
import { createInvoice } from '../invoicing/invoices';
import {
  bankTransactions, suppliers, customers, documents, reviewItems, invoices,
} from '@/db/schema';
import { makeDate } from '../dates';
import { ids } from '@/lib/ids';
import { storeDocument } from '../documents/storage';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let supplierId: string;
let customerId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let root: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered',
    vatAccountingBasis: 'invoice', seedYears: [2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  root = mkdtempSync(join(tmpdir(), 'anom-'));

  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current',
    openingDate: '2025-01-01', accountId: acc['bank_control'],
  });
  supplierId = ids.supplier();
  db.insert(suppliers).values({
    id: supplierId, companyId, name: 'Vercel Inc', matchKey: 'vercel', countryCode: 'US',
  }).run();
  customerId = ids.customer();
  db.insert(customers).values({
    id: customerId, companyId, name: 'Mulligan Digital', matchKey: 'mulligan', countryCode: 'IE',
  }).run();
});

const addTransaction = (
  description: string, amountMinor: number, date = '2025-03-15',
  over: Partial<typeof bankTransactions.$inferInsert> = {},
): string => {
  const id = ids.bankTransaction();
  db.insert(bankTransactions).values({
    id, companyId, bankAccountId, transactionDate: date, description,
    amountMinor, currency: 'EUR', fingerprint: `fp-${id}`,
    supplierId, status: 'posted', ...over,
  }).run();
  return id;
};

describe('unusual supplier amounts', () => {
  it('flags a payment far outside the supplier’s usual range', () => {
    for (let i = 0; i < 6; i++) addTransaction('VERCEL INC', -4_217, `2025-0${i + 1}-15`);
    const outlier = addTransaction('VERCEL INC', -250_000, '2025-07-15');

    const scan = scanForAnomalies(db, { companyId });
    const found = scan.anomalies.find((a) => a.entityId === outlier);
    expect(found).toBeTruthy();
    expect(found!.code).toBe('unusual_supplier_amount');
    expect(found!.detail).toContain('times higher than normal');
    // It asks rather than asserts.
    expect(found!.suggestion).toContain('would all explain it');
  });

  // With two or three data points almost anything looks anomalous, which
  // trains the user to ignore the queue.
  it('says nothing until there is enough history to judge', () => {
    addTransaction('VERCEL INC', -4_217, '2025-01-15');
    addTransaction('VERCEL INC', -250_000, '2025-02-15');
    const scan = scanForAnomalies(db, { companyId });
    expect(scan.anomalies.filter((a) => a.code === 'unusual_supplier_amount')).toHaveLength(0);
  });

  it('ignores a large ratio on a trivial amount', () => {
    for (let i = 0; i < 6; i++) addTransaction('VERCEL INC', -200, `2025-0${i + 1}-15`);
    addTransaction('VERCEL INC', -1_000, '2025-07-15');
    const scan = scanForAnomalies(db, { companyId });
    expect(scan.anomalies.filter((a) => a.code === 'unusual_supplier_amount')).toHaveLength(0);
  });

  it('uses the median, so one outlier does not hide another', () => {
    for (let i = 0; i < 6; i++) addTransaction('VERCEL INC', -4_217, `2025-0${i + 1}-15`);
    addTransaction('VERCEL INC', -500_000, '2025-07-15');
    addTransaction('VERCEL INC', -400_000, '2025-08-15');
    const scan = scanForAnomalies(db, { companyId });
    // A mean would be dragged up by the outliers and hide the second one.
    expect(scan.anomalies.filter((a) => a.code === 'unusual_supplier_amount')).toHaveLength(2);
  });
});

describe('document and transaction disagreement', () => {
  it('flags a document whose total does not match the payment', () => {
    const transactionId = addTransaction('BYRNE ACCOUNTANCY', -61_500);
    const stored = storeDocument(db, {
      companyId, filename: 'byrne.pdf', content: Buffer.from('invoice'), root,
    });
    db.update(documents).set({
      grossMinor: 95_000, currency: 'EUR', matchedTransactionId: transactionId,
      matchStatus: 'matched',
    }).where(eq(documents.id, stored.documentId)).run();

    const scan = scanForAnomalies(db, { companyId });
    const found = scan.anomalies.find((a) => a.code === 'document_amount_mismatch')!;
    expect(found.detail).toContain('950.00');
    expect(found.detail).toContain('615.00');
    expect(found.suggestion).toContain('attached to the wrong payment');
    rmSync(root, { recursive: true, force: true });
  });

  it('suggests an exchange difference when the currencies differ', () => {
    const transactionId = addTransaction('US SUPPLIER', -92_000, '2025-03-15',
      { currency: 'EUR' });
    const stored = storeDocument(db, {
      companyId, filename: 'us.pdf', content: Buffer.from('invoice'), root,
    });
    db.update(documents).set({
      grossMinor: 100_000, currency: 'USD', matchedTransactionId: transactionId,
      matchStatus: 'matched',
    }).where(eq(documents.id, stored.documentId)).run();

    const scan = scanForAnomalies(db, { companyId });
    const found = scan.anomalies.find((a) => a.code === 'document_amount_mismatch')!;
    expect(found.suggestion).toContain('exchange difference');
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores a difference of under a euro', () => {
    const transactionId = addTransaction('SUPPLIER', -61_500);
    const stored = storeDocument(db, {
      companyId, filename: 'x.pdf', content: Buffer.from('invoice'), root,
    });
    db.update(documents).set({
      grossMinor: 61_499, currency: 'EUR', matchedTransactionId: transactionId,
    }).where(eq(documents.id, stored.documentId)).run();

    const scan = scanForAnomalies(db, { companyId });
    expect(scan.anomalies.filter((a) => a.code === 'document_amount_mismatch')).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('balance-level anomalies', () => {
  it('flags anything left in suspense', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 15), narrative: 'Unidentified receipt',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 50_000 },
        { accountId: acc['suspense']!, creditMinor: 50_000 },
      ],
    });

    const scan = scanForAnomalies(db, { companyId });
    const found = scan.anomalies.find((a) => a.code === 'suspense_balance')!;
    expect(found.detail).toContain('500.00');
    expect(found.suggestion).toContain('unresolved question, not a result');
  });

  // Flagged, never computed: whether the close-company rules bite depends on
  // facts this application does not hold.
  it('flags a director in debit without calculating any tax charge', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 15), narrative: 'Drawings',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: acc['directors_current_account']!, debitMinor: 500_000 },
        { accountId: acc['bank_control']!, creditMinor: 500_000 },
      ],
    });

    const scan = scanForAnomalies(db, { companyId });
    const found = scan.anomalies.find((a) => a.code === 'director_owes_company')!;
    expect(found.detail).toContain('5000.00');
    expect(found.suggestion).toContain('close company');
    expect(found.suggestion).toContain('does not calculate either');
  });

  it('says nothing when the director is in credit', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 15), narrative: 'Expense paid personally',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['6120']!, debitMinor: 5_000 },
        { accountId: acc['directors_current_account']!, creditMinor: 5_000 },
      ],
    });
    const scan = scanForAnomalies(db, { companyId });
    expect(scan.anomalies.filter((a) => a.code === 'director_owes_company')).toHaveLength(0);
  });
});

describe('invoice anomalies', () => {
  it('flags the same invoice number used twice for one supplier', () => {
    for (let i = 0; i < 2; i++) {
      createInvoice(db, {
        companyId, direction: 'purchase', invoiceDate: makeDate(2025, 3, 15),
        supplierId, invoiceNumber: 'INV-991',
        lines: [{
          description: 'Hosting', netMinor: 10_000,
          accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
        }],
      });
    }

    const scan = scanForAnomalies(db, { companyId });
    const found = scan.anomalies.filter((a) => a.code === 'duplicate_invoice_number');
    expect(found).toHaveLength(2);
    expect(found[0]!.suggestion).toContain('claim the cost and the VAT twice');
  });

  it('flags a long-overdue sales invoice', () => {
    createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2025, 1, 5),
      dueDate: makeDate(2025, 1, 20), customerId, invoiceNumber: 'INV-1',
      lines: [{
        description: 'Consulting', netMinor: 100_000,
        accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']!,
      }],
    });

    const scan = scanForAnomalies(db, { companyId });
    const found = scan.anomalies.find((a) => a.code === 'long_overdue_invoice')!;
    expect(found.suggestion).toContain('write it off deliberately');
    expect(found.suggestion).toContain('VAT deferred that will never fall due');
  });
});

describe('capital purchases', () => {
  it('flags a large purchase charged straight to expenses', () => {
    const transactionId = addTransaction('APPLE STORE', -246_000, '2025-03-15',
      { accountId: byCode['6130'] });

    const scan = scanForAnomalies(db, { companyId });
    const found = scan.anomalies.find((a) => a.entityId === transactionId
      && a.code === 'possible_capital_purchase')!;
    expect(found.severity).toBe('info');
    expect(found.suggestion).toContain('flags it rather than deciding');
  });

  it('says nothing about a small purchase', () => {
    addTransaction('OFFICE SUPPLIES', -5_000, '2025-03-15', { accountId: byCode['6120'] });
    const scan = scanForAnomalies(db, { companyId });
    expect(scan.anomalies.filter((a) => a.code === 'possible_capital_purchase')).toHaveLength(0);
  });
});

describe('scan output', () => {
  it('reports honestly when it finds nothing', () => {
    const scan = scanForAnomalies(db, { companyId });
    expect(scan.anomalies).toHaveLength(0);
    expect(scan.summary).toContain('not a judgement about whether the figures are right');
  });

  it('never claims a finding is an error', () => {
    for (let i = 0; i < 6; i++) addTransaction('VERCEL INC', -4_217, `2025-0${i + 1}-15`);
    addTransaction('VERCEL INC', -250_000, '2025-07-15');
    const scan = scanForAnomalies(db, { companyId });
    expect(scan.summary).toContain('None of them is necessarily wrong');
  });

  it('pushes findings into the review queue', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 15), narrative: 'Unidentified',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 50_000 },
        { accountId: acc['suspense']!, creditMinor: 50_000 },
      ],
    });

    const scan = scanForAnomalies(db, { companyId });
    const count = syncAnomaliesToReviewQueue(db, { companyId, scan });
    expect(count).toBeGreaterThan(0);

    const items = db.select().from(reviewItems)
      .where(eq(reviewItems.companyId, companyId)).all();
    expect(items.some((i) => i.title.includes('suspense'))).toBe(true);
    // The suggestion travels with it, so the queue item is actionable.
    expect(items.find((i) => i.title.includes('suspense'))!.detail)
      .toContain('unresolved question');
  });

  it('does not duplicate queue items when re-run', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 15), narrative: 'Unidentified',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 50_000 },
        { accountId: acc['suspense']!, creditMinor: 50_000 },
      ],
    });

    syncAnomaliesToReviewQueue(db, { companyId, scan: scanForAnomalies(db, { companyId }) });
    syncAnomaliesToReviewQueue(db, { companyId, scan: scanForAnomalies(db, { companyId }) });

    const items = db.select().from(reviewItems)
      .where(eq(reviewItems.companyId, companyId)).all();
    expect(items.filter((i) => i.title.includes('suspense'))).toHaveLength(1);
  });
});

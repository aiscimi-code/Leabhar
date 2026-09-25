import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from '../banking/import';
import { storeDocument } from '../documents/storage';
import { linkDocument, unmatchDocument, findMatchesForDocument } from './service';
import {
  documents, bankTransactions, documentMatches, reviewItems, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let root: string;

beforeEach(async () => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01',
  });
  root = mkdtempSync(join(tmpdir(), 'link-'));

  await importStatement(db, {
    companyId, bankAccountId, filename: 'statement.csv',
    content: [
      'Date,Description,Amount',
      '15/03/2025,VERCEL INC,-42.17',
      '20/03/2025,AWS EMEA,-210.00',
    ].join('\n'),
    fileFormat: 'csv',
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
});

const transactions = () =>
  db.select().from(bankTransactions).orderBy(bankTransactions.transactionDate).all() as
    [typeof bankTransactions.$inferSelect, typeof bankTransactions.$inferSelect, ...typeof bankTransactions.$inferSelect[]];

const addDocument = (over: Partial<typeof documents.$inferInsert> = {}) => {
  const stored = storeDocument(db, {
    companyId, filename: `doc-${Math.random()}.pdf`,
    content: Buffer.from(`invoice ${Math.random()}`), root,
  });
  db.update(documents).set({
    grossMinor: 42_17, currency: 'EUR', documentDate: '2025-03-14',
    documentType: 'supplier_invoice', reviewStatus: 'confirmed', ...over,
  }).where(eq(documents.id, stored.documentId)).run();
  return stored.documentId;
};

describe('linkDocument', () => {
  it('creates a manual match and links the document', () => {
    const documentId = addDocument();
    const [vercel] = transactions();

    linkDocument(db, { companyId, documentId, bankTransactionId: vercel.id });

    const document = db.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(document.matchStatus).toBe('matched');
    expect(document.matchedTransactionId).toBe(vercel.id);

    const match = db.select().from(documentMatches)
      .where(eq(documentMatches.documentId, documentId)).get()!;
    expect(match.decision).toBe('accepted');
    expect(match.source).toBe('user');
    expect(match.provenanceStatus).toBe('user_confirmed');
    expect(match.score).toBe(100);
  });

  it('works on a document the scorer never proposed', () => {
    // A document with a wildly different amount — the scorer would never match it.
    const documentId = addDocument({ grossMinor: 9_99_00, documentDate: '2025-03-14' });
    const [, aws] = transactions();

    findMatchesForDocument(db, { companyId, documentId });
    // The scorer found nothing.
    expect(db.select().from(documents).where(eq(documents.id, documentId)).get()!.matchStatus)
      .toBe('unmatched');

    // But the user can link it anyway.
    linkDocument(db, { companyId, documentId, bankTransactionId: aws.id });
    expect(db.select().from(documents).where(eq(documents.id, documentId)).get()!.matchStatus)
      .toBe('matched');
  });

  it('unlinks the old transaction first when re-linking to a new one', () => {
    const documentId = addDocument();
    const [vercel, aws] = transactions();

    linkDocument(db, { companyId, documentId, bankTransactionId: vercel.id });
    expect(db.select().from(documents).where(eq(documents.id, documentId)).get()!.matchedTransactionId)
      .toBe(vercel.id);

    linkDocument(db, { companyId, documentId, bankTransactionId: aws.id });

    const document = db.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(document.matchedTransactionId).toBe(aws.id);

    // The unlink of the old link is in the audit trail.
    const unmatchAudit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'document_unmatched')).all();
    expect(unmatchAudit.length).toBe(1);
    expect(unmatchAudit[0]!.previousValue).toBe(vercel.id);
  });

  it('rejects pending candidates when a manual link is made', () => {
    const documentId = addDocument({ grossMinor: 21_000, documentDate: '2025-03-19' });
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });
    // Now there are pending candidates.
    const pending = db.select().from(documentMatches)
      .where(and(
        eq(documentMatches.documentId, documentId),
        eq(documentMatches.decision, 'pending'),
      )).all();
    expect(pending.length).toBeGreaterThan(0);

    const [vercel] = transactions();
    linkDocument(db, { companyId, documentId, bankTransactionId: vercel.id });

    const stillPending = db.select().from(documentMatches)
      .where(and(
        eq(documentMatches.documentId, documentId),
        eq(documentMatches.decision, 'pending'),
      )).all();
    expect(stillPending).toHaveLength(0);
  });

  it('resolves the review items for the document', () => {
    const documentId = addDocument({ grossMinor: 21_000, documentDate: '2025-03-19' });
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });
    expect(db.select().from(reviewItems)
      .where(eq(reviewItems.status, 'open')).all().length).toBeGreaterThan(0);

    const [vercel] = transactions();
    linkDocument(db, { companyId, documentId, bankTransactionId: vercel.id });

    const open = db.select().from(reviewItems)
      .where(and(eq(reviewItems.entityId, documentId), eq(reviewItems.status, 'open'))).all();
    expect(open).toHaveLength(0);
  });

  it('records a manual link in the audit trail', () => {
    const documentId = addDocument();
    const [vercel] = transactions();

    linkDocument(db, {
      companyId, documentId, bankTransactionId: vercel.id,
      actor: 'joseph', reason: 'Matched by hand',
    });

    const audit = db.select().from(auditEvents)
      .where(and(eq(auditEvents.action, 'document_matched'), eq(auditEvents.actor, 'joseph'))).get()!;
    expect(audit.source).toBe('user');
    expect(audit.reason).toBe('Matched by hand');
    expect(audit.newValue).toBe(vercel.id);
  });

  it('throws when the document does not exist', () => {
    const [vercel] = transactions();
    expect(() => linkDocument(db, {
      companyId, documentId: 'doc_nonexistent', bankTransactionId: vercel.id,
    })).toThrow(/not found/i);
  });

  it('throws when the transaction does not exist', () => {
    const documentId = addDocument();
    expect(() => linkDocument(db, {
      companyId, documentId, bankTransactionId: 'btx_nonexistent',
    })).toThrow(/not found/i);
  });
});

describe('unmatchDocument (manual unlink)', () => {
  it('clears the link and leaves the audit record', () => {
    const documentId = addDocument();
    const [vercel] = transactions();
    linkDocument(db, { companyId, documentId, bankTransactionId: vercel.id });

    unmatchDocument(db, { companyId, documentId, reason: 'Wrong payment' });

    const document = db.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(document.matchedTransactionId).toBeNull();
    expect(document.matchStatus).toBe('unmatched');

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'document_unmatched')).get()!;
    expect(audit.previousValue).toBe(vercel.id);
    expect(audit.reason).toBe('Wrong payment');
  });

  it('is a no-op when the document is not linked', () => {
    const documentId = addDocument();
    expect(() => unmatchDocument(db, { companyId, documentId, reason: 'Nothing to undo' }))
      .not.toThrow();
  });
});

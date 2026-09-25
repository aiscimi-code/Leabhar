import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from '../banking/import';
import { storeDocument } from '../documents/storage';
import {
  findMatchesForDocument, acceptMatch, rejectMatch, unmatchDocument,
  matchAllUnmatched, unmatchedTransactions,
} from './service';
import {
  documents, bankTransactions, documentMatches, reviewItems, auditEvents, suppliers,
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
let vercelId: string;
let awsId: string;

beforeEach(async () => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01',
  });
  root = mkdtempSync(join(tmpdir(), 'match-'));

  vercelId = ids.supplier();
  db.insert(suppliers).values({
    id: vercelId, companyId, name: 'Vercel Inc', matchKey: 'vercel',
    aliases: ['VERCEL'], countryCode: 'US',
  }).run();
  awsId = ids.supplier();
  db.insert(suppliers).values({
    id: awsId, companyId, name: 'Amazon Web Services', matchKey: 'amazon web services',
    aliases: ['AWS EMEA'], countryCode: 'LU',
  }).run();

  await importStatement(db, {
    companyId, bankAccountId, filename: 'statement.csv',
    content: [
      'Date,Description,Amount',
      '15/03/2025,VERCEL INC,-42.17',
      '20/03/2025,AWS EMEA SARL,-210.00',
      '25/03/2025,RANDOM THING,-999.00',
    ].join('\n'),
    fileFormat: 'csv',
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
});

const addDocument = (over: Partial<typeof documents.$inferInsert> = {}) => {
  const stored = storeDocument(db, {
    companyId, filename: `${over.invoiceNumber ?? 'doc'}-${Math.random()}.pdf`,
    content: Buffer.from(`invoice ${Math.random()}`), root,
  });
  db.update(documents).set({
    grossMinor: 4217, currency: 'EUR', documentDate: '2025-03-14',
    documentType: 'supplier_invoice', supplierId: vercelId, reviewStatus: 'confirmed', ...over,
  }).where(eq(documents.id, stored.documentId)).run();
  return stored.documentId;
};

describe('findMatchesForDocument', () => {
  it('auto-accepts a confident match', () => {
    const documentId = addDocument();
    const outcome = findMatchesForDocument(db, { companyId, documentId });

    expect(outcome.applied).toBe(true);
    expect(outcome.best!.matchType).toBe('matched');

    const document = db.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(document.matchStatus).toBe('matched');
    expect(document.matchedTransactionId).toBeTruthy();
  });

  it('records the factors behind the score, not just the score', () => {
    const documentId = addDocument();
    findMatchesForDocument(db, { companyId, documentId });
    const match = db.select().from(documentMatches)
      .where(eq(documentMatches.documentId, documentId)).get()!;
    expect(match.score).toBeGreaterThan(90);
    expect(match.factors.length).toBeGreaterThan(2);
    expect(match.factors.every((f) => f.detail.length > 0)).toBe(true);
    expect(match.amountDifferenceMinor).toBe(0);
    expect(match.dateDifferenceDays).toBe(1);
  });

  it('never applies a match when auto-accept is disabled', () => {
    const documentId = addDocument();
    const outcome = findMatchesForDocument(db, {
      companyId, documentId, autoAcceptThreshold: null,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.best!.matchType).toBe('matched');
    expect(db.select().from(documents).where(eq(documents.id, documentId)).get()!.matchStatus)
      .toBe('suggested');
  });

  it('sends an uncertain match to review rather than forcing it', () => {
    // €42.17 document against a €210.00 transaction three weeks away.
    const documentId = addDocument({ grossMinor: 21_050, documentDate: '2025-03-01' });
    const outcome = findMatchesForDocument(db, { companyId, documentId });

    expect(outcome.applied).toBe(false);
    const items = db.select().from(reviewItems).all();
    expect(items.some((i) => i.kind === 'uncertain_match')).toBe(true);
  });

  it('refuses to guess between two equally good candidates', async () => {
    // Two identical charges on the same day.
    await importStatement(db, {
      companyId, bankAccountId, filename: 'dupes.csv',
      content: [
        'Date,Description,Amount',
        '10/03/2025,APP STORE,-9.99',
        '10/03/2025,APP STORE,-9.99',
      ].join('\n'),
      fileFormat: 'csv',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    });

    const documentId = addDocument({ grossMinor: 999, documentDate: '2025-03-10' });
    const outcome = findMatchesForDocument(db, { companyId, documentId });

    expect(outcome.ambiguous).toBe(true);
    expect(outcome.applied).toBe(false);

    const item = db.select().from(reviewItems)
      .where(eq(reviewItems.kind, 'uncertain_match')).get()!;
    expect(item.title).toContain('more than one transaction');
    expect(item.detail).toContain('wrong payment');
  });

  it('offers the alternatives as inline actions', () => {
    const documentId = addDocument({ grossMinor: 21_000, documentDate: '2025-03-19' });
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });
    const item = db.select().from(reviewItems)
      .where(eq(reviewItems.kind, 'uncertain_match')).get()!;
    expect(item.suggestedActions.length).toBeGreaterThan(0);
    expect(item.suggestedActions[0]!.action).toBe('accept_match');
  });

  it('reports honestly when nothing corresponds', () => {
    const documentId = addDocument({ grossMinor: 5_000_000, documentDate: '2025-03-14' });
    const outcome = findMatchesForDocument(db, { companyId, documentId });
    expect(outcome.best).toBeNull();
    const item = db.select().from(reviewItems)
      .where(eq(reviewItems.kind, 'unmatched_transaction')).get()!;
    expect(item.detail).toContain('may not have been paid yet');
  });

  it('does not re-propose a transaction already matched to another document', () => {
    const first = addDocument();
    findMatchesForDocument(db, { companyId, documentId: first });

    const second = addDocument();
    const outcome = findMatchesForDocument(db, { companyId, documentId: second });
    const matchedTransaction = db.select().from(documents)
      .where(eq(documents.id, first)).get()!.matchedTransactionId;
    expect(outcome.candidates.map((c) => c.bankTransactionId)).not.toContain(matchedTransaction);
  });

  it('supersedes previous pending candidates when re-run', () => {
    const documentId = addDocument({ grossMinor: 21_000, documentDate: '2025-03-19' });
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });

    const all = db.select().from(documentMatches)
      .where(eq(documentMatches.documentId, documentId)).all();
    const pending = all.filter((m) => m.decision === 'pending');
    const superseded = all.filter((m) => m.decision === 'superseded');
    expect(superseded.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThan(all.length);
  });

  it('matches AWS on its alias in the bank narrative', () => {
    const documentId = addDocument({
      grossMinor: 21_000, documentDate: '2025-03-20', supplierId: awsId,
    });
    const outcome = findMatchesForDocument(db, { companyId, documentId });
    expect(outcome.best!.score).toBeGreaterThan(70);
  });

  // An amount and a date alone are coincidence, not identification.
  it('refuses to auto-match when nothing identifies the counterparty', () => {
    const documentId = addDocument({ supplierId: null, invoiceNumber: null });
    const outcome = findMatchesForDocument(db, { companyId, documentId });

    expect(outcome.applied).toBe(false);
    expect(outcome.best!.matchType).toBe('probable');
    expect(outcome.best!.explanation).toContain('nothing identifies the counterparty');
  });

  it('auto-matches on an invoice number alone when the amount and date agree', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'ref.csv',
      content: 'Date,Description,Amount,Reference\n16/03/2025,SEPA TRANSFER,-500.00,INV-2025-0099',
      fileFormat: 'csv',
      columnMap: {
        Date: 'transaction_date', Description: 'description',
        Amount: 'amount', Reference: 'bank_reference',
      },
    });
    const documentId = addDocument({
      grossMinor: 50_000, documentDate: '2025-03-16',
      supplierId: null, invoiceNumber: 'INV-2025-0099',
    });
    const outcome = findMatchesForDocument(db, { companyId, documentId });
    expect(outcome.applied).toBe(true);
  });

  it('refuses to auto-match a document with no total', () => {
    const documentId = addDocument({ grossMinor: null });
    const outcome = findMatchesForDocument(db, { companyId, documentId });
    expect(outcome.applied).toBe(false);
  });
});

describe('accepting and rejecting', () => {
  it('records an accepted match as a user decision', () => {
    const documentId = addDocument({ grossMinor: 21_000, documentDate: '2025-03-19' });
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });

    const candidate = db.select().from(documentMatches)
      .where(eq(documentMatches.documentId, documentId)).get()!;

    acceptMatch(db, {
      companyId, documentId,
      bankTransactionId: candidate.bankTransactionId!,
      actor: 'joseph', reason: 'Checked against the invoice',
    });

    const after = db.select().from(documentMatches)
      .where(eq(documentMatches.id, candidate.id)).get()!;
    expect(after.decision).toBe('accepted');
    expect(after.provenanceStatus).toBe('user_confirmed');
    expect(after.decidedBy).toBe('joseph');

    const document = db.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(document.matchStatus).toBe('matched');
  });

  it('rejects the other candidates by implication', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'more.csv',
      content: 'Date,Description,Amount\n18/03/2025,VERCEL,-42.20',
      fileFormat: 'csv',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    });
    const documentId = addDocument();
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });

    const candidates = db.select().from(documentMatches)
      .where(eq(documentMatches.documentId, documentId)).all();
    expect(candidates.length).toBeGreaterThan(1);

    acceptMatch(db, {
      companyId, documentId, bankTransactionId: candidates[0]!.bankTransactionId!,
    });

    const after = db.select().from(documentMatches)
      .where(eq(documentMatches.documentId, documentId)).all();
    expect(after.filter((m) => m.decision === 'accepted')).toHaveLength(1);
    expect(after.filter((m) => m.decision === 'rejected').length).toBeGreaterThan(0);
  });

  it('resolves the review item when a match is accepted', () => {
    const documentId = addDocument({ grossMinor: 21_000, documentDate: '2025-03-19' });
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });
    expect(db.select().from(reviewItems)
      .where(eq(reviewItems.status, 'open')).all().length).toBeGreaterThan(0);

    const candidate = db.select().from(documentMatches)
      .where(eq(documentMatches.documentId, documentId)).get()!;
    acceptMatch(db, {
      companyId, documentId, bankTransactionId: candidate.bankTransactionId!,
    });

    const item = db.select().from(reviewItems)
      .where(eq(reviewItems.dedupeKey, `document:${documentId}:match`)).get()!;
    expect(item.status).toBe('resolved');
    expect(item.resolution).toContain('Matched to transaction');
  });

  it('records a rejection with its provenance', () => {
    const documentId = addDocument();
    findMatchesForDocument(db, { companyId, documentId, autoAcceptThreshold: null });
    const candidate = db.select().from(documentMatches)
      .where(eq(documentMatches.documentId, documentId)).get()!;

    rejectMatch(db, {
      companyId, documentId, bankTransactionId: candidate.bankTransactionId!,
      reason: 'Different Vercel invoice',
    });

    const after = db.select().from(documentMatches)
      .where(eq(documentMatches.id, candidate.id)).get()!;
    expect(after.decision).toBe('rejected');
    expect(after.provenanceStatus).toBe('user_rejected');
  });

  it('unmatches without destroying the record that it was matched', () => {
    const documentId = addDocument();
    findMatchesForDocument(db, { companyId, documentId });
    const matchedTo = db.select().from(documents)
      .where(eq(documents.id, documentId)).get()!.matchedTransactionId;

    unmatchDocument(db, { companyId, documentId, reason: 'Wrong payment' });

    const after = db.select().from(documents).where(eq(documents.id, documentId)).get()!;
    expect(after.matchedTransactionId).toBeNull();
    expect(after.matchStatus).toBe('unmatched');

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'document_unmatched')).get()!;
    expect(audit.previousValue).toBe(matchedTo);
    expect(audit.reason).toBe('Wrong payment');
  });
});

describe('bulk matching', () => {
  it('processes every unmatched document', () => {
    addDocument();
    addDocument({ grossMinor: 21_000, documentDate: '2025-03-20', supplierId: awsId });
    addDocument({ grossMinor: 5_000_000, documentDate: '2025-03-20' });

    const result = matchAllUnmatched(db, { companyId });
    expect(result.processed).toBe(3);
    expect(result.autoMatched).toBeGreaterThanOrEqual(1);
  });

  it('lists transactions with no supporting document', () => {
    const documentId = addDocument();
    findMatchesForDocument(db, { companyId, documentId });

    const unmatched = unmatchedTransactions(db, { companyId });
    expect(unmatched).toHaveLength(2);
    expect(unmatched.map((t) => t.description)).not.toContain('VERCEL INC');
  });
});

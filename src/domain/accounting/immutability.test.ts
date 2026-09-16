import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { journalEntries, journalLines } from '@/db/schema';
import { postJournalEntry, reverseJournalEntry } from './journal';
import { createCompany } from '../config/setup';
import { ids } from '@/lib/ids';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

/**
 * Database-level immutability triggers (issue #49).
 *
 * These tests verify that SQLite triggers reject direct UPDATE/DELETE
 * on posted journal entries and their lines, except for the
 * reversal-linkage columns that reverseJournalEntry needs to touch.
 */
describe('posted journal immutability triggers', () => {
  let db: AppDatabase;
  let companyId: string;
  let byCode: Record<string, string>;

  beforeEach(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, {
      legalName: 'Trigger Test Co',
      financialYearEndDay: 31,
      financialYearEndMonth: 12,
      seedYears: [2025],
    });
    companyId = created.companyId;
    byCode = created.accountsByCode;
  });

  function postEntry(): string {
    return postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 3, 15),
      narrative: 'Test entry',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['6010']!, debitMinor: 100 },
        { accountId: byCode['2300']!, creditMinor: 100 },
      ],
    }).id;
  }

  it('blocks UPDATE on a posted journal entry', () => {
    const entryId = postEntry();
    expect(() =>
      db.update(journalEntries).set({ narrative: 'changed' })
        .where(eq(journalEntries.id, entryId)).run(),
    ).toThrow(/posted/);
  });

  it('blocks DELETE on a posted journal entry', () => {
    const entryId = postEntry();
    expect(() =>
      db.delete(journalEntries).where(eq(journalEntries.id, entryId)).run(),
    ).toThrow(/posted/);
  });

  it('allows UPDATE on reversal-linkage columns (reversedByEntryId, reversalReason)', () => {
    const entryId = postEntry();
    expect(() =>
      db.update(journalEntries)
        .set({ reversedByEntryId: 'rev-1', reversalReason: 'corrected' })
        .where(eq(journalEntries.id, entryId)).run(),
    ).not.toThrow();
  });

  it('allows UPDATE on reversalOfId', () => {
    const entryId = postEntry();
    expect(() =>
      db.update(journalEntries)
        .set({ reversalOfId: 'original-1' })
        .where(eq(journalEntries.id, entryId)).run(),
    ).not.toThrow();
  });

  it('blocks UPDATE on journal lines of a posted entry', () => {
    const entryId = postEntry();
    const line = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, entryId)).get();
    expect(() =>
      db.update(journalLines).set({ memo: 'changed' })
        .where(eq(journalLines.id, line!.id)).run(),
    ).toThrow(/posted/);
  });

  it('blocks DELETE on journal lines of a posted entry', () => {
    const entryId = postEntry();
    const line = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, entryId)).get();
    expect(() =>
      db.delete(journalLines).where(eq(journalLines.id, line!.id)).run(),
    ).toThrow(/posted/);
  });

  it('allows UPDATE on an unposted (draft) entry', () => {
    const entryId = ids.journalEntry();
    db.insert(journalEntries).values({
      id: entryId,
      companyId,
      entryNumber: 999,
      entryDate: makeDate(2025, 3, 15),
      narrative: 'Draft',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      isPosted: false,
      createdBy: 'test',
      createdVia: 'user',
    }).run();

    expect(() =>
      db.update(journalEntries).set({ narrative: 'changed draft' })
        .where(eq(journalEntries.id, entryId)).run(),
    ).not.toThrow();
  });

  it('does not block reverseJournalEntry', () => {
    const entryId = postEntry();
    expect(() =>
      reverseJournalEntry(db, {
        companyId,
        entryId,
        reversalDate: makeDate(2025, 3, 20),
        reason: 'Test reversal',
      }),
    ).not.toThrow();
  });
});

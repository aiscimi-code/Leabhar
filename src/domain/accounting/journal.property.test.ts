import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { seedTestBook } from '@/db/testing';
import { journalLines } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { asIsoDate } from '../dates';
import { postJournalEntry, reverseJournalEntry } from './journal';
import { UnbalancedJournalError } from './errors';

/**
 * Property tests for journal balancing (#597). Example-based tests in
 * journal.test.ts still own the specific error messages and period-lock
 * cases; these check the invariant across generated line sets.
 */
// Each run seeds a fresh book (every migration applied), so a property
// of 25 runs takes close to vitest's 5s default on its own and times out
// when the full suite loads the machine. The bound is generous on purpose.
const PROPERTY_TIMEOUT_MS = 30_000;

describe('journal balance properties (#597)', () => {
  it('a generated balanced two-line entry posts, and its lines sum to zero in base currency', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 10_000_000 }), (amount) => {
      const book = seedTestBook();
      const bank = book.accountsByKey['bank_control']!;
      const income = book.accountsByCode['4020']!;
      const posted = postJournalEntry(book.db, {
        companyId: book.companyId,
        entryDate: asIsoDate('2025-06-15'),
        narrative: `prop ${amount}`,
        sourceType: 'manual_adjustment',
        sourceId: `prop-${amount}`,
        baseCurrency: 'EUR',
        lines: [
          { accountId: bank, debitMinor: amount },
          { accountId: income, creditMinor: amount },
        ],
      });
      const lines = book.db.select().from(journalLines)
        .where(eq(journalLines.journalEntryId, posted.id)).all();
      const debit = lines.reduce((s, l) => s + l.baseDebitMinor, 0);
      const credit = lines.reduce((s, l) => s + l.baseCreditMinor, 0);
      expect(debit).toBe(credit);
      expect(debit).toBe(amount);
    }), { numRuns: 25 });
  }, PROPERTY_TIMEOUT_MS);

  it('posting rejects an unbalanced entry', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 10_000_000 }),
      fc.integer({ min: 1, max: 10_000_000 }),
      (debit, credit) => {
        fc.pre(debit !== credit);
        const book = seedTestBook();
        expect(() => postJournalEntry(book.db, {
          companyId: book.companyId,
          entryDate: asIsoDate('2025-06-15'),
          narrative: 'unbalanced',
          sourceType: 'manual_adjustment',
          sourceId: `unbal-${debit}-${credit}`,
          baseCurrency: 'EUR',
          lines: [
            { accountId: book.accountsByKey['bank_control']!, debitMinor: debit },
            { accountId: book.accountsByCode['4020']!, creditMinor: credit },
          ],
        })).toThrow(UnbalancedJournalError);
      },
    ), { numRuns: 25 });
  }, PROPERTY_TIMEOUT_MS);

  it('reversing an entry and reversing that reversal restores the posted net of the original', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 5_000_000 }), (amount) => {
      const book = seedTestBook();
      const bank = book.accountsByKey['bank_control']!;
      const income = book.accountsByCode['4020']!;
      const original = postJournalEntry(book.db, {
        companyId: book.companyId,
        entryDate: asIsoDate('2025-06-15'),
        narrative: `orig ${amount}`,
        sourceType: 'manual_adjustment',
        sourceId: `orig-${amount}`,
        baseCurrency: 'EUR',
        lines: [
          { accountId: bank, debitMinor: amount },
          { accountId: income, creditMinor: amount },
        ],
      });
      const first = reverseJournalEntry(book.db, {
        companyId: book.companyId,
        entryId: original.id,
        reversalDate: asIsoDate('2025-06-16'),
        reason: 'first reverse',
      });
      reverseJournalEntry(book.db, {
        companyId: book.companyId,
        entryId: first.id,
        reversalDate: asIsoDate('2025-06-17'),
        reason: 'reverse the reversal',
      });
      const lines = book.db.select().from(journalLines)
        .where(eq(journalLines.companyId, book.companyId)).all();
      const netByAccount = new Map<string, number>();
      for (const line of lines) {
        const net = (netByAccount.get(line.accountId) ?? 0) + line.baseDebitMinor - line.baseCreditMinor;
        netByAccount.set(line.accountId, net);
      }
      expect(netByAccount.get(bank)).toBe(amount);
      expect(netByAccount.get(income)).toBe(-amount);
    }), { numRuns: 15 });
  }, PROPERTY_TIMEOUT_MS);
});

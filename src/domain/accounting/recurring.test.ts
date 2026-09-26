import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { archiveAccount } from '../config/mutations';
import {
  createRecurringJournal, updateRecurringJournal, deactivateRecurringJournal,
  postDueRecurringJournals, dueOccurrenceDates, listRecurringJournals,
  getRecurringJournal, RecurringJournalError,
} from './recurring';
import { trialBalance, accountBalance } from './ledger';
import { journalEntries, accountingPeriods } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
});

const rentTemplate = (over: Partial<Parameters<typeof createRecurringJournal>[1]> = {}) =>
  createRecurringJournal(db, {
    companyId,
    name: 'Office rent',
    frequency: 'monthly' as const,
    startDate: makeDate(2025, 1, 31),
    lines: [
      { accountId: byCode['6200']!, debitMinor: 200_000 },
      { accountId: byCode['1010']!, creditMinor: 200_000 },
    ],
    ...over,
  });

describe('createRecurringJournal', () => {
  it('creates a template without posting anything', () => {
    rentTemplate();
    expect(db.select().from(journalEntries).all()).toHaveLength(0);
    const listed = listRecurringJournals(db, { companyId });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe('Office rent');
    expect(listed[0]!.lines).toHaveLength(2);
    expect(listed[0]!.active).toBe(true);
    expect(listed[0]!.postedOccurrences).toBe(0);
  });

  it('refuses an unbalanced template and says by how much', () => {
    try {
      rentTemplate({
        lines: [
          { accountId: byCode['6200']!, debitMinor: 200_000 },
          { accountId: byCode['1010']!, creditMinor: 199_000 },
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RecurringJournalError);
      expect((error as Error).message).toContain('difference of 1000 minor units');
    }
  });

  it('refuses one-sided amounts and nonexistent accounts', () => {
    expect(() => rentTemplate({
      lines: [{ accountId: byCode['6200']!, debitMinor: 200_000 }],
    })).toThrow(/at least two lines/);

    expect(() => rentTemplate({
      lines: [
        { accountId: byCode['6200']!, debitMinor: 200_000, creditMinor: 1 },
        { accountId: byCode['1010']!, creditMinor: 200_000 },
      ],
    })).toThrow(/both a debit and a credit/);

    expect(() => rentTemplate({
      lines: [
        { accountId: 'acc_nope', debitMinor: 200_000 },
        { accountId: byCode['1010']!, creditMinor: 200_000 },
      ],
    })).toThrow(/does not exist/);
  });

  it('refuses an inactive account and an end date before the start', () => {
    archiveAccount(db, {
      companyId, accountId: byCode['6120']!, reason: 'No longer rented',
    });

    expect(() => rentTemplate({
      lines: [
        { accountId: byCode['6120']!, debitMinor: 200_000 },
        { accountId: byCode['1010']!, creditMinor: 200_000 },
      ],
    })).toThrow(/inactive/);

    expect(() => rentTemplate({
      startDate: makeDate(2025, 6, 1),
      endDate: makeDate(2025, 5, 1),
    })).toThrow(/ends before it starts/);
  });
});

describe('dueOccurrenceDates', () => {
  it('steps monthly from the start date and clamps to month end', () => {
    const dates = dueOccurrenceDates(
      { frequency: 'monthly', startDate: makeDate(2025, 1, 31), endDate: null },
      makeDate(2025, 4, 30),
    );
    expect(dates).toEqual([
      makeDate(2025, 1, 31),
      makeDate(2025, 2, 28),
      makeDate(2025, 3, 31),
      makeDate(2025, 4, 30),
    ]);
  });

  it('steps quarterly and yearly, and honours the end date', () => {
    expect(dueOccurrenceDates(
      { frequency: 'quarterly', startDate: makeDate(2025, 2, 1), endDate: null },
      makeDate(2025, 8, 1),
    )).toEqual([
      makeDate(2025, 2, 1), makeDate(2025, 5, 1), makeDate(2025, 8, 1),
    ]);

    expect(dueOccurrenceDates(
      { frequency: 'yearly', startDate: makeDate(2024, 7, 1), endDate: null },
      makeDate(2026, 7, 1),
    )).toEqual([makeDate(2024, 7, 1), makeDate(2025, 7, 1), makeDate(2026, 7, 1)]);

    expect(dueOccurrenceDates(
      { frequency: 'monthly', startDate: makeDate(2025, 1, 1), endDate: makeDate(2025, 2, 28) },
      makeDate(2025, 6, 30),
    )).toEqual([makeDate(2025, 1, 1), makeDate(2025, 2, 1)]);
  });
});

describe('postDueRecurringJournals', () => {
  it('posts each due occurrence as a journal entry', () => {
    rentTemplate();
    const { posted, skipped } = postDueRecurringJournals(db, {
      companyId, upTo: makeDate(2025, 3, 31),
    });

    expect(skipped).toEqual([]);
    expect(posted).toHaveLength(3);
    expect(posted.map((p) => p.date)).toEqual([
      makeDate(2025, 1, 31), makeDate(2025, 2, 28), makeDate(2025, 3, 31),
    ]);

    const entries = db.select().from(journalEntries).all();
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.sourceType === 'recurring')).toBe(true);

    // Three months of rent at 2,000.00 against the bank.
    expect(accountBalance(db, {
      companyId, accountId: byCode['6200']!, asOf: makeDate(2025, 3, 31),
    })).toBe(600_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 3, 31) }).balanced).toBe(true);
  });

  it('is idempotent: running it again posts nothing new', () => {
    rentTemplate();
    postDueRecurringJournals(db, { companyId, upTo: makeDate(2025, 3, 31) });
    const again = postDueRecurringJournals(db, { companyId, upTo: makeDate(2025, 3, 31) });

    expect(again.posted).toEqual([]);
    expect(again.skipped).toEqual([]);
    expect(db.select().from(journalEntries).all()).toHaveLength(3);
  });

  it('catches up to a later date without re-posting the past', () => {
    rentTemplate();
    postDueRecurringJournals(db, { companyId, upTo: makeDate(2025, 1, 31) });
    const later = postDueRecurringJournals(db, { companyId, upTo: makeDate(2025, 4, 30) });

    expect(later.posted.map((p) => p.date)).toEqual([
      makeDate(2025, 2, 28), makeDate(2025, 3, 31), makeDate(2025, 4, 30),
    ]);
    expect(db.select().from(journalEntries).all()).toHaveLength(4);
  });

  it('skips an occurrence whose period is locked, with the reason, and posts the rest', () => {
    rentTemplate();

    // March is inside the 2025 financial year; lock the year and the March
    // occurrence (along with January and February) cannot post.
    db.update(accountingPeriods).set({ status: 'locked' })
      .where(and(
        eq(accountingPeriods.companyId, companyId),
        eq(accountingPeriods.kind, 'financial_year'),
        eq(accountingPeriods.name, 'FY 2025'),
      )).run();

    const { posted, skipped } = postDueRecurringJournals(db, {
      companyId, upTo: makeDate(2025, 2, 28),
    });
    expect(posted).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]!.reason).toMatch(/locked|closed/);
    expect(db.select().from(journalEntries).all()).toHaveLength(0);
  });

  it('leaves nothing behind when a later occurrence fails to post', () => {
    rentTemplate();

    // A second template whose account is deactivated after it was defined.
    // Its occurrence reaches postJournalEntry and is refused there; the whole
    // run rolls back, so the first template's occurrence does not survive it.
    createRecurringJournal(db, {
      companyId,
      name: 'Office refreshments',
      frequency: 'monthly' as const,
      startDate: makeDate(2025, 1, 31),
      lines: [
        { accountId: byCode['6120']!, debitMinor: 10_000 },
        { accountId: byCode['1010']!, creditMinor: 10_000 },
      ],
    });
    archiveAccount(db, {
      companyId, accountId: byCode['6120']!, reason: 'No longer rented',
    });

    expect(() => postDueRecurringJournals(db, {
      companyId, upTo: makeDate(2025, 1, 31),
    })).toThrow(/inactive/);

    expect(db.select().from(journalEntries).all()).toHaveLength(0);
    expect(accountBalance(db, {
      companyId, accountId: byCode['6200']!, asOf: makeDate(2025, 1, 31),
    })).toBe(0);
  });

  it('ignores a template that is deactivated, and one not yet started', () => {
    const id = rentTemplate({ startDate: makeDate(2025, 12, 1) });
    deactivateRecurringJournal(db, { companyId, recurringId: id, reason: 'Rent renegotiated quarterly' });

    // Active, but its first occurrence is after the run date.
    createRecurringJournal(db, {
      companyId,
      name: 'IAASA fee',
      frequency: 'quarterly',
      startDate: makeDate(2026, 1, 15),
      lines: [
        { accountId: byCode['6060']!, debitMinor: 50_000 },
        { accountId: byCode['1010']!, creditMinor: 50_000 },
      ],
    });

    const result = postDueRecurringJournals(db, { companyId, upTo: makeDate(2025, 12, 31) });
    expect(result.posted).toEqual([]);
    expect(db.select().from(journalEntries).all()).toHaveLength(0);
  });
});

describe('updateRecurringJournal', () => {
  it('changes future occurrences without touching posted ones', () => {
    const id = rentTemplate();
    postDueRecurringJournals(db, { companyId, upTo: makeDate(2025, 1, 31) });

    updateRecurringJournal(db, {
      companyId, recurringId: id,
      changes: {
        lines: [
          { accountId: byCode['6200']!, debitMinor: 250_000 },
          { accountId: byCode['1010']!, creditMinor: 250_000 },
        ],
      },
    });

    const later = postDueRecurringJournals(db, { companyId, upTo: makeDate(2025, 2, 28) });
    expect(later.posted).toHaveLength(1);

    const january = accountBalance(db, {
      companyId, accountId: byCode['6200']!,
      asOf: makeDate(2025, 1, 31), from: makeDate(2025, 1, 31),
    });
    expect(january).toBe(200_000); // posted before the edit, unchanged

    const february = accountBalance(db, {
      companyId, accountId: byCode['6200']!,
      asOf: makeDate(2025, 2, 28), from: makeDate(2025, 2, 1),
    });
    expect(february).toBe(250_000); // posted after the edit
  });

  it('refuses an unbalanced edit', () => {
    const id = rentTemplate();
    expect(() => updateRecurringJournal(db, {
      companyId, recurringId: id,
      changes: {
        lines: [
          { accountId: byCode['6200']!, debitMinor: 1 },
          { accountId: byCode['1010']!, creditMinor: 2 },
        ],
      },
    })).toThrow(/does not balance/);
  });
});

describe('listRecurringJournals', () => {
  it('reports posted occurrences and the next due date', () => {
    const id = rentTemplate();
    postDueRecurringJournals(db, { companyId, upTo: makeDate(2025, 2, 28) });

    const listed = listRecurringJournals(db, {
      companyId, asOf: makeDate(2025, 2, 28),
    });
    expect(listed[0]!.postedOccurrences).toBe(2);
    expect(listed[0]!.lastPostedDate).toBe(makeDate(2025, 2, 28));
    expect(listed[0]!.nextDueDate).toBe(makeDate(2025, 3, 31));

    const single = getRecurringJournal(db, {
      companyId, recurringId: id, asOf: makeDate(2025, 2, 28),
    });
    expect(single?.nextDueDate).toBe(makeDate(2025, 3, 31));
  });

  it('hides inactive templates unless asked', () => {
    const id = rentTemplate();
    deactivateRecurringJournal(db, { companyId, recurringId: id, reason: 'Lease ended' });

    expect(listRecurringJournals(db, { companyId })).toHaveLength(0);
    expect(listRecurringJournals(db, { companyId, includeInactive: true })).toHaveLength(1);
    expect(() => deactivateRecurringJournal(db, {
      companyId, recurringId: id, reason: '',
    })).toThrow(/needs a reason/);
  });
});

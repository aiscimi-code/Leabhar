import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { updateAccount } from '../config/mutations';
import {
  postAccrual, postPrepayment, postDueTimingReversals, reverseTimingAdjustment,
  listTimingAdjustments, TimingError,
} from './timing';
import { trialBalance, accountBalance } from './ledger';
import { journalEntries, journalLines, accountingPeriods, vatEntries } from '@/db/schema';
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

const accrual = (over: Partial<Parameters<typeof postAccrual>[1]> = {}) =>
  postAccrual(db, {
    companyId,
    date: makeDate(2025, 12, 31),
    description: 'Accountancy fees for December',
    reason: 'The invoice had not arrived by the year end',
    reversalDate: makeDate(2026, 1, 31),
    expenseLines: [{ accountId: byCode['6070']!, amountMinor: 150_000 }],
    ...over,
  });

describe('postAccrual', () => {
  it('posts the expense against accruals and records the reversal date', () => {
    const result = accrual();
    expect(result.totalMinor).toBe(150_000);

    expect(accountBalance(db, {
      companyId, accountId: byCode['6070']!, asOf: makeDate(2025, 12, 31),
    })).toBe(150_000);
    expect(accountBalance(db, {
      companyId, accountId: byCode['2300']!, asOf: makeDate(2025, 12, 31),
    })).toBe(150_000);

    const entry = db.select().from(journalEntries)
      .where(eq(journalEntries.id, result.journalEntryId)).get()!;
    expect(entry.sourceType).toBe('accrual');
    expect(entry.entryType).toBe('accrual');
    expect(entry.notes).toContain('had not arrived');

    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('claims no input VAT: an accrual has no confirmed invoice', () => {
    accrual();
    expect(db.select().from(vatEntries).all()).toHaveLength(0);
  });

  it('spreads one accrual over several expense accounts', () => {
    accrual({
      expenseLines: [
        { accountId: byCode['6070']!, amountMinor: 100_000, memo: 'December' },
        { accountId: byCode['6080']!, amountMinor: 50_000, memo: 'December' },
      ],
    });
    expect(accountBalance(db, {
      companyId, accountId: byCode['6070']!, asOf: makeDate(2025, 12, 31),
    })).toBe(100_000);
    expect(accountBalance(db, {
      companyId, accountId: byCode['6080']!, asOf: makeDate(2025, 12, 31),
    })).toBe(50_000);
    expect(accountBalance(db, {
      companyId, accountId: byCode['2300']!, asOf: makeDate(2025, 12, 31),
    })).toBe(150_000);
  });

  it('refuses a missing reason, a non-positive amount, a non-expense account and a bad reversal date', () => {
    expect(() => accrual({ reason: '' })).toThrow(/needs a reason/);

    expect(() => accrual({
      expenseLines: [{ accountId: byCode['6070']!, amountMinor: 0 }],
    })).toThrow(/positive whole number/);

    expect(() => accrual({
      expenseLines: [{ accountId: byCode['1010']!, amountMinor: 100 }],
    })).toThrow(/not an\s+expense/);

    expect(() => accrual({ reversalDate: makeDate(2025, 12, 31) }))
      .toThrow(/reversal date must come after/);
  });
});

describe('postPrepayment', () => {
  it('parks the prepaid portion in the prepayments account', () => {
    const result = postPrepayment(db, {
      companyId,
      date: makeDate(2025, 12, 31),
      description: 'Insurance paid to end of June 2026',
      reason: 'The premium covers six months of the next year',
      reversalDate: makeDate(2026, 6, 30),
      expenseAccountId: byCode['6090']!,
      amountMinor: 60_000,
    });
    expect(result.totalMinor).toBe(60_000);

    expect(accountBalance(db, {
      companyId, accountId: byCode['1600']!, asOf: makeDate(2025, 12, 31),
    })).toBe(60_000);
    expect(accountBalance(db, {
      companyId, accountId: byCode['6090']!, asOf: makeDate(2025, 12, 31),
    })).toBe(-60_000);

    const entry = db.select().from(journalEntries)
      .where(eq(journalEntries.id, result.journalEntryId)).get()!;
    expect(entry.sourceType).toBe('prepayment');
    expect(entry.entryType).toBe('prepayment');

    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('refuses a reversal on or before the posting date, and a non-expense account', () => {
    expect(() => postPrepayment(db, {
      companyId,
      date: makeDate(2025, 12, 31),
      description: 'Insurance',
      reason: 'Prepaid per the schedule',
      reversalDate: makeDate(2025, 12, 31),
      expenseAccountId: byCode['6090']!,
      amountMinor: 60_000,
    })).toThrow(/must come after/);

    expect(() => postPrepayment(db, {
      companyId,
      date: makeDate(2025, 12, 31),
      description: 'Insurance',
      reason: 'Prepaid per the schedule',
      reversalDate: makeDate(2026, 6, 30),
      expenseAccountId: byCode['1010']!,
      amountMinor: 60_000,
    })).toThrow(/not an\s+expense/);
  });
});

describe('postDueTimingReversals', () => {
  it('reverses an accrual on its reversal date and puts the cost back', () => {
    const posted = accrual();

    // Before the reversal date: nothing to do.
    expect(postDueTimingReversals(db, {
      companyId, upTo: makeDate(2026, 1, 30),
    }).reversed).toHaveLength(0);

    const { reversed, skipped } = postDueTimingReversals(db, {
      companyId, upTo: makeDate(2026, 1, 31),
    });
    expect(skipped).toEqual([]);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.timingId).toBe(posted.timingId);

    // The expense and the accrual are back to nil, dated in January 2026.
    expect(accountBalance(db, {
      companyId, accountId: byCode['6070']!, asOf: makeDate(2026, 1, 31),
    })).toBe(0);
    expect(accountBalance(db, {
      companyId, accountId: byCode['2300']!, asOf: makeDate(2026, 1, 31),
    })).toBe(0);
    // And the December figures still show the accrual, as they must.
    expect(accountBalance(db, {
      companyId, accountId: byCode['6070']!, asOf: makeDate(2025, 12, 31),
    })).toBe(150_000);

    const original = db.select().from(journalEntries)
      .where(eq(journalEntries.id, posted.journalEntryId)).get()!;
    expect(original.reversedByEntryId).toBe(reversed[0]!.reversalEntryId);
  });

  it('releases a prepayment back into its expense account', () => {
    const posted = postPrepayment(db, {
      companyId,
      date: makeDate(2025, 12, 31),
      description: 'Insurance paid to end of June 2026',
      reason: 'The premium covers six months of the next year',
      reversalDate: makeDate(2026, 6, 30),
      expenseAccountId: byCode['6090']!,
      amountMinor: 60_000,
    });

    const { reversed } = postDueTimingReversals(db, {
      companyId, upTo: makeDate(2026, 6, 30),
    });
    expect(reversed).toHaveLength(1);
    expect(reversed[0]!.timingId).toBe(posted.timingId);

    expect(accountBalance(db, {
      companyId, accountId: byCode['1600']!, asOf: makeDate(2026, 6, 30),
    })).toBe(0);
    expect(accountBalance(db, {
      companyId, accountId: byCode['6090']!, asOf: makeDate(2026, 6, 30),
    })).toBe(0);
  });

  it('is idempotent: a second run finds nothing to reverse', () => {
    accrual();
    postDueTimingReversals(db, { companyId, upTo: makeDate(2026, 1, 31) });
    const again = postDueTimingReversals(db, { companyId, upTo: makeDate(2026, 3, 31) });
    expect(again.reversed).toEqual([]);
    expect(again.skipped).toEqual([]);
  });

  it('skips a reversal whose period is locked, with the reason, and reverses the rest', () => {
    const due = accrual();
    postPrepayment(db, {
      companyId,
      date: makeDate(2025, 12, 31),
      description: 'Insurance paid to end of June 2026',
      reason: 'The premium covers six months of the next year',
      reversalDate: makeDate(2026, 6, 30),
      expenseAccountId: byCode['6090']!,
      amountMinor: 60_000,
    });

    // 2026 locked: the January accrual reversal cannot post, the June
    // prepayment release is due later and not yet reversed either.
    db.update(accountingPeriods).set({ status: 'locked' })
      .where(and(
        eq(accountingPeriods.companyId, companyId),
        eq(accountingPeriods.name, 'FY 2026'),
      )).run();

    const { reversed, skipped } = postDueTimingReversals(db, {
      companyId, upTo: makeDate(2026, 6, 30),
    });
    expect(reversed).toEqual([]);
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s) => /locked|closed/.test(s.reason))).toBe(true);

    // Nothing posted: the accrual still stands.
    const original = db.select().from(journalEntries)
      .where(eq(journalEntries.id, due.journalEntryId)).get()!;
    expect(original.reversedByEntryId).toBeNull();
  });
});

describe('reverseTimingAdjustment', () => {
  it('reverses early on a named date, and refuses a second reversal', () => {
    const posted = accrual({ reversalDate: makeDate(2026, 1, 31) });

    const early = reverseTimingAdjustment(db, {
      companyId, timingId: posted.timingId,
      reason: 'The invoice arrived in December after all',
      reversalDate: makeDate(2025, 12, 31),
    });
    expect(early.reversalDate).toBe(makeDate(2025, 12, 31));

    expect(accountBalance(db, {
      companyId, accountId: byCode['6070']!, asOf: makeDate(2025, 12, 31),
    })).toBe(0);

    expect(() => reverseTimingAdjustment(db, {
      companyId, timingId: posted.timingId, reason: 'Twice',
    })).toThrow(/already reversed/);

    expect(() => reverseTimingAdjustment(db, {
      companyId, timingId: posted.timingId, reason: '',
    })).toThrow(/needs a reason/);
  });
});

describe('listTimingAdjustments', () => {
  it('lists accruals and prepayments with their reversal state read off the books', () => {
    const posted = accrual();
    postPrepayment(db, {
      companyId,
      date: makeDate(2025, 12, 31),
      description: 'Insurance paid to end of June 2026',
      reason: 'The premium covers six months of the next year',
      reversalDate: makeDate(2026, 6, 30),
      expenseAccountId: byCode['6090']!,
      amountMinor: 60_000,
    });

    const all = listTimingAdjustments(db, { companyId });
    expect(all).toHaveLength(2);
    expect(all.every((a) => !a.reversed)).toBe(true);

    const byKind = listTimingAdjustments(db, { companyId, kind: 'accrual' });
    expect(byKind).toHaveLength(1);
    expect(byKind[0]!.description).toBe('Accountancy fees for December');
    expect(byKind[0]!.lines.map((l) => l.accountCode).sort()).toEqual(['2300', '6070']);

    postDueTimingReversals(db, { companyId, upTo: makeDate(2026, 6, 30) });

    const outstanding = listTimingAdjustments(db, { companyId, outstandingOnly: true });
    expect(outstanding).toHaveLength(0);

    const reversed = listTimingAdjustments(db, { companyId });
    expect(reversed.every((a) => a.reversed)).toBe(true);
    expect(reversed.find((a) => a.timingId === posted.timingId)!.reversalEntryNumber)
      .toBeGreaterThan(0);
  });

  it('shows the account name the entry was posted with, even after a rename', () => {
    accrual();
    // The sanctioned rename path: the account row changes, the posted line keeps
    // the identity it was posted with (issue #370).
    updateAccount(db, {
      companyId, accountId: byCode['6070']!,
      changes: { name: 'Audit and accountancy fees' },
    });

    const listed = listTimingAdjustments(db, { companyId });
    const codes = listed[0]!.lines.map((l) => [l.accountCode, l.accountName] as const);
    expect(codes).toContainEqual(['6070', 'Accountancy fees']);
    expect(codes).toContainEqual(['2300', 'Accruals']);
    expect(codes).not.toContainEqual(['6070', 'Audit and accountancy fees']);
  });
});

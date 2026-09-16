import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany, systemAccountId } from '../config/setup';
import { postJournalEntry, reverseJournalEntry } from './journal';
import { trialBalance, accountBalance, generalLedger } from './ledger';
import {
  UnbalancedJournalError, PeriodLockedError, NoPeriodError, InvalidLineError,
  MissingAccountError, CurrencyMismatchError, ImmutableEntryError,
} from './errors';
import { accountingPeriods, journalEntries, journalLines, auditEvents } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { makeDate, asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Test Company Limited',
    financialYearEndDay: 31,
    financialYearEndMonth: 12,
    seedYears: [2024, 2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
});

const post = (over: Partial<Parameters<typeof postJournalEntry>[1]> = {}) =>
  postJournalEntry(db, {
    companyId,
    entryDate: makeDate(2025, 3, 15),
    narrative: 'Test entry',
    sourceType: 'manual_adjustment',
    baseCurrency: 'EUR',
    lines: [
      { accountId: byCode['6010']!, debitMinor: 10_000 },
      { accountId: acc['bank_control']!, creditMinor: 10_000 },
    ],
    ...over,
  });

describe('postJournalEntry', () => {
  it('posts a balanced entry and assigns it to the right period', () => {
    const entry = post();
    expect(entry.entryNumber).toBe(1);
    expect(entry.lines).toHaveLength(2);

    const saved = db.select().from(journalEntries).where(eq(journalEntries.id, entry.id)).get()!;
    expect(saved.isPosted).toBe(true);
    expect(saved.postedAt).toBeTruthy();

    const period = db.select().from(accountingPeriods)
      .where(eq(accountingPeriods.id, saved.accountingPeriodId!)).get()!;
    expect(period.name).toBe('FY 2025');
    expect(period.kind).toBe('financial_year');
  });

  it('numbers entries sequentially without gaps', () => {
    expect(post().entryNumber).toBe(1);
    expect(post().entryNumber).toBe(2);
    expect(post().entryNumber).toBe(3);
  });

  it('refuses an unbalanced entry and says by how much', () => {
    expect(() => post({
      lines: [
        { accountId: byCode['6010']!, debitMinor: 10_000 },
        { accountId: acc['bank_control']!, creditMinor: 9_900 },
      ],
    })).toThrow(UnbalancedJournalError);

    try {
      post({
        lines: [
          { accountId: byCode['6010']!, debitMinor: 10_000 },
          { accountId: acc['bank_control']!, creditMinor: 9_900 },
        ],
      });
    } catch (error) {
      expect((error as Error).message).toContain('does not balance');
      expect((error as UnbalancedJournalError).detail?.differenceMinor).toBe(100);
    }
  });

  it('leaves no partial entry behind when validation fails', () => {
    expect(() => post({
      lines: [
        { accountId: byCode['6010']!, debitMinor: 10_000 },
        { accountId: acc['bank_control']!, creditMinor: 9_900 },
      ],
    })).toThrow();
    expect(db.select().from(journalEntries).all()).toHaveLength(0);
    expect(db.select().from(journalLines).all()).toHaveLength(0);
  });

  it('refuses a single-line entry', () => {
    expect(() => post({
      lines: [{ accountId: byCode['6010']!, debitMinor: 10_000 }],
    })).toThrow(InvalidLineError);
  });

  it('refuses a line with both a debit and a credit', () => {
    expect(() => post({
      lines: [
        { accountId: byCode['6010']!, debitMinor: 10_000, creditMinor: 500 },
        { accountId: acc['bank_control']!, creditMinor: 9_500 },
      ],
    })).toThrow(/both a debit and a credit/);
  });

  it('refuses a negative amount rather than flipping it silently', () => {
    expect(() => post({
      lines: [
        { accountId: byCode['6010']!, debitMinor: -10_000 },
        { accountId: acc['bank_control']!, debitMinor: 10_000 },
      ],
    })).toThrow(/negative amount/);
  });

  it('refuses a zero-amount line', () => {
    expect(() => post({
      lines: [
        { accountId: byCode['6010']!, debitMinor: 0 },
        { accountId: acc['bank_control']!, creditMinor: 0 },
      ],
    })).toThrow(/no amount/);
  });

  it('refuses a non-existent account', () => {
    expect(() => post({
      lines: [
        { accountId: 'acc_does_not_exist', debitMinor: 10_000 },
        { accountId: acc['bank_control']!, creditMinor: 10_000 },
      ],
    })).toThrow(MissingAccountError);
  });

  it('refuses a date with no accounting period', () => {
    expect(() => post({ entryDate: makeDate(2030, 1, 1) })).toThrow(NoPeriodError);
  });

  it('accepts a many-line entry that balances in aggregate', () => {
    const entry = post({
      lines: [
        { accountId: byCode['6010']!, debitMinor: 5_000 },
        { accountId: byCode['6000']!, debitMinor: 3_000 },
        { accountId: byCode['6020']!, debitMinor: 2_000 },
        { accountId: acc['bank_control']!, creditMinor: 10_000 },
      ],
    });
    expect(entry.lines).toHaveLength(4);
  });

  it('writes an audit row in the same transaction', () => {
    const entry = post();
    const audit = db.select().from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'journal_entry'), eq(auditEvents.entityId, entry.id)))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('created');
  });
});

describe('period locking', () => {
  const lockPeriod = (name: string) =>
    db.update(accountingPeriods).set({ status: 'locked' })
      .where(and(eq(accountingPeriods.companyId, companyId), eq(accountingPeriods.name, name)))
      .run();

  it('refuses to post into a locked period', () => {
    lockPeriod('FY 2025');
    expect(() => post()).toThrow(PeriodLockedError);
  });

  it('still allows posting into an open period', () => {
    lockPeriod('FY 2024');
    expect(() => post({ entryDate: makeDate(2025, 6, 1) })).not.toThrow();
    expect(() => post({ entryDate: makeDate(2024, 6, 1) })).toThrow(PeriodLockedError);
  });

  it('allows a deliberate override, and audits it with the reason', () => {
    lockPeriod('FY 2025');
    const entry = post({ overrideLock: { reason: 'Agreed correction with accountant' } });
    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'period_unlocked')).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.reason).toBe('Agreed correction with accountant');
    expect(entry.entryNumber).toBe(1);
  });
});

describe('immutability and reversal', () => {
  it('reverses an entry by posting the mirror image, leaving the original intact', () => {
    const original = post();
    const reversal = reverseJournalEntry(db, {
      companyId,
      entryId: original.id,
      reversalDate: makeDate(2025, 4, 1),
      reason: 'Coded to the wrong account',
    });

    const originalRow = db.select().from(journalEntries)
      .where(eq(journalEntries.id, original.id)).get()!;
    expect(originalRow.isPosted).toBe(true);
    expect(originalRow.reversedByEntryId).toBe(reversal.id);

    const originalLines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, original.id)).orderBy(journalLines.lineNumber).all();
    const reversalLines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, reversal.id)).orderBy(journalLines.lineNumber).all();

    expect(originalLines[0]!.debitMinor).toBe(10_000);
    expect(reversalLines[0]!.creditMinor).toBe(10_000);
    expect(reversalLines[0]!.debitMinor).toBe(0);
  });

  it('nets to zero after reversal', () => {
    const original = post();
    reverseJournalEntry(db, {
      companyId, entryId: original.id, reversalDate: makeDate(2025, 4, 1), reason: 'Error',
    });
    expect(accountBalance(db, { companyId, accountId: byCode['6010']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(0);
  });

  it('refuses to reverse the same entry twice', () => {
    const original = post();
    reverseJournalEntry(db, {
      companyId, entryId: original.id, reversalDate: makeDate(2025, 4, 1), reason: 'Error',
    });
    expect(() => reverseJournalEntry(db, {
      companyId, entryId: original.id, reversalDate: makeDate(2025, 4, 2), reason: 'Again',
    })).toThrow(/already been reversed/);
  });

  it('dates the reversal at the correction date, not the original date', () => {
    const original = post({ entryDate: makeDate(2025, 1, 10) });
    const reversal = reverseJournalEntry(db, {
      companyId, entryId: original.id, reversalDate: makeDate(2025, 5, 20), reason: 'Error',
    });
    const row = db.select().from(journalEntries).where(eq(journalEntries.id, reversal.id)).get()!;
    expect(row.entryDate).toBe('2025-05-20');
  });
});

describe('foreign currency', () => {
  it('converts to base currency using an exact rational rate', () => {
    // USD 120.00 at 1 USD = 0.92 EUR -> EUR 110.40
    const entry = post({
      lines: [
        {
          accountId: byCode['6000']!, debitMinor: 12_000, currency: 'USD',
          fxRate: { numerator: 92, denominator: 100, source: 'manual', date: '2025-03-15' },
        },
        {
          accountId: acc['bank_control']!, creditMinor: 12_000, currency: 'USD',
          fxRate: { numerator: 92, denominator: 100, source: 'manual', date: '2025-03-15' },
        },
      ],
    });
    expect(entry.lines[0]!.debitMinor).toBe(12_000);
    expect(entry.lines[0]!.currency).toBe('USD');
    expect(entry.lines[0]!.baseDebitMinor).toBe(11_040);
    expect(entry.lines[0]!.baseCurrency).toBe('EUR');
  });

  it('never replaces the original currency amount with the conversion', () => {
    const entry = post({
      lines: [
        {
          accountId: byCode['6000']!, debitMinor: 12_000, currency: 'USD',
          fxRate: { numerator: 92, denominator: 100, source: 'manual' },
        },
        {
          accountId: acc['bank_control']!, creditMinor: 12_000, currency: 'USD',
          fxRate: { numerator: 92, denominator: 100, source: 'manual' },
        },
      ],
    });
    const line = entry.lines[0]!;
    expect(line.debitMinor).not.toBe(line.baseDebitMinor);
    expect(line.fxRateNumerator).toBe(92);
    expect(line.fxRateDenominator).toBe(100);
    expect(line.fxRateSource).toBe('manual');
  });

  it('refuses a foreign-currency line with no rate rather than assuming 1.0', () => {
    expect(() => post({
      lines: [
        { accountId: byCode['6000']!, debitMinor: 12_000, currency: 'USD' },
        { accountId: acc['bank_control']!, creditMinor: 12_000, currency: 'USD' },
      ],
    })).toThrow(CurrencyMismatchError);
  });

  it('balances on base-currency amounts, not transaction amounts', () => {
    // A USD purchase settled from a EUR bank account: the two sides are in
    // different currencies and only balance after conversion.
    const entry = post({
      lines: [
        {
          accountId: byCode['6000']!, debitMinor: 10_000, currency: 'USD',
          fxRate: { numerator: 92, denominator: 100, source: 'ecb' },
        },
        { accountId: acc['bank_control']!, creditMinor: 9_200, currency: 'EUR' },
      ],
    });
    expect(entry.lines[0]!.baseDebitMinor).toBe(9_200);
    expect(entry.lines[1]!.baseCreditMinor).toBe(9_200);
  });
});

describe('trial balance', () => {
  it('balances after arbitrary sequences of postings', () => {
    for (let i = 0; i < 25; i++) {
      const amount = 1_000 + i * 137;
      post({
        entryDate: makeDate(2025, (i % 12) + 1, ((i * 3) % 28) + 1),
        lines: [
          { accountId: byCode['6010']!, debitMinor: amount },
          { accountId: acc['bank_control']!, creditMinor: amount },
        ],
      });
    }
    const tb = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0);
    expect(tb.totalDebitMinor).toBeGreaterThan(0);
  });

  it('balances with multi-line, multi-currency entries mixed in', () => {
    post({
      lines: [
        { accountId: byCode['6010']!, debitMinor: 5_000 },
        { accountId: byCode['6000']!, debitMinor: 3_333 },
        { accountId: acc['bank_control']!, creditMinor: 8_333 },
      ],
    });
    post({
      lines: [
        {
          accountId: byCode['6000']!, debitMinor: 9_999, currency: 'USD',
          fxRate: { numerator: 92, denominator: 100, source: 'ecb' },
        },
        {
          accountId: acc['bank_control']!, creditMinor: 9_999, currency: 'USD',
          fxRate: { numerator: 92, denominator: 100, source: 'ecb' },
        },
      ],
    });
    const tb = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    expect(tb.balanced).toBe(true);
  });

  it('respects the as-of date', () => {
    post({ entryDate: makeDate(2025, 1, 15) });
    post({ entryDate: makeDate(2025, 6, 15) });
    const early = trialBalance(db, { companyId, asOf: makeDate(2025, 3, 31) });
    const late = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    expect(early.totalDebitMinor).toBe(10_000);
    expect(late.totalDebitMinor).toBe(20_000);
  });

  it('reports balances on the correct natural side', () => {
    post();
    const tb = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    const expense = tb.rows.find((r) => r.code === '6010')!;
    const bank = tb.rows.find((r) => r.code === '1000')!;
    expect(expense.normalSide).toBe('debit');
    expect(expense.signedMinor).toBe(10_000);
    expect(bank.normalSide).toBe('debit');
    // The bank account is in credit, which is unusual and shows as negative.
    expect(bank.signedMinor).toBe(-10_000);
  });
});

describe('general ledger', () => {
  it('produces a running balance in the account’s natural direction', () => {
    post({ entryDate: makeDate(2025, 1, 10) });
    post({ entryDate: makeDate(2025, 2, 10) });
    const ledger = generalLedger(db, { companyId, accountId: byCode['6010']! });
    expect(ledger.lines).toHaveLength(2);
    expect(ledger.lines[0]!.runningBalanceMinor).toBe(10_000);
    expect(ledger.lines[1]!.runningBalanceMinor).toBe(20_000);
    expect(ledger.closingBalanceMinor).toBe(20_000);
  });

  it('flags reversal lines so they are visible in the trail', () => {
    const original = post();
    reverseJournalEntry(db, {
      companyId, entryId: original.id, reversalDate: makeDate(2025, 4, 1), reason: 'Error',
    });
    const ledger = generalLedger(db, { companyId, accountId: byCode['6010']! });
    expect(ledger.lines).toHaveLength(2);
    expect(ledger.lines[1]!.isReversal).toBe(true);
    expect(ledger.closingBalanceMinor).toBe(0);
  });
});

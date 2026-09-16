import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createAdjustment, reverseAdjustment, listAdjustments, AdjustmentError } from './adjustments';
import { trialBalance, accountBalance } from './ledger';
import { buildVat3Return } from '../vat/report';
import { journalEntries, auditEvents, accountingPeriods, vatPeriods } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
});

const adjust = (over: Partial<Parameters<typeof createAdjustment>[1]> = {}) =>
  createAdjustment(db, {
    companyId,
    date: makeDate(2025, 12, 31),
    description: 'Accrual for December accountancy fees',
    reason: 'Invoice not received by the year end; agreed with the accountant',
    lines: [
      { accountId: byCode['6070']!, debitMinor: 50_000 },
      { accountId: byCode['2300']!, creditMinor: 50_000 },
    ],
    ...over,
  });

describe('createAdjustment', () => {
  it('posts a balanced adjustment', () => {
    const result = adjust();
    expect(result.totalMinor).toBe(50_000);
    expect(accountBalance(db, { companyId, accountId: byCode['6070']! })).toBe(50_000);
    expect(accountBalance(db, { companyId, accountId: byCode['2300']! })).toBe(50_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('marks the entry as an adjustment so it is distinguishable', () => {
    const result = adjust();
    const entry = db.select().from(journalEntries)
      .where(eq(journalEntries.id, result.journalEntryId)).get()!;
    expect(entry.entryType).toBe('adjustment');
    expect(entry.notes).toContain('agreed with the accountant');
  });

  // The reason is the only record of why a figure was entered by hand.
  it('refuses an adjustment with no reason', () => {
    expect(() => adjust({ reason: '' })).toThrow(/needs a reason/);
    expect(() => adjust({ reason: 'x' })).toThrow(/needs a reason/);
  });

  it('refuses an unbalanced adjustment and says by how much', () => {
    expect(() => adjust({
      lines: [
        { accountId: byCode['6070']!, debitMinor: 50_000 },
        { accountId: byCode['2300']!, creditMinor: 49_000 },
      ],
    })).toThrow(/does not balance/);

    try {
      adjust({
        lines: [
          { accountId: byCode['6070']!, debitMinor: 50_000 },
          { accountId: byCode['2300']!, creditMinor: 49_000 },
        ],
      });
    } catch (error) {
      expect((error as Error).message).toContain('difference of 10.00');
      expect((error as Error).message).toContain('decide what the other side of this entry is');
    }
  });

  it('refuses a one-sided adjustment', () => {
    expect(() => adjust({
      lines: [{ accountId: byCode['6070']!, debitMinor: 50_000 }],
    })).toThrow(/at least two lines/);
  });

  it('refuses an account that does not exist', () => {
    expect(() => adjust({
      lines: [
        { accountId: 'acc_nope', debitMinor: 50_000 },
        { accountId: byCode['2300']!, creditMinor: 50_000 },
      ],
    })).toThrow(/does not exist/);
  });

  it('records the reason in the audit trail', () => {
    const result = adjust();
    const audit = db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.action, 'adjustment_posted'),
        eq(auditEvents.entityId, result.journalEntryId),
      )).get()!;
    expect(audit.reason).toContain('Invoice not received');
  });

  it('refuses to post into a locked period without an override', () => {
    db.update(accountingPeriods).set({ status: 'locked' })
      .where(eq(accountingPeriods.companyId, companyId)).run();
    expect(() => adjust()).toThrow(/locked/);
  });

  it('allows a deliberate override into a locked period, audited', () => {
    db.update(accountingPeriods).set({ status: 'locked' })
      .where(eq(accountingPeriods.companyId, companyId)).run();

    const result = adjust({
      overrideLock: { reason: 'Prior year correction agreed with the auditor' },
    });
    expect(result.totalMinor).toBe(50_000);

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'period_unlocked')).get()!;
    expect(audit.reason).toContain('agreed with the auditor');
  });

  it('carries a VAT consequence when one is supplied', () => {
    adjust({
      date: makeDate(2025, 3, 15),
      description: 'Correct under-claimed input VAT',
      reason: 'VAT on a receipt found after the return was filed',
      lines: [
        { accountId: acc['vat_on_purchases']!, debitMinor: 2_300 },
        { accountId: byCode['6010']!, creditMinor: 2_300 },
      ],
      vat: {
        treatmentId: tr['IE_STD']!, direction: 'purchases',
        netMinor: 10_000, statedVatMinor: 2_300,
      },
    });

    const periodId = db.select().from(vatPeriods)
      .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    expect(buildVat3Return(db, { companyId, vatPeriodId: periodId }).T2.amountMinor).toBe(2_300);
  });
});

describe('reverseAdjustment', () => {
  it('reverses without editing the original', () => {
    const original = adjust();
    const reversal = reverseAdjustment(db, {
      companyId, journalEntryId: original.journalEntryId,
      reversalDate: makeDate(2025, 12, 31),
      reason: 'The invoice arrived after all',
    });

    const entry = db.select().from(journalEntries)
      .where(eq(journalEntries.id, original.journalEntryId)).get()!;
    expect(entry.isPosted).toBe(true);
    expect(entry.reversedByEntryId).toBe(reversal.reversalEntryId);

    expect(accountBalance(db, { companyId, accountId: byCode['6070']! })).toBe(0);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('needs a reason to reverse', () => {
    const original = adjust();
    expect(() => reverseAdjustment(db, {
      companyId, journalEntryId: original.journalEntryId,
      reversalDate: makeDate(2025, 12, 31), reason: '',
    })).toThrow(/needs a reason/);
  });

  it('refuses to reverse an entry that is not an adjustment', () => {
    const entry = db.select().from(journalEntries).get();
    adjust();
    // Post a non-adjustment entry and try to reverse it from here.
    // We insert directly as a draft (is_posted = 0) so the immutability
    // trigger does not block the entryType change — the point is to test
    // the guard clause, not to bypass the trigger.
    const normal = createAdjustment(db, {
      companyId, date: makeDate(2025, 6, 1), description: 'x', reason: 'valid reason',
      lines: [
        { accountId: byCode['6070']!, debitMinor: 100 },
        { accountId: byCode['2300']!, creditMinor: 100 },
      ],
    });
    // Unpost the entry so the trigger allows the entryType change.
    db.update(journalEntries).set({ isPosted: false })
      .where(eq(journalEntries.id, normal.journalEntryId)).run();
    db.update(journalEntries).set({ entryType: 'standard', isPosted: true })
      .where(eq(journalEntries.id, normal.journalEntryId)).run();

    expect(() => reverseAdjustment(db, {
      companyId, journalEntryId: normal.journalEntryId,
      reversalDate: makeDate(2025, 12, 31), reason: 'Trying to reverse',
    })).toThrow(/not a manual adjustment/);
  });
});

describe('listAdjustments', () => {
  it('lists adjustments with their reasons and lines', () => {
    adjust();
    adjust({
      date: makeDate(2025, 6, 30), description: 'Prepayment',
      reason: 'Insurance paid in advance',
      lines: [
        { accountId: byCode['1600']!, debitMinor: 20_000 },
        { accountId: byCode['6090']!, creditMinor: 20_000 },
      ],
    });

    const all = listAdjustments(db, { companyId });
    expect(all).toHaveLength(2);
    expect(all[0]!.description).toBe('Accrual for December accountancy fees');
    expect(all[0]!.reason).toContain('agreed with the accountant');
    expect(all[0]!.lines).toHaveLength(2);
    expect(all[1]!.totalMinor).toBe(20_000);
  });

  it('shows when an adjustment has been reversed', () => {
    const original = adjust();
    reverseAdjustment(db, {
      companyId, journalEntryId: original.journalEntryId,
      reversalDate: makeDate(2025, 12, 31), reason: 'Not needed',
    });
    const listed = listAdjustments(db, { companyId })
      .find((a) => a.entryId === original.journalEntryId)!;
    expect(listed.reversedByEntryId).toBeTruthy();
  });

  it('filters by date range', () => {
    adjust({ date: makeDate(2025, 3, 1) });
    adjust({ date: makeDate(2025, 9, 1) });
    const filtered = listAdjustments(db, {
      companyId, from: makeDate(2025, 6, 1), to: makeDate(2025, 12, 31),
    });
    expect(filtered).toHaveLength(1);
  });
});

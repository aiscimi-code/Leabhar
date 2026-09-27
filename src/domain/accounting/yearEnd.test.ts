import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { closeFinancialYear, getYearEndClose, YearEndError } from './yearEnd';
import { trialBalance, accountBalance } from './ledger';
import { postJournalEntry, reverseJournalEntry } from './journal';
import { profitAndLoss, balanceSheet } from '../reports/financial';
import { computeCorporationTax } from '../corporationTax/computation';
import {
  journalEntries, accountingPeriods, auditEvents,
} from '@/db/schema';
import { addPartner, setPartnerShare, allocateByShares } from '../config/partners';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let acc: Record<string, string>;
let fy2025: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  acc = created.accountsByKey;
  fy2025 = db.select().from(accountingPeriods)
    .where(and(
      eq(accountingPeriods.companyId, companyId),
      eq(accountingPeriods.kind, 'financial_year'),
      eq(accountingPeriods.name, 'FY 2025'),
    )).get()!.id;
});

/** A year with 10,000.00 of sales, 6,170.00 of costs, and a bank control balance. */
function postAYearsTrading(): void {
  postJournalEntry(db, {
    companyId,
    entryDate: makeDate(2025, 3, 31),
    narrative: 'Sales for the first quarter',
    sourceType: 'sales_invoice',
    baseCurrency: 'EUR',
    lines: [
      { accountId: acc['bank_control']!, debitMinor: 1_000_000 },
      { accountId: byCode['4000']!, creditMinor: 1_000_000 },
    ],
  });
  postJournalEntry(db, {
    companyId,
    entryDate: makeDate(2025, 9, 30),
    narrative: 'Costs for the year',
    sourceType: 'purchase_invoice',
    baseCurrency: 'EUR',
    lines: [
      { accountId: byCode['6000']!, debitMinor: 500_000 },
      { accountId: byCode['6070']!, debitMinor: 117_000 },
      { accountId: acc['bank_control']!, creditMinor: 617_000 },
    ],
  });
}

describe('closeFinancialYear', () => {
  it('empties the income and expense accounts into retained earnings', () => {
    postAYearsTrading();

    const close = closeFinancialYear(db, { companyId, periodId: fy2025 });

    // 3,830.00 of profit lands in retained earnings.
    expect(close.netResultMinor).toBe(383_000);
    expect(close.totalIncomeMinor).toBe(1_000_000);
    expect(close.totalExpenseMinor).toBe(617_000);
    expect(close.retainedEarningsBalanceMinor).toBe(383_000);

    // Every income and expense account is empty at the year-end date.
    const tb = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    const remaining = tb.rows.filter((r) =>
      (r.type === 'income' || r.type === 'expense') && r.netDebitMinor !== 0);
    expect(remaining).toEqual([]);
    expect(tb.balanced).toBe(true);

    // And the balance sheet no longer reports prior-year profit in the P&L.
    const bs = balanceSheet(db, {
      companyId, asOf: makeDate(2026, 1, 31), financialYearStart: makeDate(2026, 1, 1),
    });
    expect(bs.retainedEarnings.notes).toEqual([]);
    expect(bs.balances).toBe(true);
  });

  it('posts one closing entry, dated on the year end, through the ordinary engine', () => {
    postAYearsTrading();
    const close = closeFinancialYear(db, { companyId, periodId: fy2025 });

    const entry = db.select().from(journalEntries)
      .where(eq(journalEntries.id, close.journalEntryId)).get()!;
    expect(entry.entryDate).toBe(makeDate(2025, 12, 31));
    expect(entry.sourceType).toBe('year_end_close');
    expect(entry.sourceId).toBe(fy2025);
    expect(entry.entryType).toBe('closing');
    expect(entry.isPosted).toBe(true);

    const audit = db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.action, 'year_end_closed'),
        eq(auditEvents.entityId, fy2025),
      )).get()!;
    expect(audit.newValue).toContain('"netResultMinor":383000');

    expect(getYearEndClose(db, { companyId, periodId: fy2025 })).toMatchObject({
      journalEntryId: close.journalEntryId,
      netResultMinor: 383_000,
      reversed: false,
    });
  });

  it('closes a loss year by debiting retained earnings', () => {
    postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 30),
      narrative: 'Costs exceed sales this year',
      sourceType: 'purchase_invoice',
      baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['6000']!, debitMinor: 700_000 },
        { accountId: byCode['4000']!, creditMinor: 500_000 },
        { accountId: acc['bank_control']!, creditMinor: 200_000 },
      ],
    });

    const close = closeFinancialYear(db, { companyId, periodId: fy2025 });
    expect(close.netResultMinor).toBe(-200_000);
    expect(close.retainedEarningsBalanceMinor).toBe(-200_000);

    const tb = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    expect(tb.rows.filter((r) =>
      (r.type === 'income' || r.type === 'expense') && r.netDebitMinor !== 0)).toEqual([]);
  });

  it('leaves the closed year\'s profit and loss unchanged: the closing entry is not trading', () => {
    postAYearsTrading();
    const year = { companyId, from: makeDate(2025, 1, 1), to: makeDate(2025, 12, 31) };
    const before = profitAndLoss(db, year);
    expect(before.netProfit.valueMinor).toBe(383_000);

    const close = closeFinancialYear(db, { companyId, periodId: fy2025 });
    const after = profitAndLoss(db, year);
    expect(after.netProfit.valueMinor).toBe(383_000);
    expect(after.revenue.valueMinor).toBe(before.revenue.valueMinor);

    // Reversing the close, dated in the same year, does not move it either.
    reverseJournalEntry(db, {
      companyId, entryId: close.journalEntryId,
      reversalDate: makeDate(2025, 12, 31), reason: 'Re-run the close',
    });
    expect(profitAndLoss(db, year).netProfit.valueMinor).toBe(383_000);
  });

  it('leaves the closed year\'s corporation tax computation unchanged', () => {
    postAYearsTrading();
    const year = { companyId, from: makeDate(2025, 1, 1), to: makeDate(2025, 12, 31) };
    const before = computeCorporationTax(db, year);
    expect(before.accountingProfitMinor).toBe(383_000);

    closeFinancialYear(db, { companyId, periodId: fy2025 });
    const after = computeCorporationTax(db, year);
    expect(after.accountingProfitMinor).toBe(383_000);
    expect(after.corporationTaxMinor).toBe(before.corporationTaxMinor);
  });

  it('refuses to close the same year twice', () => {
    postAYearsTrading();
    closeFinancialYear(db, { companyId, periodId: fy2025 });

    expect(() => closeFinancialYear(db, { companyId, periodId: fy2025 }))
      .toThrow(/already closed by entry/);
  });

  it('re-runs after the closing entry is reversed, never by editing it', () => {
    postAYearsTrading();
    const first = closeFinancialYear(db, { companyId, periodId: fy2025 });

    reverseJournalEntry(db, {
      companyId, entryId: first.journalEntryId,
      reversalDate: makeDate(2025, 12, 31), reason: 'A late invoice belongs in the year',
    });

    expect(getYearEndClose(db, { companyId, periodId: fy2025 })!.reversed).toBe(true);

    const second = closeFinancialYear(db, { companyId, periodId: fy2025 });
    expect(second.journalEntryId).not.toBe(first.journalEntryId);
    expect(second.netResultMinor).toBe(383_000);
  });

  it('refuses a locked year without an override, and records the override', () => {
    postAYearsTrading();
    db.update(accountingPeriods).set({ status: 'locked' })
      .where(eq(accountingPeriods.id, fy2025)).run();

    expect(() => closeFinancialYear(db, { companyId, periodId: fy2025 }))
      .toThrow(/locked|closed/);

    const close = closeFinancialYear(db, {
      companyId, periodId: fy2025,
      overrideLock: { reason: 'The close was agreed with the accountant after the lock' },
    });
    expect(close.netResultMinor).toBe(383_000);

    const override = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'period_unlocked')).get()!;
    expect(override.reason).toContain('agreed with the accountant');
  });

  it('refuses a period that is not a financial year, and a year with nothing to close', () => {
    const month = db.select().from(accountingPeriods)
      .where(and(
        eq(accountingPeriods.companyId, companyId),
        eq(accountingPeriods.kind, 'month'),
      )).get()!;
    expect(() => closeFinancialYear(db, { companyId, periodId: month.id }))
      .toThrow(/not a financial year/);

    expect(() => closeFinancialYear(db, { companyId, periodId: fy2025 }))
      .toThrow(/nothing to close/);
  });

  it('includes a prior year that was never closed, in the first close that runs', () => {
    postAYearsTrading();

    // 2026 trades too; its figures are not touched by the 2025 close.
    postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2026, 3, 31),
      narrative: 'Sales for 2026',
      sourceType: 'sales_invoice',
      baseCurrency: 'EUR',
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 400_000 },
        { accountId: byCode['4000']!, creditMinor: 400_000 },
      ],
    });

    const close = closeFinancialYear(db, { companyId, periodId: fy2025 });
    // Only the 2025 balances are closed; 2026's 4,000.00 of sales still stands.
    expect(close.totalIncomeMinor).toBe(1_000_000);
    expect(accountBalance(db, {
      companyId, accountId: byCode['4000']!, asOf: makeDate(2026, 12, 31),
    })).toBe(400_000);

    const pl2026 = profitAndLoss(db, {
      companyId, from: makeDate(2026, 1, 1), to: makeDate(2026, 12, 31),
    });
    expect(pl2026.netProfit.valueMinor).toBe(400_000);
  });
});

describe('closeFinancialYear for a partnership (issue #375)', () => {
  let db: AppDatabase;
  let companyId: string;
  let byCode: Record<string, string>;
  let acc: Record<string, string>;
  let fy2025: string;
  let aoife: { id: string; currentAccountId: string | null };
  let brian: { id: string; currentAccountId: string | null };

  beforeEach(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, {
      legalName: 'Byrne & Walsh', entityType: 'partnership', tradeCommencedOn: '2024-01-01',
      vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
    });
    companyId = created.companyId;
    byCode = created.accountsByCode;
    acc = created.accountsByKey;
    fy2025 = db.select().from(accountingPeriods)
      .where(and(
        eq(accountingPeriods.companyId, companyId),
        eq(accountingPeriods.kind, 'financial_year'),
        eq(accountingPeriods.name, 'FY 2025'),
      )).get()!.id;
    aoife = addPartner(db, {
      companyId, name: 'Aoife', shareBasisPoints: 5_000, joinedOn: '2024-01-01',
      recordedBy: 'Aoife', isPrecedentPartner: true,
    });
    brian = addPartner(db, { companyId, name: 'Brian', shareBasisPoints: 5_000, joinedOn: '2024-01-01', recordedBy: 'Aoife' });
  });

  /** A year with 10,000.00 of sales and 5,000.00 of costs: a 5,000.00 result. */
  const postAYearsTrading = () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 31), narrative: 'Sales for the first quarter',
      sourceType: 'sales_invoice', baseCurrency: 'EUR',
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 1_000_000 },
        { accountId: byCode['4000']!, creditMinor: 1_000_000 },
      ],
    });
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 9, 30), narrative: 'Costs for the year',
      sourceType: 'purchase_invoice', baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['6000']!, debitMinor: 500_000 },
        { accountId: acc['bank_control']!, creditMinor: 500_000 },
      ],
    });
  };

  it("allocates the year's result to the partners' current accounts, not to reserves", () => {
    postAYearsTrading();
    const close = closeFinancialYear(db, { companyId, periodId: fy2025 });

    expect(close.netResultMinor).toBe(500_000);
    expect(close.allocation).toEqual([
      { partnerId: aoife.id, partnerName: 'Aoife', amountMinor: 250_000 },
      { partnerId: brian.id, partnerName: 'Brian', amountMinor: 250_000 },
    ]);
    // Each partner's own current account carries their share; reserves do not.
    expect(accountBalance(db, { companyId, accountId: aoife.currentAccountId!, asOf: makeDate(2025, 12, 31) })).toBe(250_000);
    expect(accountBalance(db, { companyId, accountId: brian.currentAccountId!, asOf: makeDate(2025, 12, 31) })).toBe(250_000);
    expect(accountBalance(db, { companyId, accountId: acc['retained_earnings']!, asOf: makeDate(2025, 12, 31) })).toBe(0);

    const tb = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    expect(tb.balanced).toBe(true);
    expect(getYearEndClose(db, { companyId, periodId: fy2025 })).toMatchObject({
      netResultMinor: 500_000,
      reversed: false,
    });
  });

  it('allocates day by day through a share change, and the parts add up exactly', () => {
    postAYearsTrading();
    setPartnerShare(db, { companyId, partnerId: aoife.id, shareBasisPoints: 7_000, effectiveFrom: '2025-07-02', recordedBy: 'Aoife' });
    setPartnerShare(db, { companyId, partnerId: brian.id, shareBasisPoints: 3_000, effectiveFrom: '2025-07-02', recordedBy: 'Aoife' });

    const close = closeFinancialYear(db, { companyId, periodId: fy2025 });

    // 182 days at 50/50, 183 days at 70/30 of 5,000: day-weighted shares,
    // with the rounding residue (a cent or two) going to the precedent partner.
    const seg1 = Math.round(500_000 * 182 / 365);
    const seg2 = Math.round(500_000 * 183 / 365);
    const aoifeExpected = Math.round(seg1 * 0.5) + Math.round(seg2 * 0.7);
    const brianExpected = Math.round(seg1 * 0.5) + Math.round(seg2 * 0.3);
    const byName = Object.fromEntries(close.allocation.map((a) => [a.partnerName, a.amountMinor]));
    expect(close.allocation.reduce((s, a) => s + a.amountMinor, 0)).toBe(500_000);
    expect(Math.abs(byName.Aoife! - aoifeExpected)).toBeLessThanOrEqual(2);
    expect(Math.abs(byName.Brian! - brianExpected)).toBeLessThanOrEqual(2);

    // The books carry exactly what the one allocation function computed, so
    // the close and the Form 1 (Firms) statement cannot disagree.
    expect(close.allocation).toEqual(allocateByShares(db, companyId, {
      from: '2025-01-01', to: '2025-12-31', amountMinor: 500_000,
    }).map((a) => ({ partnerId: a.partner.id, partnerName: a.partner.name, amountMinor: a.amountMinor })));
  });

  it('refuses to close when the partners\' shares do not add up to 100%', () => {
    postAYearsTrading();
    setPartnerShare(db, { companyId, partnerId: aoife.id, shareBasisPoints: 6_000, effectiveFrom: '2025-01-01', recordedBy: 'Aoife' });
    // Aoife 6,000 and Brian 5,000: 110%.
    expect(() => closeFinancialYear(db, { companyId, periodId: fy2025 }))
      .toThrow(/do not add up to 100%/);
    // And nothing was posted.
    expect(accountBalance(db, { companyId, accountId: aoife.currentAccountId!, asOf: makeDate(2025, 12, 31) })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: byCode['4000']!, asOf: makeDate(2025, 12, 31) })).toBe(1_000_000);
  });

  it('allocates a loss to the partners\' current accounts by debit', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 6, 30), narrative: 'A bad year',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['6000']!, debitMinor: 800_000 },
        { accountId: acc['bank_control']!, creditMinor: 800_000 },
      ],
    });
    const close = closeFinancialYear(db, { companyId, periodId: fy2025 });
    expect(close.netResultMinor).toBe(-800_000);
    expect(close.allocation.map((a) => a.amountMinor)).toEqual([-400_000, -400_000]);
    expect(accountBalance(db, { companyId, accountId: aoife.currentAccountId!, asOf: makeDate(2025, 12, 31) })).toBe(-400_000);
  });

  it('refuses to close a partnership with no partners recorded', () => {
    const { db: emptyDb } = createTestDatabase();
    const created = createCompany(emptyDb, {
      legalName: 'Nobody & Co', entityType: 'partnership', tradeCommencedOn: '2024-01-01',
      vatRegistrationStatus: 'registered', seedYears: [2025],
    });
    const fy = emptyDb.select().from(accountingPeriods)
      .where(and(
        eq(accountingPeriods.companyId, created.companyId),
        eq(accountingPeriods.kind, 'financial_year'),
        eq(accountingPeriods.name, 'FY 2025'),
      )).get()!.id;
    postJournalEntry(emptyDb, {
      companyId: created.companyId, entryDate: makeDate(2025, 3, 31), narrative: 'Sales',
      sourceType: 'sales_invoice', baseCurrency: 'EUR',
      lines: [
        { accountId: created.accountsByKey['bank_control']!, debitMinor: 1_000_000 },
        { accountId: created.accountsByCode['4000']!, creditMinor: 1_000_000 },
      ],
    });
    expect(() => closeFinancialYear(emptyDb, { companyId: created.companyId, periodId: fy }))
      .toThrow(/none is recorded/);
  });
});

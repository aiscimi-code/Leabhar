import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  buildDepreciationSchedule, postDepreciation, capitalAllowancesForYear, disposeAsset,
} from './depreciation';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { fixedAssets, depreciationCharges, journalLines } from '@/db/schema';
import { postJournalEntry } from '../accounting/journal';
import { makeDate, asIsoDate } from '../dates';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;

/**
 * Create an asset the way one actually arises: a posted purchase that put the
 * cost onto the balance sheet, plus the asset-register row describing it.
 */
const addAsset = (over: Partial<typeof fixedAssets.$inferInsert> = {}): string => {
  const id = ids.fixedAsset();
  const cost = (over.baseCostMinor as number | undefined) ?? 240_000;
  const purchaseDate = (over.purchaseDate as string | undefined) ?? '2025-01-01';
  db.insert(fixedAssets).values({
    id, companyId, name: 'MacBook Pro', assetCategory: 'computer_equipment',
    purchaseDate: '2025-01-01', costMinor: 240_000, currency: 'EUR',
    baseCostMinor: 240_000, baseCurrency: 'EUR',
    accountId: acc['computer_equipment'],
    accumulatedDepreciationAccountId: acc['accumulated_depreciation'],
    depreciationExpenseAccountId: acc['depreciation_expense'],
    depreciationMethod: 'straight_line', usefulLifeMonths: 24,
    depreciationStartDate: '2025-01-01',
    capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8,
    status: 'active',
    ...over,
  }).run();

  postJournalEntry(db, {
    companyId, entryDate: asIsoDate(purchaseDate),
    narrative: 'Purchase of fixed asset', sourceType: 'fixed_asset', sourceId: id,
    baseCurrency: 'EUR',
    lines: [
      { accountId: acc['computer_equipment']!, debitMinor: cost },
      { accountId: acc['bank_control']!, creditMinor: cost },
    ],
  });

  return id;
};

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2024, 2025, 2026] });
  companyId = created.companyId;
  acc = created.accountsByKey;
});

describe('buildDepreciationSchedule', () => {
  it('spreads the cost evenly over the useful life', () => {
    const assetId = addAsset();
    const schedule = buildDepreciationSchedule(db, { companyId, assetId });

    expect(schedule.periods).toHaveLength(24);
    expect(schedule.periods[0]!.chargeMinor).toBe(10_000);
    expect(schedule.totalChargeMinor).toBe(240_000);
    expect(schedule.periods[23]!.netBookValueMinor).toBe(0);
  });

  // Rounding each month independently would leave cents on the books for ever.
  it('depreciates to exactly the residual value on an awkward cost', () => {
    const assetId = addAsset({ baseCostMinor: 100_000, usefulLifeMonths: 7 });
    const schedule = buildDepreciationSchedule(db, { companyId, assetId });
    expect(schedule.totalChargeMinor).toBe(100_000);
    expect(schedule.periods[schedule.periods.length - 1]!.netBookValueMinor).toBe(0);
  });

  it('respects a residual value', () => {
    const assetId = addAsset({ residualValueMinor: 40_000, usefulLifeMonths: 20 });
    const schedule = buildDepreciationSchedule(db, { companyId, assetId });
    expect(schedule.totalChargeMinor).toBe(200_000);
    expect(schedule.periods[schedule.periods.length - 1]!.netBookValueMinor).toBe(40_000);
  });

  it('produces nothing for an asset with no depreciation policy', () => {
    const assetId = addAsset({ depreciationMethod: 'none' });
    expect(buildDepreciationSchedule(db, { companyId, assetId }).periods).toHaveLength(0);
  });

  it('stops at the requested date', () => {
    const assetId = addAsset();
    const schedule = buildDepreciationSchedule(db, {
      companyId, assetId, upTo: makeDate(2025, 6, 30),
    });
    expect(schedule.periods).toHaveLength(6);
  });
});

describe('postDepreciation', () => {
  it('posts the charge to expense and accumulated depreciation', () => {
    addAsset();
    const result = postDepreciation(db, { companyId, upTo: makeDate(2025, 3, 31) });

    expect(result.periodsPosted).toBe(3);
    expect(result.totalChargeMinor).toBe(30_000);

    expect(accountBalance(db, { companyId, accountId: acc['depreciation_expense']! }))
      .toBe(30_000);
    // Accumulated depreciation is an asset account in credit: it reduces the
    // asset section while leaving the original cost visible.
    expect(accountBalance(db, { companyId, accountId: acc['accumulated_depreciation']! }))
      .toBe(-30_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  // The obvious way to use this is to run it at every period end.
  it('does not double-charge when run twice', () => {
    addAsset();
    postDepreciation(db, { companyId, upTo: makeDate(2025, 3, 31) });
    const second = postDepreciation(db, { companyId, upTo: makeDate(2025, 3, 31) });

    expect(second.periodsPosted).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['depreciation_expense']! }))
      .toBe(30_000);
  });

  it('picks up only the new periods on a later run', () => {
    addAsset();
    postDepreciation(db, { companyId, upTo: makeDate(2025, 3, 31) });
    const second = postDepreciation(db, { companyId, upTo: makeDate(2025, 6, 30) });

    expect(second.periodsPosted).toBe(3);
    expect(accountBalance(db, { companyId, accountId: acc['depreciation_expense']! }))
      .toBe(60_000);
  });

  it('updates the accumulated depreciation on the asset', () => {
    const assetId = addAsset();
    postDepreciation(db, { companyId, upTo: makeDate(2025, 3, 31) });
    const asset = db.select().from(fixedAssets).where(eq(fixedAssets.id, assetId)).get()!;
    expect(asset.accumulatedDepreciationMinor).toBe(30_000);
    expect(asset.status).toBe('active');
  });

  it('marks an asset fully depreciated at the end of its life', () => {
    const assetId = addAsset({ usefulLifeMonths: 3 });
    postDepreciation(db, { companyId, upTo: makeDate(2025, 12, 31) });
    const asset = db.select().from(fixedAssets).where(eq(fixedAssets.id, assetId)).get()!;
    expect(asset.accumulatedDepreciationMinor).toBe(240_000);
    expect(asset.status).toBe('fully_depreciated');
  });

  it('skips an asset still awaiting review rather than depreciating a guess', () => {
    addAsset({ status: 'pending_review' });
    const result = postDepreciation(db, { companyId, upTo: makeDate(2025, 3, 31) });
    expect(result.periodsPosted).toBe(0);
    expect(result.skipped[0]!.reason).toContain('Confirm it is a capital purchase');
  });

  it('records each charge so the schedule can be audited', () => {
    addAsset();
    postDepreciation(db, { companyId, upTo: makeDate(2025, 2, 28) });
    const charges = db.select().from(depreciationCharges).all();
    expect(charges).toHaveLength(2);
    expect(charges.every((c) => c.chargeType === 'accounting_depreciation')).toBe(true);
    expect(charges.every((c) => c.journalEntryId !== null)).toBe(true);
  });
});

describe('capitalAllowancesForYear', () => {
  it('computes the allowance from the asset’s own configuration', () => {
    addAsset();
    const result = capitalAllowancesForYear(db, {
      companyId, yearStart: makeDate(2025, 1, 1), yearEnd: makeDate(2025, 12, 31),
    });

    // 12.5% of 2,400.00
    expect(result.totalMinor).toBe(30_000);
    expect(result.lines[0]!.rateBasisPoints).toBe(1250);
    expect(result.lines[0]!.note).toContain('as configured on this asset');
  });

  it('never posts capital allowances to the ledger', () => {
    addAsset();
    capitalAllowancesForYear(db, {
      companyId, yearStart: makeDate(2025, 1, 1), yearEnd: makeDate(2025, 12, 31),
    });
    // A tax figure is not an accounting entry: only the purchase was posted.
    const entries = db.select().from(journalLines).all();
    expect(entries).toHaveLength(2);
    expect(entries.every((l) => l.accountId !== acc['depreciation_expense'])).toBe(true);
  });

  it('stops once the cost is fully written down', () => {
    // Claimed in full in its first year, so nothing remains for the next one.
    addAsset({ purchaseDate: '2024-01-01', capitalAllowanceRateBasisPoints: 10_000 });
    const result = capitalAllowancesForYear(db, {
      companyId, yearStart: makeDate(2025, 1, 1), yearEnd: makeDate(2025, 12, 31),
    });
    expect(result.totalMinor).toBe(0);
  });

  it('excludes an asset bought after the year end', () => {
    addAsset({ purchaseDate: '2026-06-01', depreciationStartDate: '2026-06-01' });
    const result = capitalAllowancesForYear(db, {
      companyId, yearStart: makeDate(2025, 1, 1), yearEnd: makeDate(2025, 12, 31),
    });
    expect(result.totalMinor).toBe(0);
  });

  it('says plainly what it does not compute', () => {
    addAsset();
    const result = capitalAllowancesForYear(db, {
      companyId, yearStart: makeDate(2025, 1, 1), yearEnd: makeDate(2025, 12, 31),
    });
    expect(result.caveat).toContain('balancing allowances or charges on disposals');
    expect(result.caveat).toContain('Confirm the rates against current legislation');
  });
});

describe('disposeAsset', () => {
  it('removes cost and accumulated depreciation and posts the profit', () => {
    const assetId = addAsset();
    postDepreciation(db, { companyId, upTo: makeDate(2025, 12, 31) });

    const result = disposeAsset(db, {
      companyId, assetId, disposalDate: makeDate(2026, 1, 15), proceedsMinor: 150_000,
    });

    // Cost 2,400.00 less 12 months at 100.00 = net book value 1,200.00.
    // Sold for 1,500.00, so a 300.00 profit.
    expect(result.profitOrLossMinor).toBe(30_000);
    expect(accountBalance(db, { companyId, accountId: acc['computer_equipment']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['accumulated_depreciation']! })).toBe(0);
    expect(trialBalance(db, { companyId, asOf: makeDate(2026, 12, 31) }).balanced).toBe(true);
  });

  it('posts a loss when sold below net book value', () => {
    const assetId = addAsset();
    postDepreciation(db, { companyId, upTo: makeDate(2025, 12, 31) });
    const result = disposeAsset(db, {
      companyId, assetId, disposalDate: makeDate(2026, 1, 15), proceedsMinor: 50_000,
    });
    expect(result.profitOrLossMinor).toBe(-70_000);
    expect(trialBalance(db, { companyId, asOf: makeDate(2026, 12, 31) }).balanced).toBe(true);
  });

  it('flags the balancing allowance without calculating it', () => {
    const assetId = addAsset();
    const result = disposeAsset(db, {
      companyId, assetId, disposalDate: makeDate(2026, 1, 15), proceedsMinor: 100_000,
    });
    expect(result.taxNote).toContain('balancing allowance or a balancing charge');
    expect(result.taxNote).toContain('does not compute the balancing figure');
  });

  it('refuses to dispose of the same asset twice', () => {
    const assetId = addAsset();
    disposeAsset(db, {
      companyId, assetId, disposalDate: makeDate(2026, 1, 15), proceedsMinor: 100_000,
    });
    expect(() => disposeAsset(db, {
      companyId, assetId, disposalDate: makeDate(2026, 2, 15), proceedsMinor: 50_000,
    })).toThrow(/already been disposed/);
  });

  it('stops depreciating a disposed asset', () => {
    const assetId = addAsset();
    postDepreciation(db, { companyId, upTo: makeDate(2025, 6, 30) });
    disposeAsset(db, {
      companyId, assetId, disposalDate: makeDate(2025, 7, 1), proceedsMinor: 100_000,
    });
    const result = postDepreciation(db, { companyId, upTo: makeDate(2025, 12, 31) });
    expect(result.periodsPosted).toBe(0);
    expect(result.skipped[0]!.reason).toBe('Disposed of.');
  });
});

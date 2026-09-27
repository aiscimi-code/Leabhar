import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedTestBook } from '@/db/testing';
import { reviewItems, fixedAssetTransfers } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { asIsoDate } from '../dates';
import { postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { postDepreciation, disposeAsset } from './depreciation';
import { registerFixedAsset, transferFixedAsset, reconcileFixedAssets, recordCarEmissions } from './register';
import { capitalAllowances } from '../corporationTax/computation';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let bankAccountId: string;
let bankControl: string;

beforeEach(() => {
  const book = seedTestBook({ seedYears: [2025, 2026] });
  ({ db, companyId, bankAccountId } = book);
  byCode = book.accountsByCode;
  bankControl = book.accountsByKey['bank_control']!;
});

/** A purchase posted to a fixed-asset account, as an invoice or a classified bank line would post it. */
function purchase(code: string, amountMinor: number, date = '2025-03-01') {
  postJournalEntry(db, {
    companyId, entryDate: asIsoDate(date), narrative: 'Purchase', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
    lines: [{ accountId: byCode[code]!, debitMinor: amountMinor }, { accountId: bankControl, creditMinor: amountMinor }],
  });
}

const laptop = (over: Partial<Parameters<typeof registerFixedAsset>[1]> = {}) => registerFixedAsset(db, {
  companyId, name: 'Laptop', assetCategory: 'computer_equipment', purchaseDate: '2025-03-01', costMinor: 300_000,
  accountId: byCode['1500']!, usefulLifeMonths: 36, recordedBy: 'owner', ...over,
});

describe('registering an acquisition (issue #534)', () => {
  it('records an asset the ledger holds, and refuses one it does not', () => {
    purchase('1500', 300_000);
    expect(laptop().asset).toMatchObject({ status: 'active', baseCostMinor: 300_000, accountId: byCode['1500'] });
    expect(() => laptop({ name: 'Second laptop' })).toThrow(/0\.00 is left, not 3000\.00/);
  });

  it('refuses an account that is not a fixed-asset cost account', () => {
    purchase('1500', 300_000);
    expect(() => laptop({ accountId: byCode['6120']! })).toThrow(/not a fixed-asset cost account/);
    expect(() => laptop({ accountId: byCode['1510']! })).toThrow(/not a fixed-asset cost account/);
  });

  it('warns that a car without CO2 emissions is not restricted, and records them with evidence', () => {
    purchase('1590', 3_000_000);
    const { asset, warnings } = registerFixedAsset(db, {
      companyId, name: 'Company car', assetCategory: 'motor_vehicles', purchaseDate: '2025-03-01', costMinor: 3_000_000,
      accountId: byCode['1590']!, recordedBy: 'owner',
    });
    expect(warnings.join(' ')).toMatch(/Part 11C/);
    recordCarEmissions(db, { companyId, assetId: asset.id, gramsPerKm: 150, evidence: 'Registration certificate', recordedBy: 'owner' });
    expect(() => recordCarEmissions(db, { companyId, assetId: asset.id, gramsPerKm: 130, evidence: 'VRT', recordedBy: 'owner' })).toThrow(/reason/);
    // Category C in 2025: the lesser of €12,000 or half the €30,000 cost; 12.5% of that.
    expect(capitalAllowances(db, { companyId, from: '2025-01-01', to: '2025-12-31' }).lines[0]!.amountMinor).toBe(-150_000);
  });
});

describe('transfers and reconciliation (issue #534)', () => {
  it('moves the cost between accounts with one journal and keeps the history', () => {
    purchase('1500', 300_000);
    const { asset } = laptop();
    transferFixedAsset(db, { companyId, assetId: asset.id, toAccountId: byCode['1520']!, date: '2025-06-01', reason: 'Reclassified', recordedBy: 'owner' });
    const bal = (code: string) => accountBalance(db, { companyId, accountId: byCode[code]!, asOf: asIsoDate('2025-12-31') });
    expect([bal('1500'), bal('1520')]).toEqual([0, 300_000]);
    expect(db.select().from(fixedAssetTransfers).all()).toHaveLength(1);
    expect(reconcileFixedAssets(db, { companyId, asOf: '2025-05-31' }).accounts).toEqual([
      expect.objectContaining({ code: '1500', kind: 'cost', ledgerMinor: 300_000, registerMinor: 300_000, differenceMinor: 0 }),
    ]);
    expect(reconcileFixedAssets(db, { companyId, asOf: '2025-12-31' }).accounts.filter((a) => a.kind === 'cost')).toEqual([
      expect.objectContaining({ code: '1520', ledgerMinor: 300_000, registerMinor: 300_000, differenceMinor: 0 }),
    ]);
    expect(() => transferFixedAsset(db, { companyId, assetId: asset.id, toAccountId: byCode['1500']!, date: '2025-04-01', reason: 'x', recordedBy: 'owner' }))
      .toThrow(/date order/);
  });

  it('agrees the accumulated depreciation account with the register\'s charges, and after a disposal', () => {
    purchase('1500', 360_000);
    const { asset } = laptop({ costMinor: 360_000 });
    postDepreciation(db, { companyId, upTo: asIsoDate('2025-12-31') });
    const rec = reconcileFixedAssets(db, { companyId, asOf: '2025-12-31' });
    const acc = rec.accounts.find((a) => a.kind === 'accumulated_depreciation')!;
    expect(acc.ledgerMinor).toBeGreaterThan(0);
    expect(acc.differenceMinor).toBe(0);
    disposeAsset(db, { companyId, assetId: asset.id, disposalDate: asIsoDate('2026-01-15'), proceedsMinor: 100_000, bankAccountId });
    expect(reconcileFixedAssets(db, { companyId, asOf: '2026-01-31' }).accounts.every((a) => a.differenceMinor === 0)).toBe(true);
  });

  it('reports a purchase posted but not registered, and adjusts nothing', () => {
    purchase('1520', 50_000);
    const rec = reconcileFixedAssets(db, { companyId, asOf: '2025-12-31' });
    expect(rec.accounts).toEqual([expect.objectContaining({ code: '1520', ledgerMinor: 50_000, registerMinor: 0, differenceMinor: 50_000 })]);
    expect(db.select().from(reviewItems).where(eq(reviewItems.kind, 'reconciliation_difference')).all()).toHaveLength(1);
  });
});

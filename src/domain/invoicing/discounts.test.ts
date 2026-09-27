import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice, lineDiscount } from './invoices';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { asIsoDate, makeDate } from '../dates';
import { customers, invoiceLines, vatEntries } from '@/db/schema';
import { parsePercentBasisPoints } from '../money';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
});

const lines = (invoiceId: string) => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))
  .orderBy(invoiceLines.lineNumber).all();

describe('line discounts (#393)', () => {
  it('charges VAT on the discounted net and keeps the undiscounted figure', () => {
    const inv = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
      lines: [
        // 3 x 33.33 = 99.99, less 10% = 10.00 (9.999 rounded) → 89.99, VAT 23% = 20.70
        { description: 'Hours', quantityMilli: 3000, unitPriceMinor: 3_333, discountBasisPoints: 1_000,
          accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! },
        // 200.00 less 25.00 → 175.00, VAT 40.25
        { description: 'Licence', netMinor: 20_000, discountMinor: 2_500, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! },
        { description: 'Support', netMinor: 5_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! },
      ],
    });
    const [hours, licence, support] = lines(inv.invoiceId);
    expect([hours!.undiscountedNetMinor, hours!.discountBasisPoints, hours!.discountMinor, hours!.netMinor, hours!.vatMinor])
      .toEqual([9_999, 1_000, 1_000, 8_999, 2_070]);
    expect([licence!.undiscountedNetMinor, licence!.discountBasisPoints, licence!.discountMinor, licence!.netMinor, licence!.vatMinor])
      .toEqual([20_000, null, 2_500, 17_500, 4_025]);
    expect([support!.undiscountedNetMinor, support!.discountMinor]).toEqual([null, 0]);
    expect([inv.netMinor, inv.vatMinor, inv.grossMinor]).toEqual([8_999 + 17_500 + 5_000, 2_070 + 4_025 + 1_150, 31_499 + 7_245]);

    // The VAT return sees the discounted figures.
    const entries = db.select().from(vatEntries).where(eq(vatEntries.sourceId, inv.invoiceId)).all();
    expect(entries.reduce((s, e) => s + e.netMinor, 0)).toBe(31_499);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(38_744);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('signs a credit note discount like the rest of the credit note', () => {
    const credit = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId, isCreditNote: true,
      lines: [{ description: 'Refund', netMinor: 10_000, discountBasisPoints: 500, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
    });
    const [line] = lines(credit.invoiceId);
    expect([line!.undiscountedNetMinor, line!.discountMinor, line!.netMinor]).toEqual([-10_000, -500, -9_500]);
  });

  it('refuses a discount that is both, not positive, over 100%, or more than the line', () => {
    expect(() => lineDiscount(1_000, { discountBasisPoints: 100, discountMinor: 10 }, 1)).toThrow(/not both/);
    expect(() => lineDiscount(1_000, { discountBasisPoints: 0 }, 1)).toThrow(/more than 0%/);
    expect(() => lineDiscount(1_000, { discountBasisPoints: 10_001 }, 1)).toThrow(/at most 100%/);
    expect(() => lineDiscount(1_000, { discountMinor: 1_001 }, 2)).toThrow(/Line 2: the discount/);
    expect(() => lineDiscount(1_000, { discountMinor: 1.5 }, 1)).toThrow(/minor units/);
    expect(lineDiscount(1_000, { discountBasisPoints: 10_000 }, 1)).toEqual({ minor: 1_000, basisPoints: 10_000 });
    expect(lineDiscount(1_000, {}, 1)).toEqual({ minor: 0, basisPoints: null });
  });
});

describe('parsePercentBasisPoints (#393)', () => {
  it('reads a typed percentage exactly, or refuses it', () => {
    expect(['10', '12.5', '7.25', '10%', ' 3 % ', '100'].map(parsePercentBasisPoints)).toEqual([1_000, 1_250, 725, 1_000, 300, 10_000]);
    expect(['', 'ten', '1.234', '-5', '1e2'].map(parsePercentBasisPoints)).toEqual([null, null, null, null, null]);
  });
});

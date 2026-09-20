/**
 * VAT treatment verification tests (Work Package 08).
 *
 * These tests verify that the VAT engine's rates and treatment mappings
 * produce the correct arithmetic (net/VAT/gross, box assignments, reverse
 * charge pairing, rate snapshotting) and that these values are internally
 * consistent and auditable.
 *
 * The test rates (23% standard, 13.5% reduced, 0% zero-rated) come from the
 * project's own seeded configuration (`createCompany`), not from invented
 * legislation. Citations in comments are informational references to the
 * statute provisions the KB was derived from, not authoritative legal claims.
 *
 * Per the Trust Model (TRUST_MODEL.md):
 *   "Rule ingestion from statutes — text parsing, no inference about what
 *    a figure 'should' be."
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { createVatEntries, vatDiscrepancy } from './engine';
import { vatTreatments, taxRates, vatEntries, vatPeriods } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { makeDate } from '@/domain/dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let tr: Record<string, string>;
let rates: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'VAT Test Ltd',
    vatNumber: 'IE1234567T',
    vatRegistrationStatus: 'registered',
    seedYears: [2024, 2025],
  });
  companyId = created.companyId;
  tr = created.treatmentsByCode;
  rates = created.ratesByCode;
});

describe('VAT rate configuration', () => {
  it('standard rate is 23% (VATCA s.46(1)(a))', () => {
    const rate = db.select().from(taxRates).where(eq(taxRates.id, rates['VAT_STD']!)).get()!;
    expect(rate.rateBasisPoints).toBe(2300);
    expect(rate.code).toBe('VAT_STD');
  });

  it('reduced rate is 13.5% (VATCA s.46(1)(b))', () => {
    const rate = db.select().from(taxRates).where(eq(taxRates.id, rates['VAT_RED']!)).get()!;
    expect(rate.rateBasisPoints).toBe(1350);
    expect(rate.code).toBe('VAT_RED');
  });
});

describe('VAT treatment: standard domestic supply', () => {
  const baseInput = {
    companyId: '', sourceType: 'purchase_invoice' as const,
    direction: 'purchases' as const, taxPointDate: makeDate(2025, 3, 15),
    currency: 'EUR', baseCurrency: 'EUR',
  };

  it('applies 23% to a standard-rated domestic purchase', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
    });
    const entry = result.entries[0]!;
    expect(entry.vatMinor).toBe(2_300);
    expect(entry.rateBasisPoints).toBe(2300);
    expect(entry.vatBox).toBe('T2');
  });

  it('applies 23% to a standard-rated domestic sale', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, direction: 'sales', sourceType: 'sales_invoice',
      treatmentId: tr['IE_STD']!, netMinor: 50_000,
    });
    const entry = result.entries[0]!;
    expect(entry.vatMinor).toBe(11_500);
    expect(entry.vatBox).toBe('T1');
    expect(entry.recoverableVatMinor).toBe(0); // output VAT is never recoverable
  });

  it('applies 13.5% to a reduced-rated purchase', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_RED']!, netMinor: 10_000,
    });
    const entry = result.entries[0]!;
    expect(entry.vatMinor).toBe(1_350);
    expect(entry.rateBasisPoints).toBe(1350);
  });

  it('produces zero VAT for a zero-rated supply (VATCA s.46(1)(a))', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_ZERO']!, netMinor: 10_000,
    });
    expect(result.entries[0]!.vatMinor).toBe(0);
    // Zero-rated supplies are reported in the T2 net box (statistical).
  });

  it('produces zero VAT for an exempt supply with no box assignment (VATCA Sch 1 Group 1)', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_EXEMPT']!, netMinor: 10_000,
    });
    expect(result.entries[0]!.vatMinor).toBe(0);
    expect(result.entries[0]!.vatBox).toBeNull();
  });

  it('produces no VAT for out-of-scope transactions', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['OUT_OF_SCOPE']!, netMinor: 10_000,
    });
    expect(result.entries[0]!.vatMinor).toBe(0);
    expect(result.entries[0]!.rateBasisPoints).toBe(0);
  });
});

describe('VAT treatment: reverse charge (non-EU services)', () => {
  const baseInput = {
    companyId: '', sourceType: 'purchase_invoice' as const,
    direction: 'purchases' as const, taxPointDate: makeDate(2025, 3, 15),
    currency: 'EUR', baseCurrency: 'EUR',
  };

  it('generates two legs: output VAT (T1) and input VAT (T2)', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['NON_EU_SERVICES_RCV']!, netMinor: 12_000,
    });
    expect(result.isReverseCharge).toBe(true);
    expect(result.entries).toHaveLength(2);

    const output = result.entries.find((e) => e.direction === 'sales')!;
    const input = result.entries.find((e) => e.direction === 'purchases')!;

    expect(output.vatBox).toBe('T1');
    expect(output.vatMinor).toBe(2_760); // 23% of 12,000
    expect(output.recoverableVatMinor).toBe(0); // output is never recoverable

    expect(input.vatBox).toBe('T2');
    expect(input.vatMinor).toBe(2_760);
    expect(input.recoverableVatMinor).toBe(2_760);
  });

  it('the two legs are paired so the reverse-charge is inspectable', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['NON_EU_SERVICES_RCV']!, netMinor: 12_000,
    });
    const output = result.entries.find((e) => e.direction === 'sales')!;
    const input = result.entries.find((e) => e.direction === 'purchases')!;
    // The input leg's pairedEntryId points to the output leg.
    expect(input.pairedEntryId).toBe(output.id);
    // The output leg's pairing is set via a post-insert DB update; reload to verify.
    const reloadedOutput = db.select().from(vatEntries).where(eq(vatEntries.id, output.id)).get()!;
    expect(reloadedOutput.pairedEntryId).toBe(input.id);
  });

  it('nets to zero in cash terms for a fully recoverable reverse charge', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['NON_EU_SERVICES_RCV']!, netMinor: 50_000,
    });
    const output = result.entries.find((e) => e.direction === 'sales')!;
    const input = result.entries.find((e) => e.direction === 'purchases')!;
    expect(output.vatMinor - input.recoverableVatMinor).toBe(0);
  });

  it('under reverse charge, the gross amount IS the net (no VAT on the invoice)', () => {
    // A $120 US invoice under reverse charge: 120 is net, 27.60 is self-assessed VAT.
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['NON_EU_SERVICES_RCV']!, grossMinor: 12_000,
    });
    expect(result.entries[0]!.netMinor).toBe(12_000);
    expect(result.entries[0]!.vatMinor).toBe(2_760);
    // The gross (what leaves the bank) equals the net under reverse charge.
    expect(result.calculation.grossMinor).toBe(12_000);
  });
});

describe('VAT treatment: EU intra-community', () => {
  const baseInput = {
    companyId: '', sourceType: 'purchase_invoice' as const,
    direction: 'purchases' as const, taxPointDate: makeDate(2025, 3, 15),
    currency: 'EUR', baseCurrency: 'EUR',
  };

  it('assigns ES2 statistical box for EU services received', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['EU_SERVICES_RCV']!, netMinor: 10_000,
    });
    const input = result.entries.find((e) => e.direction === 'purchases')!;
    expect(input.netBox).toBe('ES2');
    expect(input.vatBox).toBe('T2');
  });

  it('assigns E1 statistical box for EU goods supplied', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, direction: 'sales', sourceType: 'sales_invoice',
      treatmentId: tr['EU_GOODS_SUPPLY']!, netMinor: 10_000,
    });
    expect(result.entries[0]!.netBox).toBe('E1');
  });

  it('assigns ES1 statistical box for EU services supplied', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, direction: 'sales', sourceType: 'sales_invoice',
      treatmentId: tr['EU_SERVICES_SUPPLY']!, netMinor: 10_000,
    });
    expect(result.entries[0]!.netBox).toBe('ES1');
  });
});

describe('VAT treatment: postponed accounting (imports)', () => {
  const baseInput = {
    companyId: '', sourceType: 'purchase_invoice' as const,
    direction: 'purchases' as const, taxPointDate: makeDate(2025, 3, 15),
    currency: 'EUR', baseCurrency: 'EUR',
  };

  it('assigns PA1 statistical box for postponed accounting imports', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IMPORT_PA']!, netMinor: 100_000,
    });
    const input = result.entries.find((e) => e.direction === 'purchases')!;
    expect(input.netBox).toBe('PA1');
    expect(input.vatBox).toBe('T2');
  });
});

describe('VAT rate snapshotting (audit trail integrity)', () => {
  const baseInput = {
    companyId: '', sourceType: 'purchase_invoice' as const,
    direction: 'purchases' as const, taxPointDate: makeDate(2025, 3, 15),
    currency: 'EUR', baseCurrency: 'EUR',
  };

  it('rate is snapshotted and immune to later rate edits', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
    });
    expect(result.entries[0]!.rateBasisPoints).toBe(2300);

    db.update(taxRates).set({ rateBasisPoints: 2400 })
      .where(eq(taxRates.id, rates['VAT_STD']!)).run();

    const reloaded = db.select().from(vatEntries)
      .where(eq(vatEntries.id, result.entries[0]!.id)).get()!;
    expect(reloaded.rateBasisPoints).toBe(2300);
    expect(reloaded.vatMinor).toBe(2_300);
  });

  it('box mapping is snapshotted and immune to later treatment edits', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
    });
    db.update(vatTreatments).set({ purchasesVatBox: 'T9' })
      .where(eq(vatTreatments.id, tr['IE_STD']!)).run();

    const reloaded = db.select().from(vatEntries)
      .where(eq(vatEntries.id, result.entries[0]!.id)).get()!;
    expect(reloaded.vatBox).toBe('T2');
  });

  it('VAT period is determined from the tax point date, not today', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
      taxPointDate: makeDate(2025, 5, 20),
    });
    const period = db.select().from(vatPeriods)
      .where(eq(vatPeriods.id, result.entries[0]!.vatPeriodId!)).get()!;
    expect(period.name).toBe('May–Jun 2025');
  });
});

describe('VAT reconciliation (sum of entries to box totals)', () => {
  it('output VAT entries sum to the T1 box total', () => {
    const baseInput = {
      companyId, sourceType: 'sales_invoice' as const,
      direction: 'sales' as const, taxPointDate: makeDate(2025, 3, 15),
      currency: 'EUR', baseCurrency: 'EUR',
    };
    createVatEntries(db, {
      ...baseInput, treatmentId: tr['IE_STD']!, netMinor: 100_000,
    });
    createVatEntries(db, {
      ...baseInput, treatmentId: tr['IE_STD']!, netMinor: 50_000,
    });
    createVatEntries(db, {
      ...baseInput, treatmentId: tr['IE_RED']!, netMinor: 10_000,
    });

    const allEntries = db.select().from(vatEntries).all();
    const t1Total = allEntries
      .filter((e) => e.vatBox === 'T1')
      .reduce((s, e) => s + e.vatMinor, 0);
    // 100,000 * 23% = 23,000 + 50,000 * 23% = 11,500 + 10,000 * 13.5% = 1,350 = 35,850
    expect(t1Total).toBe(35_850);
  });

  it('input VAT entries sum to the T2 box total', () => {
    const baseInput = {
      companyId, sourceType: 'purchase_invoice' as const,
      direction: 'purchases' as const, taxPointDate: makeDate(2025, 3, 15),
      currency: 'EUR', baseCurrency: 'EUR',
    };
    createVatEntries(db, {
      ...baseInput, treatmentId: tr['IE_STD']!, netMinor: 100_000,
    });
    createVatEntries(db, {
      ...baseInput, treatmentId: tr['NON_EU_SERVICES_RCV']!, netMinor: 50_000,
    });

    const allEntries = db.select().from(vatEntries).all();
    const t2Total = allEntries
      .filter((e) => e.vatBox === 'T2')
      .reduce((s, e) => s + e.vatMinor, 0);
    // 100,000 * 23% = 23,000 + reverse charge input 50,000 * 23% = 11,500 = 34,500
    expect(t2Total).toBe(34_500);
  });
});

describe('VAT amount is never negative for purchases', () => {
  it('VAT on a purchase is always a positive charge to the input', () => {
    const result = createVatEntries(db, {
      companyId, sourceType: 'purchase_invoice', direction: 'purchases',
      taxPointDate: makeDate(2025, 3, 15), currency: 'EUR', baseCurrency: 'EUR',
      treatmentId: tr['IE_STD']!, netMinor: 10_000,
    });
    expect(result.entries[0]!.vatMinor).toBe(2_300);
    expect(result.entries[0]!.recoverableVatMinor).toBe(2_300);
  });
});

describe('VAT discrepancy detection', () => {
  it('returns null when stated VAT matches the calculated amount', () => {
    expect(vatDiscrepancy(10_000, 2_300, 2300)).toBeNull();
  });

  it('reports a discrepancy when the stated VAT differs from the rate', () => {
    const d = vatDiscrepancy(10_000, 2_299, 2300);
    expect(d).toEqual({
      expectedMinor: 2_300,
      statedMinor: 2_299,
      differenceMinor: -1,
    });
  });
});

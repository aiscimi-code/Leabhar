import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  calculateVat, createVatEntries, determineTaxPoint, resolveTreatment, resolveRate,
  vatDiscrepancy, findVatPeriod, VatError,
} from './engine';
import { vatTreatments, taxRates, vatEntries } from '@/db/schema';
import { makeDate } from '../dates';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let tr: Record<string, string>;
let rates: Record<string, string>;

const treatment = (code: string) =>
  db.select().from(vatTreatments).where(eq(vatTreatments.id, tr[code]!)).get()!;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Test Ltd', vatRegistrationStatus: 'registered',
    vatNumber: 'IE1234567T', seedYears: [2024, 2025],
  });
  companyId = created.companyId;
  tr = created.treatmentsByCode;
  rates = created.ratesByCode;
});

describe('calculateVat', () => {
  it('computes VAT from a net amount at the standard rate', () => {
    const result = calculateVat({
      treatment: treatment('IE_STD'), rateBasisPoints: 2300,
      direction: 'purchases', netMinor: 10_000,
    });
    expect(result).toMatchObject({ netMinor: 10_000, vatMinor: 2_300, grossMinor: 12_300 });
    expect(result.recoverableVatMinor).toBe(2_300);
  });

  it('extracts VAT from a gross amount', () => {
    const result = calculateVat({
      treatment: treatment('IE_STD'), rateBasisPoints: 2300,
      direction: 'purchases', grossMinor: 12_300,
    });
    expect(result).toMatchObject({ netMinor: 10_000, vatMinor: 2_300, grossMinor: 12_300 });
  });

  it('never loses a cent: net + VAT always equals gross', () => {
    for (let gross = 1; gross <= 20_000; gross += 13) {
      const r = calculateVat({
        treatment: treatment('IE_STD'), rateBasisPoints: 2300,
        direction: 'purchases', grossMinor: gross,
      });
      expect(r.netMinor + r.vatMinor).toBe(gross);
    }
  });

  it('uses a stated VAT amount rather than recomputing it', () => {
    // A supplier who rounded per line can state a figure a cent off.
    const result = calculateVat({
      treatment: treatment('IE_STD'), rateBasisPoints: 2300,
      direction: 'purchases', netMinor: 10_000, statedVatMinor: 2_299,
    });
    expect(result.vatMinor).toBe(2_299);
    expect(result.grossMinor).toBe(12_299);
  });

  it('treats a reverse-charge invoice total as net, not gross', () => {
    // The single most common reverse-charge error. A $120 Anthropic invoice
    // carries no VAT, so 120 is the net and 27.60 of VAT is self-accounted.
    const result = calculateVat({
      treatment: treatment('NON_EU_SERVICES_RCV'), rateBasisPoints: 2300,
      direction: 'purchases', grossMinor: 12_000,
    });
    expect(result.netMinor).toBe(12_000);
    expect(result.vatMinor).toBe(2_760);
    // What actually leaves the bank account is the net.
    expect(result.grossMinor).toBe(12_000);
  });

  it('produces no VAT for an exempt supply', () => {
    const result = calculateVat({
      treatment: treatment('IE_EXEMPT'), rateBasisPoints: 2300,
      direction: 'purchases', grossMinor: 10_000,
    });
    expect(result.vatMinor).toBe(0);
    expect(result.netMinor).toBe(10_000);
    expect(result.recoverableVatMinor).toBe(0);
  });

  it('produces no VAT for an outside-scope transaction', () => {
    const result = calculateVat({
      treatment: treatment('OUT_OF_SCOPE'), rateBasisPoints: 0,
      direction: 'purchases', grossMinor: 50_000,
    });
    expect(result.vatMinor).toBe(0);
  });

  it('distinguishes zero-rated from exempt, despite both yielding zero VAT', () => {
    const zero = calculateVat({
      treatment: treatment('IE_ZERO'), rateBasisPoints: 0,
      direction: 'purchases', netMinor: 10_000,
    });
    const exempt = calculateVat({
      treatment: treatment('IE_EXEMPT'), rateBasisPoints: 0,
      direction: 'purchases', netMinor: 10_000,
    });
    expect(zero.vatMinor).toBe(0);
    expect(exempt.vatMinor).toBe(0);
    // Both are zero, but only the zero-rated treatment reports into a box and
    // leaves input recovery intact. That difference is the reason treatments exist.
    expect(treatment('IE_ZERO').purchasesVatBox).toBe('T2');
    expect(treatment('IE_EXEMPT').purchasesVatBox).toBeNull();
    expect(treatment('IE_ZERO').isRecoverable).toBe(true);
    expect(treatment('IE_EXEMPT').isRecoverable).toBe(false);
  });

  it('restricts recovery for non-deductible VAT', () => {
    const result = calculateVat({
      treatment: treatment('NON_DEDUCTIBLE'), rateBasisPoints: 2300,
      direction: 'purchases', netMinor: 10_000,
    });
    expect(result.vatMinor).toBe(2_300);
    expect(result.recoverableVatMinor).toBe(0);
  });

  it('never treats output VAT as recoverable', () => {
    const result = calculateVat({
      treatment: treatment('IE_STD'), rateBasisPoints: 2300,
      direction: 'sales', netMinor: 10_000,
    });
    expect(result.recoverableVatMinor).toBe(0);
  });

  it('computes the reduced rate correctly', () => {
    const result = calculateVat({
      treatment: treatment('IE_RED'), rateBasisPoints: 1350,
      direction: 'sales', netMinor: 10_000,
    });
    expect(result.vatMinor).toBe(1_350);
  });

  // Issue #145 defects 1/3: a non-Irish supplier under a reverse-charge
  // treatment is not entitled to charge Irish VAT, so whatever figure their
  // own document states is not evidence of anything and must never become
  // the self-assessed amount — that is always the treatment's own rate on
  // the net, regardless of what was stated.
  it('ignores a stated VAT amount under reverse charge and always self-assesses via the rate', () => {
    const result = calculateVat({
      treatment: treatment('NON_EU_SERVICES_RCV'), rateBasisPoints: 2300,
      direction: 'purchases', netMinor: 20_000, statedVatMinor: 4_000, // a wrong "20%" printed on a US invoice
    });
    expect(result.netMinor).toBe(20_000);
    expect(result.vatMinor).toBe(4_600); // self-assessed at the Irish 23% rate, not the stated 4,000
    expect(result.recoverableVatMinor).toBe(4_600);
  });

  it('ignores a stated VAT amount under reverse charge even on the gross path', () => {
    const result = calculateVat({
      treatment: treatment('EU_SERVICES_RCV'), rateBasisPoints: 2300,
      direction: 'purchases', grossMinor: 12_000, statedVatMinor: 2_500,
    });
    // Reverse charge: the gross IS the net (no VAT was actually charged),
    // so self-assessment is 23% of 12,000, not derived from the stated figure.
    expect(result.netMinor).toBe(12_000);
    expect(result.vatMinor).toBe(2_760);
  });

  it('recoverableOverrideMinor holds back recovery pending review without changing the VAT charged', () => {
    const result = calculateVat({
      treatment: treatment('IE_STD'), rateBasisPoints: 2300,
      direction: 'purchases', netMinor: 20_000, statedVatMinor: 4_000,
      recoverableOverrideMinor: 0,
    });
    expect(result.vatMinor).toBe(4_000); // the stated figure is still the cost incurred
    expect(result.recoverableVatMinor).toBe(0); // but not automatically reclaimable
  });
});

describe('vatDiscrepancy', () => {
  it('returns null when the stated VAT agrees with the rate', () => {
    expect(vatDiscrepancy(10_000, 2_300, 2300)).toBeNull();
  });
  it('reports a disagreement rather than overwriting either figure', () => {
    expect(vatDiscrepancy(10_000, 2_299, 2300)).toEqual({
      expectedMinor: 2_300, statedMinor: 2_299, differenceMinor: -1,
    });
  });
});

describe('determineTaxPoint', () => {
  const invoiceDate = makeDate(2025, 2, 25);
  const paymentDate = makeDate(2025, 3, 10);

  it('uses the invoice date for sales on the invoice basis', () => {
    const result = determineTaxPoint({
      basis: 'invoice', direction: 'sales', invoiceDate, paymentDate,
    });
    expect(result.taxPointDate).toBe('2025-02-25');
  });

  it('uses the payment date for sales on the cash receipts basis', () => {
    const result = determineTaxPoint({
      basis: 'cash_receipts', direction: 'sales', invoiceDate, paymentDate,
    });
    expect(result.taxPointDate).toBe('2025-03-10');
    expect(result.reason).toContain('payment is received');
  });

  it('uses the invoice date for purchases under BOTH bases', () => {
    // The asymmetry that makes the cash receipts basis easy to get wrong:
    // it applies to output VAT only.
    for (const basis of ['invoice', 'cash_receipts'] as const) {
      const result = determineTaxPoint({
        basis, direction: 'purchases', invoiceDate, paymentDate,
      });
      expect(result.taxPointDate).toBe('2025-02-25');
    }
  });

  it('refuses to invent a tax point for an unpaid sale on the cash basis', () => {
    expect(() => determineTaxPoint({
      basis: 'cash_receipts', direction: 'sales', invoiceDate, paymentDate: null,
    })).toThrow(VatError);
  });

  it('prefers an explicit supply date over the invoice date', () => {
    const result = determineTaxPoint({
      basis: 'invoice', direction: 'sales', invoiceDate,
      supplyDate: makeDate(2025, 2, 20),
    });
    expect(result.taxPointDate).toBe('2025-02-20');
  });

  it('moves a sale into a different VAT period depending on the basis', () => {
    // Invoiced 25 Feb (Jan-Feb period), paid 10 Mar (Mar-Apr period).
    const onInvoice = determineTaxPoint({
      basis: 'invoice', direction: 'sales', invoiceDate, paymentDate,
    });
    const onCash = determineTaxPoint({
      basis: 'cash_receipts', direction: 'sales', invoiceDate, paymentDate,
    });
    expect(findVatPeriod(db, companyId, onInvoice.taxPointDate)!.name).toBe('Jan–Feb 2025');
    expect(findVatPeriod(db, companyId, onCash.taxPointDate)!.name).toBe('Mar–Apr 2025');
  });
});

describe('createVatEntries', () => {
  const baseInput = {
    companyId: '', sourceType: 'purchase_invoice' as const,
    direction: 'purchases' as const, taxPointDate: makeDate(2025, 3, 15),
    currency: 'EUR', baseCurrency: 'EUR',
  };

  it('creates one entry for a standard domestic purchase', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.isReverseCharge).toBe(false);
    expect(result.entries[0]).toMatchObject({
      direction: 'purchases', netMinor: 10_000, vatMinor: 2_300,
      vatBox: 'T2', recoverableVatMinor: 2_300,
    });
  });

  it('creates TWO entries for a reverse charge, from one document', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['NON_EU_SERVICES_RCV']!, netMinor: 12_000,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.isReverseCharge).toBe(true);

    const output = result.entries.find((e) => e.direction === 'sales')!;
    const input = result.entries.find((e) => e.direction === 'purchases')!;

    expect(output.vatBox).toBe('T1');
    expect(output.vatMinor).toBe(2_760);
    expect(output.recoverableVatMinor).toBe(0);

    expect(input.vatBox).toBe('T2');
    expect(input.vatMinor).toBe(2_760);
    expect(input.recoverableVatMinor).toBe(2_760);

    // The two legs point at each other so the pair is inspectable.
    expect(input.pairedEntryId).toBe(output.id);
    const reloadedOutput = db.select().from(vatEntries)
      .where(eq(vatEntries.id, output.id)).get()!;
    expect(reloadedOutput.pairedEntryId).toBe(input.id);
  });

  it('nets to zero in cash terms for a fully recoverable reverse charge', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['EU_SERVICES_RCV']!, netMinor: 50_000,
    });
    const output = result.entries.find((e) => e.direction === 'sales')!;
    const input = result.entries.find((e) => e.direction === 'purchases')!;
    expect(output.vatMinor - input.recoverableVatMinor).toBe(0);
  });

  it('assigns the statistical net box for EU services received', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['EU_SERVICES_RCV']!, netMinor: 10_000,
    });
    const input = result.entries.find((e) => e.direction === 'purchases')!;
    expect(input.netBox).toBe('ES2');
  });

  it('assigns PA1 for postponed accounting on imports', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IMPORT_PA']!, netMinor: 100_000,
    });
    const input = result.entries.find((e) => e.direction === 'purchases')!;
    expect(input.netBox).toBe('PA1');
    expect(input.vatBox).toBe('T2');
  });

  it('assigns E1/ES1 for EU supplies made', () => {
    const goods = createVatEntries(db, {
      ...baseInput, companyId, direction: 'sales', sourceType: 'sales_invoice',
      treatmentId: tr['EU_GOODS_SUPPLY']!, netMinor: 10_000,
    });
    expect(goods.entries[0]!.netBox).toBe('E1');

    const services = createVatEntries(db, {
      ...baseInput, companyId, direction: 'sales', sourceType: 'sales_invoice',
      treatmentId: tr['EU_SERVICES_SUPPLY']!, netMinor: 10_000,
    });
    expect(services.entries[0]!.netBox).toBe('ES1');
  });

  it('assigns the VAT period from the tax point', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
      taxPointDate: makeDate(2025, 5, 20),
    });
    const period = findVatPeriod(db, companyId, makeDate(2025, 5, 20))!;
    expect(result.entries[0]!.vatPeriodId).toBe(period.id);
    expect(period.name).toBe('May–Jun 2025');
  });

  it('converts to base currency while preserving the original amounts', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
      currency: 'USD', fxRate: { numerator: 92, denominator: 100 },
    });
    const entry = result.entries[0]!;
    expect(entry.netMinor).toBe(10_000);
    expect(entry.currency).toBe('USD');
    expect(entry.baseNetMinor).toBe(9_200);
    expect(entry.baseVatMinor).toBe(2_116); // 2300 * 0.92
    expect(entry.baseCurrency).toBe('EUR');
  });

  it('snapshots the rate so a later rate change cannot rewrite history', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
    });
    expect(result.entries[0]!.rateBasisPoints).toBe(2300);

    // The standard rate changes to 24% from 2026.
    db.update(taxRates).set({ rateBasisPoints: 2400 })
      .where(eq(taxRates.id, rates['VAT_STD']!)).run();

    const reloaded = db.select().from(vatEntries)
      .where(eq(vatEntries.id, result.entries[0]!.id)).get()!;
    expect(reloaded.rateBasisPoints).toBe(2300);
    expect(reloaded.vatMinor).toBe(2_300);
  });

  it('snapshots the box mapping so a treatment edit cannot rewrite history', () => {
    const result = createVatEntries(db, {
      ...baseInput, companyId, treatmentId: tr['IE_STD']!, netMinor: 10_000,
    });
    db.update(vatTreatments).set({ purchasesVatBox: 'T9' })
      .where(eq(vatTreatments.id, tr['IE_STD']!)).run();

    const reloaded = db.select().from(vatEntries)
      .where(eq(vatEntries.id, result.entries[0]!.id)).get()!;
    expect(reloaded.vatBox).toBe('T2');
  });
});

describe('historical rates', () => {
  it('resolves the rate that applied on the transaction date', () => {
    // Close the current standard rate and add a new one from 2026.
    db.update(taxRates).set({ effectiveTo: '2025-12-31' })
      .where(eq(taxRates.id, rates['VAT_STD']!)).run();
    const newId = ids.taxRate();
    db.insert(taxRates).values({
      id: newId, companyId, code: 'VAT_STD', name: 'VAT standard rate',
      rateBasisPoints: 2400, taxType: 'vat', jurisdiction: 'IE',
      effectiveFrom: '2026-01-01',
    }).run();

    expect(resolveRate(db, {
      companyId, rateId: rates['VAT_STD']!, onDate: makeDate(2025, 6, 1),
    }).rateBasisPoints).toBe(2300);

    expect(resolveRate(db, {
      companyId, rateId: newId, onDate: makeDate(2026, 6, 1),
    }).rateBasisPoints).toBe(2400);

    // Asking for the old row at a 2026 date finds the superseding row.
    expect(resolveRate(db, {
      companyId, rateId: rates['VAT_STD']!, onDate: makeDate(2026, 6, 1),
    }).rateBasisPoints).toBe(2400);
  });

  it('refuses when no rate was in force, instead of guessing', () => {
    db.update(taxRates).set({ effectiveFrom: '2030-01-01' })
      .where(eq(taxRates.id, rates['VAT_STD']!)).run();
    expect(() => resolveRate(db, {
      companyId, rateId: rates['VAT_STD']!, onDate: makeDate(2025, 6, 1),
    })).toThrow(/No .* rate was in force/);
  });

  it('refuses a treatment that had not taken effect yet', () => {
    db.update(vatTreatments).set({ effectiveFrom: '2026-01-01' })
      .where(eq(vatTreatments.id, tr['IE_STD']!)).run();
    expect(() => resolveTreatment(db, {
      companyId, treatmentId: tr['IE_STD']!, onDate: makeDate(2025, 6, 1),
    })).toThrow(/only takes effect from/);
  });

  it('refuses a treatment that had already ceased', () => {
    db.update(vatTreatments).set({ effectiveTo: '2024-12-31' })
      .where(eq(vatTreatments.id, tr['IE_STD']!)).run();
    expect(() => resolveTreatment(db, {
      companyId, treatmentId: tr['IE_STD']!, onDate: makeDate(2025, 6, 1),
    })).toThrow(/ceased to apply/);
  });
});

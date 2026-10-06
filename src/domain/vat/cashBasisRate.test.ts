import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, testVatBasis } from '@/db/testing';
import { createCompany } from '../config/setup';
import { supersedeTaxRate } from '../config/mutations';
import { createInvoice } from '../invoicing/invoices';
import { recordPayment } from '../invoicing/payments';
import { asIsoDate, makeDate } from '../dates';
import { customers, taxRates, vatEntries, vatTreatments } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #615: on the cash receipts basis the tax point is the receipt, but
 * "the rate of tax due by the person concerned in respect of a supply shall
 * be the rate of tax chargeable at the time the goods or services are
 * supplied" (VATCA s.80(2)(a), catalogue/vatca-2010-revised/s080.json). So
 * the VAT released on payment keeps the invoice's own rate, even when the
 * rate changed in between.
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Cash Ltd', vatRegistrationStatus: 'registered', ...testVatBasis('cash_receipts'), seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
});

const sale = () => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: makeDate(2025, 3, 20), customerId,
  lines: [{ description: 'Consulting', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
});
const pay = (invoiceId: string) => recordPayment(db, {
  companyId, direction: 'received', paymentDate: asIsoDate('2025-04-10'), amountMinor: 12_300,
  allocations: [{ invoiceId, allocatedMinor: 12_300 }],
});
const released = () => db.select().from(vatEntries).where(eq(vatEntries.sourceType, 'payment')).all();

describe('the rate on the cash receipts basis (s.80(2)(a))', () => {
  it('a sale invoiced at 23% and paid after a rate change is declared at 23%, its rate and amount agreeing', () => {
    const inv = sale();
    const stdId = db.select().from(taxRates).where(and(eq(taxRates.companyId, companyId), eq(taxRates.code, 'VAT_STD'))).get()!.id;
    supersedeTaxRate(db, { companyId, taxRateId: stdId, newRateBasisPoints: 2100, effectiveFrom: makeDate(2025, 4, 1) });
    pay(inv.invoiceId);
    const [entry] = released();
    expect(entry).toMatchObject({ taxPointDate: '2025-04-10', rateBasisPoints: 2300, vatMinor: 2_300, netMinor: 10_000 });
  });

  it('a payment is still recorded when the treatment was retired between the invoice and the receipt', () => {
    const inv = sale();
    db.update(vatTreatments).set({ effectiveTo: '2025-03-31' }).where(eq(vatTreatments.id, tr['IE_STD']!)).run();
    pay(inv.invoiceId);
    expect(released()).toHaveLength(1);
    expect(released()[0]).toMatchObject({ rateBasisPoints: 2300, vatMinor: 2_300 });
  });
});

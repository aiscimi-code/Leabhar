import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, testVatBasis } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice, InvoicingError } from './invoices';
import { buildVat3Return } from '../vat/report';
import { makeDate } from '../dates';
import { customers, invoices, vatEntries, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #678: where Chapter 2 does not require an invoice, the VAT is due when
 * the supply is made (VATCA s.74(1)(d)), not at the date of an invoice-style entry.
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', ...testVatBasis('invoice'), seedYears: [2025] });
  ({ companyId, accountsByCode: byCode, treatmentsByCode: tr } = created);
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Walk-in', matchKey: 'walk-in', countryCode: 'IE' }).run();
});

const sale = (over: { supplyDate?: ReturnType<typeof makeDate>; invoiceRequired?: boolean | null } = {}) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: makeDate(2025, 3, 3), customerId, invoiceNumber: `S-${Math.random()}`,
  supplyDate: over.supplyDate, invoiceRequired: over.invoiceRequired,
  lines: [{ description: 'Counter sale', netMinor: 10_000, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']! }],
});

const period = (name: string) => db.select().from(vatPeriods).where(eq(vatPeriods.name, name)).get()!.id;
const t1 = (name: string) => buildVat3Return(db, { companyId, vatPeriodId: period(name) }).T1.amountMinor;

describe('a supply that needs no invoice (s.74(1)(d))', () => {
  it('is due at the supply date: 28 Feb supply, entered 3 Mar, falls in Jan–Feb', () => {
    const inv = sale({ supplyDate: makeDate(2025, 2, 28), invoiceRequired: false });
    expect(t1('Jan–Feb 2025')).toBe(2_300);
    expect(t1('Mar–Apr 2025')).toBe(0);
    const [entry] = db.select().from(vatEntries).where(eq(vatEntries.sourceId, inv.invoiceId)).all();
    expect(entry!.taxPointDate).toBe('2025-02-28');
    expect(db.select().from(invoices).where(eq(invoices.id, inv.invoiceId)).get()!.invoiceRequired).toBe(false);
  });

  it('with the requirement unstated, the same sale stays in Mar–Apr under s.74(1)(a)', () => {
    sale({ supplyDate: makeDate(2025, 2, 28) });
    expect(t1('Mar–Apr 2025')).toBe(2_300);
    expect(t1('Jan–Feb 2025')).toBe(0);
  });

  it('is refused without a supply date, rather than falling back to the invoice date', () => {
    expect(() => sale({ invoiceRequired: false })).toThrow(InvoicingError);
    expect(() => sale({ invoiceRequired: false })).toThrow(/supply date/);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { buildVat3Return } from './report';
import { asIsoDate } from '../dates';
import { customers, suppliers, vatEntries, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #611: the tax point of a sale on the invoice basis is the invoice
 * date, or the end of due time when the invoice is late (VATCA s.74(1)(a),
 * S.I. 639/2010 reg.23(a)); an intra-Community acquisition's is the 15th of
 * the following month, or an earlier invoice (s.75).
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;
let deSupplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Point Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025],
  });
  ({ companyId, accountsByCode: byCode, treatmentsByCode: tr } = created);
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
  deSupplierId = ids.supplier();
  db.insert(suppliers).values({
    id: deSupplierId, companyId, name: 'Berlin GmbH', matchKey: 'berlin gmbh', countryCode: 'DE', vatNumber: 'DE123456789',
  }).run();
});

const period = (name: string) => db.select().from(vatPeriods)
  .where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, name))).get()!;
const vat3 = (name: string) => buildVat3Return(db, { companyId, vatPeriodId: period(name).id });

const sale = (invoiceDate: string, supplyDate: string, extra: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate(invoiceDate), supplyDate: asIsoDate(supplyDate), customerId,
  invoiceNumber: `S-${invoiceDate}`,
  lines: [{ description: 'Consulting', netMinor: 100_000, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']! }],
  ...extra,
});

const acquisition = (invoiceDate: string, supplyDate: string) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: asIsoDate(invoiceDate), supplyDate: asIsoDate(supplyDate),
  supplierId: deSupplierId, invoiceNumber: `A-${invoiceDate}`, documentId: insertConfirmedDocument(db, companyId),
  lines: [{ description: 'Machine parts', netMinor: 10_000, accountId: byCode['6070']!, vatTreatmentId: tr['EU_GOODS_ACQ']! }],
});

describe('a sale on the invoice basis (s.74(1)(a))', () => {
  it('supplied 28 Feb, invoiced 3 Mar: the VAT is in Mar-Apr', () => {
    sale('2025-03-03', '2025-02-28');
    expect(vat3('Jan–Feb 2025').T1.amountMinor).toBe(0);
    expect(vat3('Mar–Apr 2025').T1.amountMinor).toBe(23_000);
  });

  it('supplied 20 Jan, invoiced late on 20 Mar: the VAT is due 15 Feb, in Jan-Feb', () => {
    const inv = sale('2025-03-20', '2025-01-20');
    const [entry] = db.select().from(vatEntries).where(eq(vatEntries.journalEntryId, inv.journalEntryId)).all();
    expect(entry!.taxPointDate).toBe('2025-02-15');
    expect(vat3('Jan–Feb 2025').T1.amountMinor).toBe(23_000);
    expect(vat3('Mar–Apr 2025').T1.amountMinor).toBe(0);
  });

  it('a late invoice whose due time ended in a locked period is refused there, before anything is written', () => {
    db.update(vatPeriods).set({ status: 'locked' }).where(eq(vatPeriods.id, period('Jan–Feb 2025').id)).run();
    expect(() => sale('2025-03-20', '2025-01-20')).toThrow(/Jan–Feb 2025/);
    expect(db.select().from(vatEntries).where(eq(vatEntries.companyId, companyId)).all()).toHaveLength(0);
    // Declared in an open period by name, as any late VAT is.
    sale('2025-03-20', '2025-01-20', { vatDeclarationDate: asIsoDate('2025-03-20') });
    expect(vat3('Mar–Apr 2025').T1.amountMinor).toBe(23_000);
  });
});

describe('an intra-Community acquisition (s.75)', () => {
  it('acquired 25 Feb, invoiced 20 Mar: due 15 Mar, so T1, T2 and E2 are all in Mar-Apr', () => {
    acquisition('2025-03-20', '2025-02-25');
    const jf = vat3('Jan–Feb 2025');
    const ma = vat3('Mar–Apr 2025');
    expect([jf.T1.amountMinor, jf.T2.amountMinor, jf.E2.amountMinor]).toEqual([0, 0, 0]);
    expect([ma.T1.amountMinor, ma.T2.amountMinor, ma.E2.amountMinor]).toEqual([2_300, 2_300, 10_000]);
  });

  it('acquired 20 Feb, invoiced 10 Mar (before the 15th): due at the invoice, in Mar-Apr', () => {
    acquisition('2025-03-10', '2025-02-20');
    expect(vat3('Mar–Apr 2025').E2.amountMinor).toBe(10_000);
  });

  it('acquired 10 Feb, invoiced 2 May: due 15 Mar, not at the invoice', () => {
    const inv = acquisition('2025-05-02', '2025-02-10');
    const entries = db.select().from(vatEntries).where(eq(vatEntries.journalEntryId, inv.journalEntryId)).all();
    expect(entries.map((e) => e.taxPointDate)).toEqual(['2025-03-15', '2025-03-15']);
    expect(vat3('Mar–Apr 2025').E2.amountMinor).toBe(10_000);
    expect(vat3('May–Jun 2025').E2.amountMinor).toBe(0);
  });
});

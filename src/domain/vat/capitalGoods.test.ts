import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { asIsoDate } from '../dates';
import { suppliers, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import {
  registerCapitalGood, recordIntervalUse, postCapitalGoodAdjustment, recordCapitalGoodDisposal,
  postCapitalGoodDisposalAdjustment, dueCapitalGoodIntervals, capitalGoodsFindings,
} from './capitalGoods';
import { buildVat3Return } from './report';

/** Issue #208: the capital goods scheme record, from the invoice to the VAT3. */

function setup() {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: 'Owner Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026, 2027],
  });
  const { companyId } = created;
  const supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Builder Ltd', matchKey: 'builder ltd', countryCode: 'IE' }).run();
  // €1,000,000 + 13.5% VAT €135,000 (example 5's figures).
  const invoice = createInvoice(db, {
    companyId, direction: 'purchase', invoiceDate: asIsoDate('2025-04-07'), supplierId, invoiceNumber: 'B-1',
    lines: [{ description: 'Office building', netMinor: 100_000_000, accountId: created.accountsByCode['6120']!,
      vatTreatmentId: created.treatmentsByCode['IE_RED']!, statedVatMinor: 13_500_000 }],
  });
  const period = (name: string) => db.select().from(vatPeriods).where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, name))).get()!;
  return { db, companyId, invoiceId: invoice.invoiceId, accountId: created.accountsByCode['6120']!, period };
}

describe('the capital goods record', () => {
  it('takes the total tax from the invoices, and needs a person', () => {
    const { db, companyId, invoiceId } = setup();
    expect(() => registerCapitalGood(db, {
      companyId, description: 'Office', kind: 'acquisition_or_development', initialIntervalStart: '2025-04-07',
      sourceInvoiceIds: [invoiceId], deductedMinor: 1_350_000, registeredBy: ' ',
    })).toThrow(/who is recording/);
    expect(() => registerCapitalGood(db, {
      companyId, description: 'Office', kind: 'acquisition_or_development', initialIntervalStart: '2025-04-07',
      sourceInvoiceIds: [], deductedMinor: 0, registeredBy: 'joe',
    })).toThrow(/Name the purchase invoices/);
    expect(() => registerCapitalGood(db, {
      companyId, description: 'Office', kind: 'acquisition_or_development', initialIntervalStart: '2025-04-07',
      sourceInvoiceIds: [invoiceId], deductedMinor: 99_000_000, registeredBy: 'joe',
    })).toThrow(/between €0.00 and the total tax incurred, €135000.00/);
  });

  it('example 5 end to end: interval 1 recorded, €13,500 deductible, posted to T2 in the next period', () => {
    const { db, companyId, invoiceId, accountId, period } = setup();
    const id = registerCapitalGood(db, {
      companyId, description: 'Office, Unit 4', kind: 'acquisition_or_development', initialIntervalStart: '2025-04-07',
      sourceInvoiceIds: [invoiceId], deductedMinor: 1_350_000, registeredBy: 'joe',
    });
    expect(() => recordIntervalUse(db, { companyId, capitalGoodId: id, intervalNumber: 1, proportionBp: 2_000, recordedBy: 'joe', today: '2026-04-06' }))
      .toThrow(/record its use after it ends/);
    expect(dueCapitalGoodIntervals(db, { companyId, asOf: '2026-04-30' })).toHaveLength(1);
    expect(capitalGoodsFindings(db, { companyId, periodStart: '2026-03-01', periodEnd: '2026-04-30' }).map((f) => f.code)).toEqual(['cgs_interval_due']);

    const row = recordIntervalUse(db, { companyId, capitalGoodId: id, intervalNumber: 1, proportionBp: 2_000, recordedBy: 'joe', today: '2026-04-07' });
    expect(row).toMatchObject({ adjustmentMinor: -1_350_000, provision: 's.64(2)', startDate: '2025-04-07', endDate: '2026-04-06' });
    expect(() => recordIntervalUse(db, { companyId, capitalGoodId: id, intervalNumber: 1, proportionBp: 5_000, recordedBy: 'joe', today: '2026-04-07' }))
      .toThrow(/already recorded/);
    expect(capitalGoodsFindings(db, { companyId, periodStart: '2026-03-01', periodEnd: '2026-04-30' }).map((f) => f.code)).toEqual(['cgs_adjustment_unposted']);

    const before = buildVat3Return(db, { companyId, vatPeriodId: period('Mar–Apr 2026').id, baseCurrency: 'EUR' }).T2.amountMinor;
    postCapitalGoodAdjustment(db, { companyId, intervalId: row.id, accountId, postedBy: 'joe' });
    const after = buildVat3Return(db, { companyId, vatPeriodId: period('Mar–Apr 2026').id, baseCurrency: 'EUR' }).T2.amountMinor;
    expect(after - before).toBe(1_350_000);
    expect(capitalGoodsFindings(db, { companyId, periodStart: '2026-03-01', periodEnd: '2026-04-30' })).toEqual([]);
    expect(() => postCapitalGoodAdjustment(db, { companyId, intervalId: row.id, accountId, postedBy: 'joe' })).toThrow(/already posted/);
  });

  it('intervals are recorded in order; an unused interval takes the previous proportion (s.64(3)(c))', () => {
    const { db, companyId, invoiceId } = setup();
    const id = registerCapitalGood(db, {
      companyId, description: 'Office', kind: 'acquisition_or_development', initialIntervalStart: '2025-04-07',
      sourceInvoiceIds: [invoiceId], deductedMinor: 13_500_000, registeredBy: 'joe',
    });
    expect(() => recordIntervalUse(db, { companyId, capitalGoodId: id, intervalNumber: 2, proportionBp: 10_000, recordedBy: 'joe', today: '2027-06-01' }))
      .toThrow(/Record interval 1 first/);
    recordIntervalUse(db, { companyId, capitalGoodId: id, intervalNumber: 1, proportionBp: 10_000, recordedBy: 'joe', today: '2027-06-01' });
    const second = recordIntervalUse(db, { companyId, capitalGoodId: id, intervalNumber: 2, notUsed: true, recordedBy: 'joe', today: '2027-06-01' });
    expect(second).toMatchObject({ proportionBp: 10_000, adjustmentMinor: 0, endDate: '2026-12-31' });
  });

  it('an exempt sale in the 2nd interval: B x 19 / 20 payable, posted in the period of the sale', () => {
    const { db, companyId, invoiceId, accountId, period } = setup();
    const id = registerCapitalGood(db, {
      companyId, description: 'Office', kind: 'acquisition_or_development', initialIntervalStart: '2025-04-07',
      sourceInvoiceIds: [invoiceId], deductedMinor: 13_500_000, registeredBy: 'joe',
    });
    expect(() => recordCapitalGoodDisposal(db, { companyId, capitalGoodId: id, disposedOn: '2026-06-15', taxable: false, recordedBy: 'joe' }))
      .toThrow(/Record intervals 1 to 1 first/);
    recordIntervalUse(db, { companyId, capitalGoodId: id, intervalNumber: 1, proportionBp: 10_000, recordedBy: 'joe', today: '2026-05-01' });
    const r = recordCapitalGoodDisposal(db, { companyId, capitalGoodId: id, disposedOn: '2026-06-15', taxable: false, recordedBy: 'joe' });
    expect(r.adjustmentMinor).toBe(12_825_000); // 135,000 x 19 / 20
    const before = buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2026').id, baseCurrency: 'EUR' }).T1.amountMinor;
    postCapitalGoodDisposalAdjustment(db, { companyId, capitalGoodId: id, accountId, postedBy: 'joe' });
    expect(buildVat3Return(db, { companyId, vatPeriodId: period('May–Jun 2026').id, baseCurrency: 'EUR' }).T1.amountMinor - before).toBe(12_825_000);
    expect(dueCapitalGoodIntervals(db, { companyId, asOf: '2030-01-01' })).toEqual([]);
  });
});

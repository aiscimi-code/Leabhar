import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { recordCashBasisAuthorisation } from '../config/companyStatus';
import { createInvoice } from '../invoicing/invoices';
import { asIsoDate } from '../dates';
import { customers, vatPeriods, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { cashBasisFindings, salesTurnoverTwelveMonths, CASH_BASIS_TURNOVER_THRESHOLD_MINOR } from './cashBasis';
import { validateVatPeriod } from './periodClose';

/** Issue #208: the moneys-received basis is backed by a recorded authorisation, and its s.80(1) test by the books. */

function setup(basis: 'invoice' | 'cash_receipts' = 'cash_receipts') {
  const { db } = createTestDatabase();
  const created = createCompany(db, { legalName: 'Cash Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: basis, seedYears: [2025, 2026] });
  const { companyId } = created;
  const customer = (name: string, vatNumber: string | null) => {
    const id = ids.customer();
    db.insert(customers).values({ id, companyId, name, matchKey: name.toLowerCase(), countryCode: 'IE', vatNumber }).run();
    return id;
  };
  const sale = (customerId: string, date: string, netMinor: number, isCreditNote = false) => createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId, isCreditNote,
    lines: [{ description: 'Work', netMinor, accountId: created.accountsByCode['4020']!, vatTreatmentId: created.treatmentsByCode['IE_STD']! }],
  });
  const period = (name: string) => db.select().from(vatPeriods).where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, name))).get()!;
  return { db, companyId, customer, sale, period };
}
const codes = (f: Array<{ code: string }>) => f.map((x) => x.code);

describe('the cash receipts basis', () => {
  it('an invoice-basis company is not checked', () => {
    const { db, companyId } = setup('invoice');
    expect(cashBasisFindings(db, { companyId, periodStart: '2026-03-01', periodEnd: '2026-04-30' })).toEqual([]);
  });

  it('with no authorisation recorded, validating a period warns, and says what to do', () => {
    const { db, companyId, period } = setup();
    const v = validateVatPeriod(db, { companyId, vatPeriodId: period('Mar–Apr 2026').id });
    const f = v.findings.find((x) => x.code === 'cash_basis_not_authorised')!;
    expect(f).toMatchObject({ severity: 'warning', entityType: 'company' });
    expect(f.detail).toMatch(/S\.I\. 639\/2010 reg\.25/);
  });

  it('records an authorisation (audited); a period before it is flagged, one after is not', () => {
    const { db, companyId } = setup();
    expect(() => recordCashBasisAuthorisation(db, { companyId, eligibility: 'turnover_threshold', authorisedFrom: '2026-03-01', reference: ' ', confirmedBy: 'joe' }))
      .toThrow(/Revenue's reference/);
    recordCashBasisAuthorisation(db, { companyId, eligibility: 'turnover_threshold', authorisedFrom: '2026-03-01', reference: 'ROS 12345', confirmedBy: 'joe' });
    expect(db.select().from(auditEvents).where(eq(auditEvents.field, 'cash_basis_authorisation')).all()).toHaveLength(1);
    expect(codes(cashBasisFindings(db, { companyId, periodStart: '2026-01-01', periodEnd: '2026-02-28' }))).toEqual(['cash_basis_not_authorised']);
    expect(cashBasisFindings(db, { companyId, periodStart: '2026-03-01', periodEnd: '2026-04-30' })).toEqual([]);
  });

  it('turnover over €2,000,000 in the 12 months to the period end is flagged; credit notes and old sales count correctly', () => {
    const { db, companyId, customer, sale } = setup();
    recordCashBasisAuthorisation(db, { companyId, eligibility: 'turnover_threshold', authorisedFrom: '2025-01-01', reference: 'ROS 1', confirmedBy: 'joe' });
    const c = customer('Big Customer', null);
    sale(c, '2025-04-30', 150_000_000); // outside the 12 months to 2026-04-30
    sale(c, '2025-05-01', 150_000_000);
    sale(c, '2026-01-10', 60_000_000);
    sale(c, '2026-02-10', 5_000_000, true); // credit note
    const t = salesTurnoverTwelveMonths(db, { companyId, endDate: '2026-04-30' });
    expect(t).toMatchObject({ from: '2025-05-01', to: '2026-04-30', totalMinor: 205_000_000 });
    expect(t.totalMinor).toBeGreaterThan(CASH_BASIS_TURNOVER_THRESHOLD_MINOR);
    const f = cashBasisFindings(db, { companyId, periodStart: '2026-03-01', periodEnd: '2026-04-30' });
    expect(codes(f)).toEqual(['cash_basis_turnover_over_threshold']);
    expect(f[0]!.title).toMatch(/€2,050,000\.00/);
  });

  it('the 90% test: a large share of sales to customers with a VAT number is flagged', () => {
    const { db, companyId, customer, sale } = setup();
    recordCashBasisAuthorisation(db, { companyId, eligibility: 'supplies_to_unregistered', authorisedFrom: '2025-01-01', reference: 'ROS 2', confirmedBy: 'joe' });
    sale(customer('Shop Customer', null), '2026-01-10', 900_000);
    const trade = customer('Trade Customer Ltd', 'IE6388047V');
    sale(trade, '2026-01-11', 100_000);
    expect(cashBasisFindings(db, { companyId, periodStart: '2026-01-01', periodEnd: '2026-02-28' })).toEqual([]);
    sale(trade, '2026-02-11', 100_000);
    const f = cashBasisFindings(db, { companyId, periodStart: '2026-01-01', periodEnd: '2026-02-28' });
    expect(codes(f)).toEqual(['cash_basis_registered_customers_share']);
    expect(f[0]!.title).toMatch(/^18\.2% of sales/);
  });

  it('with nothing recorded, both the authorisation and the s.80(1) test are asked for', () => {
    const { db, companyId } = setup();
    expect(codes(cashBasisFindings(db, { companyId, periodStart: '2026-01-01', periodEnd: '2026-02-28' })))
      .toEqual(['cash_basis_not_authorised', 'cash_basis_eligibility_unrecorded']);
  });
});

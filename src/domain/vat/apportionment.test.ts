import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { asIsoDate } from '../dates';
import { customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import { accountingYearContaining, turnoverProportion, apportionmentFindings } from './apportionment';

/** Issue #209: apportionment of VAT on dual-use inputs (s.61), on the turnover basis. */

function setup(yearEndMonth = 12) {
  const { db } = createTestDatabase();
  const created = createCompany(db, { legalName: 'Mixed Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  const { companyId } = created;
  if (yearEndMonth !== 12) {
    db.run(`UPDATE companies SET financial_year_end_month = ${yearEndMonth}, financial_year_end_day = 30 WHERE id = '${companyId}'`);
  }
  const customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Client', matchKey: 'client', countryCode: 'IE' }).run();
  const sale = (date: string, net: number, treatment: string) => createInvoice(db, {
    companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId,
    lines: [{ description: 'Service', netMinor: net, accountId: created.accountsByCode['4020']!, vatTreatmentId: created.treatmentsByCode[treatment]! }],
  });
  return { db, companyId, sale };
}

describe('the turnover proportion (s.61(4))', () => {
  it('deductible over total, VAT-exclusive; outside-the-scope in neither', () => {
    const { db, companyId, sale } = setup();
    sale('2026-02-01', 60_000, 'IE_STD');
    sale('2026-02-02', 20_000, 'IE_ZERO');
    sale('2026-02-03', 40_000, 'IE_EXEMPT');
    sale('2026-02-04', 99_000, 'OUT_OF_SCOPE');
    expect(turnoverProportion(db, { companyId, yearStart: '2026-01-01', yearEnd: '2026-12-31' }))
      .toMatchObject({ deductibleMinor: 80_000, exemptMinor: 40_000, totalMinor: 120_000, proportionBp: 6667 });
  });

  it('the accounting year follows the company\'s year end', () => {
    const { db, companyId } = setup(6);
    expect(accountingYearContaining(db, companyId, '2026-08-31')).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(accountingYearContaining(db, companyId, '2026-06-30')).toEqual({ start: '2025-07-01', end: '2026-06-30' });
  });
});

describe('the period finding', () => {
  it('only when the company makes both exempt and deductible supplies', () => {
    const { db, companyId, sale } = setup();
    sale('2026-02-01', 60_000, 'IE_STD');
    expect(apportionmentFindings(db, { companyId, periodEnd: '2026-02-28' })).toEqual([]);
    sale('2026-02-03', 40_000, 'IE_EXEMPT');
    const [f] = apportionmentFindings(db, { companyId, periodEnd: '2026-02-28' });
    expect(f!.title).toMatch(/deductible at 60\.00%/);
    expect(f!.detail).not.toMatch(/ends the accounting year/);
  });

  it('the last period of the year asks for the review-period adjustment (reg.17(3))', () => {
    const { db, companyId, sale } = setup();
    sale('2026-02-01', 60_000, 'IE_STD');
    sale('2026-11-03', 40_000, 'IE_EXEMPT');
    expect(apportionmentFindings(db, { companyId, periodEnd: '2026-12-31' })[0]!.detail).toMatch(/reg\.17\(3\)/);
  });
});

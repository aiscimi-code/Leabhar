import { describe, it, expect } from 'vitest';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { classifyTransaction, reclassifyTransaction } from '../banking/classify';
import { settleBankTransaction } from '../consolidation/settle';
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

describe('sales recorded from the bank count too (issue #637)', () => {
  function bankSetup() {
    const { db } = createTestDatabase();
    const created = createCompany(db, { legalName: 'Bank Sales Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026, 2027] });
    const { companyId } = created;
    const bankAccountId = addBankAccount(db, {
      companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2026-01-01', accountId: created.accountsByKey['bank_control']!,
    });
    const receipt = (date: string, amountMinor: number, treatment: string) => classifyTransaction(db, {
      companyId, bankTransactionId: insertTestBankTransaction(db, { companyId, bankAccountId, transactionDate: date, amountMinor }),
      accountId: created.accountsByCode['4020']!, vatTreatmentId: created.treatmentsByCode[treatment]!,
    });
    return { db, companyId, created, bankAccountId, receipt };
  }
  const year = { yearStart: '2026-01-01', yearEnd: '2026-12-31' };

  it('a standard-rated receipt counts at its net, an exempt one at its whole amount, an out-of-scope one not at all', () => {
    const { db, companyId, receipt } = bankSetup();
    receipt('2026-02-01', 12_300, 'IE_STD');      // net 100.00, VAT 23.00
    receipt('2026-02-02', 5_000, 'IE_EXEMPT');
    receipt('2026-02-03', 77_700, 'OUT_OF_SCOPE');
    receipt('2027-01-05', 99_900, 'IE_EXEMPT');   // the next year
    expect(turnoverProportion(db, { companyId, ...year }))
      .toMatchObject({ deductibleMinor: 10_000, exemptMinor: 5_000, totalMinor: 15_000, proportionBp: 6667 });
  });

  it('a receipt reclassified from standard-rated to exempt counts once, as exempt', () => {
    const { db, companyId, created, receipt } = bankSetup();
    const first = receipt('2026-04-01', 12_300, 'IE_STD');
    reclassifyTransaction(db, {
      companyId, bankTransactionId: first.bankTransactionId, accountId: created.accountsByCode['4020']!,
      vatTreatmentId: created.treatmentsByCode['IE_EXEMPT']!, reason: 'Exempt service',
    });
    expect(turnoverProportion(db, { companyId, ...year })).toMatchObject({ deductibleMinor: 0, exemptMinor: 12_300 });
  });

  it('a receipt that settles a sales invoice is counted once, with the invoice', () => {
    const { db, companyId, created, bankAccountId } = bankSetup();
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'Client', matchKey: 'client', countryCode: 'IE' }).run();
    const inv = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2026-03-01'), customerId,
      lines: [{ description: 'Service', netMinor: 40_000, accountId: created.accountsByCode['4020']!, vatTreatmentId: created.treatmentsByCode['IE_EXEMPT']! }],
    });
    const bankTransactionId = insertTestBankTransaction(db, { companyId, bankAccountId, transactionDate: '2026-03-20', amountMinor: 40_000 });
    settleBankTransaction(db, { companyId, bankTransactionId, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 40_000 }] });
    expect(turnoverProportion(db, { companyId, ...year })).toMatchObject({ deductibleMinor: 0, exemptMinor: 40_000 });
  });

  it('invoiced and bank sales together drive the dual-use finding', () => {
    const { db, companyId, created, receipt } = bankSetup();
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'Client', matchKey: 'client', countryCode: 'IE' }).run();
    createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2026-02-01'), customerId,
      lines: [{ description: 'Service', netMinor: 30_000, accountId: created.accountsByCode['4020']!, vatTreatmentId: created.treatmentsByCode['IE_STD']! }],
    });
    // Without the exempt bank receipt there is no exempt turnover, and no finding.
    receipt('2026-02-10', 10_000, 'IE_EXEMPT');
    const [finding] = apportionmentFindings(db, { companyId, periodEnd: '2026-02-28' });
    expect(finding?.title).toMatch(/deductible at 75\.00%/);
  });
});

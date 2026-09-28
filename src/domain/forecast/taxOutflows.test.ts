import { describe, it, expect } from 'vitest';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import { createCompany } from '../config/setup';
import { confirmRctPrincipal } from '../config/companyStatus';
import { postJournalEntry } from '../accounting/journal';
import { createInvoice } from '../invoicing/invoices';
import { computeCorporationTax } from '../corporationTax/computation';
import { computeIncomeTax } from '../incomeTax/computation';
import {
  createProject, createSite, registerSubcontractor, recordRctContract, notifyRctPayment, recordDeductionAuthorisation, payRctPayment,
  fileRctReturn, payRctReturn,
} from '../construction';
import { asIsoDate, type IsoDate } from '../dates';
import { ctStatutoryDate, forecastOptions, statutoryOutflowLines, vatDueDate } from '.';

/** Issue #566: tax and statutory payments, dated by curated rules. */

const d = (s: string) => s as IsoDate;

describe('due dates', () => {
  it('VAT: the 19th of the month after the period (s.76(1)), the 23rd for an electronic return (s.78(2))', () => {
    expect(vatDueDate(d('2026-02-28'), 'statutory')).toBe('2026-03-19');
    expect(vatDueDate(d('2026-12-31'), 'statutory')).toBe('2027-01-19');
    expect(vatDueDate(d('2026-12-31'), 'ros')).toBe('2027-01-23');
  });

  it('corporation tax: the ROS 23rd becomes the statutory 21st; an earlier day is unchanged', () => {
    expect(ctStatutoryDate(d('2026-09-23'))).toBe('2026-09-21');
    expect(ctStatutoryDate(d('2026-02-14'))).toBe('2026-02-14');
  });
});

function rctBook() {
  const { db } = createTestDatabase();
  const created = createCompany(db, { legalName: 'Tógáil Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  const { companyId } = created;
  confirmRctPrincipal(db, { companyId, status: 'principal', from: '2026-01-01', basis: 'Main contractor', confirmedBy: 'owner' });
  const supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Ó Briain Plastering', matchKey: 'obriain', countryCode: 'IE' }).run();
  const project = createProject(db, { companyId, code: 'P1', name: 'Scoil extension', startsOn: '2026-01-10', recordedBy: 'o' });
  const site = createSite(db, { companyId, projectId: project.id, name: 'Scoil', address: 'Main St, Tuam', eircode: 'h54 x2y3', recordedBy: 'o' });
  const sub = registerSubcontractor(db, {
    companyId, supplierId, taxReference: '1234567T', identityEvidence: 'Passport', identityCheckedBy: 'owner', identityCheckedOn: '2026-01-12', notEmployeeDeclared: true,
  });
  const contract = recordRctContract(db, {
    companyId, subcontractorId: sub.id, projectId: project.id, siteId: site.id, description: 'Plastering', estimatedValueMinor: 5_000_000,
    startsOn: '2026-01-15', labourOnly: false, notifiedOn: '2026-01-14', revenueContractId: 'C-991', recordedBy: 'o',
  });
  const { invoiceId } = createInvoice(db, {
    companyId, direction: 'purchase', invoiceDate: asIsoDate('2026-02-28'), supplierId, documentId: insertConfirmedDocument(db, companyId),
    lines: [{ description: 'Plastering', netMinor: 1_000_000, accountId: created.accountsByCode['5010'] ?? created.accountsByCode['5000']!,
      vatTreatmentId: created.treatmentsByCode['RC_CONSTRUCTION'] ?? created.treatmentsByCode['IE_STD']! }],
  });
  const n = notifyRctPayment(db, { companyId, contractId: contract.id, invoiceId, grossMinor: 1_000_000, notifiedOn: '2026-03-02', recordedBy: 'o' });
  recordDeductionAuthorisation(db, { companyId, rctPaymentId: n.id, number: 'DA-1', rateBasisPoints: 2000, rctMinor: 200_000 });
  payRctPayment(db, { companyId, rctPaymentId: n.id, date: '2026-03-02', paidBy: 'o' });
  return { db, companyId };
}

describe('RCT (TCA s.530, "due date")', () => {
  it('is due 14 days after the return period, or 23 days on the ROS basis, at the tax deducted', () => {
    const { db, companyId } = rctBook();
    const opts = (dueDateBasis: 'statutory' | 'ros') => forecastOptions(db, { companyId, asOf: d('2026-03-10'), overrides: { horizonDays: 60, dueDateBasis } });
    const statutory = statutoryOutflowLines(db, opts('statutory')).lines.find((l) => l.key === 'rct:2026-03')!;
    expect(statutory).toMatchObject({ date: '2026-04-14', amountMinor: -200_000, ruleKey: 'rct.return_due_date', source: 'rule', isEstimate: true });
    expect(statutory.estimateBasis).toMatch(/the period has not ended/);
    const ros = statutoryOutflowLines(db, opts('ros')).lines.find((l) => l.key === 'rct:2026-03')!;
    expect(ros).toMatchObject({ date: '2026-04-23', ruleKey: 'rct.return_due_date_electronic' });
  });

  it('uses the filed return\'s liability, and nothing once the return is paid', () => {
    const { db, companyId } = rctBook();
    fileRctReturn(db, { companyId, period: '2026-03', summaryLiabilityMinor: 200_000, filedOn: '2026-04-10', filedBy: 'o' });
    const o = forecastOptions(db, { companyId, asOf: d('2026-04-11'), overrides: { horizonDays: 30 } });
    expect(statutoryOutflowLines(db, o).lines.find((l) => l.key === 'rct:2026-03')).toMatchObject({ amountMinor: -200_000, isEstimate: false });
    payRctReturn(db, { companyId, period: '2026-03', date: '2026-04-12', paidBy: 'o' });
    expect(statutoryOutflowLines(db, o).lines.some((l) => l.key === 'rct:2026-03')).toBe(false);
  });
});

describe('corporation tax', () => {
  it('forecasts the balance for the year on the statutory 21st or the ROS 23rd, from the computation', () => {
    const { db } = createTestDatabase();
    const created = createCompany(db, { legalName: 'Brabús Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026] });
    const { companyId } = created;
    postJournalEntry(db, { companyId, entryDate: asIsoDate('2025-06-01'), narrative: 'Fees', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [{ accountId: created.accountsByKey['bank_control']!, debitMinor: 8_000_000 }, { accountId: created.accountsByCode['4020']!, creditMinor: 8_000_000 }] });
    const ct = computeCorporationTax(db, { companyId, from: d('2025-01-01'), to: d('2025-12-31') });
    expect(ct.corporationTaxMinor).toBeGreaterThan(0);
    const prelim = ct.dates.preliminaryTax.reduce((s, p) => s + p.amountMinor, 0);
    const o = (dueDateBasis: 'statutory' | 'ros') => forecastOptions(db, { companyId, asOf: d('2026-09-01'), overrides: { horizonDays: 30, dueDateBasis } });
    const statutory = statutoryOutflowLines(db, o('statutory')).lines.find((l) => l.key.startsWith('ct_balance'))!;
    expect(statutory).toMatchObject({ date: '2026-09-21', amountMinor: -(ct.corporationTaxMinor - prelim), ruleKey: 'ct.return_filing_date' });
    expect(statutoryOutflowLines(db, o('ros')).lines.find((l) => l.key.startsWith('ct_balance'))!.date).toBe('2026-09-23');
  });
});

describe('the owner\'s tax', () => {
  it('a sole trader\'s ROS choice falls back to the statutory income tax date, with a finding', () => {
    const { db } = createTestDatabase();
    const created = createCompany(db, { legalName: 'Máire Ní Bhriain', entityType: 'sole_trader', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026] });
    const { companyId } = created;
    postJournalEntry(db, { companyId, entryDate: asIsoDate('2025-06-01'), narrative: 'Fees', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [{ accountId: created.accountsByKey['bank_control']!, debitMinor: 6_000_000 }, { accountId: created.accountsByCode['4020']!, creditMinor: 6_000_000 }] });
    const out = statutoryOutflowLines(db, forecastOptions(db, { companyId, asOf: d('2026-10-01'), overrides: { horizonDays: 60, dueDateBasis: 'ros' } }));
    expect(out.findings.join(' ')).toMatch(/income tax uses the statutory 31 October/);
    const it2025 = computeIncomeTax(db, { companyId, year: 2025 });
    const balance = it2025.individuals.reduce((s, i) => s + i.totalMinor, 0) - it2025.dates.preliminaryTaxMinor;
    expect(balance).toBeGreaterThan(0);
    expect(out.lines.find((l) => l.key === 'it_balance:2025')).toMatchObject({ date: '2026-10-31', amountMinor: -balance, ruleKey: 'income_tax.return_date' });
  });

  it('is left out when the owner chooses, and a partnership\'s is never the firm\'s', () => {
    const { db } = createTestDatabase();
    const sole = createCompany(db, { legalName: 'Máire', entityType: 'sole_trader', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
    const off = statutoryOutflowLines(db, forecastOptions(db, { companyId: sole.companyId, asOf: d('2026-10-01'), overrides: { horizonDays: 60, includeOwnerTax: false, dueDateBasis: 'ros' } }));
    expect(off.lines.some((l) => l.key.startsWith('it_'))).toBe(false);
    expect(off.findings.join(' ')).not.toMatch(/income tax/);
    const firm = createCompany(db, { legalName: 'Ó Sé agus Ó Sé', entityType: 'partnership', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
    const out = statutoryOutflowLines(db, forecastOptions(db, { companyId: firm.companyId, asOf: d('2026-10-01'), overrides: { horizonDays: 60 } }));
    expect(out.findings.join(' ')).toMatch(/Partners pay their own income tax/);
  });
});

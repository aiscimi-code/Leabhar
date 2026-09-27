import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { invoices, reviewItems, suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany } from '../config/setup';
import { confirmRctPrincipal } from '../config/companyStatus';
import { createInvoice } from '../invoicing/invoices';
import { recordPayment } from '../invoicing/payments';
import { reversePayment } from '../invoicing/reversal';
import { accountBalance } from '../accounting/ledger';
import { asIsoDate } from '../dates';
import { accountHistory } from '../invoicing/receivables';
import {
  createProject, createSite, registerSubcontractor, recordRctContract, notifyRctPayment, recordDeductionAuthorisation, payRctPayment,
  rctPeriod, fileRctReturn, payRctReturn, reconcileRct,
} from '.';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let byKey: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Tógáil Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  ({ companyId } = created);
  byCode = created.accountsByCode;
  byKey = created.accountsByKey;
  tr = created.treatmentsByCode;
  confirmRctPrincipal(db, { companyId, status: 'principal', from: '2026-01-01', basis: 'Main contractor', confirmedBy: 'owner' });
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Ó Briain Plastering', matchKey: 'obriain', countryCode: 'IE' }).run();
});

/** A subcontractor under a notified contract, with a €10,000 invoice (reverse charged: no VAT on it). */
function setup() {
  const project = createProject(db, { companyId, code: 'P1', name: 'Scoil extension', startsOn: '2026-01-10', recordedBy: 'o' });
  const site = createSite(db, { companyId, projectId: project.id, name: 'Scoil', address: 'Main St, Tuam', eircode: 'h54 x2y3', recordedBy: 'o' });
  const sub = registerSubcontractor(db, {
    companyId, supplierId, taxReference: '1234567T', identityEvidence: 'Tax clearance and passport', identityCheckedBy: 'owner',
    identityCheckedOn: '2026-01-12', notEmployeeDeclared: true,
  });
  const contract = recordRctContract(db, {
    companyId, subcontractorId: sub.id, projectId: project.id, siteId: site.id, description: 'Plastering', estimatedValueMinor: 5_000_000,
    startsOn: '2026-01-15', labourOnly: false, notifiedOn: '2026-01-14', revenueContractId: 'C-991', recordedBy: 'o',
  });
  const { invoiceId } = createInvoice(db, {
    companyId, direction: 'purchase', invoiceDate: asIsoDate('2026-02-28'), supplierId, documentId: insertConfirmedDocument(db, companyId),
    lines: [{ description: 'Plastering, February', netMinor: 1_000_000, accountId: byCode['5010'] ?? byCode['5000']!, vatTreatmentId: tr['RC_CONSTRUCTION'] ?? tr['IE_STD']! }],
  });
  return { project, site, sub, contract, invoiceId };
}

describe('subcontractors and contracts (issue #548)', () => {
  it('refuses a contract before the principal, the identity and the site are in place', () => {
    const sub = registerSubcontractor(db, {
      companyId, supplierId, taxReference: '1234567T', identityEvidence: 'Passport', identityCheckedBy: 'owner',
      identityCheckedOn: '2026-01-12', notEmployeeDeclared: true,
    });
    expect(() => registerSubcontractor(db, {
      companyId, supplierId, taxReference: 'x', identityEvidence: 'x', identityCheckedBy: 'x', identityCheckedOn: '2026-01-12', notEmployeeDeclared: true,
    })).toThrow(/already registered/);
    expect(() => recordRctContract(db, {
      companyId, subcontractorId: sub.id, description: 'Work', estimatedValueMinor: 100, startsOn: '2025-12-01', labourOnly: true, recordedBy: 'o',
    })).toThrow(/not recorded as an RCT principal/);
    expect(() => recordRctContract(db, {
      companyId, subcontractorId: sub.id, description: 'Work', estimatedValueMinor: 100, startsOn: '2026-02-01', labourOnly: true, recordedBy: 'o',
    })).toThrow(/Name the site/);
    const site = createSite(db, { companyId, name: 'Yard', address: 'Tuam', recordedBy: 'o' });
    expect(() => recordRctContract(db, {
      companyId, subcontractorId: sub.id, siteId: site.id, description: 'Work', estimatedValueMinor: 100, startsOn: '2026-02-01', labourOnly: true,
      notifiedOn: '2026-01-01', revenueContractId: 'C1', recordedBy: 'o',
    })).toThrow(/identity is checked before/);
    expect(() => createSite(db, { companyId, name: 'X', address: 'Y', eircode: '12345', recordedBy: 'o' })).toThrow(/not an Eircode/);
  });
});

describe('payments, returns and reconciliation (issue #549)', () => {
  it('pays net of the authorised tax, settles the invoice in full, and returns and pays the period', () => {
    const { contract, invoiceId } = setup();
    const notified = notifyRctPayment(db, { companyId, contractId: contract.id, invoiceId, grossMinor: 1_000_000, notifiedOn: '2026-03-02', recordedBy: 'o' });
    expect(() => payRctPayment(db, { companyId, rctPaymentId: notified.id, date: '2026-03-02', paidBy: 'o' })).toThrow(/deduction authorisation first/);
    const da = recordDeductionAuthorisation(db, { companyId, rctPaymentId: notified.id, number: 'DA-1', rateBasisPoints: 2000, rctMinor: 200_000 });
    expect(da.warnings).toEqual([]);
    const paid = payRctPayment(db, { companyId, rctPaymentId: notified.id, date: '2026-03-02', paidBy: 'o' });
    expect(paid).toMatchObject({ returnPeriod: '2026-03', paidOn: '2026-03-02' });

    const invoice = db.select().from(invoices).where(eq(invoices.id, invoiceId)).get()!;
    expect([invoice.status, invoice.outstandingMinor]).toEqual(['paid', 0]);
    const bal = (key: string) => accountBalance(db, { companyId, accountId: byKey[key]!, asOf: asIsoDate('2026-03-31') });
    expect(bal('rct_payable')).toBe(200_000);
    expect(bal('creditors')).toBe(0);
    // The supplier's statement shows the cash and the tax separately, and closes at nil.
    const statement = accountHistory(db, { companyId, side: 'supplier', partyId: supplierId, from: asIsoDate('2026-01-01'), to: asIsoDate('2026-12-31') });
    expect(statement.entries.map((e) => [e.kind, e.amountMinor])).toEqual([['invoice', 1_000_000], ['rct_deducted', -200_000], ['payment', -800_000]]);

    const period = rctPeriod(db, { companyId, period: '2026-03' });
    expect([period.grossMinor, period.liabilityMinor]).toEqual([1_000_000, 200_000]);
    fileRctReturn(db, { companyId, period: '2026-03', summaryLiabilityMinor: 200_000, filedOn: '2026-04-10', filedBy: 'o' });
    payRctReturn(db, { companyId, period: '2026-03', date: '2026-04-20', paidBy: 'o' });
    expect(accountBalance(db, { companyId, accountId: byKey['rct_payable']!, asOf: asIsoDate('2026-04-30') })).toBe(0);
    expect(reconcileRct(db, { companyId, asOf: '2026-04-30' })).toMatchObject({ ledgerMinor: 0, deductedMinor: 200_000, paidMinor: 200_000, differenceMinor: 0, unauthorised: [] });
  });

  it('records the authorisation as issued, flagging a sum that is not the rate on the gross', () => {
    const { contract, invoiceId } = setup();
    const n = notifyRctPayment(db, { companyId, contractId: contract.id, invoiceId, grossMinor: 1_000_000, notifiedOn: '2026-03-02', recordedBy: 'o' });
    expect(() => recordDeductionAuthorisation(db, { companyId, rctPaymentId: n.id, number: 'DA', rateBasisPoints: 1000, rctMinor: 1 })).toThrow(/0%, 20% or 35%/);
    const da = recordDeductionAuthorisation(db, { companyId, rctPaymentId: n.id, number: 'DA-2', rateBasisPoints: 3500, rctMinor: 349_000 });
    expect(da.warnings.join(' ')).toMatch(/recorded as issued/);
  });

  it('flags a summary that differs from the books, and a payment made outside the RCT path with its exposure', () => {
    const { contract, invoiceId } = setup();
    const n = notifyRctPayment(db, { companyId, contractId: contract.id, invoiceId, grossMinor: 500_000, notifiedOn: '2026-03-02', recordedBy: 'o' });
    recordDeductionAuthorisation(db, { companyId, rctPaymentId: n.id, number: 'DA-3', rateBasisPoints: 2000, rctMinor: 100_000 });
    payRctPayment(db, { companyId, rctPaymentId: n.id, date: '2026-03-03', paidBy: 'o' });
    fileRctReturn(db, { companyId, period: '2026-03', summaryLiabilityMinor: 120_000, filedOn: '2026-04-10', filedBy: 'o' });
    expect(db.select().from(reviewItems).all().map((r) => r.title).join(' ')).toMatch(/deduction summary is 1200\.00, the books 1000\.00/);
    // The rest of the invoice paid as an ordinary supplier payment: no notification, no authorisation.
    const direct = recordPayment(db, {
      companyId, direction: 'made', paymentDate: asIsoDate('2026-03-20'), amountMinor: 500_000,
      allocations: [{ invoiceId, allocatedMinor: 500_000 }],
    });
    const r = reconcileRct(db, { companyId, asOf: '2026-03-31' });
    // The last determination was the standard rate: a 10% penalty (s.530F(2)(c)).
    expect(r.unauthorised).toEqual([expect.objectContaining({ paymentId: direct.paymentId, amountMinor: 500_000, penaltyRateBasisPoints: 1000, exposureMinor: 50_000 })]);
  });

  it('drops a reversed payment from the period, and the tax with it', () => {
    const { contract, invoiceId } = setup();
    const n = notifyRctPayment(db, { companyId, contractId: contract.id, invoiceId, grossMinor: 1_000_000, notifiedOn: '2026-03-02', recordedBy: 'o' });
    recordDeductionAuthorisation(db, { companyId, rctPaymentId: n.id, number: 'DA-4', rateBasisPoints: 2000, rctMinor: 200_000 });
    const paid = payRctPayment(db, { companyId, rctPaymentId: n.id, date: '2026-03-02', paidBy: 'o' });
    reversePayment(db, { companyId, paymentId: paid.paymentId!, reason: 'Bounced', reversalDate: asIsoDate('2026-03-05') });
    expect(rctPeriod(db, { companyId, period: '2026-03' }).liabilityMinor).toBe(0);
    expect(accountBalance(db, { companyId, accountId: byKey['rct_payable']!, asOf: asIsoDate('2026-03-31') })).toBe(0);
    expect(db.select().from(invoices).where(eq(invoices.id, invoiceId)).get()!.outstandingMinor).toBe(1_000_000);
  });
});

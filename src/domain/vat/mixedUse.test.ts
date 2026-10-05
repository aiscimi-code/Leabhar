import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, insertConfirmedDocument } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice, type InvoiceLineInput } from '../invoicing/invoices';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { buildVat3Return } from './report';
import { precedingReviewPeriodProportion } from './apportionment';
import { makeDate } from '../dates';
import { customers, invoiceLines, reviewItems, suppliers, vatEntries, vatPeriods } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #612: input VAT on a purchase invoice line is deductible only "in so
 * far as" the cost is used for taxable supplies (VATCA s.59(2)) — the private
 * share of a mixed-use cost is not — and on a dual-use input only in the
 * proportion of tax deductible (s.61(2)), taken on a basis in S.I. 639/2010
 * reg.17(2)(a).
 */

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Mixed Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Eir', matchKey: 'eir', countryCode: 'IE' }).run();
});

const purchase = (line: Partial<InvoiceLineInput>, over: { isCreditNote?: boolean; supplier?: string } = {}) => createInvoice(db, {
  companyId, direction: 'purchase', invoiceDate: makeDate(2026, 3, 10), supplierId: over.supplier ?? supplierId,
  invoiceNumber: `P-${Math.random()}`, documentId: insertConfirmedDocument(db, companyId), isCreditNote: over.isCreditNote,
  lines: [{
    description: 'Mobile phone', netMinor: 100_000, statedVatMinor: 23_000,
    accountId: byCode['6030']!, vatTreatmentId: tr['IE_STD']!, ...line,
  }],
});

const vat3 = () => buildVat3Return(db, {
  companyId, vatPeriodId: db.select().from(vatPeriods).where(eq(vatPeriods.name, 'Mar–Apr 2026')).get()!.id,
});
const asOf = makeDate(2026, 12, 31);
const balanced = () => expect(trialBalance(db, { companyId, asOf }).balanced).toBe(true);
const flags = (invoiceId: string) => db.select().from(reviewItems)
  .where(and(eq(reviewItems.entityType, 'invoice'), eq(reviewItems.entityId, invoiceId))).all();

describe('the business-use share (s.59(2))', () => {
  it('a phone used 60% for the business: 60% of the VAT in T2, the rest in the cost', () => {
    const inv = purchase({ businessUseBasisPoints: 6_000 });
    expect(vat3().T2.amountMinor).toBe(13_800);
    // Net 1,000.00 plus the 92.00 of VAT on the private share.
    expect(accountBalance(db, { companyId, accountId: byCode['6030']!, asOf })).toBe(109_200);
    const line = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.invoiceId)).get()!;
    expect(line.businessUseBasisPoints).toBe(6_000);
    const entry = db.select().from(vatEntries).where(eq(vatEntries.sourceId, inv.invoiceId)).get()!;
    expect(entry.recoverableVatMinor).toBe(13_800);
    expect(entry.notes).toMatch(/Business use 60\.00%.*s\.59\(2\)/);
    // A judgement, so flagged — as on the bank path.
    expect(flags(inv.invoiceId).map((f) => f.detail)).toEqual([expect.stringMatching(/60\.00% business use.*s\.59\(2\)/)]);
    balanced();
  });

  it('wholly business use is the default: all the VAT in T2, nothing flagged', () => {
    const inv = purchase({});
    expect(flags(inv.invoiceId)).toEqual([]);
    expect(vat3().T2.amountMinor).toBe(23_000);
    expect(db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.invoiceId)).get()!.businessUseBasisPoints).toBeNull();
  });

  it('a credit note at the same share takes back the same VAT', () => {
    purchase({ businessUseBasisPoints: 6_000 });
    purchase({ businessUseBasisPoints: 6_000 }, { isCreditNote: true });
    expect(vat3().T2.amountMinor).toBe(0);
    balanced();
  });

  it('a reverse charge self-accounts all the VAT in T1 and deducts only the business share in T2', () => {
    const de = ids.supplier();
    db.insert(suppliers).values({ id: de, companyId, name: 'Cloud GmbH', matchKey: 'cloud gmbh', countryCode: 'DE' }).run();
    purchase({ vatTreatmentId: tr['EU_SERVICES_RCV']!, statedVatMinor: undefined, businessUseBasisPoints: 6_000 }, { supplier: de });
    const r = vat3();
    expect(r.T1.amountMinor).toBe(23_000);
    expect(r.T2.amountMinor).toBe(13_800);
    balanced();
  });

  it('VAT held back for another reason stays held back', () => {
    purchase({ businessUseBasisPoints: 6_000, holdRecoveryReason: 'Invoice lacks the supplier VAT number' });
    expect(vat3().T2.amountMinor).toBe(0);
    balanced();
  });
});

describe('the proportion of tax deductible on a dual-use input (s.61(2), reg.17(2)(a))', () => {
  it('deducts the proportion and records the basis it was taken on', () => {
    const inv = purchase({ dualUse: { proportionBasisPoints: 6_000, basis: 'preceding_review_period' } });
    expect(vat3().T2.amountMinor).toBe(13_800);
    const line = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.invoiceId)).get()!;
    expect(line).toMatchObject({ dualUseProportionBasisPoints: 6_000, dualUseBasis: 'preceding_review_period' });
    expect(db.select().from(vatEntries).where(eq(vatEntries.sourceId, inv.invoiceId)).get()!.notes)
      .toMatch(/Dual-use input: 60\.00% deductible \(VATCA s\.61\(2\)\).*reg\.17\(2\)\(a\)\(ii\)/);
    expect(flags(inv.invoiceId)).toEqual([]);
    balanced();
  });

  it('an estimate is deducted and flagged: its basis goes to Revenue with the return (reg.17(2)(b))', () => {
    const inv = purchase({ dualUse: { proportionBasisPoints: 7_500, basis: 'estimate' } });
    expect(vat3().T2.amountMinor).toBe(17_250);
    const [item] = flags(inv.invoiceId);
    expect(item!.detail).toMatch(/reg\.17\(2\)\(b\)/);
    expect(item!.detail).toMatch(/reg\.17\(3\)/);
  });

  it('a private share and a dual-use proportion together: both apply, rounded once', () => {
    // 230.00 x 60% x 50% = 69.00
    purchase({ businessUseBasisPoints: 6_000, dualUse: { proportionBasisPoints: 5_000, basis: 'actual_use' } });
    expect(vat3().T2.amountMinor).toBe(6_900);
    balanced();
  });

  it('the proportion for the preceding review period, on turnover', () => {
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'Client', matchKey: 'client', countryCode: 'IE' }).run();
    const sale = (date: string, net: number, treatment: string) => createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: date as ReturnType<typeof makeDate>, customerId,
      lines: [{ description: 'Service', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr[treatment]! }],
    });
    sale('2025-05-01', 75_000, 'IE_STD');
    sale('2025-06-01', 25_000, 'IE_EXEMPT');
    sale('2026-02-01', 10_000, 'IE_EXEMPT'); // the current review period: not counted
    expect(precedingReviewPeriodProportion(db, { companyId, date: '2026-03-10' }))
      .toMatchObject({ yearStart: '2025-01-01', yearEnd: '2025-12-31', proportionBp: 7_500 });
  });
});

describe('refusals', () => {
  it('outside 0–100%, not whole basis points, a sale, or no basis', () => {
    expect(() => purchase({ businessUseBasisPoints: 10_001 })).toThrow(/0 to 10000/);
    expect(() => purchase({ businessUseBasisPoints: 60.5 })).toThrow(/whole number/);
    expect(() => purchase({ dualUse: { proportionBasisPoints: -1, basis: 'actual_use' } })).toThrow(/0 to 10000/);
    expect(() => purchase({ dualUse: { proportionBasisPoints: 5_000, basis: 'guess' as 'estimate' } })).toThrow(/basis/);
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'Client', matchKey: 'client', countryCode: 'IE' }).run();
    expect(() => createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2026, 3, 10), customerId,
      lines: [{ description: 'Service', netMinor: 1_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']!, businessUseBasisPoints: 5_000 }],
    })).toThrow(/only to a purchase/);
  });
});

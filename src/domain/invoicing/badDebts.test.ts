import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, testVatBasis } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice, voidInvoice } from './invoices';
import { recordPayment } from './payments';
import { writeOffBadDebt, reverseBadDebtWriteOff, claimBadDebtRelief, type BadDebtReliefFacts } from './badDebts';
import { buildVat3Return } from '../vat/report';
import { SI_639_CURATED_RULES } from '../rules/si639Curation';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { asIsoDate, makeDate } from '../dates';
import { invoices, customers, vatEntries, vatPeriods, reviewItems, journalEntries } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

const setup = (basis: 'invoice' | 'cash_receipts') => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', ...testVatBasis(basis), seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
};
beforeEach(() => setup('invoice'));

const sale = (net: number) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
  lines: [{ description: 'Consulting', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
});
const row = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;
const balanced = () => expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
const pay = (invoiceId: string, amount: number, date = '2025-04-01') => recordPayment(db, {
  companyId, direction: 'received', paymentDate: asIsoDate(date), amountMinor: amount,
  allocations: [{ invoiceId, allocatedMinor: amount }],
});

describe('bad debts on the invoice basis (#404)', () => {
  it('charges the outstanding gross to bad debts, touches no VAT return, and flags possible relief', () => {
    const inv = sale(10_000); // 123.00
    pay(inv.invoiceId, 2_300);
    const vatBefore = db.select().from(vatEntries).all().length;
    const result = writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Customer in liquidation', actor: 'Joe' });
    expect(result).toMatchObject({ writtenOffMinor: 10_000, vatCancelledMinor: 0 });
    expect(row(inv.invoiceId)).toMatchObject({ status: 'written_off', outstandingMinor: 0, paidMinor: 2_300, writtenOffMinor: 10_000 });
    expect(accountBalance(db, { companyId, accountId: acc['bad_debts']! })).toBe(10_000);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
    expect(db.select().from(vatEntries).all()).toHaveLength(vatBefore);
    const flag = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `invoice:${inv.invoiceId}:bad_debt`)).get()!;
    expect(flag.detail).toMatch(/s\.39/);
    balanced();
  });

  it('is reversed when the debt is recovered, and blocks payment and voiding while it stands', () => {
    const inv = sale(10_000);
    writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Gone', actor: 'Joe' });
    expect(() => pay(inv.invoiceId, 12_300, '2025-10-15')).toThrow(/reverse the write-off first/);
    expect(() => voidInvoice(db, { companyId, invoiceId: inv.invoiceId, voidDate: asIsoDate('2025-10-15'), reason: 'Raised in error' })).toThrow(/Reverse the write-off/);
    expect(() => writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-10-01'), reason: 'Again', actor: 'Joe' })).toThrow(/already/);

    const back = reverseBadDebtWriteOff(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-10-15'), reason: 'Paid after all', actor: 'Joe' });
    expect(back.outstandingMinor).toBe(12_300);
    expect(row(inv.invoiceId)).toMatchObject({ status: 'issued', writtenOffMinor: 0 });
    expect(accountBalance(db, { companyId, accountId: acc['bad_debts']! })).toBe(0);
    pay(inv.invoiceId, 12_300, '2025-10-15');
    expect(row(inv.invoiceId).status).toBe('paid');
    balanced();
  });

  it('refuses a credit note, a paid invoice, a purchase, a date before the invoice, and no reason', () => {
    const inv = sale(1_000);
    const w = (over: Partial<Parameters<typeof writeOffBadDebt>[1]>) => () => writeOffBadDebt(db, {
      companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Gone', actor: 'Joe', ...over,
    });
    expect(w({ reason: ' ' })).toThrow(/Say why/);
    expect(w({ date: asIsoDate('2025-01-01') })).toThrow(/before the invoice/);
    expect(w({ accountId: acc['debtors'] })).toThrow(/expense account/);
    pay(inv.invoiceId, 1_230);
    expect(w({})).toThrow(/nothing outstanding/);
  });
});

describe('bad debts on the cash receipts basis (#404)', () => {
  it('cancels the unpaid share of deferred VAT and charges only the net to bad debts', () => {
    setup('cash_receipts');
    const inv = sale(10_000); // 123.00, VAT 23.00 deferred
    pay(inv.invoiceId, 6_150); // half paid: 11.50 VAT released
    const result = writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Gone', actor: 'Joe' });
    expect(result).toMatchObject({ writtenOffMinor: 6_150, vatCancelledMinor: 1_150 });
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales_deferred']! })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['vat_on_sales']! })).toBe(1_150);
    expect(accountBalance(db, { companyId, accountId: acc['bad_debts']! })).toBe(5_000);
    expect(accountBalance(db, { companyId, accountId: acc['debtors']! })).toBe(0);
    balanced();
  });
});

describe('bad-debt relief on the invoice basis (#620: VATCA s.39(2), S.I. 639/2010 reg.10)', () => {
  const facts: BadDebtReliefFacts = {
    reasonableStepsTaken: true, allowableUnderTcaS81: true, recordsKept: true, debtorConnected: false,
    taxableLettingUnderS95: false, hirePurchase: false,
  };
  const period = (name: string) => db.select().from(vatPeriods)
    .where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, name))).get()!;
  const box = (name: string, b: 'T1' | 'T2') => buildVat3Return(db, { companyId, vatPeriodId: period(name).id })[b].amountMinor;
  const writeOff = (invoiceId: string) => writeOffBadDebt(db, {
    companyId, invoiceId, date: asIsoDate('2025-09-30'), reason: 'Customer in liquidation', actor: 'Joe',
  });
  const claim = (invoiceId: string, over: Partial<BadDebtReliefFacts> = {}, date = '2025-10-15') => claimBadDebtRelief(db, {
    companyId, invoiceId, date: asIsoDate(date), actor: 'Joe', facts: { ...facts, ...over },
  });

  it('€100 outstanding at 23%: 100 x 23 / 123 = €18.70 in T2 for the claim period, off the bad-debt charge', () => {
    const inv = sale(10_000); // 123.00
    pay(inv.invoiceId, 2_300);
    writeOff(inv.invoiceId);
    const t2Before = box('Sep–Oct 2025', 'T2');
    const r = claim(inv.invoiceId);
    expect(r).toMatchObject({ posted: true, reliefMinor: 1_870 }); // 1869.92
    expect(box('Sep–Oct 2025', 'T2') - t2Before).toBe(1_870);
    expect(box('Sep–Oct 2025', 'T1')).toBe(0);
    expect(accountBalance(db, { companyId, accountId: acc['bad_debts']! })).toBe(10_000 - 1_870);
    expect(row(inv.invoiceId)).toMatchObject({ badDebtReliefMinor: 1_870, badDebtReliefClaimedAt: '2025-10-15' });
    const flag = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `invoice:${inv.invoiceId}:bad_debt`)).get()!;
    expect(flag.title).toContain('Bad-debt relief claimed');
    expect(() => claim(inv.invoiceId)).toThrow(/already been claimed/);
    balanced();
  });

  it('at 13.5%, relief on the whole gross is exactly the VAT charged', () => {
    const inv = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
      lines: [{ description: 'Repairs', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_RED']! }],
    });
    writeOff(inv.invoiceId);
    expect(claim(inv.invoiceId)).toMatchObject({ posted: true, reliefMinor: 1_350 }); // 11350 x 13.5 / 113.5
  });

  it('an unmet reg.10(3) condition, or a s.95 letting, gives no relief and writes nothing', () => {
    const inv = sale(10_000);
    writeOff(inv.invoiceId);
    const journals = db.select().from(journalEntries).all().length;
    const vat = db.select().from(vatEntries).all().length;
    const refused = claim(inv.invoiceId, { reasonableStepsTaken: false, debtorConnected: true });
    expect(refused).toMatchObject({ posted: false });
    if (refused.posted) throw new Error('posted');
    expect(refused.reason).toMatch(/reg\.10\(3\)\(a\).*reg\.10\(3\)\(d\)/);
    expect(claim(inv.invoiceId, { allowableUnderTcaS81: false })).toMatchObject({ posted: false });
    expect(claim(inv.invoiceId, { recordsKept: false })).toMatchObject({ posted: false });
    const letting = claim(inv.invoiceId, { taxableLettingUnderS95: true });
    expect(letting.posted ? '' : letting.reason).toMatch(/s\.39\(3\)/);
    expect(db.select().from(journalEntries).all()).toHaveLength(journals);
    expect(db.select().from(vatEntries).all()).toHaveLength(vat);
    expect(row(inv.invoiceId).badDebtReliefJournalEntryId).toBeNull();
  });

  it('refuses a debt not written off, a claim before the write-off, hire purchase, and mixed rates', () => {
    const open = sale(10_000);
    expect(() => claim(open.invoiceId)).toThrow(/not been written off/);
    writeOff(open.invoiceId);
    expect(() => claim(open.invoiceId, {}, '2025-09-29')).toThrow(/after the debt is written off/);
    expect(() => claim(open.invoiceId, { hirePurchase: true })).toThrow(/reg\.10\(5\)/);
    const mixed = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
      lines: [
        { description: 'Consulting', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! },
        { description: 'Repairs', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr['IE_RED']! },
      ],
    });
    writeOff(mixed.invoiceId);
    expect(() => claim(mixed.invoiceId)).toThrow(/more than one rate/);
  });

  it('refuses a claim dated in a locked VAT period before anything is written', () => {
    const inv = sale(10_000);
    writeOff(inv.invoiceId);
    db.update(vatPeriods).set({ status: 'locked' }).where(eq(vatPeriods.id, period('Sep–Oct 2025').id)).run();
    const journals = db.select().from(journalEntries).all().length;
    expect(() => claim(inv.invoiceId)).toThrow();
    expect(db.select().from(journalEntries).all()).toHaveLength(journals);
    expect(row(inv.invoiceId).badDebtReliefJournalEntryId).toBeNull();
  });

  it('a relieved debt recovered: reversing the write-off charges the tax again in T1 for that period (reg.10(10))', () => {
    const inv = sale(10_000);
    writeOff(inv.invoiceId);
    claim(inv.invoiceId); // 12300 x 23 / 123 = 2300
    expect(row(inv.invoiceId).badDebtReliefMinor).toBe(2_300);
    const back = reverseBadDebtWriteOff(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-11-20'), reason: 'Liquidator paid in full', actor: 'Joe' });
    expect(back).toMatchObject({ outstandingMinor: 12_300, reliefRepaidMinor: 2_300 });
    expect(box('Nov–Dec 2025', 'T1')).toBe(2_300);
    expect(accountBalance(db, { companyId, accountId: acc['bad_debts']! })).toBe(0);
    expect(row(inv.invoiceId)).toMatchObject({ status: 'issued', badDebtReliefMinor: 0, badDebtReliefJournalEntryId: null });
    balanced();
  });

  it('a reversal dated in a locked VAT period is refused, and the write-off and relief stand', () => {
    const inv = sale(10_000);
    writeOff(inv.invoiceId);
    claim(inv.invoiceId);
    db.update(vatPeriods).set({ status: 'locked' }).where(eq(vatPeriods.id, period('Nov–Dec 2025').id)).run();
    expect(() => reverseBadDebtWriteOff(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-11-20'), reason: 'Paid', actor: 'Joe' })).toThrow();
    expect(row(inv.invoiceId)).toMatchObject({ status: 'written_off', badDebtReliefMinor: 2_300 });
  });

  it('the formula is the one in S.I. 639/2010 reg.10(4)', () => {
    const rule = SI_639_CURATED_RULES.find((r) => r.ruleKey === 'vat.bad_debt_relief')!;
    expect(rule.statementExcerpt).toContain('100+B');
  });
});

describe('bad-debt relief on the cash receipts basis (#620)', () => {
  it('is refused: the unpaid VAT was never accounted for', () => {
    setup('cash_receipts');
    const inv = sale(10_000);
    writeOffBadDebt(db, { companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-09-30'), reason: 'Gone', actor: 'Joe' });
    expect(() => claimBadDebtRelief(db, {
      companyId, invoiceId: inv.invoiceId, date: asIsoDate('2025-10-15'), actor: 'Joe',
      facts: { reasonableStepsTaken: true, allowableUnderTcaS81: true, recordsKept: true, debtorConnected: false, taxableLettingUnderS95: false, hirePurchase: false },
    })).toThrow(/cash receipts basis/);
  });
});

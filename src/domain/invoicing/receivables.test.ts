import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from './invoices';
import { recordPayment } from './payments';
import { reversePayment } from './reversal';
import { applyCreditNote } from './customerCredit';
import { writeOffBadDebt } from './badDebts';
import { setCustomerTerms } from '../parties/customerAccount';
import {
  overdueInvoices, customerStatement, produceReminderLetter, reminderLetter, receivablesSummary,
} from './receivables';
import { renderStatementPdf, renderReminderPdf } from '@/lib/receivablesPdf';
import { extractPdfText } from '../extraction/pdfText';
import { accountBalance } from '../accounting/ledger';
import { asIsoDate } from '../dates';
import { customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025] });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
  setCustomerTerms(db, { companyId, customerId, paymentTermsDays: 30, actor: 'Joe' });
});

const sale = (net: number, date: string, over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate(date), customerId,
  lines: [{ description: 'Work', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});
const receive = (amount: number, date: string, allocations: Array<[string, number]>) => recordPayment(db, {
  companyId, direction: 'received', paymentDate: asIsoDate(date), amountMinor: amount, customerId,
  allocations: allocations.map(([invoiceId, allocatedMinor]) => ({ invoiceId, allocatedMinor })),
});

/** January: invoice A. February: invoice B, credit note applied to A, a payment. March: a reversed payment, write-off of C. */
function history() {
  const a = sale(10_000, '2025-01-10'); // 123.00, due 09/02
  const b = sale(20_000, '2025-02-05'); // 246.00, due 07/03
  const cn = sale(1_000, '2025-02-10', { isCreditNote: true, creditNoteOfId: a.invoiceId }); // 12.30
  applyCreditNote(db, { companyId, creditNoteId: cn.invoiceId, invoiceId: a.invoiceId, amountMinor: 1_230, date: asIsoDate('2025-02-10'), actor: 'Joe' });
  receive(11_070, '2025-02-20', [[a.invoiceId, 11_070]]); // A settled
  const bounced = receive(5_000, '2025-03-02', [[b.invoiceId, 5_000]]);
  reversePayment(db, { companyId, paymentId: bounced.paymentId, reason: 'Bounced', reversalDate: asIsoDate('2025-03-05') });
  const c = sale(5_000, '2025-03-01'); // 61.50
  writeOffBadDebt(db, { companyId, invoiceId: c.invoiceId, date: asIsoDate('2025-03-25'), reason: 'Gone', actor: 'Joe' });
  return { a, b, c, cn };
}

describe('customer statement (#405)', () => {
  it('closes at the customer\'s debtors balance, and a later period opens where the earlier closed', () => {
    history();
    const full = customerStatement(db, { companyId, customerId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-03-31') });
    expect(full.openingBalanceMinor).toBe(0);
    expect(full.closingBalanceMinor).toBe(accountBalance(db, { companyId, accountId: acc['debtors']! }));
    expect(full.closingBalanceMinor).toBe(24_600);
    expect(full.entries.map((e) => [e.date, e.kind, e.amountMinor])).toEqual([
      ['2025-01-10', 'invoice', 12_300],
      ['2025-02-05', 'invoice', 24_600],
      ['2025-02-10', 'credit_note', -1_230],
      ['2025-02-20', 'payment', -11_070],
      ['2025-03-01', 'invoice', 6_150],
      ['2025-03-02', 'payment', -5_000],
      ['2025-03-05', 'payment_reversed', 5_000],
      ['2025-03-25', 'write_off', -6_150],
    ]);

    const march = customerStatement(db, { companyId, customerId, from: asIsoDate('2025-03-01'), to: asIsoDate('2025-03-31') });
    const feb = customerStatement(db, { companyId, customerId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-02-28') });
    expect(march.openingBalanceMinor).toBe(feb.closingBalanceMinor);
    expect(march.closingBalanceMinor).toBe(full.closingBalanceMinor);
    // B (due 7 March) is 1–30 days past due at 31 March.
    expect(march.ageing.find((x) => x.label === '1–30 days')!.amountMinor).toBe(24_600);
  });

  it('renders the statement as a PDF', async () => {
    history();
    const st = customerStatement(db, { companyId, customerId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-03-31') });
    const text = await extractPdfText(Buffer.from(await renderStatementPdf(st, { name: 'Acme Ltd', address: '1 Main St' })));
    for (const s of ['STATEMENT OF ACCOUNT', 'Balance brought forward', 'Credit note', 'Written off', 'Balance due', '€246.00']) {
      expect(text).toContain(s);
    }
  });
});

describe('overdue invoices and reminders (#405)', () => {
  it('computes overdue on the day asked, and records each reminder with what was outstanding', async () => {
    const { b } = history();
    expect(overdueInvoices(db, { companyId, asOf: asIsoDate('2025-03-07') })).toEqual([]);
    const overdue = overdueInvoices(db, { companyId, asOf: asIsoDate('2025-03-20') });
    expect(overdue.map((o) => [o.invoiceId, o.daysOverdue, o.outstandingMinor, o.lastReminderLevel])).toEqual([[b.invoiceId, 13, 24_600, null]]);

    const letter = produceReminderLetter(db, { companyId, customerId, asOf: asIsoDate('2025-03-20'), level: 1, actor: 'Joe' });
    expect(letter).toMatchObject({ invoices: 1, totalMinor: 24_600 });
    expect(overdueInvoices(db, { companyId, asOf: asIsoDate('2025-03-21') })[0]).toMatchObject({ lastReminderLevel: 1, lastReminderOn: '2025-03-20' });

    const content = reminderLetter(db, { companyId, letterId: letter.letterId });
    expect(content.title).toBe('Payment reminder');
    const text = await extractPdfText(Buffer.from(await renderReminderPdf(content)));
    expect(text).toContain('PAYMENT REMINDER');
    expect(text).toContain('€246.00');

    expect(() => produceReminderLetter(db, { companyId, customerId, asOf: asIsoDate('2025-03-01'), level: 1, actor: 'Joe' })).toThrow(/Nothing/);
    expect(() => produceReminderLetter(db, { companyId, customerId, asOf: asIsoDate('2025-03-20'), level: 4, actor: 'Joe' })).toThrow(/level 1, 2 or 3/);
  });

  it('summarises receivables: owed, overdue, top debtors, those over their limit, reminders due', () => {
    history();
    setCustomerTerms(db, { companyId, customerId, creditLimitMinor: 10_000, actor: 'Joe' });
    const summary = receivablesSummary(db, { companyId, asOf: asIsoDate('2025-03-20') });
    expect(summary).toMatchObject({ owedMinor: 24_600, overdueMinor: 24_600, overdueCount: 1, needingReminder: 1, onAccountMinor: 0 });
    expect(summary.topDebtors).toEqual([{ customerId, name: 'Mulligan', owedMinor: 24_600, overdueMinor: 24_600 }]);
    expect(summary.overLimit.map((c) => c.customerId)).toEqual([customerId]);
  });
});

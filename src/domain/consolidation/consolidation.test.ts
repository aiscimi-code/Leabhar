import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from '../banking/import';
import { classifyTransaction, ClassificationError } from '../banking/classify';
import { storeDocument } from '../documents/storage';
import { confirmDocument, type ReviewedDocumentValues, type ReviewedLine } from '../documents/review';
import { postDocumentAsInvoice, documentEvidenceLines, ConsolidationError } from './postDocument';
import { settleBankTransaction } from './settle';
import { trialBalance } from '../accounting/ledger';
import { makeDate } from '../dates';
import {
  invoices, invoiceLines, vatEntries, bankTransactions, reviewItems, suppliers, customers, documents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let supplierId: string;
let customerId: string;
let root: string;

const setup = (basis: 'invoice' | 'cash_receipts' = 'cash_receipts') => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: basis, seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, { companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01' });
  supplierId = ids.supplier();
  db.insert(suppliers).values({
    id: supplierId, companyId, name: 'Murphy Office Supplies', matchKey: 'murphy office supplies',
    countryCode: 'IE', vatNumber: 'IE8254410U',
  }).run();
  customerId = ids.customer();
  db.insert(customers).values({
    id: customerId, companyId, name: 'Mulligan Digital', matchKey: 'mulligan digital', countryCode: 'IE',
  }).run();
  root = mkdtempSync(join(tmpdir(), 'consolidation-'));
};

beforeEach(() => setup());
afterEach(() => rmSync(root, { recursive: true, force: true }));

const line = (description: string, net: number, rate: number | null, vat: number | null): ReviewedLine => ({
  description, quantity: null, unitPriceMinor: null, netMinor: net, vatRateBasisPoints: rate, vatMinor: vat,
  grossMinor: vat === null ? null : net + vat,
});

/** A document a person has confirmed, with the given lines. */
function confirmed(over: Partial<ReviewedDocumentValues> & { lines?: ReviewedLine[] }, party: 'supplier' | 'customer' = 'supplier'): string {
  const lines = over.lines ?? [];
  const net = lines.reduce((s, l) => s + (l.netMinor ?? 0), 0);
  const vat = lines.reduce((s, l) => s + (l.vatMinor ?? 0), 0);
  const values: ReviewedDocumentValues = {
    documentType: 'supplier_invoice', invoiceNumber: `INV-${Math.random().toString(36).slice(2, 7)}`,
    documentDate: '2025-03-14', dueDate: null, supplyDate: null, currency: 'EUR',
    supplierNameStated: party === 'supplier' ? 'Murphy Office Supplies' : 'Acme Ltd',
    supplierAddress: null, supplierVatNumber: null, supplierCountry: 'IE',
    customerNameStated: party === 'customer' ? 'Mulligan Digital' : 'Acme Ltd',
    customerAddress: null, customerVatNumber: null, customerCountry: 'IE', vatLegends: [], paymentTerms: null,
    originalDocumentNumber: null, netMinor: net, vatMinor: vat, grossMinor: net + vat, vatTotals: [],
    ...over, lines,
  };
  const stored = storeDocument(db, { companyId, filename: `${Math.random()}.pdf`, content: Buffer.from(String(Math.random())), root });
  confirmDocument(db, {
    companyId, documentId: stored.documentId, values, reviewedBy: 'joe',
    acknowledgedCheckCodes: ['no_lines', 'credit_note_without_original'],
    supplierId: party === 'supplier' ? supplierId : null,
    customerId: party === 'customer' ? customerId : null,
  });
  return stored.documentId;
}

const code = (account: string, treatment: string) => ({ accountId: byCode[account]!, vatTreatmentId: tr[treatment]! });

async function bank(rows: Array<[string, string, string]>) {
  await importStatement(db, {
    companyId, bankAccountId, filename: `s-${Math.random()}.csv`,
    content: ['Date,Description,Amount', ...rows.map((r) => r.join(','))].join('\n'),
    fileFormat: 'csv', columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  return (description: string) => db.select().from(bankTransactions)
    .where(eq(bankTransactions.description, description)).get()!;
}

const entriesFor = (invoiceId: string) => db.select().from(vatEntries).where(eq(vatEntries.sourceId, invoiceId)).all();
const balanced = () => expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);

describe('posting a confirmed document as an invoice', () => {
  it('posts a single-line invoice with the VAT as printed', () => {
    const doc = confirmed({ lines: [line('Printer paper', 2_000, 2300, 460)] });
    const inv = postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6120', 'IE_STD')] });
    expect([inv.netMinor, inv.vatMinor, inv.grossMinor]).toEqual([2_000, 460, 2_460]);
    const [entry] = entriesFor(inv.invoiceId);
    expect(entry).toMatchObject({ direction: 'purchases', vatMinor: 460, recoverableVatMinor: 460, taxPointDate: '2025-03-14' });
    balanced();
  });

  it('posts every line of a multi-line invoice at the same rate, one VAT entry per line', () => {
    const doc = confirmed({ lines: [line('Paper', 2_000, 2300, 460), line('Lamp', 4_000, 2300, 920), line('Pens', 500, 2300, 115)] });
    const inv = postDocumentAsInvoice(db, {
      companyId, documentId: doc, coding: [code('6120', 'IE_STD'), code('6130', 'IE_STD'), code('6120', 'IE_STD')],
    });
    expect(inv.vatMinor).toBe(1_495);
    const lines = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.invoiceId)).orderBy(invoiceLines.lineNumber).all();
    expect(lines.map((l) => [l.accountId, l.vatMinor])).toEqual([[byCode['6120'], 460], [byCode['6130'], 920], [byCode['6120'], 115]]);
    // Every line traces to its printed line, and every VAT entry to its invoice line.
    expect(lines.every((l) => l.documentLineId)).toBe(true);
    expect(entriesFor(inv.invoiceId).map((e) => e.invoiceLineId).sort()).toEqual(lines.map((l) => l.id).sort());
  });

  it('posts mixed rates line by line, never one rate for the whole invoice', () => {
    const doc = confirmed({ lines: [line('Stationery', 10_000, 2300, 2_300), line('Plumbing labour', 20_000, 1350, 2_700), line('Books', 3_000, 0, 0)] });
    const inv = postDocumentAsInvoice(db, {
      companyId, documentId: doc, coding: [code('6120', 'IE_STD'), code('6150', 'IE_RED'), code('6140', 'IE_ZERO')],
    });
    expect(inv.vatMinor).toBe(5_000);
    expect(entriesFor(inv.invoiceId).map((e) => [e.rateBasisPoints, e.vatMinor]).sort()).toEqual([[0, 0], [1350, 2_700], [2300, 2_300]]);
    balanced();
  });

  it('refuses a treatment whose rate differs from the rate printed on the line', () => {
    const doc = confirmed({ lines: [line('Labour', 20_000, 1350, 2_700)] });
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6150', 'IE_STD')] }))
      .toThrow(/printed at 13.5%/);
  });

  it('refuses a no-VAT treatment on a line where VAT was charged', () => {
    const doc = confirmed({ lines: [line('Paper', 2_000, 2300, 460)] });
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6120', 'IE_EXEMPT')] }))
      .toThrow(/charges none/);
  });

  it('self-assesses a reverse-charge invoice on the printed net, which is the total', () => {
    const doc = confirmed({ lines: [line('Cloud hosting', 21_050, null, 0)], vatLegends: ['Reverse charge, Article 196'] });
    const inv = postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6010', 'EU_SERVICES_RCV')] });
    expect(inv.grossMinor).toBe(21_050);
    const entries = entriesFor(inv.invoiceId);
    expect(entries.map((e) => [e.direction, e.vatMinor]).sort()).toEqual([['purchases', 4_842], ['sales', 4_842]]);
    balanced();
  });

  it('posts a credit note negative from its positive printed figures', () => {
    const doc = confirmed({ documentType: 'credit_note', originalDocumentNumber: 'INV-1', lines: [line('Returned lamp', 4_000, 2300, 920)] });
    const inv = postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6130', 'IE_STD')] });
    expect([inv.netMinor, inv.vatMinor, inv.grossMinor]).toEqual([-4_000, -920, -4_920]);
    expect(entriesFor(inv.invoiceId)[0]!.recoverableVatMinor).toBe(-920);
  });

  it('posts a foreign-currency invoice at the rate given, and needs one', () => {
    const doc = confirmed({ currency: 'USD', supplierCountry: 'US', lines: [line('API usage', 12_000, null, 0)] });
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6000', 'NON_EU_SERVICES_RCV')] }))
      .toThrow(/exchange rate/);
    const inv = postDocumentAsInvoice(db, {
      companyId, documentId: doc, coding: [code('6000', 'NON_EU_SERVICES_RCV')],
      fxRate: { numerator: 9, denominator: 10, source: 'ecb', date: '2025-03-14' },
    });
    const row = db.select().from(invoices).where(eq(invoices.id, inv.invoiceId)).get()!;
    expect([row.currency, row.grossMinor, row.baseGrossMinor]).toEqual(['USD', 12_000, 10_800]);
    const input = entriesFor(inv.invoiceId).find((e) => e.direction === 'purchases')!;
    expect(input.baseNetMinor).toBe(10_800);
    balanced();
  });

  it('uses the per-rate totals when the document prints no lines', () => {
    const doc = confirmed({
      lines: [], netMinor: 30_000, vatMinor: 5_000, grossMinor: 35_000,
      vatTotals: [
        { rateBasisPoints: 2300, label: '23%', netMinor: 10_000, vatMinor: 2_300 },
        { rateBasisPoints: 1350, label: '13.5%', netMinor: 20_000, vatMinor: 2_700 },
      ],
    });
    const evidence = documentEvidenceLines(db, { companyId, documentId: doc });
    expect(evidence.lines.map((l) => [l.origin, l.netMinor, l.vatMinor])).toEqual([['vat_total', 10_000, 2_300], ['vat_total', 20_000, 2_700]]);
    const inv = postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6120', 'IE_STD'), code('6150', 'IE_RED')] });
    expect(inv.vatMinor).toBe(5_000);
  });

  it('refuses a bare total under a VAT-charging treatment, rather than splitting it', () => {
    const doc = confirmed({ lines: [], netMinor: null, vatMinor: null, grossMinor: 12_300 });
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6120', 'IE_STD')] }))
      .toThrow(/only a total/);
  });

  it('refuses a draft, a document already posted, and a missing coding', () => {
    const doc = confirmed({ lines: [line('Paper', 2_000, 2300, 460)] });
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [] })).toThrow(/Code every line/);
    postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6120', 'IE_STD')] });
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('6120', 'IE_STD')] }))
      .toThrow(ConsolidationError);
    const draft = storeDocument(db, { companyId, filename: 'd.pdf', content: Buffer.from('draft'), root });
    expect(() => postDocumentAsInvoice(db, { companyId, documentId: draft.documentId, coding: [] }))
      .toThrow(/has not been confirmed/);
  });
});

describe('settling bank lines against invoices', () => {
  const post = (lines: ReviewedLine[], over: Partial<ReviewedDocumentValues> = {}, codes = lines.map(() => code('6120', 'IE_STD'))) =>
    postDocumentAsInvoice(db, { companyId, documentId: confirmed({ lines, ...over }), coding: codes });

  it('settles three invoices with one payment, and computes no VAT from the bank amount', async () => {
    const a = post([line('A', 1_000, 2300, 230)]);
    const b = post([line('B', 2_000, 2300, 460)]);
    const c = post([line('C', 3_000, 2300, 690)]);
    const vatBefore = db.select().from(vatEntries).all().length;
    const find = await bank([['20/03/2025', 'MURPHY OFFICE', '-73.80']]);
    const payment = settleBankTransaction(db, {
      companyId, bankTransactionId: find('MURPHY OFFICE').id,
      allocations: [{ invoiceId: a.invoiceId, amountMinor: 1_230 }, { invoiceId: b.invoiceId, amountMinor: 2_460 }, { invoiceId: c.invoiceId, amountMinor: 3_690 }],
    });
    expect(payment.unallocatedMinor).toBe(0);
    expect(db.select().from(invoices).all().every((i) => i.status === 'paid')).toBe(true);
    expect(db.select().from(vatEntries).all().length).toBe(vatBefore);
    expect(find('MURPHY OFFICE').status).toBe('posted');
    balanced();
  });

  it('settles one invoice over two payments', async () => {
    const inv = post([line('Laptop', 200_000, 2300, 46_000)]);
    const find = await bank([['20/03/2025', 'PART ONE', '-1000.00'], ['20/04/2025', 'PART TWO', '-1460.00']]);
    settleBankTransaction(db, { companyId, bankTransactionId: find('PART ONE').id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 100_000 }] });
    expect(db.select().from(invoices).where(eq(invoices.id, inv.invoiceId)).get()!.status).toBe('part_paid');
    settleBankTransaction(db, { companyId, bankTransactionId: find('PART TWO').id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 146_000 }] });
    const row = db.select().from(invoices).where(eq(invoices.id, inv.invoiceId)).get()!;
    expect([row.status, row.outstandingMinor]).toEqual(['paid', 0]);
    // Input VAT stays dated by the invoice, whatever the payment dates.
    expect(entriesFor(inv.invoiceId).map((e) => e.taxPointDate)).toEqual(['2025-03-14']);
  });

  it('settles a payment net of a credit note', async () => {
    const inv = post([line('Lamps', 10_000, 2300, 2_300)]);
    const cn = post([line('Returned lamp', 4_000, 2300, 920)], { documentType: 'credit_note', originalDocumentNumber: 'X' });
    const find = await bank([['20/03/2025', 'NET PAYMENT', '-73.80']]);
    const payment = settleBankTransaction(db, {
      companyId, bankTransactionId: find('NET PAYMENT').id,
      allocations: [{ invoiceId: inv.invoiceId, amountMinor: 12_300 }, { invoiceId: cn.invoiceId, amountMinor: 4_920 }],
    });
    expect(payment.unallocatedMinor).toBe(0);
    const rows = db.select().from(invoices).all();
    expect(rows.every((r) => r.outstandingMinor === 0)).toBe(true);
    balanced();
  });

  it('holds and flags money left over after the chosen invoices', async () => {
    const inv = post([line('Paper', 2_000, 2300, 460)]);
    const find = await bank([['20/03/2025', 'OVERPAID', '-30.00']]);
    const payment = settleBankTransaction(db, { companyId, bankTransactionId: find('OVERPAID').id, allocations: [{ invoiceId: inv.invoiceId, amountMinor: 2_460 }] });
    expect(payment.unallocatedMinor).toBe(540);
    const item = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `bank_transaction:${find('OVERPAID').id}:unallocated`)).get();
    expect(item?.status).toBe('open');
    balanced();
  });
});

describe('a bank line with no invoice', () => {
  it('claims no input VAT, posts the whole amount as cost, and is flagged', async () => {
    const find = await bank([['20/03/2025', 'CARD PURCHASE', '-123.00']]);
    const tx = find('CARD PURCHASE');
    const result = classifyTransaction(db, { companyId, bankTransactionId: tx.id, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']! });
    expect([result.netMinor, result.vatMinor]).toEqual([12_300, 0]);
    expect(db.select().from(vatEntries).where(eq(vatEntries.sourceId, tx.id)).all()).toHaveLength(0);
    const item = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `bank_transaction:${tx.id}:no_invoice`)).get();
    expect(item?.kind).toBe('missing_document');
    balanced();
  });

  it('refuses to classify a bank line that has a confirmed invoice behind it', async () => {
    const find = await bank([['20/03/2025', 'MURPHY OFFICE', '-24.60']]);
    const doc = confirmed({ lines: [line('Paper', 2_000, 2300, 460)] });
    db.update(documents).set({ matchedTransactionId: find('MURPHY OFFICE').id }).where(eq(documents.id, doc)).run();
    expect(() => classifyTransaction(db, {
      companyId, bankTransactionId: find('MURPHY OFFICE').id, accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']!,
    })).toThrow(ClassificationError);
  });

  it('never computes input VAT from a bank amount, under any VAT-charging treatment', async () => {
    const codes = ['IE_STD', 'IE_RED', 'IE_SECOND_RED', 'EU_SERVICES_RCV', 'NON_EU_SERVICES_RCV', 'EU_GOODS_ACQ'];
    const find = await bank(codes.map((c, i) => [`2${i}/03/2025`, `OUT ${c}`, '-100.00'] as [string, string, string]));
    for (const c of codes) {
      const tx = find(`OUT ${c}`);
      const r = classifyTransaction(db, { companyId, bankTransactionId: tx.id, accountId: byCode['6120']!, vatTreatmentId: tr[c]! });
      expect(r.vatMinor).toBe(0);
    }
    expect(db.select().from(vatEntries).where(eq(vatEntries.direction, 'purchases')).all()).toHaveLength(0);
  });

  it('keeps output VAT on a receipt with no sales document, and flags it', async () => {
    const find = await bank([['20/03/2025', 'TAKINGS', '123.00']]);
    const tx = find('TAKINGS');
    const r = classifyTransaction(db, { companyId, bankTransactionId: tx.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']! });
    expect(r.vatMinor).toBe(2_300);
    expect(db.select().from(reviewItems).where(and(eq(reviewItems.entityId, tx.id), eq(reviewItems.kind, 'missing_document'))).get())
      .toBeTruthy();
  });
});

describe('timing', () => {
  it('on the cash receipts basis dates sales VAT at receipt and purchase VAT at the invoice date', async () => {
    const sale = postDocumentAsInvoice(db, {
      companyId, documentId: confirmed({ documentType: 'sales_invoice', lines: [line('Consulting', 100_000, 2300, 23_000)] }, 'customer'),
      coding: [code('4020', 'IE_STD')],
    });
    const purchase = postDocumentAsInvoice(db, {
      companyId, documentId: confirmed({ lines: [line('Paper', 2_000, 2300, 460)] }), coding: [code('6120', 'IE_STD')],
    });
    expect(sale.vatDeferred).toBe(true);
    expect(entriesFor(sale.invoiceId)).toHaveLength(0);
    expect(entriesFor(purchase.invoiceId).map((e) => e.taxPointDate)).toEqual(['2025-03-14']);

    const find = await bank([['02/05/2025', 'MULLIGAN', '1230.00'], ['03/05/2025', 'MURPHY', '-24.60']]);
    settleBankTransaction(db, { companyId, bankTransactionId: find('MULLIGAN').id, allocations: [{ invoiceId: sale.invoiceId, amountMinor: 123_000 }] });
    settleBankTransaction(db, { companyId, bankTransactionId: find('MURPHY').id, allocations: [{ invoiceId: purchase.invoiceId, amountMinor: 2_460 }] });
    const released = db.select().from(vatEntries).where(eq(vatEntries.direction, 'sales')).all();
    expect(released.map((e) => [e.taxPointDate, e.vatMinor])).toEqual([['2025-05-02', 23_000]]);
    expect(entriesFor(purchase.invoiceId).map((e) => e.taxPointDate)).toEqual(['2025-03-14']);
    balanced();
  });

  it('on the cash receipts basis releases only the net VAT when a customer pays net of our credit note', async () => {
    const sale = postDocumentAsInvoice(db, {
      companyId, documentId: confirmed({ documentType: 'sales_invoice', lines: [line('Consulting', 100_000, 2300, 23_000)] }, 'customer'),
      coding: [code('4020', 'IE_STD')],
    });
    const credit = postDocumentAsInvoice(db, {
      companyId, documentId: confirmed({ documentType: 'credit_note', originalDocumentNumber: 'S-1', lines: [line('Discount', 20_000, 2300, 4_600)] }, 'customer'),
      coding: [code('4020', 'IE_STD')],
    });
    const find = await bank([['02/05/2025', 'MULLIGAN NET', '984.00']]);
    settleBankTransaction(db, {
      companyId, bankTransactionId: find('MULLIGAN NET').id,
      allocations: [{ invoiceId: sale.invoiceId, amountMinor: 123_000 }, { invoiceId: credit.invoiceId, amountMinor: 24_600 }],
    });
    const released = db.select().from(vatEntries).where(eq(vatEntries.direction, 'sales')).all();
    expect(released.reduce((s, e) => s + e.vatMinor, 0)).toBe(18_400);
    expect(released.every((e) => e.taxPointDate === '2025-05-02')).toBe(true);
    balanced();
  });

  it('reports a zero-VAT EU supply once, at the invoice, not again when it is paid', async () => {
    const eu = ids.customer();
    db.insert(customers).values({ id: eu, companyId, name: 'Continental', matchKey: 'continental', countryCode: 'IT', vatNumber: 'IT12345678901' }).run();
    const doc = confirmed({ documentType: 'sales_invoice', customerCountry: 'IT', lines: [line('Licence', 600_000, 0, 0)] }, 'customer');
    db.update(documents).set({ customerId: eu }).where(eq(documents.id, doc)).run();
    const sale = postDocumentAsInvoice(db, { companyId, documentId: doc, coding: [code('4000', 'EU_SERVICES_SUPPLY')] });
    const find = await bank([['31/03/2025', 'CONTINENTAL', '6000.00']]);
    settleBankTransaction(db, { companyId, bankTransactionId: find('CONTINENTAL').id, allocations: [{ invoiceId: sale.invoiceId, amountMinor: 600_000 }] });
    const sales = db.select().from(vatEntries).where(eq(vatEntries.direction, 'sales')).all();
    expect(sales.map((e) => [e.taxPointDate, e.netMinor])).toEqual([['2025-03-14', 600_000]]);
  });

  it('on the invoice basis dates sales VAT at the invoice date', () => {
    setup('invoice');
    const sale = postDocumentAsInvoice(db, {
      companyId, documentId: confirmed({ documentType: 'sales_invoice', lines: [line('Consulting', 100_000, 2300, 23_000)] }, 'customer'),
      coding: [code('4020', 'IE_STD')],
    });
    expect(entriesFor(sale.invoiceId).map((e) => [e.taxPointDate, e.vatMinor])).toEqual([['2025-03-14', 23_000]]);
  });
});

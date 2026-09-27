import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { invoices, invoiceLines, companies, customers, vatTreatments } from '@/db/schema';
import { parseVatNumber } from '../extraction/vatNumbers';
import { billingContact } from '../parties/customerAccount';
import { InvoicingError } from './invoices';

/**
 * What a sales invoice or credit note says (issue #395), arranged for
 * rendering, with the particulars S.I. 639/2010 reg.20(2) requires checked
 * against it. Every figure is the posted invoice's own; nothing is recomputed
 * here except the per-rate summary, which is a sum of the posted lines.
 *
 * A missing particular is never filled in: the document is still produced so
 * it can be reviewed, marked as a draft, and the gaps are listed.
 */

export interface InvoiceParty { name: string; address: string | null; vatNumber: string | null }

export interface InvoiceDocumentLine {
  number: number;
  description: string;
  quantityMilli: number;
  unitPriceMinor: number;
  undiscountedNetMinor: number | null;
  discountBasisPoints: number | null;
  discountMinor: number;
  netMinor: number;
  rateBasisPoints: number;
  vatMinor: number;
  grossMinor: number;
  treatmentCode: string | null;
}

export interface InvoiceDocument {
  invoiceId: string;
  kind: 'invoice' | 'credit_note' | 'debit_note';
  number: string | null;
  issueDate: string;
  supplyDate: string | null;
  dueDate: string | null;
  currency: string;
  supplier: InvoiceParty & { croNumber: string | null; tradingName: string | null };
  customer: InvoiceParty & { attention: string | null };
  /** For a credit note, the invoice it credits. */
  creditsInvoiceNumber: string | null;
  /** For a debit note, the invoice it adds to (issue #403). */
  adjustsInvoiceNumber: string | null;
  lines: InvoiceDocumentLine[];
  /** Net and VAT at each rate (reg.20(2)(j), (k)). */
  rates: Array<{ rateBasisPoints: number; netMinor: number; vatMinor: number }>;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  /** Statements the supply's treatment requires on the invoice. */
  legends: string[];
  missing: Array<{ code: string; paragraph: string; what: string }>;
}

/**
 * The wording each treatment puts on a sales invoice. These follow the
 * Directive's invoice mentions (Art. 226(11), (11a)) and VATCA s.16 for the
 * construction reverse charge; an accountant should confirm them for the
 * business's own supplies.
 */
const LEGENDS: Record<string, string> = {
  EU_GOODS_SUPPLY: 'Intra-Community supply of goods: exempt from Irish VAT (Directive 2006/112/EC, Art. 138).',
  EU_SERVICES_SUPPLY: 'Reverse charge: VAT to be accounted for by the recipient (Directive 2006/112/EC, Art. 196).',
  RC_CONSTRUCTION: 'Reverse charge: VAT on this supply is to be accounted for by the principal contractor (VATCA 2010 s.16).',
  IE_EXEMPT: 'Exempt from VAT.',
  NON_EU_SERVICES_SUPPLY: 'Place of supply outside the State: no Irish VAT charged.',
};

/** Treatments whose invoice must carry the customer's VAT number. */
const NEEDS_CUSTOMER_VAT = new Set(['EU_GOODS_SUPPLY', 'EU_SERVICES_SUPPLY', 'RC_CONSTRUCTION']);

export function salesInvoiceDocument(
  db: AppDatabase, params: { companyId: string; invoiceId: string },
): InvoiceDocument {
  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.id, params.invoiceId), eq(invoices.companyId, params.companyId))).get();
  if (!invoice) throw new InvoicingError(`Invoice ${params.invoiceId} not found.`);
  if (invoice.direction !== 'sales') {
    throw new InvoicingError('Only a sales invoice or credit note is produced here; a purchase invoice is the supplier\'s document.');
  }
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const customer = invoice.customerId
    ? db.select().from(customers).where(eq(customers.id, invoice.customerId)).get()
    : undefined;
  const contact = customer ? billingContact(db, { companyId: params.companyId, customerId: customer.id }) : null;

  const rows = db.select({ line: invoiceLines, treatmentCode: vatTreatments.code })
    .from(invoiceLines).leftJoin(vatTreatments, eq(invoiceLines.vatTreatmentId, vatTreatments.id))
    .where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(invoiceLines.lineNumber).all();

  // A credit note is stored signed; the document states its figures as printed.
  const sign = invoice.isCreditNote ? -1 : 1;
  const lines: InvoiceDocumentLine[] = rows.map(({ line, treatmentCode }) => ({
    number: line.lineNumber,
    description: line.description,
    quantityMilli: line.quantityMilli,
    unitPriceMinor: line.unitPriceMinor,
    undiscountedNetMinor: line.undiscountedNetMinor === null ? null : line.undiscountedNetMinor * sign,
    discountBasisPoints: line.discountBasisPoints,
    discountMinor: line.discountMinor * sign,
    netMinor: line.netMinor * sign,
    rateBasisPoints: line.rateBasisPoints,
    vatMinor: line.vatMinor * sign,
    grossMinor: line.grossMinor * sign,
    treatmentCode,
  }));

  const byRate = new Map<number, { netMinor: number; vatMinor: number }>();
  for (const line of lines) {
    const entry = byRate.get(line.rateBasisPoints) ?? { netMinor: 0, vatMinor: 0 };
    entry.netMinor += line.netMinor;
    entry.vatMinor += line.vatMinor;
    byRate.set(line.rateBasisPoints, entry);
  }
  const rates = [...byRate.entries()].sort(([a], [b]) => b - a)
    .map(([rateBasisPoints, v]) => ({ rateBasisPoints, ...v }));

  const codes = new Set(lines.map((l) => l.treatmentCode).filter((c): c is string => !!c));
  const legends = [...codes].map((c) => LEGENDS[c]).filter((l): l is string => !!l);

  const creditsInvoiceNumber = invoice.creditNoteOfId
    ? db.select({ n: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, invoice.creditNoteOfId)).get()?.n ?? null
    : null;

  const doc: InvoiceDocument = {
    invoiceId: invoice.id,
    kind: invoice.isCreditNote ? 'credit_note' : invoice.isDebitNote ? 'debit_note' : 'invoice',
    number: invoice.invoiceNumber,
    issueDate: invoice.invoiceDate,
    supplyDate: invoice.supplyDate && invoice.supplyDate !== invoice.invoiceDate ? invoice.supplyDate : null,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    supplier: {
      name: company.legalName,
      tradingName: company.tradingName,
      address: company.principalBusinessAddress ?? company.registeredOffice,
      vatNumber: company.vatNumber,
      croNumber: company.croNumber,
    },
    customer: {
      name: customer?.legalName ?? customer?.name ?? '',
      address: customer?.addressLines ?? null,
      vatNumber: customer?.vatNumber ?? null,
      attention: contact?.name ?? null,
    },
    creditsInvoiceNumber,
    adjustsInvoiceNumber: invoice.debitNoteOfId
      ? db.select({ n: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, invoice.debitNoteOfId)).get()?.n ?? null
      : null,
    lines,
    rates,
    netMinor: invoice.netMinor * sign,
    vatMinor: invoice.vatMinor * sign,
    grossMinor: invoice.grossMinor * sign,
    legends,
    missing: [],
  };
  doc.missing = missingSalesParticulars(doc, company.vatRegistrationStatus === 'registered');
  return doc;
}

const blank = (v: string | null | undefined) => !v || !v.trim();

/**
 * The reg.20(2) particulars a sales invoice lacks. Only a VAT-registered
 * business issues VAT invoices; for one that is not, the supplier's VAT number
 * is not asked for.
 */
export function missingSalesParticulars(
  doc: InvoiceDocument, vatRegistered: boolean,
): InvoiceDocument['missing'] {
  const out: InvoiceDocument['missing'] = [];
  const need = (cond: boolean, code: string, paragraph: string, what: string) => {
    if (cond) out.push({ code, paragraph, what });
  };
  need(blank(doc.issueDate), 'date_of_issue', 'reg.20(2)(a)', 'the date of issue');
  need(blank(doc.number), 'sequential_number', 'reg.20(2)(b)', 'a sequential invoice number');
  need(blank(doc.supplier.name), 'supplier_name', 'reg.20(2)(c)', 'your business\'s full name');
  need(blank(doc.supplier.address), 'supplier_address', 'reg.20(2)(c)',
    'your business\'s address (set the principal business address or registered office)');
  if (vatRegistered) {
    const vat = doc.supplier.vatNumber ? parseVatNumber(doc.supplier.vatNumber) : null;
    need(!(vat?.isIrish && vat.structurallyValid), 'supplier_vat_number', 'reg.20(2)(c)', 'your Irish VAT registration number');
  }
  need(blank(doc.customer.name), 'customer_name', 'reg.20(2)(d)', 'the customer\'s full name');
  need(blank(doc.customer.address), 'customer_address', 'reg.20(2)(d)', 'the customer\'s address');
  const needsCustomerVat = doc.lines.some((l) => l.treatmentCode && NEEDS_CUSTOMER_VAT.has(l.treatmentCode));
  need(needsCustomerVat && blank(doc.customer.vatNumber), 'customer_vat_number', 'reg.20(2)(e)',
    'the customer\'s VAT number, which this supply requires');
  need(doc.lines.length === 0 || doc.lines.some((l) => blank(l.description)), 'description', 'reg.20(2)(g)',
    'what was supplied on every line');
  need(doc.kind === 'credit_note' && blank(doc.creditsInvoiceNumber), 'credited_invoice', 'reg.20(3)',
    'the invoice this credit note relates to');
  return out;
}

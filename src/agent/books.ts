import { and, eq, isNull, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  companies, invoices, invoiceLines, bankTransactions, vatPeriods, accounts, vatTreatments,
  suppliers, customers, payments, paymentAllocations,
} from '@/db/schema';
import { asIsoDate, today } from '@/domain/dates';
import { parseAmount } from '@/domain/money';
import { createInvoice, voidInvoice, type CreatedInvoice, type VoidedInvoice } from '@/domain/invoicing/invoices';
import { recordPayment, type RecordedPayment } from '@/domain/invoicing/payments';
import { createAdjustment, type CreatedAdjustment } from '@/domain/accounting/adjustments';
import { reverseJournalEntry, type PostedJournal } from '@/domain/accounting/journal';
import { yearEndPack, type YearEndPack } from '@/domain/reports/yearEnd';
import { buildVat3Return, type Vat3Return } from '@/domain/vat/report';
import { resolveAccountId, resolveVatTreatmentId } from './reconcile';
import { resolveCustomerId, resolveSupplierId } from './induction';
import type {
  CreateInvoiceCsvInput, RecordPaymentCliInput, JournalCliInput,
  ListTransactionsInput, ShowInvoiceInput, YearEndCliInput, VatReturnCliInput,
  VoidInvoiceCliInput, ReverseJournalCliInput,
} from './schema';

/**
 * CLI books commands (issue #153): loading and inspecting the invoice-led
 * middle of a company's books once `induction.ts` has a company, bank
 * account and chart in place.
 */

// ---- CSV parsing (minimal RFC4180-lite: quoted fields, no embedded newlines) ----

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; } else { inQuotes = false; }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsv(content: string): string[][] {
  return content
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim() !== '')
    .map(parseCsvLine);
}

// ---- create-invoice --file <csv> ----

export interface CreateInvoiceCsvRowResult {
  row: number;
  invoiceNumber: string | null;
  invoiceId?: string;
  error?: string;
}

export interface CreateInvoicesFromCsvResult {
  created: number;
  failed: number;
  results: CreateInvoiceCsvRowResult[];
}

/**
 * One CSV row is one invoice with a single line, which is the shape every
 * bill/invoice in the acceptance test pack takes. Required columns:
 * `invoiceNumber`, `date`, `party` (a customer/supplier name or id already
 * created via add-customer/create-supplier), `description`, `net`,
 * `account` (code), `vatTreatment` (code). Optional: `dueDate`, `supplyDate`,
 * `statedVat`, `currency`, `creditNote` ("true"/"false"), `reference`.
 */
export async function createInvoicesFromCsv(
  db: AppDatabase, input: CreateInvoiceCsvInput,
): Promise<CreateInvoicesFromCsvResult> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(input.file, 'utf8');
  const rows = parseCsv(content);
  if (rows.length === 0) throw new Error('CSV file is empty.');

  const header = rows[0]!.map((h) => h.trim());
  const dataRows = rows.slice(1);

  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  if (!company) throw new Error(`Company ${input.companyId} not found.`);

  const results: CreateInvoiceCsvRowResult[] = [];

  for (const [index, cells] of dataRows.entries()) {
    const rowNumber = index + 2; // 1-indexed, plus the header row
    const record: Record<string, string> = {};
    header.forEach((h, i) => { record[h] = (cells[i] ?? '').trim(); });
    const invoiceNumber = record.invoiceNumber || null;

    try {
      const requireCell = (column: string): string => {
        const value = record[column];
        if (!value) throw new Error(`Row ${rowNumber} is missing "${column}".`);
        return value;
      };

      const currency = record.currency || company.baseCurrency;
      const isCreditNote = /^true$/i.test(record.creditNote ?? '');
      const partyId = input.direction === 'sales'
        ? resolveCustomerId(db, input.companyId, requireCell('party'))
        : resolveSupplierId(db, input.companyId, requireCell('party'));
      const accountId = resolveAccountId(db, input.companyId, requireCell('account'));
      const vatTreatmentId = resolveVatTreatmentId(db, input.companyId, requireCell('vatTreatment'));
      const netMinor = parseAmount(requireCell('net'), currency);
      const statedVatMinor = record.statedVat ? parseAmount(record.statedVat, currency) : undefined;

      const created: CreatedInvoice = createInvoice(db, {
        companyId: input.companyId,
        direction: input.direction,
        invoiceDate: asIsoDate(requireCell('date')),
        dueDate: record.dueDate ? asIsoDate(record.dueDate) : null,
        supplyDate: record.supplyDate ? asIsoDate(record.supplyDate) : null,
        supplierId: input.direction === 'purchase' ? partyId : null,
        customerId: input.direction === 'sales' ? partyId : null,
        invoiceNumber,
        reference: record.reference || null,
        currency: currency.toUpperCase() !== company.baseCurrency.toUpperCase() ? currency : undefined,
        isCreditNote,
        lines: [{
          description: record.description || '',
          netMinor,
          accountId,
          vatTreatmentId,
          statedVatMinor,
        }],
        actor: 'cli',
      });

      results.push({ row: rowNumber, invoiceNumber, invoiceId: created.invoiceId });
    } catch (e) {
      results.push({ row: rowNumber, invoiceNumber, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    created: results.filter((r) => !r.error).length,
    failed: results.filter((r) => r.error).length,
    results,
  };
}

// ---- record-payment ----

function resolveInvoiceByNumber(db: AppDatabase, companyId: string, number: string) {
  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.invoiceNumber, number)))
    .get();
  if (!invoice) throw new Error(`Invoice "${number}" not found.`);
  return invoice;
}

export function recordPaymentCli(db: AppDatabase, input: RecordPaymentCliInput): RecordedPayment {
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  if (!company) throw new Error(`Company ${input.companyId} not found.`);

  const transaction = input.bankTransactionId
    ? (() => {
      const t = db.select().from(bankTransactions)
        .where(and(
          eq(bankTransactions.id, input.bankTransactionId!),
          eq(bankTransactions.companyId, input.companyId),
        )).get();
      if (!t) throw new Error(`Bank transaction ${input.bankTransactionId} not found.`);
      return t;
    })()
    : undefined;

  const invoiceNumbers = input.invoices
    ? input.invoices.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const resolvedInvoices = invoiceNumbers.map((number) => resolveInvoiceByNumber(db, input.companyId, number));

  if (resolvedInvoices.length === 0 && !input.unallocated) {
    throw new Error('Supply --invoices (comma-separated invoice numbers) or --unallocated.');
  }

  let direction: 'received' | 'made';
  if (resolvedInvoices.length > 0) {
    // A credit note's cash flow runs the opposite way from its own
    // direction — a sales credit note is refunded ('made'), a purchase
    // credit note refunds us ('received') — issue #157. Grouping by
    // `direction` alone would infer the wrong cash flow for one.
    const cashDirections = new Set<'received' | 'made'>(resolvedInvoices.map((inv) =>
      (inv.direction === 'sales') !== inv.isCreditNote ? 'received' : 'made'));
    if (cashDirections.size > 1) {
      throw new Error(
        'All invoices in one payment must need the same cash-flow direction — mixing an '
          + 'invoice with a credit note that refunds the opposite way is not supported in one payment.',
      );
    }
    direction = [...cashDirections][0]!;
  } else if (transaction) {
    direction = transaction.amountMinor < 0 ? 'made' : 'received';
  } else if (input.direction) {
    direction = input.direction;
  } else {
    throw new Error(
      'Cannot tell whether this payment was received or made — supply --invoices, '
        + '--transaction, or --direction.',
    );
  }

  const currency = (resolvedInvoices[0]?.currency ?? transaction?.currency ?? company.baseCurrency).toUpperCase();
  // A credit note's outstandingMinor is negative (issue #157); the amount of
  // cash it takes to settle one is the magnitude, not the signed figure.
  const amountMinor = input.amount !== undefined
    ? parseAmount(input.amount, currency)
    : transaction
      ? Math.abs(transaction.amountMinor)
      : resolvedInvoices.reduce((s, inv) => s + Math.abs(inv.outstandingMinor), 0);

  // Allocate in the order the invoices were given, each up to its own
  // outstanding balance, until the payment is exhausted — covering an exact
  // single-invoice payment, a lump payment across several invoices, and a
  // part-payment (an --amount below the first invoice's outstanding) alike.
  // Allocated amounts are always positive magnitudes, credit note or not —
  // recordPayment itself applies the credit note's sign (issue #157).
  const allocations: Array<{ invoiceId: string; allocatedMinor: number }> = [];
  if (!input.unallocated) {
    let remaining = amountMinor;
    for (const invoice of resolvedInvoices) {
      if (remaining <= 0) break;
      const allocate = Math.min(remaining, Math.abs(invoice.outstandingMinor));
      if (allocate > 0) {
        allocations.push({ invoiceId: invoice.id, allocatedMinor: allocate });
        remaining -= allocate;
      }
    }
  }

  return recordPayment(db, {
    companyId: input.companyId,
    direction,
    paymentDate: input.date
      ? asIsoDate(input.date)
      : transaction ? asIsoDate(transaction.transactionDate) : today(),
    amountMinor,
    currency,
    method: input.method,
    bankTransactionId: input.bankTransactionId ?? null,
    allocations,
    reference: input.reference,
    actor: 'cli',
  });
}

// ---- journal (manual multi-line adjustment) ----

interface JournalLineJson {
  account: string;
  debit?: number | string;
  credit?: number | string;
  memo?: string;
  supplier?: string;
  customer?: string;
}

export function journalCli(db: AppDatabase, input: JournalCliInput): CreatedAdjustment {
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  if (!company) throw new Error(`Company ${input.companyId} not found.`);
  const currency = company.baseCurrency;

  let rawLines: JournalLineJson[];
  try {
    rawLines = JSON.parse(input.lines) as JournalLineJson[];
  } catch (e) {
    throw new Error(`--lines is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!Array.isArray(rawLines) || rawLines.length < 2) {
    throw new Error('--lines must be a JSON array with at least two entries.');
  }

  const lines = rawLines.map((line, index) => {
    if (!line.account) throw new Error(`Line ${index + 1} is missing "account".`);
    return {
      accountId: resolveAccountId(db, input.companyId, line.account),
      debitMinor: line.debit !== undefined ? parseAmount(String(line.debit), currency) : undefined,
      creditMinor: line.credit !== undefined ? parseAmount(String(line.credit), currency) : undefined,
      memo: line.memo,
      supplierId: line.supplier ? resolveSupplierId(db, input.companyId, line.supplier) : undefined,
      customerId: line.customer ? resolveCustomerId(db, input.companyId, line.customer) : undefined,
    };
  });

  return createAdjustment(db, {
    companyId: input.companyId,
    date: asIsoDate(input.date),
    description: input.narrative,
    reason: input.reason ?? input.narrative,
    lines,
    actor: 'cli',
  });
}

// ---- list-transactions ----

export interface TransactionSummary {
  id: string;
  transactionDate: string;
  description: string;
  amountMinor: number;
  currency: string;
  status: string;
  bankAccountId: string;
}

export function listTransactionsCli(
  db: AppDatabase, input: ListTransactionsInput,
): TransactionSummary[] {
  const conditions = [eq(bankTransactions.companyId, input.companyId)];
  if (input.bankAccountId) conditions.push(eq(bankTransactions.bankAccountId, input.bankAccountId));
  if (input.unclassified) conditions.push(eq(bankTransactions.status, 'unclassified'));
  if (input.unposted) {
    conditions.push(isNull(bankTransactions.journalEntryId));
    conditions.push(ne(bankTransactions.status, 'ignored'));
    conditions.push(ne(bankTransactions.status, 'duplicate'));
  }

  return db.select({
    id: bankTransactions.id,
    transactionDate: bankTransactions.transactionDate,
    description: bankTransactions.description,
    amountMinor: bankTransactions.amountMinor,
    currency: bankTransactions.currency,
    status: bankTransactions.status,
    bankAccountId: bankTransactions.bankAccountId,
  }).from(bankTransactions)
    .where(and(...conditions))
    .orderBy(bankTransactions.transactionDate)
    .all();
}

// ---- show-invoice ----

export interface InvoiceDetailResult {
  invoice: typeof invoices.$inferSelect;
  party: { name: string; countryCode: string | null } | null;
  lines: Array<{
    lineNumber: number; description: string; netMinor: number; vatMinor: number; grossMinor: number;
    accountCode: string | null; accountName: string | null;
    treatmentCode: string | null; treatmentName: string | null;
  }>;
  allocations: Array<{
    paymentId: string; paymentDate: string; allocatedMinor: number; method: string;
  }>;
}

export function showInvoiceCli(db: AppDatabase, input: ShowInvoiceInput): InvoiceDetailResult {
  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.companyId, input.companyId), eq(invoices.invoiceNumber, input.number)))
    .get();
  if (!invoice) throw new Error(`Invoice "${input.number}" not found.`);

  const lineRows = db.select({
    line: invoiceLines,
    accountCode: accounts.code,
    accountName: accounts.name,
    treatmentCode: vatTreatments.code,
    treatmentName: vatTreatments.name,
  }).from(invoiceLines)
    .leftJoin(accounts, eq(invoiceLines.accountId, accounts.id))
    .leftJoin(vatTreatments, eq(invoiceLines.vatTreatmentId, vatTreatments.id))
    .where(eq(invoiceLines.invoiceId, invoice.id))
    .orderBy(invoiceLines.lineNumber)
    .all();

  const allocationRows = db.select({
    paymentId: paymentAllocations.paymentId,
    allocatedMinor: paymentAllocations.allocatedMinor,
    paymentDate: payments.paymentDate,
    method: payments.method,
  }).from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(eq(paymentAllocations.invoiceId, invoice.id))
    .orderBy(payments.paymentDate)
    .all();

  const party = invoice.supplierId
    ? db.select({ name: suppliers.name, countryCode: suppliers.countryCode }).from(suppliers)
      .where(eq(suppliers.id, invoice.supplierId)).get() ?? null
    : invoice.customerId
      ? db.select({ name: customers.name, countryCode: customers.countryCode }).from(customers)
        .where(eq(customers.id, invoice.customerId)).get() ?? null
      : null;

  return {
    invoice,
    party,
    lines: lineRows.map((r) => ({
      lineNumber: r.line.lineNumber,
      description: r.line.description,
      netMinor: r.line.netMinor,
      vatMinor: r.line.vatMinor,
      grossMinor: r.line.grossMinor,
      accountCode: r.accountCode,
      accountName: r.accountName,
      treatmentCode: r.treatmentCode,
      treatmentName: r.treatmentName,
    })),
    allocations: allocationRows,
  };
}

// ---- year-end ----

export function yearEndCli(db: AppDatabase, input: YearEndCliInput): YearEndPack {
  return yearEndPack(db, {
    companyId: input.companyId,
    from: asIsoDate(input.from),
    to: asIsoDate(input.to),
  });
}

// ---- vat-return ----

export function resolveVatPeriodId(db: AppDatabase, companyId: string, idOrName: string): string {
  if (idOrName.startsWith('vp_')) return idOrName;
  const row = db.select({ id: vatPeriods.id }).from(vatPeriods)
    .where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, idOrName)))
    .get();
  if (!row) throw new Error(`VAT period "${idOrName}" not found. Pass its exact name (e.g. "Jan–Feb 2025") or its id.`);
  return row.id;
}

export function vatReturnCli(db: AppDatabase, input: VatReturnCliInput): Vat3Return {
  const vatPeriodId = resolveVatPeriodId(db, input.companyId, input.period);
  return buildVat3Return(db, { companyId: input.companyId, vatPeriodId });
}

// ---- void-invoice ----

/**
 * A mistake made via create-invoice needed no CLI-driven fix path (issue
 * #155) — this resolves the invoice by number and hands off to the domain
 * layer's own voidInvoice, which reverses the journal entry and any VAT
 * entries rather than editing or deleting the original posting.
 */
export function voidInvoiceCli(db: AppDatabase, input: VoidInvoiceCliInput): VoidedInvoice {
  const invoice = resolveInvoiceByNumber(db, input.companyId, input.number);
  return voidInvoice(db, {
    companyId: input.companyId,
    invoiceId: invoice.id,
    voidDate: asIsoDate(input.date),
    reason: input.reason,
    actor: 'cli',
  });
}

// ---- reverse-journal ----

/**
 * A mistake made via journal (or any other posting path) needed no
 * CLI-driven fix path (issue #155) — wraps reverseJournalEntry directly,
 * which works for any journal entry rather than only ones typed as a
 * manual adjustment.
 */
export function reverseJournalCli(db: AppDatabase, input: ReverseJournalCliInput): PostedJournal {
  return reverseJournalEntry(db, {
    companyId: input.companyId,
    entryId: input.entryId,
    reversalDate: asIsoDate(input.date),
    reason: input.reason,
    createdBy: 'cli',
  });
}

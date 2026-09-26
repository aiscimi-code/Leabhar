import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { documents, invoices, bankTransactions } from '@/db/schema';
import {
  documentReviewValues, confirmDocument, type ConfirmDocumentResult,
} from '@/domain/documents/review';
import { checkDocumentValues, type ReviewedDocumentValues, type DocumentCheck } from '@/domain/documents/checks';
import { documentLineChoices } from '@/domain/consolidation/suggest';
import { postDocumentAsInvoice } from '@/domain/consolidation/postDocument';
import { settleBankTransaction } from '@/domain/consolidation/settle';
import { transactionTrace, type TransactionTrace } from '@/domain/consolidation/trace';
import type { CreatedInvoice } from '@/domain/invoicing/invoices';
import type { RecordedPayment } from '@/domain/invoicing/payments';
import { asIsoDate } from '@/domain/dates';
import { parseAmount, parseDecimalRate } from '@/domain/money';
import { resolveAccountId, resolveVatTreatmentId } from './reconcile';

/**
 * CLI wrappers for the invoice-led workflow (issue #222): read a document,
 * confirm it, see each line's treatment options, post it as an invoice, settle
 * a bank line against invoices, and trace the result. Each calls the same
 * domain function as the web screen, so the two cannot disagree.
 *
 * Confirmation stays a person's decision: `confirm-document` requires
 * `--confirmed-by`, the name of the person who checked the document against
 * the page, and records it. An agent must never confirm on its own judgement.
 */

type FxRate = { numerator: number; denominator: number; source: string };

/** "113/100" or "1.13" as an exact fraction; never a float. */
export function parseFxArgument(raw: string | undefined): FxRate | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  const fraction = /^(\d+)\/(\d+)$/.exec(text);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (numerator > 0 && denominator > 0) return { numerator, denominator, source: 'user_supplied' };
  }
  const decimal = parseDecimalRate(text);
  if (decimal) return { ...decimal, source: 'user_supplied' };
  throw new Error(`"${raw}" is not an exchange rate. Give a positive decimal (1.0842) or a fraction (10842/10000).`);
}

function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${what} is not valid JSON.`);
  }
}

// ---- show-document ----

export interface ShowDocumentResult {
  documentId: string;
  filename: string;
  reviewStatus: string;
  invoiceId: string | null;
  /** The values as they stand: the draft read from the page, or what a person confirmed. Amounts in minor units. */
  values: ReviewedDocumentValues;
  /** Arithmetic and completeness checks on those values. Errors block confirmation; warnings need acknowledging. */
  checks: DocumentCheck[];
}

export function showDocumentCli(db: AppDatabase, input: { companyId: string; documentId: string }): ShowDocumentResult {
  const doc = db.select().from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.companyId, input.companyId))).get();
  if (!doc) throw new Error(`Document ${input.documentId} not found.`);
  const { values, reviewStatus } = documentReviewValues(db, input);
  return {
    documentId: doc.id, filename: doc.originalFilename, reviewStatus, invoiceId: doc.invoiceId,
    values, checks: checkDocumentValues(values),
  };
}

// ---- confirm-document ----

export interface ConfirmDocumentCliInput {
  companyId: string;
  documentId: string;
  /** Who checked the document against the page. Required: confirmation is a person's decision. */
  confirmedBy: string;
  /** Corrections to the draft, as JSON: top-level fields replace the draft's; `lines` or `vatTotals`, when given, replace the whole list. Minor units. */
  values?: string;
  /** Comma-separated warning codes the person has read and accepts. */
  ack?: string;
  supplierId?: string;
  customerId?: string;
  createSupplier?: boolean;
  createCustomer?: boolean;
  note?: string;
}

export function confirmDocumentCli(db: AppDatabase, input: ConfirmDocumentCliInput): ConfirmDocumentResult & {
  checks: DocumentCheck[];
} {
  if (!input.confirmedBy?.trim()) {
    throw new Error('--confirmed-by is required: the name of the person who checked this document against the page. '
      + 'An agent must never confirm a document on its own judgement.');
  }
  const { values: draft } = documentReviewValues(db, input);
  const corrections = input.values ? parseJson<Partial<ReviewedDocumentValues>>(input.values, '--values') : {};
  if (typeof corrections !== 'object' || corrections === null || Array.isArray(corrections)) {
    throw new Error('--values must be a JSON object of the fields to correct.');
  }
  const values: ReviewedDocumentValues = { ...draft, ...corrections };
  const result = confirmDocument(db, {
    companyId: input.companyId,
    documentId: input.documentId,
    values,
    reviewedBy: input.confirmedBy.trim(),
    acknowledgedCheckCodes: input.ack ? input.ack.split(',').map((c) => c.trim()).filter(Boolean) : [],
    supplierId: input.supplierId ?? null,
    customerId: input.customerId ?? null,
    createSupplier: input.createSupplier,
    createCustomer: input.createCustomer,
    note: input.note ?? null,
  });
  return { ...result, checks: checkDocumentValues(values) };
}

// ---- line-choices ----

export interface LineChoicesCliResult {
  documentId: string;
  direction: 'sales' | 'purchase';
  /** What the invoice says against itself or the parties' records; while any is open nothing is suggested. */
  conflicts: Array<{ code: string; message: string }>;
  /** Particulars the invoice lacks for its VAT to be deducted; post-document then needs --hold-vat (issue #209). */
  missingParticulars: Array<{ code: string; paragraph: string; what: string }>;
  lines: Array<{
    index: number;
    description: string;
    netMinor: number;
    vatMinor: number | null;
    rateBasisPoints: number | null;
    options: Array<{ treatment: string; name: string; reasons: string[]; ruleKeys: string[] }>;
    /** Set only when every source agrees; otherwise the person chooses. */
    suggestedTreatment: string | null;
    suggestedAccount: string | null;
    accountReason: string | null;
    flags: string[];
  }>;
}

export function lineChoicesCli(db: AppDatabase, input: { companyId: string; documentId: string }): LineChoicesCliResult {
  const choices = documentLineChoices(db, input);
  return {
    documentId: input.documentId,
    direction: choices.direction,
    conflicts: choices.conflicts,
    missingParticulars: choices.missingParticulars,
    lines: choices.lines.map((c, index) => ({
      index,
      description: c.line.description,
      netMinor: c.line.netMinor,
      vatMinor: c.line.vatMinor,
      rateBasisPoints: c.line.rateBasisPoints,
      options: c.options.map((o) => ({ treatment: o.code, name: o.name, reasons: o.reasons, ruleKeys: o.ruleKeys })),
      suggestedTreatment: c.options.find((o) => o.treatmentId === c.preselectedTreatmentId)?.code ?? null,
      suggestedAccount: c.accountId,
      accountReason: c.accountReason,
      flags: c.flags,
    })),
  };
}

// ---- post-document ----

export interface PostDocumentCliInput {
  companyId: string;
  documentId: string;
  /**
   * JSON array, one entry per line in `line-choices` order:
   * `{"account":"6120","treatment":"IE_STD"}`. A line may omit `treatment` or
   * `account` only where `line-choices` suggested one (every source agreed).
   */
  coding: string;
  fx?: string;
  vatDeclarationDate?: string;
  /** Post with the VAT held back when the invoice lacks a required particular (issue #209). */
  holdVat?: boolean;
}

export function postDocumentCli(db: AppDatabase, input: PostDocumentCliInput): CreatedInvoice {
  const entries = parseJson<Array<{ account?: string; treatment?: string }>>(input.coding, '--coding');
  if (!Array.isArray(entries)) throw new Error('--coding must be a JSON array, one entry per line.');
  const choices = documentLineChoices(db, input);
  if (entries.length !== choices.lines.length) {
    throw new Error(`--coding has ${entries.length} entries but the document has ${choices.lines.length} lines. `
      + 'Run line-choices to see them.');
  }
  const coding = choices.lines.map((choice, i) => {
    const entry = entries[i] ?? {};
    let treatmentId: string;
    if (entry.treatment) {
      treatmentId = resolveVatTreatmentId(db, input.companyId, entry.treatment);
    } else if (choice.preselectedTreatmentId) {
      treatmentId = choice.preselectedTreatmentId;
    } else {
      throw new Error(`Line ${i} ("${choice.line.description}") has more than one possible treatment: choose one. `
        + `Options: ${choice.options.map((o) => o.code).join(', ') || 'none suggested'}.`);
    }
    const accountId = entry.account ? resolveAccountId(db, input.companyId, entry.account) : choice.accountId;
    if (!accountId) throw new Error(`Line ${i} ("${choice.line.description}") needs an account.`);
    const chosen = choice.options.find((o) => o.treatmentId === treatmentId);
    return { accountId, vatTreatmentId: treatmentId, vatRuleKeys: chosen?.ruleKeys ?? [] };
  });
  return postDocumentAsInvoice(db, {
    companyId: input.companyId,
    documentId: input.documentId,
    coding,
    fxRate: parseFxArgument(input.fx),
    vatDeclarationDate: input.vatDeclarationDate ? asIsoDate(input.vatDeclarationDate) : undefined,
    holdVatForMissingParticulars: input.holdVat,
    actor: 'cli',
  });
}

// ---- settle ----

export interface SettleCliInput {
  companyId: string;
  bankTransactionId: string;
  /** JSON array: `[{"invoice":"MOS-5120","amount":"24.60"}]`, amounts in the bank line's currency, major units. `invoice` is a number or an id. */
  allocations: string;
  fx?: string;
  vatDeclarationDate?: string;
}

export function settleCli(db: AppDatabase, input: SettleCliInput): RecordedPayment {
  const tx = db.select().from(bankTransactions)
    .where(and(eq(bankTransactions.id, input.bankTransactionId), eq(bankTransactions.companyId, input.companyId))).get();
  if (!tx) throw new Error(`Bank transaction ${input.bankTransactionId} not found.`);
  const entries = parseJson<Array<{ invoice?: string; amount?: string }>>(input.allocations, '--allocations');
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('--allocations must be a JSON array with at least one {"invoice","amount"} entry.');
  }
  const allocations = entries.map((entry, i) => {
    if (!entry.invoice || !entry.amount) throw new Error(`Allocation ${i} needs "invoice" and "amount".`);
    const invoice = db.select({ id: invoices.id }).from(invoices).where(and(
      eq(invoices.companyId, input.companyId),
      entry.invoice.startsWith('inv_') ? eq(invoices.id, entry.invoice) : eq(invoices.invoiceNumber, entry.invoice),
    )).all();
    if (invoice.length === 0) throw new Error(`Invoice "${entry.invoice}" not found.`);
    if (invoice.length > 1) throw new Error(`More than one invoice is numbered "${entry.invoice}": use its id.`);
    return { invoiceId: invoice[0]!.id, amountMinor: parseAmount(String(entry.amount), tx.currency) };
  });
  return settleBankTransaction(db, {
    companyId: input.companyId,
    bankTransactionId: tx.id,
    allocations,
    fxRate: parseFxArgument(input.fx),
    vatDeclarationDate: input.vatDeclarationDate ? asIsoDate(input.vatDeclarationDate) : undefined,
    actor: 'cli',
  });
}

// ---- trace ----

export function traceCli(db: AppDatabase, input: { companyId: string; bankTransactionId: string }): TransactionTrace {
  const trace = transactionTrace(db, input);
  if (!trace) throw new Error(`Bank transaction ${input.bankTransactionId} not found.`);
  return trace;
}

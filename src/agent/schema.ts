import { z } from 'zod';

/**
 * Input schemas for the CLI commands.
 *
 * Each command validates its arguments with one of these before any domain
 * function is called, so a bad flag produces a clean error message rather than
 * a stack trace from inside the accounting engine.
 */

export const isoDate = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  'Dates must be ISO format: YYYY-MM-DD',
);

export const listAccountsInput = z.object({
  companyId: z.string(),
});

export const listReconciliationsInput = z.object({
  companyId: z.string(),
});

export const importInput = z.object({
  companyId: z.string(),
  accountId: z.string(),
  file: z.string(),
});

export const autoClassifyInput = z.object({
  companyId: z.string(),
  bankAccountId: z.string(),
});

export const reconcileInput = z.object({
  companyId: z.string(),
  bankAccountId: z.string(),
  from: isoDate,
  to: isoDate,
  signOff: z.boolean().default(false),
  acceptDifference: z.string().optional(),
  statementClosingBalance: z
    .union([z.number(), z.string().transform((v) => Number(v))])
    .optional(),
});

export const runPipelineInput = z.object({
  companyId: z.string(),
  bankAccountId: z.string(),
  file: z.string().optional(),
  from: isoDate,
  to: isoDate,
  statementClosingBalance: z
    .union([z.number(), z.string().transform((v) => Number(v))])
    .optional(),
  signOff: z.boolean().default(false),
  acceptDifference: z.string().optional(),
});

export type ListAccountsInput = z.infer<typeof listAccountsInput>;
export type ListReconciliationsInput = z.infer<typeof listReconciliationsInput>;
export type ImportInput = z.infer<typeof importInput>;
export type AutoClassifyInput = z.infer<typeof autoClassifyInput>;
export type ReconcileInput = z.infer<typeof reconcileInput>;
export type RunPipelineInput = z.infer<typeof runPipelineInput>;

export const matchInput = z.object({
  companyId: z.string(),
});

export const listMatchesInput = z.object({
  companyId: z.string(),
  decision: z.string().optional(),
});

export const acceptMatchInput = z.object({
  companyId: z.string(),
  documentId: z.string(),
  bankTransactionId: z.string(),
  reason: z.string().optional(),
});

export const linkInput = z.object({
  companyId: z.string(),
  documentId: z.string(),
  bankTransactionId: z.string(),
  reason: z.string().optional(),
});

export const rejectMatchInput = z.object({
  companyId: z.string(),
  documentId: z.string(),
  bankTransactionId: z.string(),
  reason: z.string().optional(),
});

export const unmatchInput = z.object({
  companyId: z.string(),
  documentId: z.string(),
  reason: z.string(),
});

export const createSupplierInput = z.object({
  companyId: z.string(),
  name: z.string(),
  countryCode: z.string().optional(),
  vatNumber: z.string().optional(),
  documentId: z.string().optional(),
});

export type MatchInput = z.infer<typeof matchInput>;
export type ListMatchesInput = z.infer<typeof listMatchesInput>;
export type AcceptMatchInput = z.infer<typeof acceptMatchInput>;
export type LinkInput = z.infer<typeof linkInput>;
export type RejectMatchInput = z.infer<typeof rejectMatchInput>;
export type UnmatchInput = z.infer<typeof unmatchInput>;
export type CreateSupplierInput = z.infer<typeof createSupplierInput>;

export const classifyTxnInput = z.object({
  companyId: z.string(),
  bankTransactionId: z.string(),
  accountId: z.string(),
  vatTreatmentId: z.string(),
  supplierId: z.string().optional(),
  fxRateNumerator: z.number().optional(),
  fxRateDenominator: z.number().optional(),
  notes: z.string().optional(),
});

export const createRuleCliInput = z.object({
  companyId: z.string(),
  name: z.string(),
  conditions: z.array(z.object({
    field: z.string(),
    operator: z.string(),
    value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])), z.null()]),
  })),
  actions: z.array(z.object({
    field: z.string(),
    value: z.union([z.string(), z.null()]),
  })),
  autoApply: z.boolean().optional(),
  priority: z.number().optional(),
});

export const setFxInput = z.object({
  companyId: z.string(),
  bankTransactionId: z.string(),
  baseAmount: z.union([z.number(), z.string().transform((v) => Number(v))]).optional(),
  fxRateNumerator: z.union([z.number(), z.string().transform((v) => Number(v))]).optional(),
  fxRateDenominator: z.union([z.number(), z.string().transform((v) => Number(v))]).optional(),
});

export type ClassifyTxnInput = z.infer<typeof classifyTxnInput>;
export type CreateRuleCliInput = z.infer<typeof createRuleCliInput>;
export type SetFxInput = z.infer<typeof setFxInput>;

// ---- Induction (issue #153) ----

export const initCompanyInput = z.object({
  legalName: z.string(),
  tradingName: z.string().optional(),
  croNumber: z.string().optional(),
  vatNumber: z.string().optional(),
  vatRegistrationStatus: z.enum(['not_registered', 'registered', 'deregistered', 'pending']).optional(),
  vatAccountingBasis: z.enum(['invoice', 'cash_receipts']).optional(),
  vatPeriodFrequency: z.enum(['monthly', 'bi_monthly', 'four_monthly', 'half_yearly', 'annual']).optional(),
  /** "MM-DD", e.g. "12-31". Defaults to 31 December. */
  yearEnd: z.string().regex(/^\d{2}-\d{2}$/, 'Use MM-DD, e.g. 12-31').optional(),
  baseCurrency: z.string().optional(),
  /** Comma-separated years to seed financial/VAT periods for, e.g. "2024,2025". */
  seedYears: z.string().optional(),
});

export const addBankInput = z.object({
  companyId: z.string(),
  bankName: z.string(),
  accountName: z.string().optional(),
  iban: z.string().optional(),
  bic: z.string().optional(),
  currency: z.string().optional(),
  accountType: z.enum(['current', 'deposit', 'savings', 'credit_card', 'loan', 'merchant', 'other']).optional(),
  /** Decimal string in major units, e.g. "14250.00" — parsed with parseAmount(), never a float. */
  opening: z.string().optional(),
  openingDate: isoDate.optional(),
});

export const addAccountInput = z.object({
  companyId: z.string(),
  code: z.string(),
  name: z.string(),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  subtype: z.string().optional(),
  reportSection: z.string().optional(),
  vatApplicable: z.boolean().optional(),
});

export const addCustomerInput = z.object({
  companyId: z.string(),
  name: z.string(),
  countryCode: z.string().optional(),
  vatNumber: z.string().optional(),
  defaultAccount: z.string().optional(),
});

export type InitCompanyInput = z.infer<typeof initCompanyInput>;
export type AddBankInput = z.infer<typeof addBankInput>;
export type AddAccountInput = z.infer<typeof addAccountInput>;
export type AddCustomerInput = z.infer<typeof addCustomerInput>;

// ---- Books (issue #153) ----

export const createInvoiceCsvInput = z.object({
  companyId: z.string(),
  direction: z.enum(['sales', 'purchase']),
  file: z.string(),
});

export const recordPaymentInput = z.object({
  companyId: z.string(),
  bankTransactionId: z.string().optional(),
  /** Comma-separated invoice numbers, in the order to allocate against. */
  invoices: z.string().optional(),
  /** Decimal string in major units — parsed with parseAmount(), never a float. */
  amount: z.string().optional(),
  date: isoDate.optional(),
  unallocated: z.boolean().default(false),
  /** Only needed when neither --invoices nor --transaction implies it. */
  direction: z.enum(['received', 'made']).optional(),
  method: z.enum([
    'bank_transfer', 'card', 'direct_debit', 'cash', 'cheque',
    'director_personal', 'offset', 'other',
  ]).optional(),
  reference: z.string().optional(),
});

export const journalCliInput = z.object({
  companyId: z.string(),
  date: isoDate.optional(),
  narrative: z.string().optional(),
  reason: z.string().optional(),
  /** JSON array of {account, debit?, credit?, memo?, supplier?, customer?}, amounts in major units. */
  lines: z.string(),
  /**
   * A bank transaction id, same as --transaction on classify/record-payment
   * (issue #158). When given, this posts a split for THAT statement line
   * instead of a standalone manual
   * adjustment — linking `bank_transactions.journalEntryId`/`status` to the
   * new entry in the same call, rather than a caller posting then updating
   * the row itself as a second step. `date` and `reason` are ignored: the
   * entry is dated at the transaction's own date, and it is not an
   * adjustment needing a reason.
   */
  transaction: z.string().optional(),
  /** JSON {direction, treatment, net? or gross?, statedVat?, rate?}, major units — only with --transaction. */
  vat: z.string().optional(),
}).refine((v) => v.transaction || (v.date && v.narrative), {
  message: '--date and --narrative are required unless --transaction is given.',
});

export const listTransactionsInput = z.object({
  companyId: z.string(),
  bankAccountId: z.string().optional(),
  unposted: z.boolean().default(false),
  unclassified: z.boolean().default(false),
});

export const showInvoiceInput = z.object({
  companyId: z.string(),
  number: z.string(),
});

export const yearEndCliInput = z.object({
  companyId: z.string(),
  from: isoDate,
  to: isoDate,
});

export const vatReturnCliInput = z.object({
  companyId: z.string(),
  period: z.string(),
});

export type CreateInvoiceCsvInput = z.infer<typeof createInvoiceCsvInput>;
export type RecordPaymentCliInput = z.infer<typeof recordPaymentInput>;
export type JournalCliInput = z.infer<typeof journalCliInput>;
export type ListTransactionsInput = z.infer<typeof listTransactionsInput>;
export type ShowInvoiceInput = z.infer<typeof showInvoiceInput>;
export type YearEndCliInput = z.infer<typeof yearEndCliInput>;
export type VatReturnCliInput = z.infer<typeof vatReturnCliInput>;

// ---- Corrections (issue #155): void-invoice, reverse-journal ----

export const voidInvoiceCliInput = z.object({
  companyId: z.string(),
  number: z.string(),
  date: isoDate,
  reason: z.string(),
});

export const reverseJournalCliInput = z.object({
  companyId: z.string(),
  entryId: z.string(),
  date: isoDate,
  reason: z.string(),
});

export type VoidInvoiceCliInput = z.infer<typeof voidInvoiceCliInput>;
export type ReverseJournalCliInput = z.infer<typeof reverseJournalCliInput>;

// ---- Review queue (issue #155): scan-anomalies, list-review-queue ----

const reviewItemKind = z.enum([
  'unmatched_transaction', 'unclassified_transaction', 'missing_document',
  'uncertain_vat_treatment', 'uncertain_match', 'suspected_duplicate',
  'currency_discrepancy', 'invoice_total_mismatch', 'missing_fx_rate',
  'unbalanced_journal', 'capital_purchase_review', 'missing_vat_number',
  'negative_vat', 'transaction_outside_period', 'unresolved_ai_suggestion',
  'extraction_failed', 'reconciliation_difference', 'period_validation',
  'other',
]);

const reviewItemSeverity = z.enum(['info', 'warning', 'error', 'blocking']);

export const scanAnomaliesCliInput = z.object({
  companyId: z.string(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Also write findings into the review queue, not just report them. */
  sync: z.boolean().default(false),
});

export const listReviewQueueInput = z.object({
  companyId: z.string(),
  status: z.enum(['open', 'resolved', 'dismissed', 'snoozed', 'superseded', 'all']).optional(),
  severity: reviewItemSeverity.optional(),
  kind: reviewItemKind.optional(),
});

export type ScanAnomaliesCliInput = z.infer<typeof scanAnomaliesCliInput>;
export type ListReviewQueueInput = z.infer<typeof listReviewQueueInput>;

// ---- Party lists (issue #155): list-suppliers, list-customers ----

export const listPartiesInput = z.object({
  companyId: z.string(),
});

export type ListPartiesInput = z.infer<typeof listPartiesInput>;

// ---- Chart defaults + Irish SME rule pack (issue #159) ----

export const ensureDefaultAccountsInput = z.object({
  companyId: z.string(),
});

export const installRulePackInput = z.object({
  companyId: z.string(),
  /** Also match this employee's name in the description, alongside the generic SALARY keyword. */
  employee: z.string().optional(),
  /** Account code for a second/savings bank account (defaults to the seeded 1020). */
  secondBankAccount: z.string().optional(),
  /** Account code rent is posted to (defaults to the seeded 6200). */
  rentAccount: z.string().optional(),
});

export type EnsureDefaultAccountsInput = z.infer<typeof ensureDefaultAccountsInput>;
export type InstallRulePackInput = z.infer<typeof installRulePackInput>;

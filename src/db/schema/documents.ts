import { sqliteTable, text, integer, index, unique } from 'drizzle-orm/sqlite-core';
import { timestamps, provenance } from './_shared';
import { companies } from './company';
import { accounts, vatTreatments } from './config';
import { suppliers, customers } from './parties';
import { bankTransactions } from './banking';

/**
 * Document repository (README §11).
 *
 * Invariant #5: the stored file is never modified. Extraction reads it and
 * writes its findings to adjacent tables. The SHA-256 recorded at ingest is
 * re-checkable, which is what lets the year-end pack assert that the evidence
 * behind a figure is the same evidence that was there when it was classified.
 */
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),

  filename: text('filename').notNull(),
  originalFilename: text('original_filename').notNull(),
  /** Path relative to DOCUMENT_STORAGE_PATH. Content-addressed. */
  storagePath: text('storage_path').notNull(),
  mimeType: text('mime_type').notNull(),
  fileSizeBytes: integer('file_size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  pageCount: integer('page_count'),

  documentType: text('document_type', {
    enum: [
      'supplier_invoice', 'sales_invoice', 'receipt', 'bank_statement',
      'credit_note', 'tax_document', 'company_document', 'contract',
      // A till Z-report or daily takings sheet: the evidence for sales made
      // without an invoice (issue #203).
      'sales_record', 'proforma',
      'other', 'unknown',
    ],
  }).notNull().default('unknown'),

  uploadedAt: text('uploaded_at').notNull(),
  uploadedBy: text('uploaded_by').notNull().default('user'),
  /** The date on the document itself, as opposed to when it was filed. */
  documentDate: text('document_date'),

  supplierId: text('supplier_id').references(() => suppliers.id),
  customerId: text('customer_id').references(() => customers.id),
  invoiceNumber: text('invoice_number'),

  currency: text('currency'),
  netMinor: integer('net_minor'),
  vatMinor: integer('vat_minor'),
  grossMinor: integer('gross_minor'),

  /**
   * Everything else the document states (issue #202). Extraction fills these
   * as a best-effort draft; a person confirms or corrects every one of them
   * before the document is used for anything (`reviewStatus`).
   */
  dueDate: text('due_date'),
  /** Date the goods or services were supplied, when it differs from the issue date. */
  supplyDate: text('supply_date'),
  supplierNameStated: text('supplier_name_stated'),
  supplierAddress: text('supplier_address'),
  supplierVatNumber: text('supplier_vat_number'),
  supplierCountry: text('supplier_country'),
  customerNameStated: text('customer_name_stated'),
  customerAddress: text('customer_address'),
  customerVatNumber: text('customer_vat_number'),
  customerCountry: text('customer_country'),
  /** VAT wording printed on the document: "reverse charge", "Article 196", "zero-rated", "exempt"... */
  vatLegends: text('vat_legends', { mode: 'json' }).$type<string[]>().notNull().default([]),
  paymentTerms: text('payment_terms'),
  /** For a credit note: the number of the invoice it credits, as stated. */
  originalDocumentNumber: text('original_document_number'),

  /**
   * Human confirmation (issue #202). Extraction is best effort; nothing may use
   * a document — matching, VAT, suggestions, reports — until a person has
   * checked it against the page and confirmed it. `rejected` means the person
   * decided it is not usable evidence (unreadable, not a business document...).
   */
  reviewStatus: text('review_status', { enum: ['unreviewed', 'confirmed', 'rejected'] })
    .notNull().default('unreviewed'),
  reviewedAt: text('reviewed_at'),
  reviewedBy: text('reviewed_by'),
  reviewNote: text('review_note'),

  suggestedAccountId: text('suggested_account_id').references(() => accounts.id),
  suggestedVatTreatmentId: text('suggested_vat_treatment_id').references(() => vatTreatments.id),

  extractionStatus: text('extraction_status', {
    enum: ['pending', 'extracting', 'extracted', 'failed', 'skipped', 'manual'],
  }).notNull().default('pending'),
  classificationStatus: text('classification_status', {
    enum: ['pending', 'suggested', 'confirmed', 'rejected', 'needs_review'],
  }).notNull().default('pending'),
  matchStatus: text('match_status', {
    enum: ['unmatched', 'suggested', 'matched', 'no_match_expected', 'conflict'],
  }).notNull().default('unmatched'),

  matchedTransactionId: text('matched_transaction_id').references(() => bankTransactions.id),
  invoiceId: text('invoice_id'),

  /**
   * Duplicate detection (§11). A file whose hash already exists is recorded and
   * flagged, never written over the existing one.
   */
  isDuplicateOf: text('is_duplicate_of'),
  duplicateConfirmed: integer('duplicate_confirmed', { mode: 'boolean' })
    .notNull().default(false),

  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  ...provenance,
  ...timestamps,
}, (t) => [
  index('documents_company_idx').on(t.companyId),
  index('documents_hash_idx').on(t.companyId, t.sha256),
  index('documents_status_idx').on(t.companyId, t.extractionStatus, t.matchStatus),
  index('documents_supplier_idx').on(t.companyId, t.supplierId),
]);

/**
 * The result of one extraction run over a document (README §12).
 *
 * Kept separate from `documents` so that re-running extraction with a different
 * provider does not destroy the previous attempt, and so the user can see what
 * each provider proposed and what they themselves confirmed.
 */
export const documentExtractions = sqliteTable('document_extractions', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  documentId: text('document_id').notNull().references(() => documents.id),

  provider: text('provider').notNull(),        // local | anthropic | manual
  providerVersion: text('provider_version'),
  model: text('model'),

  extractedText: text('extracted_text'),
  textExtractionMethod: text('text_extraction_method', {
    enum: ['pdf_text_layer', 'ocr', 'none', 'provided'],
  }),

  /** Field name -> { value, confidence, evidence }. */
  fields: text('fields', { mode: 'json' })
    .$type<Record<string, { value: string | number | null; confidence: number; evidence?: string }>>()
    .notNull().default({}),

  /** Line items and per-rate VAT totals as extracted (issue #202) — kept so a
   *  confirmed correction can always be compared with what was read. */
  lines: text('lines', { mode: 'json' }).$type<ExtractedLineSnapshot[]>().notNull().default([]),
  vatTotals: text('vat_totals', { mode: 'json' }).$type<ExtractedVatTotalSnapshot[]>().notNull().default([]),

  overallConfidence: integer('overall_confidence').notNull().default(0),
  status: text('status', {
    enum: ['pending', 'running', 'succeeded', 'partial', 'failed'],
  }).notNull().default('pending'),
  errorMessage: text('error_message'),

  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  durationMs: integer('duration_ms'),
  ...timestamps,
}, (t) => [index('doc_extractions_document_idx').on(t.documentId)]);

/** One line as extracted, before anyone checked it (stored on the extraction run). */
export interface ExtractedLineSnapshot {
  description: string | null;
  quantity: string | null;
  unitPriceMinor: number | null;
  netMinor: number | null;
  vatRateBasisPoints: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
  confidence: number;
  evidence?: string;
}

/** One VAT-rate total as extracted. */
export interface ExtractedVatTotalSnapshot {
  rateBasisPoints: number | null;
  label: string | null;
  netMinor: number | null;
  vatMinor: number | null;
  confidence: number;
  evidence?: string;
}

/**
 * A line on a document (issue #202): what was supplied, and the VAT the
 * supplier charged on it. One invoice can have many lines at different rates,
 * and it is these lines — never the bank amount — that VAT is taken from
 * (issue #203). Money is integer minor units; `quantity` is a decimal string
 * because it is a count, not money. Lines are part of the document's
 * confirmed content: extraction writes a draft, a person confirms it.
 */
export const documentLines = sqliteTable('document_lines', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  documentId: text('document_id').notNull().references(() => documents.id),
  lineNumber: integer('line_number').notNull(),
  description: text('description').notNull(),
  quantity: text('quantity'),
  unitPriceMinor: integer('unit_price_minor'),
  netMinor: integer('net_minor'),
  /** Null when the line states no rate (e.g. exempt, or the invoice gives rates only in its totals). */
  vatRateBasisPoints: integer('vat_rate_basis_points'),
  vatMinor: integer('vat_minor'),
  grossMinor: integer('gross_minor'),
  ...provenance,
  ...timestamps,
}, (t) => [
  unique('document_lines_document_line_unique').on(t.documentId, t.lineNumber),
  index('document_lines_document_idx').on(t.documentId),
]);

/**
 * The VAT analysis a document prints — net and VAT per rate (issue #202).
 * Many invoices state VAT only here, not per line; it is also the check the
 * lines are reconciled against before confirmation.
 */
export const documentVatTotals = sqliteTable('document_vat_totals', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  documentId: text('document_id').notNull().references(() => documents.id),
  /** Null for a band that states no rate (e.g. "Exempt", "Outside scope"). */
  rateBasisPoints: integer('rate_basis_points'),
  /** The band as the document labels it, e.g. "23%", "Exempt". */
  label: text('label'),
  netMinor: integer('net_minor'),
  vatMinor: integer('vat_minor'),
  ...provenance,
  ...timestamps,
}, (t) => [index('document_vat_totals_document_idx').on(t.documentId)]);

/**
 * A scored candidate link between a document and a bank transaction
 * (README §16). Candidates are stored, not just the winner, so the user can see
 * why a match was proposed and what the alternatives were. Nothing below the
 * auto-accept threshold is ever applied silently.
 */
export const documentMatches = sqliteTable('document_matches', {
  id: text('id').primaryKey(),
  companyId: text('company_id').notNull().references(() => companies.id),
  documentId: text('document_id').notNull().references(() => documents.id),
  bankTransactionId: text('bank_transaction_id').references(() => bankTransactions.id),
  invoiceId: text('invoice_id'),

  matchType: text('match_type', {
    enum: ['matched', 'probable', 'possible', 'no_match', 'conflict'],
  }).notNull(),
  score: integer('score').notNull(), // 0-100

  /** Per-factor contributions, so "MATCH: 98%" is explainable (§43). */
  factors: text('factors', { mode: 'json' })
    .$type<Array<{ factor: string; weight: number; score: number; detail: string }>>()
    .notNull().default([]),

  amountDifferenceMinor: integer('amount_difference_minor'),
  dateDifferenceDays: integer('date_difference_days'),
  currencyMatches: integer('currency_matches', { mode: 'boolean' }),

  decision: text('decision', {
    enum: ['pending', 'accepted', 'rejected', 'superseded', 'auto_accepted'],
  }).notNull().default('pending'),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'),
  decisionReason: text('decision_reason'),

  ...provenance,
  ...timestamps,
}, (t) => [
  index('doc_matches_document_idx').on(t.documentId),
  index('doc_matches_transaction_idx').on(t.bankTransactionId),
  index('doc_matches_decision_idx').on(t.companyId, t.decision),
]);

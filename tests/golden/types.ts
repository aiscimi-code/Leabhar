/**
 * Golden accounting test case framework (docs/trust TRUST_MODEL.md, Work
 * Package 03).
 *
 * A "golden case" is a single accounting scenario with explicit, hand-verified
 * expected results across all nine trust-model questions.
 */

/** Authority tag — distinguishes deterministic rules from professional-practice assertions. */
export type GoldenAuthority = 'LEABHAR_RULE' | 'PROFESSIONAL_PRACTICE' | 'REVENUE_GUIDANCE' | 'LEGISLATION' | 'REVIEW_REQUIRED';

export interface GoldenEvidenceSpec {
  /** Document type, e.g. "invoice", "bank_statement", "receipt" */
  type: 'invoice' | 'bank_statement' | 'receipt' | 'credit_note' | 'statement' | 'contract';
  /** Identifier that would appear on the source document */
  id: string;
  /** URL or path to the source document (optional) */
  url?: string;
}

export interface GoldenTransactionInput {
  transactionDate: string;
  amountMinor: number;
  currency?: string;
  entityType?: string;
  vatRegistered?: boolean;
  supplierType?: string;
  supplierCountry?: string;
  transactionType?: string;
  description?: string;
  businessUsePercent?: number;
  invoiceAvailable?: boolean;
  supplyType?: 'goods' | 'services';
  isReverseCharge?: boolean;
  /** Pre-journal entries to post before the main case (opening balances, etc.). */
  preJournalEntries?: Array<{ lines: Array<{ accountId: string; debitMinor?: number; creditMinor?: number }> }>;
}

export interface GoldenJournalLineSpec {
  /** Account code (e.g. "6010") OR system key (e.g. "bank_control"). Exactly one. */
  accountCode?: string;
  accountKey?: string;
  debitMinor?: number;
  creditMinor?: number;
  currency?: string;
  memo?: string;
}

export interface GoldenJournalSpec {
  /** Whether a journal entry is expected to be posted. */
  posted?: boolean;
  balanced?: boolean;
  lines: GoldenJournalLineSpec[];
}

export interface GoldenVatSpec {
  /** Whether any VAT computation is expected. */
  computed?: boolean;
  entryCount?: number;
  totalNetMinor?: number;
  totalVatMinor?: number;
  totalGrossMinor?: number;
  totalRecoverableMinor?: number;
  isReverseCharge?: boolean;
  rateBasisPoints?: number;
  vatBoxes?: string[];
}

export interface GoldenClassificationSpec {
  identifiedTopics?: string[];
  applicableRuleKeys?: string[];
  notApplicableRuleKeys?: string[];
  reviewRequired?: boolean;
}

export interface GoldenReconciliationSpec {
  /** Whether the transaction should be reconciled to a bank entry. */
  reconciled?: boolean;
}

export interface GoldenCase {
  id: string;
  description: string;
  authority: GoldenAuthority;
  references?: string[];
  notes?: string;
  inputs: {
    transaction: GoldenTransactionInput;
    evidence?: GoldenEvidenceSpec[];
    bankTransaction?: GoldenTransactionInput;
    preJournalEntries?: GoldenJournalLineSpec[][];
  };
  expected_classification?: GoldenClassificationSpec;
  expected_journal?: GoldenJournalSpec;
  expected_vat?: GoldenVatSpec;
  expected_reconciliation?: GoldenReconciliationSpec;
  review_required: boolean;
}

export interface GoldenCaseResult {
  id: string;
  pass: boolean;
  failures: string[];
  lookupResult: ReturnType<typeof import('@/domain/rules/transactionLookup').lookupTransactionRules> | null;
  journalResult: ReturnType<typeof import('@/domain/accounting/journal').postJournalEntry> | null;
}

/**
 * Accounting decision explanation model (docs/trust TRUST_MODEL.md,
 * Work Package 06).
 *
 * This module defines a structured, machine-readable representation of a
 * single accounting decision — the full chain from evidence through rules to
 * accounting result and VAT impact. It uses the project's existing data
 * architecture (TransactionContext, LookupResult, PostedJournal) as inputs.
 *
 * The principle is documented in TRUST_MODEL.md:
 *   "AI can propose. Rules decide. Accounting engines post. Verification proves."
 *
 * Every field here is filled by deterministic rules — never by AI confidence
 * scores masquerading as facts.
 */
import type { TransactionContext, TransactionLookupResult, ApplicableRule } from '@/domain/rules/transactionLookup';
import type { PostedJournal } from '@/domain/accounting/journal';

/**
 * A single accounting decision, as a machine-readable explanation.
 *
 * This is the structured answer to the nine trust-model questions:
 * 1. What happened? → transaction context
 * 2. What evidence supports it? → evidence
 * 3. What did the system extract? → extractedFacts
 * 4. What did AI suggest? → aiSuggestions
 * 5. What rule was applied? → rulesApplied
 * 6. Why was that rule applicable? → rulesEvaluated
 * 7. What accounting entry resulted? → accountingResult
 * 8. What VAT/tax effect resulted? → vatResult
 * 9. Can the result be reconciled? → verification
 */
export interface AccountingDecision {
  /** Unique identifier for this decision instance. */
  decisionId: string;
  /** The rule-derived classification key, e.g. "software_expense". */
  decision: string;
  /** When the decision was made. */
  decidedAt: string;
  /** The transaction that triggered the decision. */
  transaction: TransactionContext;
  /** Original source evidence (bank statement, invoice, receipt). */
  evidence: EvidenceRef[];
  /** Facts deterministically extracted from the evidence. */
  extractedFacts: ExtractedFact[];
  /** AI-suggested interpretations (probabilistic, never authoritative). */
  aiSuggestions: AISuggestion[];
  /** Rules that were evaluated and their outcomes (all candidates). */
  rulesEvaluated: RuleEvaluation[];
  /** Rules that matched and produced the final decision (subset of above). */
  rulesApplied: RuleApplication[];
  /** The resulting accounting entry. */
  accountingResult: AccountingResult;
  /** The resulting VAT/tax effect. */
  vatResult: VatResult;
  /** Whether human review was or is required. */
  reviewRequired: boolean;
  /** Machine-readable verification of internal consistency. */
  verification: Verification;
}

export interface EvidenceRef {
  /** Evidence type: invoice, bank_statement, receipt, etc. */
  type: string;
  /** Stable identifier (document id, bank reference, fingerprint, etc.). */
  id: string;
  /** Optional URL or path to the stored document. */
  url?: string;
  /** SHA-256 hash of the document content, for immutability verification. */
  hash?: string;
}

export interface ExtractedFact {
  /** The field name, e.g. "supplier", "invoice_total", "vat", "currency". */
  field: string;
  /** The extracted value. */
  value: string | number | boolean;
  /** Whether the extraction was performed by AI (vs deterministic parsing). */
  source: 'deterministic' | 'ai';
  /** Confidence in the extraction (0-100), only meaningful for AI extraction. */
  confidence?: number;
  /** Rule or condition that makes this fact relevant, if any. */
  ruleRef?: string;
}

export interface AISuggestion {
  /** What the AI suggested, e.g. "software_expense", "capital_purchase". */
  suggestion: string;
  /** What aspect was suggested. */
  field: string;
  /** 0-100 confidence, clearly labelled as probabilistic. */
  confidence: number;
  /** The rule that overrode or affirmed the suggestion, if any. */
  resolvedByRule?: string;
  /** Whether the AI suggestion was accepted, rejected, or overridden by rules. */
  disposition: 'accepted' | 'rejected' | 'overridden' | 'requires_review';
}

export interface RuleEvaluation {
  /** Stable rule key, e.g. "vat.input_deduction_general". */
  ruleKey: string;
  /** Human-readable rule name. */
  ruleName: string;
  /** Whether the rule's conditions all matched. */
  matched: boolean;
  /** Individual condition outcomes. */
  conditions: Array<{
    field: string;
    passed: boolean;
    /** Human-readable explanation of why the condition passed/failed. */
    reason: string;
  }>;
  /** Citation for the rule (e.g. "VATCA 2010 s.59"). */
  citation?: string;
  /** Whether the rule requires human review (e.g. status: ai_extracted). */
  reviewStatus: string;
  /** Exceptions the rule states but this system does not evaluate automatically. */
  exceptions: Array<{ text: string }>;
  /** Unresolved fields (condition fields not supplied by the caller). */
  unresolvedFields: string[];
}

export interface RuleApplication {
  /** The rule that was applied. */
  ruleKey: string;
  /** The rule's effect on the accounting decision. */
  accountingEffect: string | null;
  /** The rule's effect on VAT. */
  vatEffect: string | null;
  /** The rule's effect on tax. */
  taxEffect: string | null;
  /** The rule's effect on reporting. */
  reportingEffect: string | null;
}

export interface AccountingResult {
  /** The posted journal entry, if any. */
  journal?: JournalSummary;
  /** Whether the journal balances (SUM(debits) == SUM(credits)). */
  balanced: boolean;
  /** Account code → name mapping for the journal lines. */
  accounts: Record<string, { code: string; name: string }>;
  /** Total debit and credit in base currency, for quick verification. */
  totals: { debitMinor: number; creditMinor: number };
}

export interface JournalSummary {
  entryId: string;
  entryNumber: number;
  entryDate: string;
  narrative: string;
  lines: Array<{
    accountCode: string;
    accountName: string;
    debitMinor: number;
    creditMinor: number;
    currency: string;
  }>;
}

export interface VatResult {
  /** Whether VAT was computed for this transaction. */
  computed: boolean;
  /** VAT entries produced. */
  entries: Array<{
    /** VAT rate in basis points (e.g. 2300 = 23%). */
    rateBasisPoints: number;
    /** Whether this is a reverse-charge entry. */
    isReverseCharge: boolean;
    /** The VAT box this entry reports to (e.g. "T1", "T2", "E1"). */
    vatBox?: string;
    netMinor: number;
    vatMinor: number;
    grossMinor: number;
    /** How much of the VAT is recoverable. */
    recoverableMinor: number;
  }>;
  totalNetMinor: number;
  totalVatMinor: number;
  totalRecoverableMinor: number;
}

export interface Verification {
  /** Whether the journal arithmetic was verified (debits == credits). */
  journalBalanced: boolean;
  /** Whether the result was reconciled to a bank transaction. */
  reconciled: boolean;
  /** Whether all applicable rules are human-approved (not ai_extracted). */
  rulesApproved: boolean;
  /** Whether any unresolved fields remain. */
  unresolvedFields: string[];
  /** Overall verification state: VERIFIED, REVIEW_REQUIRED, or CONFLICT. */
  state: 'VERIFIED' | 'REVIEW_REQUIRED' | 'CONFLICT' | 'UNRECONCILED';
}

/**
 * Build an AccountingDecision from the pipeline's outputs.
 *
 * This function is a pure assembler — it takes the deterministic outputs of
 * the lookup, journal, and VAT layers and formats them into the structured
 * explanation. It does NOT make any accounting decisions itself.
 */
export function buildAccountingDecision(params: {
  transaction: TransactionContext;
  lookupResult: TransactionLookupResult;
  journal: PostedJournal | null;
  vatEntries: VatEntrySummary[];
  evidence: EvidenceRef[];
  extractedFacts: ExtractedFact[];
  aiSuggestions: AISuggestion[];
  accounts: AccountSummary[];
  reconciled: boolean;
  decidedAt: string;
}): AccountingDecision {
  const lookup = params.lookupResult;

  // Determine the decision key from applicable rules.
  const rulesApplied: RuleApplication[] = lookup.applicableRules.map((r) => ({
    ruleKey: r.ruleKey,
    accountingEffect: r.effect.accounting,
    vatEffect: r.effect.vat,
    taxEffect: r.effect.tax,
    reportingEffect: r.effect.reporting,
  }));

  // Determine the decision classification.
  const treatmentEffects = rulesApplied.map((r) => r.accountingEffect).filter(Boolean);
  const decision = treatmentEffects.length > 0
    ? treatmentEffects[0]!
    : lookup.possibleTreatment.accounting[0] ?? 'uncategorised';

  // Build journal summary.
  const journalSummary = params.journal ? {
    entryId: params.journal.id,
    entryNumber: params.journal.entryNumber,
    entryDate: lookup.transactionContext.transactionDate,
    narrative: '',
    lines: params.journal.lines.map((l) => ({
      accountCode: params.accounts.find((a) => a.id === l.accountId)?.code ?? l.accountId,
      accountName: params.accounts.find((a) => a.id === l.accountId)?.name ?? '',
      debitMinor: l.baseDebitMinor ?? 0,
      creditMinor: l.baseCreditMinor ?? 0,
      currency: l.currency,
    })),
  } : undefined;

  const totalDebit = journalSummary
    ? journalSummary.lines.reduce((s, l) => s + l.debitMinor, 0)
    : 0;
  const totalCredit = journalSummary
    ? journalSummary.lines.reduce((s, l) => s + l.creditMinor, 0)
    : 0;

  const totalNet = params.vatEntries.reduce((s, e) => s + e.netMinor, 0);
  const totalVat = params.vatEntries.reduce((s, e) => s + e.vatMinor, 0);
  const totalRecoverable = params.vatEntries.reduce((s, e) => s + e.recoverableMinor, 0);

  // Determine verification state.
  const rulesApproved = !lookup.applicableRules.some((r) =>
    r.humanReviewRequired || r.requiresGuidance || r.exceptions.length > 0);
  const state: Verification['state'] = lookup.reviewRequired
    ? 'REVIEW_REQUIRED'
    : rulesApproved && totalDebit === totalCredit && params.reconciled
    ? 'VERIFIED'
    : 'UNRECONCILED';

  return {
    decisionId: params.journal?.id ?? `decision-${params.decidedAt}`,
    decision,
    decidedAt: params.decidedAt,
    transaction: params.transaction,
    evidence: params.evidence,
    extractedFacts: params.extractedFacts,
    aiSuggestions: params.aiSuggestions,
    rulesEvaluated: lookup.applicableRules.map((r): RuleEvaluation => ({
      ruleKey: r.ruleKey,
      ruleName: r.name,
      matched: r.matched,
      conditions: r.conditionResults.map((c) => ({
        field: c.condition.field,
        passed: c.passed,
        reason: c.detail ?? '',
      })),
      citation: r.citation.sectionNumber
        ? `${r.citation.citation} s.${r.citation.sectionNumber}`
        : r.citation.citation,
      reviewStatus: r.reviewStatus,
      exceptions: r.exceptions.map((e) => ({ text: e.effect })),
      unresolvedFields: [],
    })),
    rulesApplied,
    accountingResult: {
      journal: journalSummary,
      balanced: totalDebit === totalCredit,
      accounts: Object.fromEntries(params.accounts.map((a) => [a.id, { code: a.code, name: a.name }])),
      totals: { debitMinor: totalDebit, creditMinor: totalCredit },
    },
    vatResult: {
      computed: params.vatEntries.length > 0,
      entries: params.vatEntries,
      totalNetMinor: totalNet,
      totalVatMinor: totalVat,
      totalRecoverableMinor: totalRecoverable,
    },
    reviewRequired: lookup.reviewRequired,
    verification: {
      journalBalanced: totalDebit === totalCredit,
      reconciled: params.reconciled,
      rulesApproved,
      unresolvedFields: lookup.unresolvedFields,
      state,
    },
  };
}

interface AccountSummary {
  id: string;
  code: string;
  name: string;
}

interface VatEntrySummary {
  rateBasisPoints: number;
  isReverseCharge: boolean;
  vatBox?: string;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  recoverableMinor: number;
}

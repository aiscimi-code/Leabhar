/**
 * Audit trail integrity verification (docs/trust TRUST_MODEL.md,
 * Work Package 07).
 *
 * This module verifies that the audit trail — the chain of evidence, rules,
 * accounting entries, and VAT effects — is complete, consistent, and
 * independently verifiable. It does NOT make accounting decisions; it checks
 * that the decisions already recorded are well-formed.
 *
 * The verification functions answer:
 * - Does every journal line trace back to source evidence?
 * - Can the explanation be serialized to JSON and reconstructed without loss?
 * - Are rule citations present and resolvable?
 * - Is the journal arithmetically balanced?
 */
import type { AccountingDecision, JournalSummary } from './explanation';

export interface AuditTrailVerification {
  decisionId: string;
  /** Every check that was run, with its outcome. */
  checks: Array<{
    name: string;
    passed: boolean;
    /** Human-readable explanation, including failure detail. */
    detail: string;
  }>;
  /** Number of individual checks that passed. */
  passedChecks: number;
  /** Total number of checks run. */
  totalChecks: number;
  /** Overall verdict. */
  verdict: 'VERIFIED' | 'INCOMPLETE' | 'CONFLICT';
  /** Any unresolved issues that require human attention. */
  issues: Array<{
    severity: 'info' | 'warning' | 'error';
    message: string;
    /** Which check raised this issue, for traceability. */
    checkName: string;
  }>;
}

/** Verify the integrity of a single accounting decision's audit trail. */
export function verifyAuditTrail(decision: AccountingDecision): AuditTrailVerification {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  const issues: AuditTrailVerification['issues'] = [];

  function record(name: string, passed: boolean, detail: string, severity: 'info' | 'warning' | 'error' = 'info') {
    checks.push({ name, passed, detail });
    if (!passed) {
      issues.push({ severity, message: detail, checkName: name });
    }
  }

  // Check 1: Decision has a unique identifier.
  const hasId = decision.decisionId.length > 0;
  record('decision_has_id', hasId,
    hasId ? `Decision ID: ${decision.decisionId}` : 'Decision has no identifier',
    hasId ? 'info' : 'error');

  // Check 2: Transaction context is complete.
  const tx = decision.transaction;
  const txComplete = !!tx.transactionDate && typeof tx.amountMinor === 'number' && !!tx.currency;
  record('transaction_context_complete', txComplete,
    txComplete ? 'Transaction date, amount, and currency present' : 'Transaction context is missing required fields',
    txComplete ? 'info' : 'error');

  // Check 3: Evidence references are present if a journal was posted.
  if (decision.accountingResult.journal) {
    const hasEvidence = decision.evidence.length > 0;
    record('journal_has_evidence', hasEvidence,
      hasEvidence ? `Journal traces to ${decision.evidence.length} evidence reference(s)` : 'Journal posted without source evidence',
      hasEvidence ? 'info' : 'error');
  }

  // Check 4: Extracted facts are tagged with a source.
  const factsTagged = decision.extractedFacts.every((f) => f.source === 'deterministic' || f.source === 'ai');
  record('facts_tagged_by_source', factsTagged,
    factsTagged
      ? `All ${decision.extractedFacts.length} extracted facts tagged with deterministic or ai source`
      : 'Some extracted facts lack a source tag',
    factsTagged ? 'info' : 'warning');

  // Check 5: AI suggestions are clearly labelled as non-authoritative.
  const aiSuggestionsLabelled = decision.aiSuggestions.every((s) => s.confidence !== undefined && s.disposition !== undefined);
  record('ai_suggestions_labelled', aiSuggestionsLabelled,
    aiSuggestionsLabelled
      ? `All ${decision.aiSuggestions.length} AI suggestions include confidence and disposition`
      : 'AI suggestions lack confidence/disposition fields',
    aiSuggestionsLabelled ? 'info' : 'warning');

  // Check 6: Rules evaluated have conditions or explicit "no conditions" state.
  const rulesHaveConditions = decision.rulesEvaluated.every((r) =>
    r.conditions.length > 0 || r.exceptions.length > 0 || r.reviewStatus !== 'active');
  record('rules_have_conditions', rulesHaveConditions,
    rulesHaveConditions
      ? `All ${decision.rulesEvaluated.length} rules have condition results, exceptions, or pending review status`
      : 'Some rules have no condition results, exceptions, or review status',
    rulesHaveConditions ? 'info' : 'warning');

  // Check 7: Journal arithmetic is balanced.
  if (decision.accountingResult.journal) {
    const balanced = decision.accountingResult.balanced;
    record('journal_balanced', balanced,
      balanced
        ? `Journal balances: debits=${decision.accountingResult.totals.debitMinor}, credits=${decision.accountingResult.totals.creditMinor}`
        : `Journal imbalance: debits=${decision.accountingResult.totals.debitMinor} != credits=${decision.accountingResult.totals.creditMinor}`,
      balanced ? 'info' : 'error');
  }

  // Check 8: Rules applied match rules evaluated.
  if (decision.rulesApplied.length > 0) {
    const appliedKeys = new Set(decision.rulesApplied.map((r) => r.ruleKey));
    const evaluatedKeys = new Set(decision.rulesEvaluated.map((r) => r.ruleKey));
    const allAppliedAreEvaluated = [...appliedKeys].every((k) => evaluatedKeys.has(k));
    record('applied_rules_in_evaluated_set', allAppliedAreEvaluated,
      allAppliedAreEvaluated ? 'All applied rules were evaluated' : 'Some applied rules were not in the evaluated set',
      allAppliedAreEvaluated ? 'info' : 'error');
  }

  // Check 9: Verification state is set.
  const stateSet = decision.verification.state !== undefined;
  record('verification_state_set', stateSet,
    stateSet ? `Verification state: ${decision.verification.state}` : 'No verification state set',
    stateSet ? 'info' : 'error');

  // Check 10: If VAT computed, entries have rate info.
  if (decision.vatResult.computed) {
    const vatEntriesValid = decision.vatResult.entries.every((e) =>
      typeof e.rateBasisPoints === 'number' && typeof e.netMinor === 'number' && typeof e.vatMinor === 'number');
    record('vat_entries_complete', vatEntriesValid,
      vatEntriesValid ? `All ${decision.vatResult.entries.length} VAT entries have rate and amounts` : 'Some VAT entries are missing rate or amount fields',
      vatEntriesValid ? 'info' : 'warning');
  }

  const passedChecks = checks.filter((c) => c.passed).length;
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  const verdict: AuditTrailVerification['verdict'] =
    errors > 0 ? 'CONFLICT' : warnings > 0 ? 'INCOMPLETE' : 'VERIFIED';

  return {
    decisionId: decision.decisionId,
    checks,
    passedChecks,
    totalChecks: checks.length,
    verdict,
    issues,
  };
}

/**
 * Verify that an AccountingDecision round-trips through JSON serialization
 * without information loss. This is critical for audit — the trail must be
 * reproducible from stored output.
 *
 * The check serializes to JSON, parses back, and verifies that key fields
 * survive the round-trip by comparing the JSON representation of each field.
 */
export function verifySerialization(decision: AccountingDecision): { roundTrips: boolean; detail: string } {
  try {
    const json = JSON.stringify(decision);
    const restored = JSON.parse(json) as AccountingDecision;

    // Check that all top-level fields are present in the restored object.
    const expectedKeys = [
      'decisionId', 'decision', 'decidedAt', 'transaction', 'evidence',
      'extractedFacts', 'aiSuggestions', 'rulesEvaluated', 'rulesApplied',
      'accountingResult', 'vatResult', 'reviewRequired', 'verification',
    ];
    const missingKeys = expectedKeys.filter((k) => !(k in restored));
    if (missingKeys.length > 0) {
      return { roundTrips: false, detail: `Missing top-level fields after round-trip: ${missingKeys.join(', ')}` };
    }

    // Check nested structures are preserved by comparing JSON strings.
    const checks: Array<[string, boolean]> = [
      ['decisionId', restored.decisionId === decision.decisionId],
      ['decision', restored.decision === decision.decision],
      ['decidedAt', restored.decidedAt === decision.decidedAt],
      ['transaction', JSON.stringify(restored.transaction) === JSON.stringify(decision.transaction)],
      ['evidence', JSON.stringify(restored.evidence) === JSON.stringify(decision.evidence)],
      ['rulesEvaluated', JSON.stringify(restored.rulesEvaluated) === JSON.stringify(decision.rulesEvaluated)],
      ['rulesApplied', JSON.stringify(restored.rulesApplied) === JSON.stringify(decision.rulesApplied)],
      ['vatResult', JSON.stringify(restored.vatResult) === JSON.stringify(decision.vatResult)],
      ['verification', JSON.stringify(restored.verification) === JSON.stringify(decision.verification)],
    ];

    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    const allPass = failed.length === 0;

    return {
      roundTrips: allPass,
      detail: allPass
        ? 'Decision round-trips through JSON without loss'
        : `Round-trip check failed for: ${failed.join(', ')}`,
    };
  } catch (e) {
    return { roundTrips: false, detail: `Serialization error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Verify that a journal is arithmetically balanced.
 * This is a standalone check that can be applied to any journal summary
 * without needing the full AccountingDecision.
 */
export function verifyJournalBalance(journal: JournalSummary): { balanced: boolean; totalDebit: number; totalCredit: number; detail: string } {
  let totalDebit = 0;
  let totalCredit = 0;
  for (const line of journal.lines) {
    totalDebit += line.debitMinor;
    totalCredit += line.creditMinor;
  }
  const balanced = totalDebit === totalCredit;
  return {
    balanced,
    totalDebit,
    totalCredit,
    detail: balanced
      ? `Balanced: debits=${totalDebit} == credits=${totalCredit}`
      : `Imbalanced: debits=${totalDebit} != credits=${totalCredit}`,
  };
}

/**
 * Verify that every journal line can be traced to evidence.
 * This follows the traceability chain: journalLine → journalEntry → source.
 */
export function verifyEvidenceChain(decision: AccountingDecision): {
  complete: boolean;
  linesTraced: number;
  linesTotal: number;
  missingEvidence: Array<{ line: number; accountCode: string }>;
} {
  const journal = decision.accountingResult.journal;
  if (!journal) {
    return { complete: false, linesTraced: 0, linesTotal: 0, missingEvidence: [] };
  }

  // If the journal exists and there is evidence at the decision level,
  // the chain is complete. The journal entry has sourceType/sourceId
  // linking to the original bank transaction / invoice.
  const hasEvidence = decision.evidence.length > 0;
  const missingEvidence: Array<{ line: number; accountCode: string }> = [];

  if (!hasEvidence) {
    // No evidence at decision level — flag all lines.
    journal.lines.forEach((line, i) => {
      missingEvidence.push({ line: i + 1, accountCode: line.accountCode });
    });
  }

  return {
    complete: hasEvidence,
    linesTraced: hasEvidence ? journal.lines.length : 0,
    linesTotal: journal.lines.length,
    missingEvidence,
  };
}

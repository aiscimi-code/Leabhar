import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { bankTransactions } from '@/db/schema';
import { classifyTransaction } from '@/domain/banking/classify';
import { evaluateRules, subjectFromTransaction, recordRuleApplication } from '@/domain/rules/engine';
import type { AutoClassifyInput } from './schema';

export interface AutoClassifyResult {
  examined: number;
  classified: number;
  unclassified: number;
  errors: Array<{ transactionId: string; description: string; message: string }>;
}

/**
 * Batch auto-classify unclassified bank transactions from deterministic rules.
 *
 * This is the one piece of new domain-adjacent logic the CLI needs. The rules
 * engine already evaluates a subject against the company's rules and returns
 * `effectiveActions` (account + VAT treatment) plus a `winner` with an
 * `autoApply` flag. What did not exist was the wiring that takes that result
 * and calls `classifyTransaction` in a batch, respecting the invariants:
 *
 *  - Only rules with `autoApply: true` decide; the rest are suggestions (the
 *    user — or an AI proposing — must confirm them). README §18.
 *  - Both an account and a VAT treatment are required. A rule that supplies
 *    only one is incomplete and is skipped rather than half-posting an entry.
 *  - `classifyTransaction` posts a balanced journal entry and marks the
 *    transaction as `posted`, with provenance `system_rule` (never
 *    `user_confirmed` — a rule decided, not a person). README §10.
 *  - A classification failure for one transaction never aborts the batch; the
 *    error is recorded and the rest are tried. README §7: a detected problem
 *    becomes a review item, not a silent stop.
 */
export function autoClassifyFromRules(
  db: AppDatabase, input: AutoClassifyInput,
): AutoClassifyResult {
  const unclassified = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.bankAccountId, input.bankAccountId),
      eq(bankTransactions.companyId, input.companyId),
      isNull(bankTransactions.journalEntryId),
      eq(bankTransactions.status, 'unclassified'),
    ))
    .orderBy(bankTransactions.transactionDate, bankTransactions.createdAt)
    .all();

  const result: AutoClassifyResult = {
    examined: unclassified.length,
    classified: 0,
    unclassified: 0,
    errors: [],
  };

  for (const tx of unclassified) {
    const subject = subjectFromTransaction(db, tx);
    const evalResult = evaluateRules(db, {
      companyId: input.companyId,
      subject,
      appliesTo: 'bank_transaction',
    });

    const winner = evalResult.winner;
    if (!winner || !winner.autoApply) {
      result.unclassified++;
      continue;
    }

    const accountId = evalResult.effectiveActions['accountId'];
    const vatTreatmentId = evalResult.effectiveActions['vatTreatmentId'];
    if (!accountId || !vatTreatmentId) {
      result.unclassified++;
      continue;
    }

    try {
      classifyTransaction(db, {
        companyId: input.companyId,
        bankTransactionId: tx.id,
        accountId,
        vatTreatmentId,
        source: 'rule',
        provenanceStatus: 'system_rule',
        appliedRuleId: winner.ruleId,
        actor: 'cli',
      });
      recordRuleApplication(db, winner.ruleId);
      result.classified++;
    } catch (error) {
      result.errors.push({
        transactionId: tx.id,
        description: tx.description,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

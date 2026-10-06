import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishTaxRules, type IrishRuleReviewStatus } from '@/db/schema';
import { nowIso } from '../dates';
import { atomically } from '../accounting/journal';
import { recordRuleDecision } from './ruleDecisions';

/**
 * Move a rule through the review lifecycle (task: DRAFT -> AI_EXTRACTED ->
 * HUMAN_REVIEW -> APPROVED -> ACTIVE -> SUPERSEDED).
 *
 * Reaching `active` is the only thing that turns off `humanReviewRequired`
 * for lookup purposes — an AI-extracted rule never becomes authoritative on
 * its own (task: "never make AI-generated legal rules automatically
 * authoritative"). Reaching `rejected` disables the rule outright so it can
 * never again surface as a candidate, while leaving the row (and the reason)
 * on record rather than deleting it.
 *
 * Every call also appends the decision to `irish_rule_decisions`, so the
 * book's history of decisions is kept when a later one replaces the row's.
 */
export function setRuleReviewStatus(
  db: AppDatabase,
  params: { ruleId: string; status: IrishRuleReviewStatus; reviewedBy: string; notes?: string },
): void {
  const rule = db.select({ id: irishTaxRules.id, companyId: irishTaxRules.companyId, ruleKey: irishTaxRules.ruleKey, ruleVersion: irishTaxRules.ruleVersion }).from(irishTaxRules)
    .where(eq(irishTaxRules.id, params.ruleId)).get();
  if (!rule) throw new Error(`No rule with id ${params.ruleId}.`);

  const decidedAt = nowIso();
  const patch: Partial<typeof irishTaxRules.$inferInsert> = {
    reviewStatus: params.status,
    reviewedBy: params.reviewedBy,
    reviewedAt: decidedAt,
    reviewNotes: params.notes ?? null,
  };

  if (params.status === 'active') {
    patch.humanReviewRequired = false;
    patch.provenanceStatus = 'user_confirmed';
  }
  if (params.status === 'rejected') {
    patch.enabled = false;
    patch.active = false;
  }
  if (params.status === 'superseded') {
    patch.active = false;
  }

  // The decision is the book's record (ADR-0020 §6); the row's columns are what
  // lookups read until the rules move to the install-level store.
  atomically(db, () => {
    recordRuleDecision(db, {
      companyId: rule.companyId, ruleKey: rule.ruleKey, ruleVersion: rule.ruleVersion, ruleId: rule.id,
      status: params.status, decidedBy: params.reviewedBy, decidedAt, reason: params.notes ?? null,
    });
    db.update(irishTaxRules).set(patch).where(eq(irishTaxRules.id, params.ruleId)).run();
  });
}

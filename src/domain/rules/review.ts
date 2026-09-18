import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishTaxRules, type IrishRuleReviewStatus } from '@/db/schema';
import { nowIso } from '../dates';

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
 */
export function setRuleReviewStatus(
  db: AppDatabase,
  params: { ruleId: string; status: IrishRuleReviewStatus; reviewedBy: string; notes?: string },
): void {
  const rule = db.select({ id: irishTaxRules.id }).from(irishTaxRules)
    .where(eq(irishTaxRules.id, params.ruleId)).get();
  if (!rule) throw new Error(`No rule with id ${params.ruleId}.`);

  const patch: Partial<typeof irishTaxRules.$inferInsert> = {
    reviewStatus: params.status,
    reviewedBy: params.reviewedBy,
    reviewedAt: nowIso(),
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

  db.update(irishTaxRules).set(patch).where(eq(irishTaxRules.id, params.ruleId)).run();
}

import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { visibleTaxRules, type IrishRuleReviewStatus } from '@/db/schema';
import { nowIso } from '../dates';
import { recordRuleDecision } from './ruleDecisions';

/**
 * Move a rule through the review lifecycle (task: DRAFT -> AI_EXTRACTED ->
 * HUMAN_REVIEW -> APPROVED -> ACTIVE -> SUPERSEDED).
 *
 * The decision is the book's own record (ADR-0020 §6), appended to
 * `irish_rule_decisions`; the rule itself lives in the read-only store and is
 * never written (ADR-0021). Every reader resolves a rule's review through
 * `ruleReviewResolver`, so the decision is what it follows: reaching `active`
 * is the only thing that makes a rule authoritative for lookup purposes (an
 * AI-extracted rule never becomes so on its own), and `rejected` or
 * `superseded` withdraws it, so it can never again surface as a candidate or
 * supply a figure. The rule stays on record, with the decision's reason.
 *
 * `ruleId` is the visible row's ID (`visibleTaxRules.id`): `key@version` for
 * a store version, the frozen copy's ID for a retained one.
 */
export function setRuleReviewStatus(
  db: AppDatabase,
  params: { companyId: string; ruleId: string; status: IrishRuleReviewStatus; reviewedBy: string; notes?: string },
): void {
  const rule = db.select({ id: visibleTaxRules.id, ruleKey: visibleTaxRules.ruleKey, ruleVersion: visibleTaxRules.ruleVersion, origin: visibleTaxRules.origin })
    .from(visibleTaxRules)
    .where(and(eq(visibleTaxRules.companyId, params.companyId), eq(visibleTaxRules.id, params.ruleId))).get();
  if (!rule) throw new Error(`No rule with id ${params.ruleId}.`);
  recordRuleDecision(db, {
    companyId: params.companyId, ruleKey: rule.ruleKey, ruleVersion: rule.ruleVersion, ruleId: rule.id,
    // A store version is numbered as the catalogue numbers it; a frozen one keeps the book's number.
    numbering: rule.origin === 'store' ? 'catalogue' : 'book',
    status: params.status, decidedBy: params.reviewedBy, decidedAt: nowIso(), reason: params.notes ?? null,
  });
}

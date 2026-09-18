/**
 * Quality-control audit report (task Phase 7).
 *
 * This never claims the knowledge base is legally complete — it counts what
 * was ingested, what was judged relevant, what was extracted, what still
 * needs a human, and what looks contradictory or ambiguous, so a reviewer
 * knows exactly how much of the source has and has not been turned into a
 * usable rule.
 */
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  irishKnowledgeSources, irishActProvisions, irishTaxRules, irishTaxRuleTests,
} from '@/db/schema';
import { SECTION_RULE_KEYS } from './factExtractor';

export interface AuditReport {
  generatedAt: string;
  sources: Array<{ id: string; citation: string; sourceType: string; provisionCount: number }>;
  provisionCount: number;
  relevantProvisionCount: number;
  notRelevantProvisionCount: number;
  ruleCount: number;
  rulesByReviewStatus: Record<string, number>;
  rulesRequiringHumanReview: number;
  rulesRequiringGuidance: number;
  rulesWithExceptions: number;
  /** Relevant provisions with a curated rule key (factExtractor.ts) that have not yet produced a rule row. */
  provisionsWithoutExtractedRule: Array<{ sectionNumber: string; heading: string; ruleKey: string }>;
  /** Relevant provisions falling back to category "other" — the keyword categoriser found nothing. */
  ambiguousProvisions: Array<{ sectionNumber: string; heading: string; reason: string }>;
  /** amendsSection references that do not resolve to a section number ingested from the same source. */
  unresolvedCrossReferences: Array<{ sectionNumber: string; reference: string }>;
  duplicateRuleKeys: string[];
  testSummary: { total: number; passed: number; failed: number; neverRun: number };
}

export function generateAuditReport(db: AppDatabase, params: { companyId: string }): AuditReport {
  const sourceRows = db.select().from(irishKnowledgeSources).all();
  const provisions = db.select().from(irishActProvisions).all();
  const rules = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, params.companyId)).all();
  const tests = db.select().from(irishTaxRuleTests).all();

  const provisionsBySource = new Map<string, typeof provisions>();
  for (const p of provisions) {
    const list = provisionsBySource.get(p.sourceId) ?? [];
    list.push(p);
    provisionsBySource.set(p.sourceId, list);
  }

  const sources = sourceRows.map((s) => ({
    id: s.id, citation: s.citation, sourceType: s.sourceType,
    provisionCount: provisionsBySource.get(s.id)?.length ?? 0,
  }));

  const relevant = provisions.filter((p) => p.relevant);
  const ruledSectionNumbers = new Set(rules.map((r) => {
    const prov = provisions.find((p) => p.id === r.provisionId);
    return prov?.sectionNumber;
  }));

  const provisionsWithoutExtractedRule = relevant
    .filter((p) => SECTION_RULE_KEYS[p.sectionNumber] && !ruledSectionNumbers.has(p.sectionNumber))
    .map((p) => ({
      sectionNumber: p.sectionNumber, heading: p.heading,
      ruleKey: SECTION_RULE_KEYS[p.sectionNumber]!.key,
    }));

  const ambiguousProvisions = relevant
    .filter((p) => p.category === 'other')
    .map((p) => ({ sectionNumber: p.sectionNumber, heading: p.heading, reason: p.relevanceReason ?? 'Category is "other".' }));

  const sectionNumbersBySource = new Map<string, Set<string>>();
  for (const p of provisions) {
    const set = sectionNumbersBySource.get(p.sourceId) ?? new Set<string>();
    set.add(p.sectionNumber);
    sectionNumbersBySource.set(p.sourceId, set);
  }
  const unresolvedCrossReferences: AuditReport['unresolvedCrossReferences'] = [];
  for (const p of relevant) {
    if (!p.amendsSection) continue;
    const known = sectionNumbersBySource.get(p.sourceId) ?? new Set();
    for (const ref of p.amendsSection.split('; ')) {
      const num = ref.match(/section\s+(\d+)/i)?.[1];
      if (num && !known.has(num)) {
        unresolvedCrossReferences.push({ sectionNumber: p.sectionNumber, reference: ref });
      }
    }
  }

  const ruleKeyCounts = new Map<string, number>();
  for (const r of rules) {
    if (!r.active) continue;
    ruleKeyCounts.set(r.ruleKey, (ruleKeyCounts.get(r.ruleKey) ?? 0) + 1);
  }
  const duplicateRuleKeys = [...ruleKeyCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k);

  const rulesByReviewStatus: Record<string, number> = {};
  for (const r of rules) {
    rulesByReviewStatus[r.reviewStatus] = (rulesByReviewStatus[r.reviewStatus] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    sources,
    provisionCount: provisions.length,
    relevantProvisionCount: relevant.length,
    notRelevantProvisionCount: provisions.length - relevant.length,
    ruleCount: rules.length,
    rulesByReviewStatus,
    rulesRequiringHumanReview: rules.filter((r) => r.humanReviewRequired).length,
    rulesRequiringGuidance: rules.filter((r) => r.requiresGuidance).length,
    rulesWithExceptions: rules.filter((r) => r.exceptions.length > 0).length,
    provisionsWithoutExtractedRule,
    ambiguousProvisions,
    unresolvedCrossReferences,
    duplicateRuleKeys,
    testSummary: {
      total: tests.length,
      passed: tests.filter((t) => t.lastRunPassed === true).length,
      failed: tests.filter((t) => t.lastRunPassed === false).length,
      neverRun: tests.filter((t) => t.lastRunAt === null).length,
    },
  };
}

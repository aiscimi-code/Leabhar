/**
 * Ingestion for the Social Welfare Consolidation Act 2005 sections on
 * self-employment contributions (LRC revised; issue #212), and the derive
 * step for every curated income tax, USC and PRSI rule, whichever source it
 * quotes. A rule family (one ruleKey) is chained by date: each version
 * supersedes the one before it and only the latest is active.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseVatcaRevisedSection } from './vatcaRevisedSectionParser';
import { parseScheduleFrontMatter } from './vatcaScheduleParser';
import { provisionSlug } from './statuteParser';
import { INCOME_TAX_CURATED_RULES, type CuratedIncomeTaxRule } from './incomeTaxCuration';
import { upsertReviewItem } from '../extraction/service';

export const SWCA_SECTIONS = ['20', '21', '22', '23'];
export const swcaPath = (n: string) => `docs/statutes/swca-2005/swca-2005-s${n}.md`;

/** Ingest one revised SWCA 2005 section. Idempotent by content. */
export function ingestSwcaSection(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): { sourceId: string; ingested: boolean } {
  const fm = parseScheduleFrontMatter(params.markdown);
  const digest = sha256Hex(params.markdown);
  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(eq(irishKnowledgeSources.citation, fm.citation), eq(irishKnowledgeSources.sha256, digest))).get();
  if (existing) return { sourceId: existing.id, ingested: false };
  const parsed = parseVatcaRevisedSection(params.markdown);
  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId, companyId: params.companyId ?? null, sourceType: 'legislation', title: fm.title, citation: fm.citation,
      jurisdiction: 'IE', sourceUrl: fm.sourceUrl, localPath: params.localPath ?? null, sha256: digest,
      ingestVersion: params.ingestVersion, publicationDate: null, retrievedAt: nowIso(),
      effectiveFrom: '2026-09-25',
      sourceNote: 'LRC revised text as retrieved on 2026-09-25: current law on that date, not a dated history.',
      sourceDate: nowIso(),
    }).run();
    tx.insert(irishActProvisions).values({
      id: ids.provision(), companyId: params.companyId ?? null, sourceId, sectionNumber: parsed.sectionNumber,
      slug: provisionSlug(`swca-${parsed.sectionNumber}`, parsed.heading), heading: parsed.heading, principalAct: null,
      provisionText: parsed.provisionText, sourceStart: parsed.sourceStart, sourceEnd: parsed.sourceEnd,
      category: 'income_tax', amendsSection: null, effectiveClue: null, citedActs: [], relevant: true,
      relevanceReason: 'Self-employment (Class S) contributions for sole traders and partners (issue #212).',
      source: 'import', provenanceStatus: 'imported',
    }).run();
    return { sourceId, ingested: true };
  });
}

export interface IncomeTaxDeriveResult { created: number; superseded: number; unchanged: number; skippedNoProvision: string[] }

/** Derive the curated income tax rules, one dated version per row, chained by `supersedesRuleId`. */
export function deriveIncomeTaxRules(db: AppDatabase, params: { companyId: string }): IncomeTaxDeriveResult {
  const result: IncomeTaxDeriveResult = { created: 0, superseded: 0, unchanged: 0, skippedNoProvision: [] };
  const families = new Map<string, CuratedIncomeTaxRule[]>();
  for (const r of INCOME_TAX_CURATED_RULES) families.set(r.ruleKey, [...(families.get(r.ruleKey) ?? []), r]);

  const provisionFor = (rule: CuratedIncomeTaxRule) => {
    const sources = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, rule.citation)).all().map((s) => s.id);
    return db.select().from(irishActProvisions).where(eq(irishActProvisions.sectionNumber, rule.sectionNumber)).all()
      .filter((p) => sources.includes(p.sourceId)).at(-1);
  };

  for (const [ruleKey, versions] of families) {
    const ordered = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const provisions = ordered.map(provisionFor);
    if (provisions.some((p, i) => !p || !p.provisionText?.includes(ordered[i]!.statementExcerpt))) {
      result.skippedNoProvision.push(ruleKey);
      continue;
    }
    const stored = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, ruleKey))).all();
    const kept = new Set<string>();
    let previousId: string | null = null;
    let nextVersion = stored.reduce((m, r) => Math.max(m, r.ruleVersion), 0) + 1;
    ordered.forEach((rule, i) => {
      const prov = provisions[i]!;
      const match = stored.find((r) => !kept.has(r.id) && r.provisionId === prov.id && r.effectiveFrom === rule.effectiveFrom
        && (r.effectiveTo ?? null) === rule.effectiveTo && r.statement === rule.statementExcerpt && r.numericValue === rule.numericValue);
      if (match) { kept.add(match.id); previousId = match.id; result.unchanged++; return; }
      const id = ids.taxRule();
      db.insert(irishTaxRules).values({
        id, companyId: params.companyId, provisionId: prov.id, ruleKey, ruleType: rule.ruleType,
        topic: ruleKey.split('.')[0]!, name: rule.name, statement: rule.statementExcerpt,
        extractedFact: rule.numericValue !== null ? String(rule.numericValue) : null, humanExplanation: rule.interpretationNote,
        numericValue: rule.numericValue, unit: rule.unit,
        qualifier: rule.rateBasisPoints !== undefined ? `rate_bp:${rule.rateBasisPoints}` : null,
        conditions: [], exceptions: [], crossReferences: [], accountingEffect: null, taxEffect: rule.name, vatEffect: null,
        reportingEffect: null, requiresGuidance: true, humanReviewRequired: true, reviewStatus: 'ai_extracted',
        ruleVersion: nextVersion++, supersedesRuleId: previousId, priority: 100,
        effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo, active: false,
        source: 'derived', confidence: 75, provenanceStatus: 'ai_suggestion',
        sourceNote: `Curated from ${rule.citation} s.${rule.sectionNumber}; not yet human-reviewed. ${rule.interpretationNote}`,
        sourceDate: nowIso(),
      }).run();
      kept.add(id);
      previousId = id;
      result.created++;
      upsertReviewItem(db, {
        companyId: params.companyId, kind: 'unresolved_ai_suggestion', severity: 'info',
        title: `New income tax rule extracted: ${rule.name}`,
        detail: `${rule.citation} s.${rule.sectionNumber}. ${rule.interpretationNote} Review against the source text and approve, `
          + 'or reject, before it is treated as authoritative.',
        entityType: 'irish_tax_rule', entityId: id, dedupeKey: `irish_tax_rule:${id}`, context: { ruleKey },
      });
    });
    for (const row of stored) {
      if (kept.has(row.id) || (row.effectiveTo === row.effectiveFrom && !row.active)) continue;
      db.update(irishTaxRules).set({ effectiveTo: row.effectiveFrom, active: false }).where(eq(irishTaxRules.id, row.id)).run();
      result.superseded++;
    }
    for (const row of db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, ruleKey))).all()) {
      const shouldBeActive = row.id === previousId;
      if (row.active !== shouldBeActive && row.effectiveTo !== row.effectiveFrom) {
        db.update(irishTaxRules).set({ active: shouldBeActive }).where(eq(irishTaxRules.id, row.id)).run();
      }
    }
  }
  return result;
}

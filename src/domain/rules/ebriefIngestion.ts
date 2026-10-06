/**
 * Ingestion of a Revenue eBrief — a Revenue notice, the first source of the
 * `revenue_ebrief` type (issue #440, epic #310 "Sources: Revenue notices").
 *
 * An eBrief is how Revenue announces that guidance has changed: it can update
 * how a Tax and Duty Manual is read, but it is still guidance — it ranks
 * below legislation and never supersedes it (sourceHierarchy.ts). The KB's
 * first one, eBrief No. 168/25, records that TDM Part 38-01-03b — the manual
 * this KB already ingests a passage of, and the manual the registration
 * threshold rules are read against — was updated on 3 September 2025, with
 * the EU VAT SME scheme (S.I. 69/2025) among the sections changed.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { normaliseSpace } from '../vat/boxDefinitions';
import { upsertReviewItem } from '../extraction/service';
import { sameCrossReferences } from './dependencies';
import { taxHeadsFor } from './taxHeads';

export const EBRIEF_168_25_MD_PATH = 'docs/statutes/ebriefs/2025/no-168-25.md';

export const EBRIEF_168_25 = {
  citation: 'Revenue eBrief No. 168/25',
  title: 'Revenue eBrief No. 168/25 — Part 38-01-03b: Guidelines for VAT Registration updated',
  sourceUrl: 'https://www.revenue.ie/en/tax-professionals/ebrief/2025/no-1682025.aspx',
  // The notice's own published date, stated twice on the page.
  effectiveFrom: '2025-09-03',
  sectionNumber: '168/25',
};

export const EBRIEF_168_25_RULE = {
  ruleKey: 'vat.registration_guidelines_updated_2025_09',
  ruleType: 'procedure' as const,
  name: 'Revenue updated the VAT registration guidelines on 3 September 2025',
  statementExcerpt: 'Tax and Duty Manual Part 38-01-03b - Guidelines for VAT Registration - has been updated as follows:',
  interpretationNote: 'A Revenue notice, not law: it says the guidance changed, and which sections of the manual. '
    + 'The updated sections are 3.4 (registration application details), 3.4.4 (turnover and registration '
    + 'thresholds — the FA 2024 s.78 thresholds this KB curates) and 10 (the EU VAT SME scheme, S.I. 69/2025). '
    + 'Re-read those treatments against the updated manual before relying on guidance dated before 3 September 2025.',
  crossReferences: ['S.I. 69/2025 reg.7', 'S.I. 69/2025 reg.9', 'Revenue TDM Part 38-01-03b'],
  effectiveFrom: EBRIEF_168_25.effectiveFrom,
};

export interface EbriefIngestResult { sourceId: string; provisionCount: number; ingested: boolean }

/** Ingest the eBrief: one source, one provision (the notice is a single passage). */
export function ingestEbrief168_25(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): EbriefIngestResult {
  const digest = sha256Hex(params.markdown);
  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(eq(irishKnowledgeSources.citation, EBRIEF_168_25.citation), eq(irishKnowledgeSources.sha256, digest))).get();
  if (existing) {
    const count = db.select({ id: irishActProvisions.id }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all().length;
    return { sourceId: existing.id, provisionCount: count, ingested: false };
  }

  // The notice body: everything after the front matter, verbatim (whitespace aside).
  const body = normaliseSpace(params.markdown.replace(/^---\n[\s\S]*?\n---\n/, ''));
  if (!body.includes(EBRIEF_168_25_RULE.statementExcerpt)) {
    throw new Error('The eBrief transcript does not contain the passage the curated rule quotes.');
  }
  const sourceStart = params.markdown.indexOf(EBRIEF_168_25_RULE.statementExcerpt);
  const sourceEnd = sourceStart >= 0
    ? params.markdown.indexOf('*Published: 03 September 2025*', sourceStart) + 1 || params.markdown.length
    : params.markdown.length;

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'revenue_ebrief',
      title: EBRIEF_168_25.title,
      citation: EBRIEF_168_25.citation,
      jurisdiction: 'IE',
      sourceUrl: EBRIEF_168_25.sourceUrl,
      localPath: params.localPath ?? EBRIEF_168_25_MD_PATH,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: EBRIEF_168_25.effectiveFrom,
      retrievedAt: nowIso(),
      effectiveFrom: EBRIEF_168_25.effectiveFrom,
      sourceNote: 'A Revenue notice: it records that TDM Part 38-01-03b was updated on 3 September 2025 (sections '
        + '3.4, 3.4.4 and 10). It ranks below legislation (sourceHierarchy.ts) and never supersedes the Act or '
        + 'the Regulations; it tells a reader the guidance this KB cites has moved.',
      sourceDate: nowIso(),
    }).run();
    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: EBRIEF_168_25.sectionNumber,
      slug: 'ebrief-168-25-part-38-01-03b-updated',
      heading: 'Part 38-01-03b - Guidelines for VAT Registration',
      principalAct: null,
      provisionText: body,
      sourceStart: sourceStart >= 0 ? sourceStart : 0,
      sourceEnd,
      locator: 'notice 168/25',
      category: 'procedure',
      amendsSection: null,
      effectiveClue: 'Published: 03 September 2025',
      citedActs: ['S.I. 69/2025'],
      relevant: true,
      relevanceReason: 'Curated: a procedure rule cites this notice (ebriefIngestion.ts).',
      source: 'import',
      provenanceStatus: 'imported',
    }).run();
    return { sourceId, provisionCount: 1, ingested: true };
  });
}

export interface EbriefDeriveResult { created: number; superseded: number; unchanged: number; skippedNoProvision: string[] }

/** Derive the curated rule from the ingested notice. */
export function deriveEbriefRules(db: AppDatabase, params: { companyId: string }): EbriefDeriveResult {
  const result: EbriefDeriveResult = { created: 0, superseded: 0, unchanged: 0, skippedNoProvision: [] };
  const rule = EBRIEF_168_25_RULE;
  const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, EBRIEF_168_25.citation)).get()?.id;
  const prov = sourceId
    ? db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, EBRIEF_168_25.sectionNumber))).get()
    : undefined;
  if (!prov || !prov.provisionText?.includes(rule.statementExcerpt)) {
    result.skippedNoProvision.push(rule.ruleKey);
    return result;
  }
  const existing = db.select().from(irishTaxRules)
    .where(and(
      eq(irishTaxRules.companyId, params.companyId),
      eq(irishTaxRules.ruleKey, rule.ruleKey),
      eq(irishTaxRules.active, true),
    )).get();
  if (existing && existing.statement === rule.statementExcerpt && existing.provisionId === prov.id
    && sameCrossReferences(existing.crossReferences, rule.crossReferences)) {
    result.unchanged = 1;
    return result;
  }
  if (existing) {
    db.update(irishTaxRules)
      .set({ effectiveTo: rule.effectiveFrom, active: false })
      .where(eq(irishTaxRules.id, existing.id)).run();
    result.superseded = 1;
  }
  const newRuleId = ids.taxRule();
  db.insert(irishTaxRules).values({
    id: newRuleId,
    companyId: params.companyId,
    provisionId: prov.id,
    ruleKey: rule.ruleKey,
    ruleType: rule.ruleType,
    topic: 'vat_registration',
    taxHeads: taxHeadsFor(rule.ruleKey, 'vat_registration'),
    name: rule.name,
    statement: rule.statementExcerpt,
    extractedFact: null,
    humanExplanation: rule.interpretationNote,
    numericValue: null,
    unit: null,
    qualifier: null,
    conditions: [],
    exceptions: [],
    crossReferences: rule.crossReferences,
    accountingEffect: null,
    taxEffect: null,
    vatEffect: null,
    reportingEffect: 'Re-read the registration thresholds and the EU VAT SME scheme against the updated TDM before '
      + 'relying on guidance dated before 3 September 2025.',
    requiresGuidance: false,
    humanReviewRequired: true,
    reviewStatus: 'ai_extracted',
    ruleVersion: existing ? existing.ruleVersion + 1 : 1,
    supersedesRuleId: existing?.id ?? null,
    priority: 100,
    effectiveFrom: rule.effectiveFrom,
    source: 'derived',
    confidence: 75,
    provenanceStatus: 'ai_suggestion',
    sourceNote: `Curated from ${EBRIEF_168_25.citation}; not yet human-reviewed. ${rule.interpretationNote}`,
    sourceDate: nowIso(),
  }).run();
  result.created = 1;
  upsertReviewItem(db, {
    companyId: params.companyId,
    kind: 'unresolved_ai_suggestion',
    severity: 'info',
    title: `New Irish notice rule extracted: ${rule.name}`,
    detail: `${EBRIEF_168_25.citation}. ${rule.interpretationNote} Review against the source text and approve, `
      + 'or reject, before it is treated as authoritative.',
    entityType: 'irish_tax_rule',
    entityId: newRuleId,
    dedupeKey: `irish_tax_rule:${newRuleId}`,
    context: { ruleKey: rule.ruleKey },
  });
  return result;
}

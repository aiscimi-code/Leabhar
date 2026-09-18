/**
 * VATCA 2010 ingestion and rule derivation.
 *
 * Mirrors the Finance Act 2024 pipeline in `irishRules.ts` (ingest ->
 * provisions -> derive curated rules -> generic lookup), but as its own file:
 * a new source gets its own parser + curation + ingestion module and plugs
 * into the shared `irish_*` schema and the generic lookup functions in
 * `irishRules.ts` (`lookupTaxRule`, `listTaxRulesByTopic`,
 * `listTaxRulesByCategory`) — adding a source is meant to be exactly this
 * (a new small module), never a change to the lookup engine.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  irishKnowledgeSources, irishActProvisions, irishTaxRules, type IrishSourceType,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseVatca2010, provisionSlug, assessRelevance, VATCA_2010_MD_PATH } from './vatcaParser';
import { VATCA_CURATED_RULES } from './vatcaCuration';
import { upsertReviewItem } from '../extraction/service';

export interface VatcaSourceRef {
  title: string;
  citation: string;
  sourceType: IrishSourceType;
  sourceUrl: string;
  localPath?: string;
  /** ISO date of commencement, read verbatim from the Act's own text (s.125). */
  enactedDate: string;
}

export const VATCA_2010: VatcaSourceRef = {
  title: 'Value-Added Tax Consolidation Act 2010',
  citation: '2010 Act 31',
  sourceType: 'legislation',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2010/act/31/enacted/en/pdf',
  localPath: 'docs/statutes/vatca-2010/vatca-2010-enacted.md',
  enactedDate: '2010-11-01',
};

export { VATCA_2010_MD_PATH };

export interface VatcaIngestResult {
  sourceId: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest the VATCA 2010 converted Markdown. Idempotent by content, same as `ingestFinanceAct2024`. */
export function ingestVatca2010(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): VatcaIngestResult {
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, VATCA_2010.citation),
      eq(irishKnowledgeSources.sha256, digest),
    )).get();

  if (existing) {
    const rows = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all();
    if (rows.length > 0) {
      return {
        sourceId: existing.id, provisionCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: VATCA_2010.sourceType,
      title: VATCA_2010.title,
      citation: VATCA_2010.citation,
      jurisdiction: 'IE',
      sourceUrl: VATCA_2010.sourceUrl,
      localPath: params.localPath ?? VATCA_2010.localPath ?? null,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: VATCA_2010.enactedDate,
      retrievedAt: nowIso(),
      effectiveFrom: VATCA_2010.enactedDate,
      sourceNote: `Ingest ${params.ingestVersion} of ${VATCA_2010.citation} enacted Markdown. `
        + 'Enacted text only — later Finance Act amendments (e.g. the standard VAT rate change '
        + 'to 23%) are not reflected; see docs/RULES_KB.md "Limitations".',
      sourceDate: nowIso(),
    }).run();

    const parsed = parseVatca2010(params.markdown);
    const curatedSections = new Set(VATCA_CURATED_RULES.map((r) => r.sectionNumber));
    let relevantCount = 0;
    for (const p of parsed) {
      let { relevant, reason } = assessRelevance(p.category);
      if (!relevant && curatedSections.has(p.sectionNumber)) {
        relevant = true;
        reason = `Curated: mapped to a rule in vatcaCuration.ts, overriding the ${p.category} category default.`;
      }
      if (relevant) relevantCount++;

      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId ?? null,
        sourceId,
        sectionNumber: p.sectionNumber,
        slug: provisionSlug(p.sectionNumber, p.heading),
        heading: p.heading,
        principalAct: null,
        provisionText: p.provisionText,
        sourceStart: p.sourceStart,
        sourceEnd: p.sourceEnd,
        category: p.category,
        amendsSection: p.amendsSection.length ? p.amendsSection.join('; ') : null,
        effectiveClue: p.effectiveClue,
        citedActs: p.citedActs,
        relevant,
        relevanceReason: reason,
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }

    return { sourceId, provisionCount: parsed.length, relevantCount, ingested: true };
  });
}

export interface VatcaDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

/**
 * Derive `irish_tax_rules` rows from `VATCA_CURATED_RULES`.
 *
 * Unlike `deriveTaxRules` (Finance Act 2024), there is no mechanical fact to
 * re-check for drift on re-ingestion — a curated VATCA rule's `conditions`/
 * `effect` are fixed by the curation, not read off a changing figure. So
 * "supersede on change" here means: if the curation itself changes (a
 * different `statementExcerpt` than what is stored), version it the same
 * way — closing the old row and inserting a new one — rather than editing in
 * place, for the same reason (AGENTS.md invariant #6).
 */
export function deriveVatcaRules(
  db: AppDatabase,
  params: { companyId: string; sourceId?: string },
): VatcaDeriveResult {
  // Scoped to this source's own provisions, never every provision in the
  // company's DB — see the identical comment in irishRules.ts's
  // deriveTaxRules for why an un-scoped scan is a correctness bug once more
  // than one source shares a company (a section number collides across Acts).
  const sourceId = params.sourceId ?? db
    .select({ id: irishKnowledgeSources.id })
    .from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, VATCA_2010.citation))
    .get()?.id;

  const provisionsQuery = db.select().from(irishActProvisions);
  const provisions = (sourceId
    ? provisionsQuery.where(eq(irishActProvisions.sourceId, sourceId))
    : provisionsQuery
  ).all();

  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const curated of VATCA_CURATED_RULES) {
    const prov = provisions.find((p) => p.sectionNumber === curated.sectionNumber);
    if (!prov) { skippedNoProvision.push(curated.ruleKey); continue; }
    if (!prov.relevant) { skippedNoProvision.push(curated.ruleKey); continue; }

    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, curated.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();

    if (existing) {
      if (existing.statement === curated.statementExcerpt) { unchanged++; continue; }
      db.update(irishTaxRules)
        .set({ effectiveTo: VATCA_2010.enactedDate, active: false })
        .where(eq(irishTaxRules.id, existing.id)).run();
      superseded++;
    }

    const newRuleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: newRuleId,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: curated.ruleKey,
      ruleType: curated.ruleType,
      topic: curated.topic,
      name: curated.name,
      statement: curated.statementExcerpt,
      extractedFact: null,
      humanExplanation: curated.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: null,
      conditions: curated.conditions,
      exceptions: curated.exceptions,
      crossReferences: prov.amendsSection ? prov.amendsSection.split('; ') : [],
      accountingEffect: curated.accountingEffect,
      taxEffect: null,
      vatEffect: curated.vatEffect,
      reportingEffect: curated.reportingEffect,
      requiresGuidance: curated.requiresGuidance,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom: VATCA_2010.enactedDate,
      source: 'derived',
      // Lower confidence and ai_suggestion (not system_rule) provenance than
      // the mechanical Finance Act figures: mapping a legal test onto
      // TransactionContext fields is an interpretation, not a regex match —
      // see vatcaCuration.ts's own header.
      confidence: 70,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from VATCA 2010 s.${curated.sectionNumber}; not yet human-reviewed. ${curated.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rule extracted: ${curated.name}`,
      detail: `VATCA 2010 s.${curated.sectionNumber}. ${curated.interpretationNote} `
        + 'Review the condition mapping against the source text and approve, or reject, before it '
        + 'is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: curated.ruleKey, sectionNumber: curated.sectionNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

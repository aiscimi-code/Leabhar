/**
 * Ingestion for the Companies Act 2014 size-threshold/filing/audit-exemption
 * sections in their LRC-revised form — closing issue #135. Each section is
 * its own independently-fetched, independently-hashed page, so — matching
 * `vatcaRevisedIngestion.ts`'s precedent for the same kind of source — each
 * becomes its own `irish_knowledge_sources` row, never merged with another.
 *
 * The knowledge base loads every section from its rules catalogue entry
 * (`catalogue/companies-act-2014/s<N>.json`, with the LRC page beside it;
 * `ingestCompaniesAct2014FromCatalogue`, #556). `ingestCompaniesAct2014Section`
 * ingests one section from a Markdown copy (the CLI's `--file`).
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  irishKnowledgeSources, irishActProvisions, irishTaxRules, type IrishSourceType,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import {
  parseCompaniesAct2014Section, provisionSlug, assessRelevance, type ParsedCompaniesAct2014Section,
} from './companiesAct2014SectionParser';
import { parseScheduleFrontMatter } from './vatcaScheduleParser';
import { COMPANIES_ACT_2014_CURATED_RULES } from './companiesAct2014Curation';
import { upsertReviewItem } from '../extraction/service';
import { crossReferencesFromProvision, sameCrossReferences } from './dependencies';
import { taxHeadsFor } from './taxHeads';
import { ingestCatalogueFile, type CatalogueIngestResult } from './catalogue';
import { preferredSourceId } from './catalogueSupersession';

const SOURCE_TYPE: IrishSourceType = 'legislation';

/**
 * The sections the knowledge base holds, each a catalogue entry: the first eight (issue #135), s.280B/C/F for company size (issue #554), and
 * ss.281, 283–286, 290–293, 343 and 347 for accounting records, statutory
 * financial statements and the annual return (issue #559 / #214).
 */
export const COMPANIES_ACT_2014_SECTION_NUMBERS = [
  '282', '280A', '280B', '280C', '280D', '280E', '280F', '352', '358', '359', '360',
  '281', '283', '284', '285', '286', '290', '291', '292', '293', '343', '347',
] as const;

export type CompaniesAct2014SectionNumber = typeof COMPANIES_ACT_2014_SECTION_NUMBERS[number];

/**
 * What every section's source says of itself: a live LRC page, so the
 * source's date means "confirmed accurate as retrieved", not a commencement.
 */
export const COMPANIES_ACT_2014_NOTE = 'LRC-revised text as retrieved — a live, continuously-updated page, '
  + 'not a dated historical snapshot. Distinct source row per section, never merged with any other '
  + 'Companies Act 2014 section.';

/** Whether a section bears on the rules: its category's default, or curated into a rule. */
export function companiesAct2014Relevance(parsed: ParsedCompaniesAct2014Section): { relevant: boolean; reason: string } {
  const { relevant, reason } = assessRelevance(parsed.category);
  if (relevant || !COMPANIES_ACT_2014_CURATED_RULES.some((r) => r.sectionNumber === parsed.sectionNumber)) return { relevant, reason };
  return {
    relevant: true,
    reason: `Curated: mapped to a rule in companiesAct2014Curation.ts, overriding the ${parsed.category} category default.`,
  };
}

/** A section's catalogue entry. */
export const companiesAct2014CatalogueEntry = (n: CompaniesAct2014SectionNumber) => `companies-act-2014/s${n}.json`;

export interface CompaniesAct2014CatalogueIngestResult {
  sections: Array<CatalogueIngestResult & { sectionNumber: CompaniesAct2014SectionNumber }>;
}

/** Load every section from its catalogue entry. */
export function ingestCompaniesAct2014FromCatalogue(
  db: AppDatabase,
  params: { companyId?: string | null; ingestVersion?: string; root?: string },
): CompaniesAct2014CatalogueIngestResult {
  return {
    sections: COMPANIES_ACT_2014_SECTION_NUMBERS.map((sectionNumber) => ({
      sectionNumber, ...ingestCatalogueFile(db, { ...params, entry: companiesAct2014CatalogueEntry(sectionNumber) }),
    })),
  };
}

export interface CompaniesAct2014IngestResult {
  sourceId: string;
  sectionNumber: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest one Companies Act 2014 section from a Markdown copy (the CLI's `--file`). Idempotent by content. */
export function ingestCompaniesAct2014Section(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): CompaniesAct2014IngestResult {
  const fm = parseScheduleFrontMatter(params.markdown);
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, fm.citation),
      eq(irishKnowledgeSources.sha256, digest),
    )).get();

  if (existing) {
    const rows = db.select({ relevant: irishActProvisions.relevant }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all();
    if (rows.length > 0) {
      const parsed = parseCompaniesAct2014Section(params.markdown);
      return {
        sourceId: existing.id, sectionNumber: parsed.sectionNumber, provisionCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  const parsed = parseCompaniesAct2014Section(params.markdown);

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: SOURCE_TYPE,
      title: fm.title,
      citation: fm.citation,
      jurisdiction: 'IE',
      sourceUrl: fm.sourceUrl,
      localPath: params.localPath ?? null,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      // Same convention as vatcaRevisedIngestion.ts: a live LRC page, not a
      // dated historical snapshot — effectiveFrom means "confirmed accurate
      // as of ingest", not a claimed commencement date.
      effectiveFrom: nowIso().slice(0, 10),
      sourceNote: `Ingest ${params.ingestVersion} of ${fm.citation}, ${COMPANIES_ACT_2014_NOTE}`,
      sourceDate: nowIso(),
    }).run();

    const { relevant, reason } = companiesAct2014Relevance(parsed);

    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: parsed.sectionNumber,
      slug: provisionSlug(`ca2014-${parsed.sectionNumber}`, parsed.heading),
      heading: parsed.heading,
      principalAct: null,
      provisionText: parsed.provisionText,
      sourceStart: parsed.sourceStart,
      sourceEnd: parsed.sourceEnd,
      category: parsed.category,
      amendsSection: null,
      effectiveClue: null,
      citedActs: [],
      relevant,
      relevanceReason: reason,
      source: 'import',
      provenanceStatus: 'imported',
    }).run();

    return { sourceId, sectionNumber: parsed.sectionNumber, provisionCount: 1, relevantCount: relevant ? 1 : 0, ingested: true };
  });
}

export interface CompaniesAct2014DeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

/** Derive `irish_tax_rules` rows from `COMPANIES_ACT_2014_CURATED_RULES`. */
export function deriveCompaniesAct2014Rules(
  db: AppDatabase,
  params: { companyId: string },
): CompaniesAct2014DeriveResult {
  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const rule of COMPANIES_ACT_2014_CURATED_RULES) {
    const sourceId = preferredSourceId(db, rule.citation);
    const prov = sourceId
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, rule.sectionNumber)))
        .get()
      : undefined;
    if (!prov) { skippedNoProvision.push(rule.ruleKey); continue; }
    if (!prov.relevant) { skippedNoProvision.push(rule.ruleKey); continue; }

    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();

    if (existing) {
      if (existing.statement === rule.statementExcerpt && existing.numericValue === rule.numericValue
        && sameCrossReferences(existing.crossReferences, crossReferencesFromProvision(prov))) {
        unchanged++; continue;
      }
      db.update(irishTaxRules)
        .set({ effectiveTo: rule.effectiveFrom, active: false })
        .where(eq(irishTaxRules.id, existing.id)).run();
      superseded++;
    }

    const newRuleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: newRuleId,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: rule.ruleKey,
      ruleType: rule.ruleType,
      topic: rule.topic,
      taxHeads: taxHeadsFor(rule.ruleKey, rule.topic),
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: rule.extractedFact,
      humanExplanation: rule.interpretationNote,
      numericValue: rule.numericValue,
      unit: rule.unit,
      qualifier: rule.qualifier,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: crossReferencesFromProvision(prov),
      accountingEffect: null,
      taxEffect: null,
      vatEffect: null,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: null,
      source: 'derived',
      confidence: 70,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${rule.citation} (LRC revised, as retrieved); not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish company-filing rule extracted: ${rule.name}`,
      detail: `${rule.citation} s.${rule.sectionNumber}. ${rule.interpretationNote} `
        + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, sectionNumber: rule.sectionNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

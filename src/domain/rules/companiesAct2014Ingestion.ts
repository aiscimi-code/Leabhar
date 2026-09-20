/**
 * Ingestion for the Companies Act 2014 size-threshold/filing/audit-exemption
 * sections in their LRC-revised form (docs/statutes/companies-act-2014/s*.md,
 * fetched by extract_vat_sources.py's extract_companies_act_2014()) —
 * closing issue #135. Each section is its own independently-fetched,
 * independently-hashed document (its own `source_html_sha256`), so — matching
 * `vatcaRevisedIngestion.ts`'s precedent for the same kind of source — each
 * becomes its own `irish_knowledge_sources` row, never merged with another.
 *
 * Unlike `vatcaRevisedIngestion.ts` (which ingests one named section, s.46),
 * this source is eight separate files from the start with no single default
 * to point `--file` at, so there are two entry points: `ingestCompaniesAct2014Section`
 * for one file (generic, mirrors `ingestVatcaRevisedSection`), and
 * `ingestAllCompaniesAct2014Sections` to ingest the whole fetched set in one
 * call — the CLI (`npm run cli:rules -- ingest --source companies-act-2014`)
 * uses the latter.
 */
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  irishKnowledgeSources, irishActProvisions, irishTaxRules, type IrishSourceType,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import {
  parseCompaniesAct2014Section, provisionSlug, assessRelevance, companiesAct2014SectionPath,
} from './companiesAct2014SectionParser';
import { parseScheduleFrontMatter } from './vatcaScheduleParser';
import { COMPANIES_ACT_2014_CURATED_RULES } from './companiesAct2014Curation';
import { upsertReviewItem } from '../extraction/service';

const SOURCE_TYPE: IrishSourceType = 'legislation';

/** All eight sections extract_companies_act_2014() fetches (docs/statutes/scripts/extract_vat_sources.py). */
export const COMPANIES_ACT_2014_SECTION_NUMBERS = [
  '282', '280A', '280D', '280E', '352', '358', '359', '360',
] as const;

export interface CompaniesAct2014IngestResult {
  sourceId: string;
  sectionNumber: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest one Companies Act 2014 section's Markdown. Idempotent by content. */
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
      sourceNote: `Ingest ${params.ingestVersion} of ${fm.citation}, LRC-revised text as retrieved — `
        + 'a live, continuously-updated page, not a dated historical snapshot. Distinct source row per section, '
        + 'never merged with any other Companies Act 2014 section.',
      sourceDate: nowIso(),
    }).run();

    let { relevant, reason } = assessRelevance(parsed.category);
    const curated = COMPANIES_ACT_2014_CURATED_RULES.some((r) => r.sectionNumber === parsed.sectionNumber);
    if (!relevant && curated) {
      relevant = true;
      reason = `Curated: mapped to a rule in companiesAct2014Curation.ts, overriding the ${parsed.category} category default.`;
    }

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

export interface CompaniesAct2014IngestAllResult {
  sections: CompaniesAct2014IngestResult[];
}

/** Ingest every fetched section (docs/statutes/companies-act-2014/s*.md) in one call. */
export function ingestAllCompaniesAct2014Sections(
  db: AppDatabase,
  params: { companyId?: string | null; ingestVersion: string },
): CompaniesAct2014IngestAllResult {
  const sections = COMPANIES_ACT_2014_SECTION_NUMBERS.map((n) => {
    const path = companiesAct2014SectionPath(n);
    const markdown = readFileSync(path, 'utf8');
    return ingestCompaniesAct2014Section(db, { ...params, markdown, localPath: path });
  });
  return { sections };
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
    const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, rule.citation)).get()?.id;
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
      if (existing.statement === rule.statementExcerpt && existing.numericValue === rule.numericValue) {
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
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: rule.extractedFact,
      humanExplanation: rule.interpretationNote,
      numericValue: rule.numericValue,
      unit: rule.unit,
      qualifier: rule.qualifier,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: [],
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

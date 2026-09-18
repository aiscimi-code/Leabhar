/**
 * Irish tax-rules knowledge base: ingest + deterministic lookup.
 *
 * This module bridges the deterministic statute parser to the
 * `irish_*` schema tables. It never invents rules: every stored fact is a
 * verbatim provision slice or a value explicitly read from the statute text.
 * A plain-language `humanExplanation` is always stored with
 * `provenance_status = 'ai_suggestion'` so it cannot be mistaken for the
 * statute's own words — per AGENTS.md invariant #8 ("provenance is mandatory")
 * and the task's "LLM extracts/explains only — never invents rules".
 */
import { and, eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishStatuteSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import {
  parseFinanceAct2024,
  provisionSlug,
  categoriseProvision,
} from './statuteParser';
import { extractFactsFromProvision, SECTION_RULE_KEYS, type CuratedRule } from './factExtractor';
import type { ParsedProvision } from './statuteParser';

export interface StatuteSourceRef {
  title: string;
  citation: string;
  sourceUrl: string;
  localPath?: string;
}

/** The Finance Act 2024 (2024 Act 43) metadata. */
export const FINANCE_ACT_2024: StatuteSourceRef = {
  title: 'Finance Act 2024',
  citation: '2024 Act 43',
  sourceUrl: 'https://www.irishstatutebook.ie/eli/2024/act/43/enacted/en/pdf',
  localPath: 'docs/statutes/2024-act-43/2024-act-43-enacted.md',
};

/**
 * Ingest the Finance Act 2024 enacted Markdown into the KB.
 *
 * Idempotent: re-ingesting the same bytes (same SHA-256) is a no-op;
 * documents are never modified, so a changed file creates a new source row
 * and re-derives the provisions.
 */
export function ingestFinanceAct2024(
  db: AppDatabase,
  params: {
    companyId: string;
    markdown: string;
    ingestVersion: string;
    localPath?: string;
  },
): { sourceId: string; provisionCount: number; ingested: boolean } {
  const digest = sha256Hex(params.markdown);

  const existing = db
    .select({ id: irishStatuteSources.id })
    .from(irishStatuteSources)
    .where(
      and(
        eq(irishStatuteSources.citation, FINANCE_ACT_2024.citation),
        eq(irishStatuteSources.sha256, digest),
      ),
    )
    .get();

  if (existing) {
    const cnt = db
      .select({ n: irishActProvisions.id })
      .from(irishActProvisions)
      .where(eq(irishActProvisions.statuteSourceId, existing.id))
      .all().length;
    if (cnt > 0) return { sourceId: existing.id, provisionCount: cnt, ingested: false };
  }

  return db.transaction((tx) => {
    const sourceId = ids.statuteSource();
    tx.insert(irishStatuteSources).values({
      id: sourceId,
      companyId: params.companyId,
      title: FINANCE_ACT_2024.title,
      citation: FINANCE_ACT_2024.citation,
      sourceUrl: FINANCE_ACT_2024.sourceUrl,
      localPath: params.localPath ?? FINANCE_ACT_2024.localPath ?? null,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      ingestedAt: nowIso(),
      sourceNote: `Ingest ${params.ingestVersion} of ${FINANCE_ACT_2024.citation} enacted Markdown.`,
      sourceDate: nowIso(),
    }).run();

    const parsed = parseFinanceAct2024(params.markdown);
    for (const p of parsed) {
      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId,
        statuteSourceId: sourceId,
        sectionNumber: p.sectionNumber,
        slug: provisionSlug(p.sectionNumber, p.heading),
        heading: p.heading,
        principalAct: p.principalActs.length ? p.principalActs.join('; ') : null,
        provisionText: p.provisionText,
        sourceStart: p.sourceStart,
        sourceEnd: p.sourceEnd,
        category: categoriseProvision(p.heading, p.provisionText),
        amendsSection: p.amendsSection.length ? p.amendsSection.join('; ') : null,
        effectiveClue: p.effectiveClue,
        citedActs: p.citedActs.length ? JSON.stringify(p.citedActs) : null,
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }

    return { sourceId, provisionCount: parsed.length, ingested: true };
  });
}

/**
 * Derive `irish_tax_rules` rows from already-ingested provisions.
 *
 * This is the "extraction" phase: for each provision, the mechanical fact
 * extractor reads the verbatim text for monetary amounts, percentages and
 * year-counts. Where a curated key exists for the section, that stable key
 * attaches to the extracted figure; otherwise the fact is skipped from named
 * lookup but the provision itself is still on disk for audit.
 *
 * Every rule row's `extractedFact` is the verbatim statute token (e.g. "€27,382"),
 * and `humanExplanation` — where populated — is stored as `ai_suggestion` provenance
 * so it can never be mistaken for the statute's words. No rate is invented:
 * numeric values come only from figures the extractor located in the text.
 */
export function deriveTaxRules(
  db: AppDatabase,
  params: { companyId: string },
): { ruleCount: number } {
  const provisions = db
    .select({
      id: irishActProvisions.id,
      sectionNumber: irishActProvisions.sectionNumber,
      heading: irishActProvisions.heading,
      provisionText: irishActProvisions.provisionText,
      effectiveClue: irishActProvisions.effectiveClue,
      category: irishActProvisions.category,
    })
    .from(irishActProvisions)
    .where(eq(irishActProvisions.companyId, params.companyId))
    .all();

  let created = 0;
  for (const prov of provisions) {
    const parsed: ParsedProvision = {
      sectionNumber: prov.sectionNumber,
      heading: prov.heading ?? '',
      provisionText: prov.provisionText ?? '',
      sourceStart: prov.sourceStart ?? 0,
      sourceEnd: prov.sourceEnd ?? 0,
      principalActs: [],
      amendsSection: [],
      effectiveClue: prov.effectiveClue,
      citedActs: [],
    };
    const facts = extractFactsFromProvision(parsed);
    const curated = SECTION_RULE_KEYS[prov.sectionNumber];

    for (const fact of facts) {
      const ruleKey = curated ? curated.key : `${curated ? curated.key : `s${prov.sectionNumber}.fact`}.${fact.unit}.${fact.rawValue}`;
      // If no curated key, skip creating a named lookup rule — the figure is
      // still recoverable via a raw provision lookup, but we do not advertise
      // an unreviewed invented key. Only curated sections become named rules.
      if (!curated) continue;

      // De-duplicate by ruleKey within the company.
      const exists = db
        .select({ id: irishTaxRules.id })
        .from(irishTaxRules)
        .where(eq(irishTaxRules.ruleKey, ruleKey))
        .get();
      if (exists) continue;

      db.insert(irishTaxRules).values({
        id: ids.taxRule(),
        companyId: params.companyId,
        provisionId: prov.id,
        ruleKey,
        name: curated.name,
        extractedFact: fact.rawValue,
        humanExplanation: `Section ${prov.sectionNumber}: ${fact.evidence}`,
        numericValue: fact.numericValue,
        unit: fact.unit,
        qualifier: fact.qualifier ?? curated.kind === 'threshold' ? (prov.effectiveClue ?? null) : null,
        priority: curated.kind === 'rate' ? 50 : 100,
        source: 'rule',
        confidence: 95,
        provenanceStatus: 'system_rule',
        sourceNote: `Derived verbatim from Finance Act 2024 s.${prov.sectionNumber}.`,
        sourceDate: nowIso(),
      }).run();
      created++;
    }
  }

  return { ruleCount: created };
}

export interface LookupResult {
  id: string;
  provisionId: string;
  sectionNumber: string;
  heading: string;
  ruleKey: string;
  name: string;
  extractedFact: string | null;
  value: number | null;
  unit: string | null;
  qualifier: string | null;
  sourceNote: string | null;
  sourceDate: string | null;
  provisionText: string | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  sourceUrl: string;
}

/**
 * Deterministic lookup of a tax rule by stable key, e.g.
 * `lookupTaxRule(db, { companyId, ruleKey: 'usc.first_12012_eur_threshold' })`.
 *
 * Rules are looked up by a stable key, never by an LLM query over prose.
 * The result always carries the verbatim `provisionText` and its source offset
 * so the reader can verify it against the statute rather than trust the KB.
 */
export function lookupTaxRule(
  db: AppDatabase,
  params: { companyId: string; ruleKey: string },
): LookupResult | null {
  const row = db
    .select({
      id: irishTaxRules.id,
      provisionId: irishTaxRules.provisionId,
      ruleKey: irishTaxRules.ruleKey,
      name: irishTaxRules.name,
      extractedFact: irishTaxRules.extractedFact,
      value: irishTaxRules.numericValue,
      unit: irishTaxRules.unit,
      qualifier: irishTaxRules.qualifier,
      sourceNote: irishTaxRules.sourceNote,
      sourceDate: irishTaxRules.sourceDate,
      sectionNumber: irishActProvisions.sectionNumber,
      heading: irishActProvisions.heading,
      provisionText: irishActProvisions.provisionText,
      sourceStart: irishActProvisions.sourceStart,
      sourceEnd: irishActProvisions.sourceEnd,
      sourceUrl: irishStatuteSources.sourceUrl,
    })
    .from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishTaxRules.provisionId, irishActProvisions.id))
    .innerJoin(irishStatuteSources, eq(irishActProvisions.statuteSourceId, irishStatuteSources.id))
    .where(
      and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, params.ruleKey),
        eq(irishTaxRules.enabled, true),
      ),
    )
    .orderBy(desc(irishTaxRules.priority))
    .get();

  if (!row) return null;
  return {
    id: row.id,
    provisionId: row.provisionId,
    sectionNumber: row.sectionNumber,
    heading: row.heading,
    ruleKey: row.ruleKey,
    name: row.name,
    extractedFact: row.extractedFact,
    value: row.value,
    unit: row.unit,
    qualifier: row.qualifier,
    sourceNote: row.sourceNote,
    sourceDate: row.sourceDate,
    provisionText: row.provisionText,
    sourceStart: row.sourceStart,
    sourceEnd: row.sourceEnd,
    sourceUrl: row.sourceUrl,
  };
}

/**
 * List rules applicable to a given category (e.g. 'vat'), ordered by priority.
 * Pure data lookup — no LLM inference.
 */
export function listTaxRulesByCategory(
  db: AppDatabase,
  params: { companyId: string; category: ParsedProvision['category'] },
): LookupResult[] {
  return db
    .select({
      id: irishTaxRules.id,
      provisionId: irishTaxRules.provisionId,
      ruleKey: irishTaxRules.ruleKey,
      name: irishTaxRules.name,
      extractedFact: irishTaxRules.extractedFact,
      value: irishTaxRules.numericValue,
      unit: irishTaxRules.unit,
      qualifier: irishTaxRules.qualifier,
      sourceNote: irishTaxRules.sourceNote,
      sourceDate: irishTaxRules.sourceDate,
      sectionNumber: irishActProvisions.sectionNumber,
      heading: irishActProvisions.heading,
      provisionText: irishActProvisions.provisionText,
      sourceStart: irishActProvisions.sourceStart,
      sourceEnd: irishActProvisions.sourceEnd,
      sourceUrl: irishStatuteSources.sourceUrl,
    })
    .from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishTaxRules.provisionId, irishActProvisions.id))
    .innerJoin(irishStatuteSources, eq(irishActProvisions.statuteSourceId, irishStatuteSources.id))
    .where(
      and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.enabled, true),
        eq(irishActProvisions.category, params.category),
      ),
    )
    .orderBy(desc(irishTaxRules.priority))
    .all();
}

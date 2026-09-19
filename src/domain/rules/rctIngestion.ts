/**
 * Ingestion and rule derivation for Relevant Contracts Tax (RCT).
 *
 * Distinct sources, distinct `irish_knowledge_sources` rows, never conflated
 * (see `rctCuration.ts`'s own header for why each is used the way it is, and
 * why S.I. 651/2011, and TDM 18-02-01/18-02-02, are used for none):
 *
 *  - TCA 1997 s.530 (`legislation`, as-enacted-1997) — parsed with
 *    `tca1997SectionParser.ts` into a single provision.
 *  - Revenue TDMs 18-02-04, 18-02-05 and 18-02-11 (`revenue_guidance`) —
 *    each ingested as a single whole-document provision (continuous prose
 *    with numbered headings, not a statute with addressable sections),
 *    never as `legislation`, so this KB's source hierarchy can never let
 *    Revenue's own explanation outrank a statute covering the same ground
 *    once one is ingested. TDM 18-02-01 (Relevant Operations) and 18-02-02
 *    (Who is a Principal Contractor) are NOT ingested here even though
 *    listed in docs/statutes/rct/README.md: both are still paraphrased
 *    summaries in this repo (no page markers, no source hash), not the
 *    verbatim text this KB's provenance policy requires before curating
 *    anything from them.
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
  parseTca1997Section, provisionSlug, assessRelevance, TCA_1997_S530_MD_PATH,
} from './tca1997SectionParser';
import { RCT_CURATED_RULES, type RctSourceKind } from './rctCuration';
import { upsertReviewItem } from '../extraction/service';

export { TCA_1997_S530_MD_PATH };

const TCA_1997_S530 = {
  citation: '1997 Act 39 s.530',
  sourceType: 'legislation' as IrishSourceType,
  sourceUrl: 'https://www.irishstatutebook.ie/eli/1997/act/39/section/530/enacted/en/html',
  // TCA 1997's own commencement date is not verified against the Act's own
  // commencement section from this file alone; used as a year-level
  // placeholder consistent with the "as-enacted-1997" tag already in
  // s530.md's front matter, not asserted as the precise day. Flagged rather
  // than guessed at day-level precision.
  effectiveFrom: '1997-01-01',
};

type RctTdmKey = Exclude<RctSourceKind, 'tca1997_s530'>;

const RCT_TDM_SOURCES: Record<RctTdmKey, {
  citation: string; sourceType: IrishSourceType; sourceUrl: string; effectiveFrom: string; localPath: string;
}> = {
  tdm_18_02_04: {
    citation: 'Revenue TDM Part 18-02-04',
    sourceType: 'revenue_guidance',
    sourceUrl: 'https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-18/18-02-04.pdf',
    // The TDM describes the electronic RCT system operating "since 1 January
    // 2012" (its own §1) — used as the effective date of the guidance it
    // gives, not a claim about when the document itself was authored.
    effectiveFrom: '2012-01-01',
    localPath: 'docs/statutes/rct/tdm-18-02-04.md',
  },
  tdm_18_02_05: {
    citation: 'Revenue TDM Part 18-02-05',
    sourceType: 'revenue_guidance',
    sourceUrl: 'https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-18/18-02-05.pdf',
    effectiveFrom: '2012-01-01',
    localPath: 'docs/statutes/rct/tdm-18-02-05.md',
  },
  tdm_18_02_11: {
    citation: 'Revenue TDM Part 18-02-11',
    sourceType: 'revenue_guidance',
    sourceUrl: 'https://www.revenue.ie/en/tax-professionals/tdm/income-tax-capital-gains-tax-corporation-tax/part-18/18-02-11.pdf',
    effectiveFrom: '2012-01-01',
    localPath: 'docs/statutes/rct/tdm-18-02-11.md',
  },
};

function stripFrontMatterAndTitle(markdown: string): { title: string; body: string } {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  const afterFm = fmMatch ? markdown.slice(fmMatch[0].length) : markdown;
  const titleMatch = afterFm.match(/^\s*#\s+(.*)$/m);
  const title = titleMatch?.[1]?.trim() ?? 'RCT TDM';
  const body = titleMatch ? afterFm.slice((titleMatch.index ?? 0) + titleMatch[0].length) : afterFm;
  return { title, body: body.replace(/\n{3,}/g, '\n\n').trim() };
}

export interface RctIngestResult {
  sourceId: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/** Ingest TCA 1997 s.530. Idempotent by content, same pattern as `ingestVatca2010`. */
export function ingestTca1997S530(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, TCA_1997_S530.citation),
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
    const parsed = parseTca1997Section(params.markdown);
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: TCA_1997_S530.sourceType,
      title: `TCA 1997 s.${parsed.sectionNumber}`,
      citation: TCA_1997_S530.citation,
      jurisdiction: 'IE',
      sourceUrl: TCA_1997_S530.sourceUrl,
      localPath: params.localPath ?? TCA_1997_S530_MD_PATH,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: TCA_1997_S530.effectiveFrom,
      sourceNote: 'As-enacted 1997 text — no LRC revised TCA exists (docs/statutes/tca-1997/README.md). '
        + 'The definitions here (relevant contract, relevant operations) remain part of the current RCT '
        + 'scheme alongside ss.530A-530V (inserted by Finance Act 2011 s.20, not yet ingested); the '
        + 'pre-2012 compliance mechanics this section also defines (certificate of authorisation, relevant '
        + 'payments card) were superseded by the electronic system and are not curated into any rule here.',
      sourceDate: nowIso(),
    }).run();

    let { relevant, reason } = assessRelevance(parsed.category);
    const curated = RCT_CURATED_RULES.some(
      (r) => r.source === 'tca1997_s530' && r.sectionNumber === parsed.sectionNumber,
    );
    if (!relevant && curated) {
      relevant = true;
      reason = 'Curated: mapped to a rule in rctCuration.ts, overriding the '
        + `${parsed.category} category default.`;
    }

    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: parsed.sectionNumber,
      chapter: parsed.chapter,
      slug: provisionSlug(parsed.sectionNumber, parsed.heading),
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

    return { sourceId, provisionCount: 1, relevantCount: relevant ? 1 : 0, ingested: true };
  });
}

/** Ingest one whole RCT TDM document as a single provision. */
function ingestRctTdm(
  db: AppDatabase,
  params: { tdmKey: RctTdmKey; companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  const meta = RCT_TDM_SOURCES[params.tdmKey];
  const digest = sha256Hex(params.markdown);

  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.citation, meta.citation),
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

  const { title, body } = stripFrontMatterAndTitle(params.markdown);

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: meta.sourceType,
      title,
      citation: meta.citation,
      jurisdiction: 'IE',
      sourceUrl: meta.sourceUrl,
      localPath: params.localPath ?? meta.localPath,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: meta.effectiveFrom,
      sourceNote: "Revenue guidance, not legislation — never allowed to outrank TCA 1997 ss.530-530V "
        + '(sourceHierarchy.ts). Ingested as one whole-document provision rather than split by heading: '
        + 'it is continuous procedural prose, not an addressable statute.',
      sourceDate: nowIso(),
    }).run();

    // Ingested wholesale, not run through categoriseProvision/assessRelevance
    // (designed for a single statute section, not an 18-page mixed-topic
    // guidance document) — relevant only when this TDM actually backs a
    // curated rule (RCT_CURATED_RULES), same override convention every
    // other ingestion module in this KB applies.
    const curated = RCT_CURATED_RULES.some((r) => r.source === params.tdmKey);
    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: 'full',
      chapter: null,
      slug: provisionSlug('full', title),
      heading: title,
      principalAct: null,
      provisionText: body,
      sourceStart: 0,
      sourceEnd: body.length,
      category: 'procedure',
      amendsSection: null,
      effectiveClue: null,
      citedActs: [],
      relevant: curated,
      relevanceReason: curated
        ? 'Curated: mapped to a rule in rctCuration.ts.'
        : 'Ingested for citability; not currently curated into a rule (see rctCuration.ts for what is).',
      source: 'import',
      provenanceStatus: 'imported',
    }).run();

    return { sourceId, provisionCount: 1, relevantCount: curated ? 1 : 0, ingested: true };
  });
}

export function ingestRctTdm18_02_04(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  return ingestRctTdm(db, { ...params, tdmKey: 'tdm_18_02_04' });
}

export function ingestRctTdm18_02_05(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  return ingestRctTdm(db, { ...params, tdmKey: 'tdm_18_02_05' });
}

export function ingestRctTdm18_02_11(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  return ingestRctTdm(db, { ...params, tdmKey: 'tdm_18_02_11' });
}

export interface RctDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
}

/** Derive `irish_tax_rules` rows from `RCT_CURATED_RULES`, scoped to each rule's own source. */
export function deriveRctRules(
  db: AppDatabase,
  params: { companyId: string },
): RctDeriveResult {
  const citationFor = (source: RctSourceKind): string =>
    source === 'tca1997_s530' ? TCA_1997_S530.citation : RCT_TDM_SOURCES[source].citation;
  const effectiveFromFor = (source: RctSourceKind): string =>
    source === 'tca1997_s530' ? TCA_1997_S530.effectiveFrom : RCT_TDM_SOURCES[source].effectiveFrom;

  const usedSources = [...new Set(RCT_CURATED_RULES.map((r) => r.source))];
  const provisionsBySource = new Map<RctSourceKind, (typeof irishActProvisions.$inferSelect)[]>();
  for (const source of usedSources) {
    const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, citationFor(source))).get()?.id;
    provisionsBySource.set(
      source,
      sourceId ? db.select().from(irishActProvisions).where(eq(irishActProvisions.sourceId, sourceId)).all() : [],
    );
  }

  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];

  for (const rule of RCT_CURATED_RULES) {
    const provisions = provisionsBySource.get(rule.source) ?? [];
    const prov = provisions.find((p) => p.sectionNumber === rule.sectionNumber);
    if (!prov) { skippedNoProvision.push(rule.ruleKey); continue; }
    if (!prov.relevant) { skippedNoProvision.push(rule.ruleKey); continue; }

    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();

    const effectiveFrom = effectiveFromFor(rule.source);

    if (existing) {
      if (existing.statement === rule.statementExcerpt) { unchanged++; continue; }
      db.update(irishTaxRules)
        .set({ effectiveTo: effectiveFrom, active: false })
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
      extractedFact: null,
      humanExplanation: rule.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: null,
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: [],
      accountingEffect: rule.accountingEffect,
      taxEffect: rule.taxEffect,
      vatEffect: null,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: rule.requiresGuidance,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom,
      source: 'derived',
      confidence: 60,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${citationFor(rule.source)}`
        + `, para/section ${rule.sectionNumber}; not yet human-reviewed. ${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish RCT rule extracted: ${rule.name}`,
      detail: `${rule.interpretationNote} Review the condition mapping against the source text and approve, `
        + 'or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, source: rule.source, sectionNumber: rule.sectionNumber },
    });
  }

  return { created, superseded, unchanged, skippedNoProvision };
}

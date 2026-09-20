/**
 * Ingestion and rule derivation for Relevant Contracts Tax (RCT).
 *
 * Distinct sources, distinct `irish_knowledge_sources` rows, never conflated
 * (see `rctCuration.ts`'s own header for why each is used the way it is, and
 * why S.I. 651/2011, and TDM 18-02-01/18-02-02, are used for none):
 *
 *  - TCA 1997 s.530 (`legislation`, as-enacted-1997) — parsed with
 *    `tca1997SectionParser.ts` into a single provision.
 *  - TCA 1997 ss.530A, 530E, 530G, 530H, 530I (`legislation`,
 *    as-enacted-2011; issue #131) — parsed with
 *    `financeAct2011RctSectionParser.ts`, one provision per section, each
 *    under its own `irish_knowledge_sources` row (own citation, e.g.
 *    "1997 Act 39 s.530E") even though all six share one physical source
 *    document (the eISB Finance Act 2011 s.20 page) — same per-section
 *    citation convention `si692025Ingestion.ts` uses for a shared document.
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
import {
  parseFinanceAct2011RctSection, tca1997RctSectionMdPath,
} from './financeAct2011RctSectionParser';
import { RCT_CURATED_RULES, type RctSourceKind } from './rctCuration';
import { upsertReviewItem } from '../extraction/service';

export { TCA_1997_S530_MD_PATH };
export { tca1997RctSectionMdPath };

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

type RctFa2011SectionKey = Extract<
  RctSourceKind, 'tca1997_s530a' | 'tca1997_s530e' | 'tca1997_s530g' | 'tca1997_s530h' | 'tca1997_s530i'
>;

const RCT_FA2011_SECTIONS: Record<RctFa2011SectionKey, {
  sectionNumber: string; citation: string; sourceUrl: string; effectiveFrom: string; localPath: string;
}> = {
  // TDM 18-02-04 §1 gives the electronic RCT system's own start date
  // (1 January 2012) as the effective date of the guidance it describes —
  // reused here for the sections it describes too, for the same reason
  // RCT_TDM_SOURCES below does: this KB has not independently verified
  // Finance Act 2011's own commencement order against a primary source.
  tca1997_s530a: {
    sectionNumber: '530A',
    citation: '1997 Act 39 s.530A',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2011/act/6/section/20/enacted/en/html',
    effectiveFrom: '2012-01-01',
    localPath: 'docs/statutes/tca-1997/s530A.md',
  },
  tca1997_s530e: {
    sectionNumber: '530E',
    citation: '1997 Act 39 s.530E',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2011/act/6/section/20/enacted/en/html',
    effectiveFrom: '2012-01-01',
    localPath: 'docs/statutes/tca-1997/s530E.md',
  },
  tca1997_s530g: {
    sectionNumber: '530G',
    citation: '1997 Act 39 s.530G',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2011/act/6/section/20/enacted/en/html',
    effectiveFrom: '2012-01-01',
    localPath: 'docs/statutes/tca-1997/s530G.md',
  },
  tca1997_s530h: {
    sectionNumber: '530H',
    citation: '1997 Act 39 s.530H',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2011/act/6/section/20/enacted/en/html',
    effectiveFrom: '2012-01-01',
    localPath: 'docs/statutes/tca-1997/s530H.md',
  },
  tca1997_s530i: {
    sectionNumber: '530I',
    citation: '1997 Act 39 s.530I',
    sourceUrl: 'https://www.irishstatutebook.ie/eli/2011/act/6/section/20/enacted/en/html',
    effectiveFrom: '2012-01-01',
    localPath: 'docs/statutes/tca-1997/s530I.md',
  },
};

type RctTdmKey = Exclude<RctSourceKind, 'tca1997_s530' | RctFa2011SectionKey>;

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
        + 'scheme alongside ss.530A-530V (inserted by Finance Act 2011 s.20; the load-bearing rate-'
        + 'determination sections, 530A/530E/530G/530H/530I, are ingested separately below — see '
        + '`ingestTca1997RctFa2011Section`). The pre-2012 compliance mechanics this section also defines '
        + '(certificate of authorisation, relevant payments card) were superseded by the electronic system '
        + 'and are not curated into any rule here.',
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

/**
 * Ingest one TCA 1997 section as inserted by Finance Act 2011 s.20 (issue
 * #131). Idempotent by (own citation + content hash), same pattern as
 * `ingestTca1997S530` — each of the six sections gets its own
 * `irish_knowledge_sources` row even though all six were fetched from the
 * same physical Finance Act 2011 s.20 page (same content hash across all
 * six files, per docs/statutes/tca-1997/s530A.md etc.'s own front matter).
 */
function ingestTca1997RctFa2011Section(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
  key: RctFa2011SectionKey,
): RctIngestResult {
  const meta = RCT_FA2011_SECTIONS[key];
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

  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    const parsed = parseFinanceAct2011RctSection(params.markdown);
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'legislation',
      title: `TCA 1997 s.${parsed.sectionNumber} (as inserted by FA 2011 s.20)`,
      citation: meta.citation,
      jurisdiction: 'IE',
      sourceUrl: meta.sourceUrl,
      localPath: params.localPath ?? tca1997RctSectionMdPath(meta.sectionNumber),
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: meta.effectiveFrom,
      sourceNote: 'Inserted by Finance Act 2011 s.20 — no LRC revised TCA 1997 page exists for ss.530A-530V '
        + '(every revisedacts.lawreform.ie URL for them 404s, reconfirmed for issue #131), so this was fetched '
        + 'from the eISB as-enacted Finance Act 2011 s.20 page instead, the inserting Act\'s own text. Later '
        + 'Finance Acts may have amended this section since 2011; not independently checked here.',
      sourceDate: nowIso(),
    }).run();

    const curated = RCT_CURATED_RULES.some((r) => r.source === key && r.sectionNumber === parsed.sectionNumber);
    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: parsed.sectionNumber,
      chapter: null,
      slug: provisionSlug(parsed.sectionNumber, parsed.heading),
      heading: parsed.heading,
      principalAct: 'Taxes Consolidation Act 1997',
      provisionText: parsed.provisionText,
      sourceStart: parsed.sourceStart,
      sourceEnd: parsed.sourceEnd,
      category: parsed.category,
      amendsSection: null,
      effectiveClue: null,
      citedActs: ['Taxes Consolidation Act 1997', 'Finance Act 2011'],
      relevant: curated,
      relevanceReason: curated
        ? `Curated: mapped to rule(s) in rctCuration.ts for s.${parsed.sectionNumber}.`
        : `Ingested for citability; not currently curated (see rctCuration.ts for s.${parsed.sectionNumber}).`,
      source: 'import',
      provenanceStatus: 'imported',
    }).run();

    return { sourceId, provisionCount: 1, relevantCount: curated ? 1 : 0, ingested: true };
  });
}

export function ingestTca1997S530A(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  return ingestTca1997RctFa2011Section(db, params, 'tca1997_s530a');
}

export function ingestTca1997S530E(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  return ingestTca1997RctFa2011Section(db, params, 'tca1997_s530e');
}

export function ingestTca1997S530G(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  return ingestTca1997RctFa2011Section(db, params, 'tca1997_s530g');
}

export function ingestTca1997S530H(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  return ingestTca1997RctFa2011Section(db, params, 'tca1997_s530h');
}

export function ingestTca1997S530I(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): RctIngestResult {
  return ingestTca1997RctFa2011Section(db, params, 'tca1997_s530i');
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
  const isFa2011Section = (source: RctSourceKind): source is RctFa2011SectionKey => source in RCT_FA2011_SECTIONS;
  const citationFor = (source: RctSourceKind): string => {
    if (source === 'tca1997_s530') return TCA_1997_S530.citation;
    if (isFa2011Section(source)) return RCT_FA2011_SECTIONS[source].citation;
    return RCT_TDM_SOURCES[source].citation;
  };
  const effectiveFromFor = (source: RctSourceKind): string => {
    if (source === 'tca1997_s530') return TCA_1997_S530.effectiveFrom;
    if (isFa2011Section(source)) return RCT_FA2011_SECTIONS[source].effectiveFrom;
    return RCT_TDM_SOURCES[source].effectiveFrom;
  };

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
      extractedFact: rule.numericValue !== null ? String(rule.numericValue) : null,
      humanExplanation: rule.interpretationNote,
      numericValue: rule.numericValue,
      unit: rule.unit,
      qualifier: rule.qualifier,
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

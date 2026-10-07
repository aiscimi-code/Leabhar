/**
 * Ingestion for individual VATCA 2010 sections in their LRC-revised form
 * (docs/statutes/vatca-2010-revised/s*.md) — a third, distinct family of
 * VATCA sources alongside the as-enacted whole-Act text (`vatcaIngestion.ts`)
 * and the revised Schedules (`vatcaScheduleIngestion.ts`). Each revised
 * section is its own independently-fetched, independently-hashed document
 * (its own `source_html_sha256`), so — matching the Schedule precedent —
 * each becomes its own `irish_knowledge_sources` row rather than being
 * merged into the whole-Act source, which would conflate a 2010 snapshot
 * with continuously-updated current text.
 *
 * Built generically (`ingestVatcaRevisedSection` takes any section's
 * Markdown) rather than hard-coded to one section, so a future pass can
 * ingest more of the ~50 available files without a new ingestion function
 * each time — this pass curates only s.46 (rates), the single section this
 * whole family exists to fix (see `vatcaRevisedCuration.ts`'s header for
 * why the as-enacted text could never safely state a current rate).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { appRoot } from '@/lib/paths';
import type { AppDatabase } from '@/db';
import {
  irishKnowledgeSources, irishActProvisions, irishTaxRules, type IrishSourceType,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import {
  parseVatcaRevisedSection, provisionSlug, assessRelevance,
} from './vatcaRevisedSectionParser';
import { parseScheduleFrontMatter } from './vatcaScheduleParser';
import { VATCA_REVISED_CURATED_RULES, RETIRED_S46_RULE_KEYS, type CuratedVatcaRevisedRule } from './vatcaRevisedCuration';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';
import { VAT_PLACE_OF_SUPPLY_CURATED_RULES } from './vatPlaceOfSupplyCuration';
import { upsertReviewItem } from '../extraction/service';
import { crossReferencesFromProvision, sameCrossReferences } from './dependencies';
import { taxHeadsFor } from './taxHeads';

import { containsIgnoringLayout, plainQuotes } from './lrcAnnotations';
import { CATALOGUE_ENTRIES, ingestCatalogueFile, type CatalogueIngestResult } from './catalogue';
import { catalogueSourcesFirst } from './catalogueSupersession';

/** s.46 is ported to the rules catalogue (#443): its statute copy is gone. */
export const VATCA_REVISED_S046_CATALOGUE_ENTRY = 'vatca-2010-revised/s046.json';

/**
 * The Acts the s.46 rate rules cite for paragraph (cb) from 2020 to 2023,
 * which the revised s.46 no longer holds: the insertion and each later
 * end date (#688).
 */
export const VATCA_S46_CB_CHAIN_CATALOGUE_ENTRIES = [
  'finance-act-2020/s39.json',
  'finance-covid-2021/s6.json',
  'finance-covid-2022/s7.json',
  'finance-act-2023/s5.json',
] as const;

/** Load s.46 (rates) from the rules catalogue, with the Acts its (cb) versions cite. Returns s.46's result. */
export function ingestVatcaRevisedS46(
  db: AppDatabase,
  params: { companyId?: string | null; ingestVersion?: string; root?: string },
): CatalogueIngestResult {
  for (const entry of VATCA_S46_CB_CHAIN_CATALOGUE_ENTRIES) ingestCatalogueFile(db, { ...params, entry });
  return ingestCatalogueFile(db, { ...params, entry: VATCA_REVISED_S046_CATALOGUE_ENTRY });
}

/**
 * Load one revised section, wherever it now lives: its rules catalogue entry
 * when it has been ported (#556), else its statute copy. `section` is the
 * file stem's number, e.g. "34", "059" or "92A".
 */
export function ingestVatcaRevised(
  db: AppDatabase,
  params: { companyId?: string | null; section: string; ingestVersion?: string; root?: string },
): { sourceId: string; ingested: boolean } {
  const stem = /^\d+$/.test(params.section) ? params.section.padStart(3, '0') : params.section;
  const entry = `vatca-2010-revised/s${stem}.json`;
  if ((CATALOGUE_ENTRIES as readonly string[]).includes(entry)) {
    return ingestCatalogueFile(db, { companyId: params.companyId, entry, ingestVersion: params.ingestVersion, root: params.root });
  }
  const localPath = `docs/statutes/vatca-2010-revised/s${stem}.md`;
  return ingestVatcaRevisedSection(db, {
    companyId: params.companyId, ingestVersion: params.ingestVersion ?? 'v1', localPath,
    markdown: readFileSync(join(params.root ?? appRoot(), localPath), 'utf8'),
  });
}

const SOURCE_TYPE: IrishSourceType = 'legislation';

export interface VatcaRevisedIngestResult {
  sourceId: string;
  sectionNumber: string;
  provisionCount: number;
  relevantCount: number;
  ingested: boolean;
}

/**
 * Whether a revised section bears on the rules, and why: its category's
 * default, unless a curated rule is mapped to it. Shared with the catalogue
 * extraction (scripts/catalogue/extract.ts), so both judge a section alike.
 */
export function vatcaRevisedRelevance(
  sectionNumber: string, citation: string, category: Parameters<typeof assessRelevance>[0],
): { relevant: boolean; reason: string } {
  const { relevant, reason } = assessRelevance(category);
  const curated = VATCA_REVISED_CURATED_RULES.some((r) => r.sectionNumber === sectionNumber)
    || [...VAT_SCOPE_CURATED_RULES, ...VAT_PLACE_OF_SUPPLY_CURATED_RULES].some((r) => r.citation === citation);
  if (!relevant && curated) {
    return { relevant: true, reason: `Curated: mapped to a rule in vatcaRevisedCuration.ts, overriding the ${category} category default.` };
  }
  return { relevant, reason };
}

/** Ingest one VATCA revised section's Markdown. Idempotent by content. */
export function ingestVatcaRevisedSection(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath?: string },
): VatcaRevisedIngestResult {
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
      const parsed = parseVatcaRevisedSection(params.markdown);
      return {
        sourceId: existing.id, sectionNumber: parsed.sectionNumber, provisionCount: rows.length,
        relevantCount: rows.filter((r) => r.relevant).length, ingested: false,
      };
    }
  }

  const parsed = parseVatcaRevisedSection(params.markdown);

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
      // Unlike vatca-2010 (frozen 2010 as-enacted text) and the Schedules
      // (which at least mark an lrc_updated_to date), this simpler
      // extraction records no "consolidated to" date of its own — the LRC
      // page reflects whatever was in force when fetched, which can move.
      // effectiveFrom here means "confirmed accurate as of ingest", not a
      // historical commencement date; see individual rules' own sourceNote
      // for anything more precise a provision's own text supports.
      effectiveFrom: nowIso().slice(0, 10),
      sourceNote: `Ingest ${params.ingestVersion} of ${fm.citation}, LRC-revised text as retrieved — `
        + 'a live, continuously-updated page, not a dated historical snapshot. Distinct source row from '
        + 'both "2010 Act 31" (the frozen as-enacted whole-Act text) and any Schedule source; never merged '
        + 'with either.',
      sourceDate: nowIso(),
    }).run();

    const { relevant, reason } = vatcaRevisedRelevance(parsed.sectionNumber, fm.citation, parsed.category);

    tx.insert(irishActProvisions).values({
      id: ids.provision(),
      companyId: params.companyId ?? null,
      sourceId,
      sectionNumber: parsed.sectionNumber,
      slug: provisionSlug(`revised-${parsed.sectionNumber}`, parsed.heading),
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

export interface VatcaRevisedDeriveResult {
  created: number;
  superseded: number;
  unchanged: number;
  skippedNoProvision: string[];
  /** Families left as they are because a version's stated period did not check out against its sources. */
  skippedStatedPeriod: string[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "31 August 2023" → "2023-08-31"; null when it is not a date in those words. */
export function isoFromWords(words: string): string | null {
  const m = /^(\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(words.trim());
  const month = m ? MONTHS.indexOf(m[2]!) + 1 : 0;
  return m && month > 0 ? `${m[3]}-${String(month).padStart(2, '0')}-${m[1]!.padStart(2, '0')}` : null;
}

const dayAfter = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * Why a version's stated period does not hold, or [] when it does: each
 * quote is in its provision (ignoring layout), the setting words start on
 * `effectiveFrom`, each substitution replaces the end date before it, and the
 * last one ends the day before `effectiveTo` (exclusive). `textOf` reads a
 * provision's text by citation and section, or null when it is not ingested.
 */
export function statedPeriodProblems(
  rule: CuratedVatcaRevisedRule,
  textOf: (citation: string, sectionNumber: string) => string | null,
): string[] {
  const period = rule.statedPeriod;
  if (!period) return [];
  const problems: string[] = [];
  const check = (q: { citation: string; sectionNumber: string; quote: string }) => {
    const text = textOf(q.citation, q.sectionNumber);
    if (text === null) problems.push(`${q.citation} is not ingested`);
    else if (!containsIgnoringLayout(text, q.quote)) problems.push(`"${q.quote}" is not in ${q.citation}`);
  };
  check(period.setBy);
  const set = /from (\d{1,2} [A-Z][a-z]+ \d{4}) to (\d{1,2} [A-Z][a-z]+ \d{4})/.exec(period.setBy.quote);
  if (!set) return [...problems, `the setting words state no "from … to …" period`];
  if (isoFromWords(set[1]!) !== rule.effectiveFrom) problems.push(`the period starts ${set[1]}, not ${rule.effectiveFrom}`);
  let end = set[2]!;
  for (const sub of period.endDateSubstitutions) {
    check(sub);
    if (!plainQuotes(sub.quote).includes(`"${sub.substitutes}" for "${sub.replaces}"`)) {
      problems.push(`${sub.citation}: the quote does not substitute "${sub.substitutes}" for "${sub.replaces}"`);
    }
    if (sub.replaces !== end) problems.push(`${sub.citation} replaces "${sub.replaces}", but the end date then was "${end}"`);
    end = sub.substitutes;
  }
  const last = isoFromWords(end);
  if (!last || rule.effectiveTo !== dayAfter(last)) problems.push(`the stated period ends ${end}, but effectiveTo is ${rule.effectiveTo}`);
  return problems;
}

/**
 * Derive `irish_tax_rules` rows from `VATCA_REVISED_CURATED_RULES` (issue #205).
 *
 * A ruleKey is a family of dated versions. Each curated version is one row;
 * a version already stored with the same window, text and figure is left
 * alone. A new version supersedes the one before it in time
 * (`supersedesRuleId`), or, when it corrects a stored row it replaces, that
 * row. A stored row no curated version accounts for (a wrong window, a
 * retired key) is retired: its window is emptied and it is marked inactive,
 * never deleted. Only a family's latest version is `active`.
 */
/** What the rule's provision cites, and what the curation adds (the later Acts that moved its dates). */
function crossReferencesFor(
  rule: CuratedVatcaRevisedRule, prov: Parameters<typeof crossReferencesFromProvision>[0],
): string[] {
  return [...new Set([...crossReferencesFromProvision(prov), ...(rule.crossReferences ?? [])])];
}

export function deriveVatcaRevisedRules(
  db: AppDatabase,
  params: { companyId: string },
): VatcaRevisedDeriveResult {
  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  const skippedNoProvision: string[] = [];
  const skippedStatedPeriod: string[] = [];

  const families = new Map<string, CuratedVatcaRevisedRule[]>();
  for (const rule of VATCA_REVISED_CURATED_RULES) {
    families.set(rule.ruleKey, [...(families.get(rule.ruleKey) ?? []), rule]);
  }

  const provisionFor = (rule: CuratedVatcaRevisedRule) => {
    // The latest source for the citation: a re-fetched page whose words moved
    // is a new source row beside the old one (#688).
    const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, rule.citation))
      .orderBy(catalogueSourcesFirst(), desc(irishKnowledgeSources.retrievedAt)).get()?.id;
    return sourceId
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, rule.sectionNumber)))
        .get()
      : undefined;
  };
  const provisionTextOf = (citation: string, sectionNumber: string): string | null => {
    const prov = provisionFor({ citation, sectionNumber } as CuratedVatcaRevisedRule);
    return prov ? prov.provisionText ?? '' : null;
  };
  const storedRows = (ruleKey: string) => db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, ruleKey))).all();
  const retire = (row: typeof irishTaxRules.$inferSelect) => {
    if (row.effectiveTo === row.effectiveFrom && !row.active) return false;
    db.update(irishTaxRules).set({ effectiveTo: row.effectiveFrom, active: false })
      .where(eq(irishTaxRules.id, row.id)).run();
    return true;
  };

  for (const [ruleKey, versions] of families) {
    const ordered = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    const provisions = ordered.map(provisionFor);
    if (provisions.some((prov) => !prov || !prov.relevant)) { skippedNoProvision.push(ruleKey); continue; }
    // A date the version's own quote does not state is checked against the
    // words that do; a family whose dates do not check out is not derived.
    const periodProblems = ordered.flatMap((rule) => statedPeriodProblems(rule, provisionTextOf));
    if (periodProblems.length) {
      skippedStatedPeriod.push(ruleKey);
      upsertReviewItem(db, {
        companyId: params.companyId,
        kind: 'other',
        severity: 'warning',
        title: `The dates of ${ruleKey} do not match the Acts that state them`,
        detail: `${periodProblems.join('; ')}. The rule was not derived; nothing else has been changed.`,
        entityType: 'irish_rule_key',
        entityId: ruleKey,
        dedupeKey: `rule_stated_period:${ruleKey}:${periodProblems.join('|')}`,
        context: { ruleKey, problems: periodProblems },
      });
      continue;
    }

    const stored = storedRows(ruleKey);
    const kept = new Set<string>();
    let previousId: string | null = null;
    let nextVersion = stored.reduce((max, r) => Math.max(max, r.ruleVersion), 0) + 1;

    ordered.forEach((rule, i) => {
      const prov = provisions[i]!;
      const match = stored.find((r) => !kept.has(r.id)
        && r.provisionId === prov.id && r.effectiveFrom === rule.effectiveFrom
        && (r.effectiveTo ?? null) === rule.effectiveTo
        && r.statement === rule.statementExcerpt && r.numericValue === rule.numericValue
        && sameCrossReferences(r.crossReferences, crossReferencesFor(rule, prov)));
      if (match) {
        kept.add(match.id);
        previousId = match.id;
        unchanged++;
        return;
      }
      // A stored row for the same period that this version corrects.
      const corrected = stored.find((r) => !kept.has(r.id) && r.effectiveTo !== r.effectiveFrom
        && r.effectiveFrom < (rule.effectiveTo ?? '9999-12-31')
        && (r.effectiveTo === null || r.effectiveTo > rule.effectiveFrom));

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
        exceptions: [],
        crossReferences: crossReferencesFor(rule, prov),
        accountingEffect: null,
        taxEffect: null,
        vatEffect: rule.vatEffect,
        reportingEffect: null,
        requiresGuidance: true,
        humanReviewRequired: true,
        reviewStatus: 'ai_extracted',
        ruleVersion: nextVersion++,
        supersedesRuleId: corrected?.id ?? previousId,
        priority: 100,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
        active: false,
        source: 'derived',
        confidence: 70,
        provenanceStatus: 'ai_suggestion',
        sourceNote: `Curated from ${rule.citation}${rule.citation.includes('s.') ? '' : ` s.${rule.sectionNumber}`}; `
          + `not yet human-reviewed. ${rule.interpretationNote}`,
        sourceDate: nowIso(),
      }).run();
      kept.add(newRuleId);
      previousId = newRuleId;
      created++;

      upsertReviewItem(db, {
        companyId: params.companyId,
        kind: 'unresolved_ai_suggestion',
        severity: 'info',
        title: `New Irish VAT rate rule extracted: ${rule.name}`,
        detail: `${rule.citation} s.${rule.sectionNumber}. ${rule.interpretationNote} `
          + 'Review against the source text and approve, or reject, before it is treated as authoritative.',
        entityType: 'irish_tax_rule',
        entityId: newRuleId,
        dedupeKey: `irish_tax_rule:${newRuleId}`,
        context: { ruleKey: rule.ruleKey, sectionNumber: rule.sectionNumber },
      });
    });

    for (const row of stored) {
      if (!kept.has(row.id) && retire(row)) superseded++;
    }
    // Only the family's latest version is active.
    for (const row of storedRows(ruleKey)) {
      const shouldBeActive = row.id === previousId;
      if (row.active !== shouldBeActive && row.effectiveTo !== row.effectiveFrom) {
        db.update(irishTaxRules).set({ active: shouldBeActive }).where(eq(irishTaxRules.id, row.id)).run();
      }
    }
  }

  for (const ruleKey of RETIRED_S46_RULE_KEYS) {
    for (const row of storedRows(ruleKey)) if (retire(row)) superseded++;
  }

  return { created, superseded, unchanged, skippedNoProvision, skippedStatedPeriod };
}

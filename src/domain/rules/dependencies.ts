/**
 * Rule dependencies (issue #438, epic #310 "Rule dependencies").
 *
 * `irish_tax_rules.crossReferences` records the other provisions and Acts a
 * rule's provision depends on — an amending Finance Act section names the
 * section it amends, a Regulation's rule leans on the Act it implements. The
 * write side existed; nothing ever read it back. This module is the read
 * side: it resolves each reference against what this book actually holds, so
 * "this rule depends on X" is either "X is ingested: provision s.N of Act Y,
 * cited by these rules" or "X is not in this knowledge base" — never a guess
 * and never a silent merge.
 *
 * Resolution is deterministic: a reference names an instrument (matched by
 * alias against ingested source citations) and a locator within it (s./reg./
 * art. number). A reference that names neither, or an instrument this book
 * has not ingested, is reported unresolved with the reason — the traceability
 * audit's "REQUIRED, NOT INGESTED" finding is now a query, not a manual check.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { isCatalogueSource } from './catalogueSupersession';

/** What a reference names as the instrument it points into. */
const INSTRUMENT_ALIASES: Array<{ match: RegExp; citation: RegExp }> = [
  { match: /value-added tax consolidation act|vatca/i, citation: /VATCA 2010|Value-Added Tax Consolidation Act 2010|2010 Act 31/i },
  { match: /taxes consolidation act|tca\s*1997/i, citation: /TCA 1997|Taxes Consolidation Act 1997|1997 Act 39/i },
  { match: /companies act 2014/i, citation: /Companies Act 2014|2014 Act 38/i },
  { match: /social welfare consolidation act|swca/i, citation: /SWCA 2005|Social Welfare Consolidation Act 2005|2005 Act 26/i },
  { match: /finance act\s*2024/i, citation: /Finance Act 2024|2024 Act 43/i },
  { match: /finance act\s*2025/i, citation: /Finance Act 2025|2025 Act 18/i },
  { match: /finance act\s*2003/i, citation: /Finance Act 2003|2003 Act 3/i },
  { match: /finance act\s*2020/i, citation: /Finance Act 2020|2020 Act 26/i },
  { match: /finance act\s*2023/i, citation: /Finance Act 2023|2023 Act 11/i },
  { match: /miscellaneous provisions\) act\s*2021/i, citation: /2021 Act 23/i },
  { match: /miscellaneous provisions\) act\s*2022/i, citation: /2022 Act 9\b/i },
  { match: /282\/2011/i, citation: /282\/2011/i },
];

/** The locator a reference carries: a section, regulation or article number. */
export function referenceLocator(reference: string): string | null {
  const patterns = [
    /\bs\.?\s*(\d+[A-Z]*(?:\(\d+[A-Za-z]*\))*)/i,
    /\bsection\s+(\d+[A-Z]*(?:\(\d+[A-Za-z]*\))*)/i,
    /\breg(?:ulation)?\.?\s*(\d+[A-Z]*)/i,
    /\bart(?:icle)?\.?\s*(\d+[a-z]*(?:\(\d+\))?)/i,
    /^(\d+[A-Z]*)(?:\(\d+[A-Za-z]*\))*$/, // a bare section number amended by this provision
  ];
  for (const p of patterns) {
    const m = p.exec(reference);
    if (m) return m[1]!;
  }
  return null;
}

/** The instrument a reference names, matched against ingested citations. */
export function referenceInstrument(reference: string): { matched: boolean; citation?: RegExp } {
  const si = /S\.I\.?\s*(\d+)\s*\/\s*(\d+)/i.exec(reference);
  if (si) return { matched: true, citation: new RegExp(`S\\.I\\. ${si[1]}/${si[2]}`, 'i') };
  for (const alias of INSTRUMENT_ALIASES) {
    if (alias.match.test(reference)) return { matched: true, citation: alias.citation };
  }
  return { matched: false };
}

export interface ResolvedDependency {
  /** The cross-reference as stored on the rule, verbatim. */
  reference: string;
  resolved: boolean;
  provision: {
    id: string;
    sectionNumber: string;
    heading: string;
    citation: string;
    sourceType: string;
    sourceUrl: string;
  } | null;
  /** The rules derived from that provision, when it resolved. */
  ruleKeys: string[];
  /** Why it did not resolve, when it did not. */
  reason: string | null;
}

/**
 * The cross-references a rule's provision itself states: the sections it
 * amends (qualified by its principal Act, so a bare "472BB(3)" becomes
 * "Taxes Consolidation Act 1997 s.472BB(3)") plus the Acts it cites verbatim.
 * The derive steps that had nothing to say used to write `[]`; this gives
 * them the provision's own answer instead of an empty one.
 */
export function crossReferencesFromProvision(prov: {
  amendsSection: string | null;
  citedActs: string[];
  principalAct: string | null;
}): string[] {
  const amended = (prov.amendsSection ?? '')
    .split('; ')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (/^\d+[A-Z]*(\(\d+[A-Za-z]*\))*$/.test(s) && prov.principalAct
      ? `${prov.principalAct} s.${s}`
      : s));
  return [...new Set([...amended, ...prov.citedActs])];
}

/** Whether a stored rule's cross-references already say what the provision says (order-insensitive). */
export function sameCrossReferences(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

/** Resolve one rule's cross-references against what this book holds. */
export function resolveRuleDependencies(
  db: AppDatabase,
  params: { ruleId: string },
): ResolvedDependency[] {
  const rule = db.select().from(irishTaxRules).where(eq(irishTaxRules.id, params.ruleId)).get();
  if (!rule) throw new Error(`No rule with id ${params.ruleId}.`);
  if (!rule.crossReferences.length) return [];
  return resolveReferences(db, rule, bookContext(db, rule.companyId));
}

/**
 * Resolve a free-standing reference ("VATCA 2010 s.46") against this book, as
 * a rule's cross-reference would be. Used to name a provision for `impact`.
 */
export function resolveReference(db: AppDatabase, params: { companyId: string; reference: string }): ResolvedDependency {
  const asRule = { crossReferences: [params.reference], provisionId: '' } as unknown as RuleRow;
  return resolveReferences(db, asRule, bookContext(db, params.companyId))[0]!;
}

type RuleRow = typeof irishTaxRules.$inferSelect;
interface BookContext {
  sources: Array<typeof irishKnowledgeSources.$inferSelect>;
  provisionRules: RuleRow[];
  provisions: Map<string, typeof irishActProvisions.$inferSelect>;
}

function bookContext(db: AppDatabase, companyId: string): BookContext {
  return {
    sources: db.select().from(irishKnowledgeSources).all(),
    provisionRules: db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all(),
    provisions: new Map(),
  };
}

function provisionById(db: AppDatabase, ctx: BookContext, id: string) {
  if (!ctx.provisions.has(id)) {
    const row = db.select().from(irishActProvisions).where(eq(irishActProvisions.id, id)).get();
    if (row) ctx.provisions.set(id, row);
  }
  return ctx.provisions.get(id);
}

function resolveReferences(db: AppDatabase, rule: RuleRow, ctx: BookContext): ResolvedDependency[] {
  const provision = provisionById(db, ctx, rule.provisionId);
  const references = rule.crossReferences;
  const { sources, provisionRules } = ctx;

  return references.map((reference) => {
    const locator = referenceLocator(reference);
    if (!locator) {
      return { reference, resolved: false, provision: null, ruleKeys: [],
        reason: 'The reference names no section, regulation or article this KB can look up.' };
    }
    const instrument = referenceInstrument(reference);
    // A bare locator amended by this provision points into its own principal
    // Act; a reference that names an instrument this book does not hold says
    // so, rather than being quietly read as the provision's own Act.
    const hasActWords = /\bact\b|\bregulation\b|\bmanual\b|\bdirective\b|s\.i\./i.test(reference);
    const bareLocator = !hasActWords;
    const actName = instrument.matched ? null : bareLocator ? provision?.principalAct ?? null : null;
    const citationPattern = instrument.matched
      ? instrument.citation!
      : actName
        ? referenceInstrument(actName).citation ?? null
        : null;
    if (!citationPattern) {
      return { reference, resolved: false, provision: null, ruleKeys: [],
        reason: 'This book ingests no source for the instrument the reference names '
          + `("${reference.replace(/\s*(s|reg|art|section)\b.*$/i, '').trim() || reference}").` };
    }
    // An instrument is often ingested as several sources (the whole Act, single
    // sections of it, its Schedules): prefer the source that names this very
    // section, then the principal Act, and read a Schedule last — a Schedule's
    // paragraph numbers share a namespace with nothing but themselves.
    const section = locator.replace(/\(.*$/, '');
    const rank = (c: string): number => (new RegExp(`s\\.?\\s*${section}\\b`, 'i').test(c) ? 0 : /sch/i.test(c) ? 2 : 1);
    const candidates = sources
      .filter((s) => citationPattern.test(s.citation) || citationPattern.test(s.title))
      // A source loaded from the catalogue before a pre-port copy of it (#706).
      .sort((a, b) => rank(a.citation) - rank(b.citation) || Number(isCatalogueSource(b.localPath)) - Number(isCatalogueSource(a.localPath)));
    if (candidates.length === 0) {
      return { reference, resolved: false, provision: null, ruleKeys: [],
        reason: 'The instrument this reference names is not ingested in this book.' };
    }
    let target: typeof irishActProvisions.$inferSelect | undefined;
    let source: typeof irishKnowledgeSources.$inferSelect | undefined;
    for (const candidate of candidates) {
      const found = db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, candidate.id), eq(irishActProvisions.sectionNumber, section))).get();
      if (found) { target = found; source = candidate; break; }
    }
    if (!target || !source) {
      const instrumentName = actName ?? (reference.replace(/\s*(s|reg|art|section)\b.*$/i, '').trim() || 'the instrument');
      return { reference, resolved: false, provision: null, ruleKeys: [],
        reason: `${instrumentName} is ingested here as ${candidates.length} source${candidates.length === 1 ? '' : 's'}, `
          + `but no ingested provision is section ${section}.` };
    }
    return {
      reference, resolved: true,
      provision: {
        id: target.id, sectionNumber: target.sectionNumber, heading: target.heading,
        citation: source.citation, sourceType: source.sourceType, sourceUrl: source.sourceUrl,
      },
      ruleKeys: provisionRules.filter((r) => r.provisionId === target.id && r.active).map((r) => r.ruleKey),
      reason: null,
    };
  });
}

/** Every active rule version's dependencies, resolved, with the version's dates (the `cites` links, ruleLinks.ts). */
export function resolveBookDependencies(db: AppDatabase, params: { companyId: string }): Array<ResolvedDependency & {
  ruleKey: string; effectiveFrom: string; effectiveTo: string | null;
}> {
  const ctx = bookContext(db, params.companyId);
  return db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.active, true))).all()
    .filter((r) => r.crossReferences.length > 0)
    .flatMap((rule) => resolveReferences(db, rule, ctx).map((dep) => ({
      ...dep, ruleKey: rule.ruleKey, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo,
    })));
}

/** Every active rule's dependencies, resolved, for the audit report. */
export function resolveAllRuleDependencies(db: AppDatabase, params: { companyId: string }): Array<{
  ruleKey: string; reference: string; resolved: boolean; reason: string | null;
}> {
  return resolveBookDependencies(db, params)
    .map((d) => ({ ruleKey: d.ruleKey, reference: d.reference, resolved: d.resolved, reason: d.reason }));
}

/**
 * Links between statutory rules (ADR-0020 §3, issue #686 step 1).
 *
 * `irish_rule_links` records how one rule relies on another, so "what does
 * this rule rely on?" and "what relies on this rule?" are queries rather than
 * a search through TypeScript. This module declares the curated links, writes
 * them into a book (`syncRuleLinks`, run by `loadStatutoryKnowledgeBase`), and
 * reads them back in either direction.
 *
 * Step 1 loads the links the curation already states as data:
 *
 *   - `silenced_by`: an advisory rule and the rule that settles its question
 *     (`ADVISORY_RULES`, issue #208);
 *   - `excludes`: a VATCA s.60(2)(a) blocked category and the general s.59
 *     deduction it overrides (`resolveDeductionExclusivity`, issue #143).
 *
 * The code still reads those constants. Step 2 moves the readers onto the
 * links, and adds the Schedule 3 `rate_from` links, the VAT-rate exclusivity
 * group and the resolved citations.
 */
import { and, eq, or, isNull, gt, lte, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishRuleLinks, type IrishRuleLinkKind } from '@/db/schema';
import { ids } from '@/lib/ids';
import { isIsoDate, nowIso } from '../dates';
import { ADVISORY_RULES } from './advisoryRules';
import { VAT_GENERAL_DEDUCTION_RULE_KEY, VAT_DEDUCTION_EXCLUSION_RULE_KEYS } from './vatcaCuration';

/**
 * The start date of a link that adds no date of its own: it holds whenever
 * both rules are in force, and the rules' own effective dates bound it.
 */
export const LINK_FROM_RULES = '0001-01-01';

export interface CuratedRuleLink {
  fromKey: string;
  kind: IrishRuleLinkKind;
  toKey: string;
  effectiveFrom: string;
  /** Exclusive, like a rule's `effectiveTo`. Null while the link holds. */
  effectiveTo: string | null;
  note: string;
}

const SOURCE_NOTE = 'Curated rule link (ADR-0020; src/domain/rules/ruleLinks.ts).';

export const CURATED_RULE_LINKS: CuratedRuleLink[] = [
  ...ADVISORY_RULES.flatMap((a) => a.silencedBy.map((toKey) => ({
    fromKey: a.ruleKey,
    kind: 'silenced_by' as const,
    toKey,
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: null,
    note: 'The advisory is dropped when this rule also matches: it settles the question the advisory raises (issue #208).',
  }))),
  ...VAT_DEDUCTION_EXCLUSION_RULE_KEYS.map((fromKey) => ({
    fromKey,
    kind: 'excludes' as const,
    toKey: VAT_GENERAL_DEDUCTION_RULE_KEY,
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: null,
    note: 'A blocked category under VATCA 2010 s.60(2)(a) overrides the general s.59 deduction (issue #143).',
  })),
];

/** Fields that identify a link. A change to any of them is a new link, never an edit. */
const identity = (l: {
  fromKey: string; kind: string; toKey: string | null; effectiveFrom: string; effectiveTo: string | null; note: string | null;
}) => JSON.stringify([l.fromKey, l.kind, l.toKey, l.effectiveFrom, l.effectiveTo, l.note]);

export interface RuleLinkSyncResult {
  inserted: number;
  /** Links the curation no longer states, set inactive (never deleted). */
  withdrawn: number;
  /** Withdrawn links the curation states again. */
  restored: number;
}

/**
 * Bring a book's curated links in line with `links`. Idempotent: an unchanged
 * link is left alone. A curated link is never edited or deleted. One the
 * curation stops stating is set `active = false`, and a changed one is a new
 * row beside the withdrawn old one, so what a rule relied on stays on record.
 * Only `system` links are touched; a person's own links are theirs.
 */
export function syncRuleLinks(
  db: AppDatabase,
  params: { companyId: string; links?: CuratedRuleLink[] },
): RuleLinkSyncResult {
  const links = params.links ?? CURATED_RULE_LINKS;
  const wanted = new Map(links.map((l) => [identity(l), l]));
  if (wanted.size !== links.length) throw new Error('syncRuleLinks: the curated links contain a duplicate.');

  const existing = db.select().from(irishRuleLinks)
    .where(and(eq(irishRuleLinks.companyId, params.companyId), eq(irishRuleLinks.source, 'system')))
    .all();
  const result: RuleLinkSyncResult = { inserted: 0, withdrawn: 0, restored: 0 };
  const seen = new Set<string>();

  for (const row of existing) {
    const key = identity(row);
    if (wanted.has(key)) {
      seen.add(key);
      if (!row.active) {
        db.update(irishRuleLinks).set({ active: true, updatedAt: nowIso() })
          .where(eq(irishRuleLinks.id, row.id)).run();
        result.restored += 1;
      }
    } else if (row.active) {
      db.update(irishRuleLinks).set({ active: false, updatedAt: nowIso() })
        .where(eq(irishRuleLinks.id, row.id)).run();
      result.withdrawn += 1;
    }
  }

  for (const [key, l] of wanted) {
    if (seen.has(key)) continue;
    db.insert(irishRuleLinks).values({
      id: ids.ruleLink(),
      companyId: params.companyId,
      fromKey: l.fromKey,
      kind: l.kind,
      toKey: l.toKey,
      note: l.note,
      effectiveFrom: l.effectiveFrom,
      effectiveTo: l.effectiveTo,
      source: 'system',
      provenanceStatus: 'system_rule',
      sourceNote: SOURCE_NOTE,
    }).run();
    result.inserted += 1;
  }
  return result;
}

export type RuleLink = typeof irishRuleLinks.$inferSelect;

interface LinkQuery {
  companyId: string;
  ruleKey: string;
  /** Only links in force on this date. Omitted: every active link, whatever its dates. */
  asOfDate?: string;
  kinds?: IrishRuleLinkKind[];
}

function linkFilters(q: LinkQuery) {
  if (q.asOfDate !== undefined && !isIsoDate(q.asOfDate)) {
    throw new Error(`Invalid as-of date "${q.asOfDate}" for rule links.`);
  }
  return [
    eq(irishRuleLinks.companyId, q.companyId),
    eq(irishRuleLinks.active, true),
    ...(q.kinds ? [inArray(irishRuleLinks.kind, q.kinds)] : []),
    ...(q.asOfDate !== undefined ? [
      lte(irishRuleLinks.effectiveFrom, q.asOfDate),
      or(isNull(irishRuleLinks.effectiveTo), gt(irishRuleLinks.effectiveTo, q.asOfDate)),
    ] : []),
  ];
}

/** What `ruleKey` relies on: its outgoing links. */
export function ruleLinksFrom(db: AppDatabase, q: LinkQuery): RuleLink[] {
  return db.select().from(irishRuleLinks)
    .where(and(eq(irishRuleLinks.fromKey, q.ruleKey), ...linkFilters(q)))
    .orderBy(irishRuleLinks.kind, irishRuleLinks.toKey, irishRuleLinks.effectiveFrom)
    .all();
}

/** What relies on `ruleKey`: the links pointing at it. */
export function ruleLinksTo(db: AppDatabase, q: LinkQuery): RuleLink[] {
  return db.select().from(irishRuleLinks)
    .where(and(eq(irishRuleLinks.toKey, q.ruleKey), ...linkFilters(q)))
    .orderBy(irishRuleLinks.kind, irishRuleLinks.fromKey, irishRuleLinks.effectiveFrom)
    .all();
}

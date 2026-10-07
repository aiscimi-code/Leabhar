/**
 * Links between statutory rules (ADR-0020 §3, issue #686).
 *
 * `irish_rule_links` records how one rule relies on another, so "what does
 * this rule rely on?" and "what relies on this rule?" are queries rather than
 * a search through TypeScript. A relationship between rules is declared here,
 * once, and nowhere else: the code that acts on it reads it from here, and
 * `syncRuleLinks` (run by `deriveStatutoryKnowledgeBase`) writes the same
 * links into the rules store when it is built, where the graph checks, the
 * impact query and the rule page read them.
 *
 * The code reads the declared links rather than the table, so a store built
 * before a link was declared answers the same as one built after it; the
 * table is what the curation declared, as of the store's build.
 *
 * Declared here:
 *
 *   - `silenced_by`: an advisory rule and the rule that settles its question
 *     (issue #208; read by `advisoryReasons`);
 *   - `excludes`: a VATCA s.60(2)(a) blocked category over the general s.59
 *     deduction (issue #143), and the standard-rate fallback over the other
 *     headline rate facts (issue #136); read by `lookupTransactionRules`;
 *   - `rate_from`: a Schedule 3 rule and the s.46 rate rule its paragraph
 *     bears on each date (issue #205; read by the Schedule 3 binding);
 *   - `consumed_by`: a rule and each computation that reads it, from the
 *     computations' manifests (consumers.ts), so `impact` reaches them;
 *   - `supersedes`: merges, splits, renames and carve-outs between keys
 *     (supersessions.ts). A new version of one key is not a link: its
 *     `supersedesRuleId` chains it to the version before.
 *
 * Derived from the book at load (`bookDerivedLinks`):
 *
 *   - `excludes`: every VAT rate rule with real conditions over each
 *     empty-condition rate rule, the "determination beats a headline fact"
 *     half of VAT-rate exclusivity, which turns on the rules' own conditions;
 *   - `cites`: each rule's resolved cross-references, to the provision
 *     (`resolveRuleDependencies`). Unresolved ones stay audit findings.
 */
import { and, eq, or, isNull, gt, lte, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishRuleLinks, irishTaxRules, visibleRuleLinks, type IrishRuleLinkKind } from '@/db/schema';
import { ids } from '@/lib/ids';
import { addDays, asIsoDate, isIsoDate, nowIso } from '../dates';
import { DOMESTIC_RC_ADVISORY_RULE_KEYS, RC_CONSTRUCTION_RULE_KEY } from './domesticReverseChargeCuration';
import { VAT_GENERAL_DEDUCTION_RULE_KEY, VAT_DEDUCTION_EXCLUSION_RULE_KEYS } from './vatcaCuration';
import { VAT_STANDARD_RATE_FALLBACK_RULE_KEY, VATCA_REVISED_CURATED_RULES } from './vatcaRevisedCuration';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import {
  CA_LIST_KNOWN_FROM, SECOND_REDUCED_WINDOWS, scheduleThreeRate, scheduleThreeGap, withinReference, type ScheduleRate,
} from './scheduleRates';
import { resolveBookDependencies } from './dependencies';
import { RULE_CONSUMERS, TOPIC_RULE_CONSUMERS, consumerId, type RuleConsumer, type TopicRuleConsumer } from './consumers';
import { LOOKUP_TOPICS } from './transactionLookup';
import { VAT_SUGGESTION_RULE_KEYS } from './vatSuggestion';
import { SUPERSESSIONS } from './supersessions';

/**
 * The start date of a link that adds no date of its own: it holds whenever
 * both rules are in force, and the rules' own effective dates bound it.
 */
export const LINK_FROM_RULES = '0001-01-01';

export interface CuratedRuleLink {
  fromKey: string;
  kind: IrishRuleLinkKind;
  /** The rule linked to. Null when the link is to a provision (`cites`). */
  toKey: string | null;
  /** The provision linked to, for `cites`. Book-specific, so only derived links carry one. */
  toProvisionId?: string | null;
  effectiveFrom: string;
  /** Exclusive, like a rule's `effectiveTo`. Null while the link holds. */
  effectiveTo: string | null;
  /** For `rate_from`, the provision that sets the rate, e.g. "VATCA 2010 s.46(1)(caa)". */
  note: string;
}

const SOURCE_NOTE = 'Curated rule link (ADR-0020; src/domain/rules/ruleLinks.ts).';

/** The empty-condition VAT rate rule the standard-rate fallback excludes (issue #136 bug 1). */
export const HEADLINE_VAT_RATE_RULE_KEYS = [VAT_STANDARD_RATE_FALLBACK_RULE_KEY, 'vat.rate_reduced_current'];

/**
 * The s.46 rule a Schedule 3 sub-paragraph takes the reduced rate from, where
 * it has its own dated family (vatcaRevisedCuration.ts); otherwise
 * `vat.rate_reduced_current`.
 */
const REDUCED_RATE_FAMILY: Record<string, string> = {
  '3(1)': 'vat.rate_hospitality',
  '3(3)': 'vat.rate_hospitality',
  '13(3)': 'vat.rate_hairdressing',
};

/** The s.46 rule a Schedule 3 paragraph bears on a date, and the provision that sets it, or null. */
function scheduleRateTarget(ref: string, onDate: string): { toKey: string; provision: string } | null {
  const rate = scheduleThreeRate(ref, onDate);
  if (rate.code === null) return null;
  if (rate.code === 'IE_RED') {
    const family = Object.entries(REDUCED_RATE_FAMILY).find(([listed]) => withinReference(ref, listed));
    return { toKey: family?.[1] ?? 'vat.rate_reduced_current', provision: rate.provision };
  }
  for (const w of SECOND_REDUCED_WINDOWS) {
    if (onDate < w.from || (w.to !== null && onDate > w.to)) continue;
    const listed = w.refs.find((l) => withinReference(ref, l));
    if (listed) {
      const toKey = w.rateKeys[listed];
      if (!toKey) throw new Error(`No s.46 rate rule is named for Schedule 3 paragraph ${listed} under ${w.provision}.`);
      return { toKey, provision: w.provision };
    }
  }
  throw new Error(`scheduleThreeRate gave ${ref} the second reduced rate on ${onDate}, but no window lists it.`);
}

/**
 * The dates on which some Schedule 3 paragraph's rate can change: each window's
 * first day, the day after its last, and the day the (ca) list is first known.
 */
const RATE_BOUNDARIES = [...new Set([
  CA_LIST_KNOWN_FROM,
  ...SECOND_REDUCED_WINDOWS.flatMap((w) => [w.from, ...(w.to ? [addDays(asIsoDate(w.to), 1) as string] : [])]),
])].sort();

/** The dated `rate_from` links of one Schedule 3 rule: one per stretch with the same rate rule and provision. */
function scheduleRateLinks(ruleKey: string, ref: string): CuratedRuleLink[] {
  const starts = [LINK_FROM_RULES, ...RATE_BOUNDARIES];
  const links: CuratedRuleLink[] = [];
  starts.forEach((from, i) => {
    const target = scheduleRateTarget(ref, from);
    const to = starts[i + 1] ?? null;
    const last = links.at(-1);
    if (last && target && last.effectiveTo === from && last.toKey === target.toKey && last.note === target.provision) {
      last.effectiveTo = to;
      return;
    }
    if (target) links.push({ fromKey: ruleKey, kind: 'rate_from', toKey: target.toKey, effectiveFrom: from, effectiveTo: to, note: target.provision });
  });
  return links;
}

export const CURATED_RULE_LINKS: CuratedRuleLink[] = [
  ...DOMESTIC_RC_ADVISORY_RULE_KEYS.map((fromKey) => ({
    fromKey,
    kind: 'silenced_by' as const,
    toKey: RC_CONSTRUCTION_RULE_KEY,
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: null,
    note: 'The advisory is dropped when this rule also matches: it settles the question the advisory raises (issue #208).',
  })),
  ...VAT_DEDUCTION_EXCLUSION_RULE_KEYS.map((fromKey) => ({
    fromKey,
    kind: 'excludes' as const,
    toKey: VAT_GENERAL_DEDUCTION_RULE_KEY,
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: null,
    note: 'A blocked category under VATCA 2010 s.60(2)(a) overrides the general s.59 deduction (issue #143).',
  })),
  ...HEADLINE_VAT_RATE_RULE_KEYS.filter((k) => k !== VAT_STANDARD_RATE_FALLBACK_RULE_KEY).map((toKey) => ({
    fromKey: VAT_STANDARD_RATE_FALLBACK_RULE_KEY,
    kind: 'excludes' as const,
    toKey,
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: null,
    note: 'Absent a more specific rate rule, only the standard rate is kept: an unconditioned rate fact is not '
      + 'evidence a supply is within that rate\'s category (VATCA 2010 s.46(1); issue #136).',
  })),
  ...VATCA_SCHEDULE_CURATED_RULES
    .filter((r) => r.scheduleNumber === '3' && (r.rateRefs ?? []).length > 0)
    .flatMap((r) => scheduleRateLinks(r.ruleKey, r.rateRefs![0]!)),
  ...(Object.keys(RULE_CONSUMERS) as RuleConsumer[]).flatMap((consumer) => RULE_CONSUMERS[consumer].keys.map((fromKey) => ({
    fromKey,
    kind: 'consumed_by' as const,
    toKey: consumerId(consumer),
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: null,
    note: `Read by ${RULE_CONSUMERS[consumer].name} (${RULE_CONSUMERS[consumer].modules.join(', ')}).`,
  }))),
  ...SUPERSESSIONS.flatMap((s) => s.newKeys.flatMap((fromKey) => s.oldKeys.map((toKey) => ({
    fromKey,
    kind: 'supersedes' as const,
    toKey,
    effectiveFrom: s.from ?? LINK_FROM_RULES,
    effectiveTo: null,
    note: `${s.shape.replace('_', '-')}${s.whole ? '' : ', in part'}: ${s.note}`,
  })))),
];

/** The declared links matching a query, the way the code that acts on them reads them. */
function declared(match: (l: CuratedRuleLink) => boolean, q: { asOfDate?: string; kinds?: IrishRuleLinkKind[] }) {
  if (q.asOfDate !== undefined && !isIsoDate(q.asOfDate)) {
    throw new Error(`Invalid as-of date "${q.asOfDate}" for rule links.`);
  }
  return CURATED_RULE_LINKS.filter((l) => match(l)
    && (!q.kinds || q.kinds.includes(l.kind))
    && (q.asOfDate === undefined || (l.effectiveFrom <= q.asOfDate && (l.effectiveTo === null || l.effectiveTo > q.asOfDate))));
}

/** What `ruleKey` relies on, as declared. */
export function declaredLinksFrom(ruleKey: string, q: { asOfDate?: string; kinds?: IrishRuleLinkKind[] } = {}): CuratedRuleLink[] {
  return declared((l) => l.fromKey === ruleKey, q);
}

/** What relies on `ruleKey`, as declared. */
export function declaredLinksTo(ruleKey: string, q: { asOfDate?: string; kinds?: IrishRuleLinkKind[] } = {}): CuratedRuleLink[] {
  return declared((l) => l.toKey === ruleKey, q);
}

/**
 * The rate a Schedule 3 rule bears on a date: the rate stated by the s.46 rule
 * it takes its rate from (`rate_from`), in force on that date. No link in
 * force means the sources cannot say (`scheduleThreeGap`); `ref` is the
 * rule's first sub-paragraph, for that message.
 */
export function scheduleRuleRate(ruleKey: string, ref: string, onDate: string): ScheduleRate {
  const link = declaredLinksFrom(ruleKey, { kinds: ['rate_from'], asOfDate: onDate })[0];
  if (!link?.toKey) return scheduleThreeGap(ref);
  const rate = VATCA_REVISED_CURATED_RULES.find((v) => v.ruleKey === link.toKey
    && v.effectiveFrom <= onDate && (v.effectiveTo === null || v.effectiveTo > onDate));
  const code = rate?.numericValue === 9 ? 'IE_SECOND_RED' : rate?.numericValue === 13.5 ? 'IE_RED' : null;
  if (!code) {
    return {
      code: null,
      provision: link.note,
      gap: `${link.toKey}, the rule paragraph ${ref} takes its rate from, states no 9% or 13.5% rate on ${onDate}.`,
    };
  }
  return { code, provision: link.note };
}

/**
 * The links that turn on what a book holds: the conditioned-over-headline half
 * of VAT-rate exclusivity, and each rule's resolved citations.
 */
export function bookDerivedLinks(db: AppDatabase, params: { companyId: string }): CuratedRuleLink[] {
  const rateRules = db.select({ ruleKey: irishTaxRules.ruleKey, conditions: irishTaxRules.conditions })
    .from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.active, true),
      eq(irishTaxRules.topic, 'vat'), eq(irishTaxRules.ruleType, 'rate')))
    .all();
  const headline = [...new Set(rateRules.filter((r) => r.conditions.length === 0).map((r) => r.ruleKey))].sort();
  const conditioned = [...new Set(rateRules.filter((r) => r.conditions.length > 0).map((r) => r.ruleKey))].sort();
  const rateLinks = conditioned.flatMap((fromKey) => headline.filter((toKey) => toKey !== fromKey).map((toKey) => ({
    fromKey,
    kind: 'excludes' as const,
    toKey,
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: null,
    note: 'A rate rule with real conditions that matched is a determination; it excludes a bare "this rate exists" '
      + 'fact (VATCA 2010 s.46(1); issue #136).',
  })));

  // The readers by topic (#694): the lookup reads every rule of a topic it
  // routes to; the suggestion acts on the keys its tables name.
  const held = db.select({ ruleKey: irishTaxRules.ruleKey, topic: irishTaxRules.topic,
    effectiveFrom: irishTaxRules.effectiveFrom, effectiveTo: irishTaxRules.effectiveTo })
    .from(irishTaxRules).where(eq(irishTaxRules.companyId, params.companyId)).all()
    .filter((r) => r.effectiveTo === null || r.effectiveTo > r.effectiveFrom);
  const topics = new Set(LOOKUP_TOPICS);
  const readBy = (consumer: TopicRuleConsumer, keys: Iterable<string>): CuratedRuleLink[] => [...new Set(keys)].sort().map((fromKey) => ({
    fromKey,
    kind: 'consumed_by' as const,
    toKey: consumerId(consumer),
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: null,
    note: `Read by ${TOPIC_RULE_CONSUMERS[consumer].name} (${TOPIC_RULE_CONSUMERS[consumer].modules.join(', ')}).`,
  }));
  const heldKeys = new Set(held.map((r) => r.ruleKey));
  const topicLinks = [
    ...readBy('transaction_lookup', held.filter((r) => topics.has(r.topic)).map((r) => r.ruleKey)),
    ...readBy('vat_suggestion', VAT_SUGGESTION_RULE_KEYS.filter((k) => heldKeys.has(k))),
  ];

  const seen = new Set<string>();
  const citeLinks: CuratedRuleLink[] = [];
  for (const dep of resolveBookDependencies(db, params)) {
    if (!dep.resolved || !dep.provision) continue;
    const link: CuratedRuleLink = {
      fromKey: dep.ruleKey,
      kind: 'cites',
      toKey: null,
      toProvisionId: dep.provision.id,
      effectiveFrom: dep.effectiveFrom,
      effectiveTo: dep.effectiveTo,
      note: dep.reference,
    };
    const key = identity(link);
    if (!seen.has(key)) { seen.add(key); citeLinks.push(link); }
  }
  return [...rateLinks, ...topicLinks, ...citeLinks];
}

/** Fields that identify a link. A change to any of them is a new link, never an edit. */
function identity(l: {
  fromKey: string; kind: string; toKey: string | null; toProvisionId?: string | null;
  effectiveFrom: string; effectiveTo: string | null; note: string | null;
}): string {
  return JSON.stringify([l.fromKey, l.kind, l.toKey, l.toProvisionId ?? null, l.effectiveFrom, l.effectiveTo, l.note]);
}

export interface RuleLinkSyncResult {
  inserted: number;
  /** Links the curation no longer states, set inactive (never deleted). */
  withdrawn: number;
  /** Withdrawn links the curation states again. */
  restored: number;
}

/**
 * Bring a book's curated links in line with `links` (by default, the declared
 * links and those derived from the book). Idempotent: an unchanged
 * link is left alone. A curated link is never edited or deleted. One the
 * curation stops stating is set `active = false`, and a changed one is a new
 * row beside the withdrawn old one, so what a rule relied on stays on record.
 * Only `system` links are touched; a person's own links are theirs.
 */
export function syncRuleLinks(
  db: AppDatabase,
  params: { companyId: string; links?: CuratedRuleLink[] },
): RuleLinkSyncResult {
  const links = params.links ?? [...CURATED_RULE_LINKS, ...bookDerivedLinks(db, params)];
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
      toProvisionId: l.toProvisionId ?? null,
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

export type RuleLink = typeof visibleRuleLinks.$inferSelect;

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
    eq(visibleRuleLinks.companyId, q.companyId),
    eq(visibleRuleLinks.active, true),
    ...(q.kinds ? [inArray(visibleRuleLinks.kind, q.kinds)] : []),
    ...(q.asOfDate !== undefined ? [
      lte(visibleRuleLinks.effectiveFrom, q.asOfDate),
      or(isNull(visibleRuleLinks.effectiveTo), gt(visibleRuleLinks.effectiveTo, q.asOfDate)),
    ] : []),
  ];
}

/** What `ruleKey` relies on: its outgoing links. */
export function ruleLinksFrom(db: AppDatabase, q: LinkQuery): RuleLink[] {
  return db.select().from(visibleRuleLinks)
    .where(and(eq(visibleRuleLinks.fromKey, q.ruleKey), ...linkFilters(q)))
    .orderBy(visibleRuleLinks.kind, visibleRuleLinks.toKey, visibleRuleLinks.effectiveFrom)
    .all();
}

/** What relies on `ruleKey`: the links pointing at it. */
export function ruleLinksTo(db: AppDatabase, q: LinkQuery): RuleLink[] {
  return db.select().from(visibleRuleLinks)
    .where(and(eq(visibleRuleLinks.toKey, q.ruleKey), ...linkFilters(q)))
    .orderBy(visibleRuleLinks.kind, visibleRuleLinks.fromKey, visibleRuleLinks.effectiveFrom)
    .all();
}

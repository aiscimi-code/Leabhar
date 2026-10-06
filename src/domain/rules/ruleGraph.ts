/**
 * Graph checks over a book's rules and their links (ADR-0020 §5, issue #686
 * step 3). `ruleGraph.test.ts` runs them on a freshly loaded book, so the
 * gate fails when the curation:
 *
 *   - links to a rule key the book does not hold (`dangling`);
 *   - has an in-force rule relying on a key with no version in force over
 *     the same dates (`uncovered`);
 *   - leaves a gap or an overlap between one key's versions (`gap`,
 *     `overlap`), other than a gap the sources leave, declared with its
 *     reason in `DECLARED_VERSION_GAPS`;
 *   - has rules relying on each other in a circle (`cycle`).
 *
 * A computation's manifest (`consumed_by`) must name keys the book holds and a
 * declared consumer.
 *
 * Exclusions (`excludes`) and silencing (`silenced_by`) are not reliance: a
 * rule that excludes one no longer in force simply excludes nothing, so they
 * are checked for dangling keys and cycles only.
 */
import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishRuleLinks, irishTaxRules, type IrishRuleLinkKind } from '@/db/schema';
import { CA_LIST_KNOWN_FROM } from './scheduleRates';
import { RULE_CONSUMERS, consumerId, type RuleConsumer } from './consumers';

export type RuleGraphFindingKind = 'dangling' | 'uncovered' | 'gap' | 'overlap' | 'cycle';

export interface RuleGraphFinding {
  kind: RuleGraphFindingKind;
  ruleKey: string;
  detail: string;
}

/** Links through which one rule relies on another's being in force. */
export const RELIANCE_KINDS: IrishRuleLinkKind[] = ['uses_value', 'rate_from', 'supersedes'];

const OPEN_END = '9999-12-31';

/**
 * Gaps the sources leave, declared with the reason, so the check can tell
 * them from a version left out by mistake. Each must match a gap exactly.
 */
export const DECLARED_VERSION_GAPS: Array<{ ruleKey: string; from: string; to: string; reason: string }> = [
  ...['vat.rate_hospitality', 'vat.rate_hairdressing'].map((ruleKey) => ({
    ruleKey, from: '2023-09-01', to: CA_LIST_KNOWN_FROM,
    reason: 'Between the end of the 2020-2023 9% clause and 1 January 2025 the s.46(1)(ca) list is not in the '
      + 'repository, so the rate cannot be confirmed from the sources (scheduleRates.ts).',
  })),
];

interface Span { from: string; to: string }

const end = (to: string | null) => to ?? OPEN_END;

/** The parts of `want` that `have` (sorted, possibly overlapping) does not cover. */
export function uncoveredSpans(want: Span, have: Span[]): Span[] {
  const out: Span[] = [];
  let at = want.from;
  for (const h of [...have].sort((a, b) => a.from.localeCompare(b.from))) {
    if (h.to <= at) continue;
    if (h.from >= want.to) break;
    if (h.from > at) out.push({ from: at, to: h.from });
    at = h.to > at ? h.to : at;
    if (at >= want.to) break;
  }
  if (at < want.to) out.push({ from: at, to: want.to });
  return out;
}

const showSpan = (s: Span) => `${s.from} to ${s.to === OPEN_END ? 'open' : s.to}`;

export function checkRuleGraph(db: AppDatabase, params: { companyId: string }): RuleGraphFinding[] {
  const findings: RuleGraphFinding[] = [];
  const versions = db.select({
    ruleKey: irishTaxRules.ruleKey, ruleVersion: irishTaxRules.ruleVersion,
    effectiveFrom: irishTaxRules.effectiveFrom, effectiveTo: irishTaxRules.effectiveTo,
  }).from(irishTaxRules)
    // In force for its own dates, as `lookupTaxRule` reads it: enabled, not
    // retired on review, and a non-empty window. `active` marks only the
    // latest version; a superseded one still holds for its own window.
    .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.enabled, true),
      ne(irishTaxRules.reviewStatus, 'superseded')))
    .all()
    .filter((v) => v.effectiveTo === null || v.effectiveTo > v.effectiveFrom);
  const spansByKey = new Map<string, Array<Span & { version: number }>>();
  for (const v of versions) {
    const list = spansByKey.get(v.ruleKey) ?? [];
    list.push({ from: v.effectiveFrom, to: end(v.effectiveTo), version: v.ruleVersion });
    spansByKey.set(v.ruleKey, list);
  }

  // One key's versions: in date order, each ends where the next begins.
  for (const [ruleKey, spans] of spansByKey) {
    const sorted = [...spans].sort((a, b) => a.from.localeCompare(b.from) || a.version - b.version);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const next = sorted[i]!;
      const declared = DECLARED_VERSION_GAPS.some((g) => g.ruleKey === ruleKey && g.from === prev.to && g.to === next.from);
      if (prev.to < next.from && !declared) {
        findings.push({ kind: 'gap', ruleKey, detail: `No version in force from ${prev.to} to ${next.from} (between v${prev.version} and v${next.version}).` });
      } else if (prev.to > next.from) {
        findings.push({ kind: 'overlap', ruleKey, detail: `v${prev.version} (${showSpan(prev)}) overlaps v${next.version} (${showSpan(next)}).` });
      }
    }
  }

  const links = db.select().from(irishRuleLinks)
    .where(and(eq(irishRuleLinks.companyId, params.companyId), eq(irishRuleLinks.active, true)))
    .all();

  const consumers = new Set((Object.keys(RULE_CONSUMERS) as RuleConsumer[]).map(consumerId));
  for (const l of links) {
    if (l.kind === 'consumed_by') {
      if (!spansByKey.has(l.fromKey)) {
        findings.push({ kind: 'dangling', ruleKey: l.fromKey, detail: `${l.toKey} declares it reads ${l.fromKey}, which this book does not hold in force.` });
      }
      if (l.toKey === null || !consumers.has(l.toKey)) {
        findings.push({ kind: 'dangling', ruleKey: l.fromKey, detail: `A consumed_by link names ${l.toKey}, which is not a declared consumer.` });
      }
      continue;
    }
    for (const key of [l.fromKey, l.toKey]) {
      if (key !== null && !spansByKey.has(key)) {
        findings.push({ kind: 'dangling', ruleKey: l.fromKey, detail: `A ${l.kind} link names ${key}, which this book does not hold in force.` });
      }
    }
    if (l.toKey === null || !RELIANCE_KINDS.includes(l.kind)) continue;
    const target = spansByKey.get(l.toKey);
    if (!target) continue;
    const linkSpan = { from: l.effectiveFrom, to: end(l.effectiveTo) };
    for (const v of spansByKey.get(l.fromKey) ?? []) {
      const want = { from: v.from > linkSpan.from ? v.from : linkSpan.from, to: v.to < linkSpan.to ? v.to : linkSpan.to };
      if (want.from >= want.to) continue;
      for (const hole of uncoveredSpans(want, target)) {
        findings.push({
          kind: 'uncovered', ruleKey: l.fromKey,
          detail: `v${v.version} relies on ${l.toKey} (${l.kind}), which has no version in force ${showSpan(hole)}.`,
        });
      }
    }
  }

  // A circle of rules relying on, excluding or silencing one another.
  const edges = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.toKey === null || l.kind === 'consumed_by') continue;
    edges.set(l.fromKey, (edges.get(l.fromKey) ?? new Set()).add(l.toKey));
  }
  const state = new Map<string, 'open' | 'done'>();
  const visit = (key: string, path: string[]) => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'open') {
      const loop = path.slice(path.indexOf(key));
      findings.push({ kind: 'cycle', ruleKey: key, detail: `${[...loop, key].join(' → ')}.` });
      return;
    }
    state.set(key, 'open');
    for (const next of edges.get(key) ?? []) visit(next, [...path, key]);
    state.set(key, 'done');
  };
  for (const key of [...edges.keys()].sort()) visit(key, []);

  return findings;
}

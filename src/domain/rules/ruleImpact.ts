/**
 * What relies on a rule or provision, and what a rule relies on (ADR-0020
 * §6, issue #686 step 4).
 *
 * `ruleImpact` answers "what is affected if X changes?": every rule linking
 * to the target, then every rule linking to those, and so on, each with the
 * link it was reached through. For a provision the first ring is the rules
 * derived from it and the rules that cite it. `ruleDepends` is the reverse
 * walk. Both read the book's `irish_rule_links`, so they see what the
 * curation declared as of the book's last load.
 *
 * The computations reading the target or anything reached (`consumed_by`,
 * from their manifests) are listed beside the rules, so the answer includes
 * the returns and computations a change reaches.
 *
 * Every link kind counts: a rule that excludes, silences or takes its rate
 * from X has to be looked at again when X changes, even where it turns out
 * not to move.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishActProvisions, irishKnowledgeSources, irishRuleLinks, irishTaxRules } from '@/db/schema';
import { resolveReference } from './dependencies';
import { consumerName } from './consumers';

export interface ImpactEdge {
  /** The rule reached. */
  ruleKey: string;
  /** Steps from the target: 1 is direct. */
  depth: number;
  /** How it was reached: a link kind, or `derived_from` for a rule derived from the target provision. */
  kind: string;
  /** The rule key or provision on the other end of that link. */
  through: string;
  note: string | null;
}

export type ImpactTarget =
  | { kind: 'rule'; ruleKey: string }
  | { kind: 'provision'; provisionId: string; citation: string };

export interface ImpactResult {
  target: ImpactTarget;
  /** In the order reached: nearest first, then by key. Each rule appears once, at its nearest depth. */
  affected: ImpactEdge[];
  /** The computations that read the target or an affected rule (`consumed_by`), and through which rules. */
  consumers: Array<{ consumer: string; name: string; ruleKeys: string[] }>;
}

function activeLinks(db: AppDatabase, companyId: string) {
  return db.select().from(irishRuleLinks)
    .where(and(eq(irishRuleLinks.companyId, companyId), eq(irishRuleLinks.active, true)))
    .all();
}

function provisionLabel(db: AppDatabase, provisionId: string): string {
  const row = db.select({ citation: irishKnowledgeSources.citation, section: irishActProvisions.sectionNumber })
    .from(irishActProvisions)
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(eq(irishActProvisions.id, provisionId)).get();
  return row ? `${row.citation} s.${row.section}` : provisionId;
}

/**
 * Name the target: a rule key the book holds, a provision id, or a reference
 * such as "VATCA 2010 s.46" resolved as a cross-reference would be. Throws
 * when it names none of these, rather than reporting an empty impact.
 */
export function resolveImpactTarget(db: AppDatabase, params: { companyId: string; target: string }): ImpactTarget {
  const { companyId, target } = params;
  const rule = db.select({ id: irishTaxRules.id }).from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, target))).get();
  if (rule) return { kind: 'rule', ruleKey: target };
  const provision = db.select({ id: irishActProvisions.id }).from(irishActProvisions)
    .where(eq(irishActProvisions.id, target)).get();
  if (provision) return { kind: 'provision', provisionId: provision.id, citation: provisionLabel(db, provision.id) };
  const resolved = resolveReference(db, { companyId, reference: target });
  if (resolved.resolved && resolved.provision) {
    return { kind: 'provision', provisionId: resolved.provision.id, citation: provisionLabel(db, resolved.provision.id) };
  }
  throw new Error(`"${target}" is not a rule key, provision id or resolvable reference in this book`
    + `${resolved.reason ? `: ${resolved.reason}` : '.'}`);
}

/** Everything that relies on the target, directly and transitively. */
export function ruleImpact(db: AppDatabase, params: { companyId: string; target: ImpactTarget }): ImpactResult {
  const links = activeLinks(db, params.companyId);
  const byTo = new Map<string, typeof links>();
  const consumedBy = new Map<string, string[]>();
  for (const l of links) {
    if (l.toKey === null) continue;
    if (l.kind === 'consumed_by') {
      consumedBy.set(l.fromKey, [...(consumedBy.get(l.fromKey) ?? []), l.toKey]);
      continue;
    }
    byTo.set(l.toKey, [...(byTo.get(l.toKey) ?? []), l]);
  }
  const seen = new Set<string>();
  const affected: ImpactEdge[] = [];
  let ring: ImpactEdge[] = [];

  const t = params.target;
  if (t.kind === 'rule') {
    seen.add(t.ruleKey);
    ring = (byTo.get(t.ruleKey) ?? []).map((l) => ({ ruleKey: l.fromKey, depth: 1, kind: l.kind, through: t.ruleKey, note: l.note }));
  } else {
    const derived = db.select({ ruleKey: irishTaxRules.ruleKey }).from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.provisionId, t.provisionId))).all();
    ring = [
      ...derived.map((r) => ({ ruleKey: r.ruleKey, depth: 1, kind: 'derived_from', through: t.citation, note: null })),
      ...links.filter((l) => l.toProvisionId === t.provisionId)
        .map((l) => ({ ruleKey: l.fromKey, depth: 1, kind: l.kind, through: t.citation, note: l.note })),
    ];
  }

  while (ring.length > 0) {
    const next: ImpactEdge[] = [];
    for (const edge of [...ring].sort((a, b) => a.ruleKey.localeCompare(b.ruleKey) || a.kind.localeCompare(b.kind))) {
      if (seen.has(edge.ruleKey)) continue;
      seen.add(edge.ruleKey);
      affected.push(edge);
      for (const l of byTo.get(edge.ruleKey) ?? []) {
        next.push({ ruleKey: l.fromKey, depth: edge.depth + 1, kind: l.kind, through: edge.ruleKey, note: l.note });
      }
    }
    ring = next;
  }

  const reached = new Map<string, Set<string>>();
  for (const key of [...(t.kind === 'rule' ? [t.ruleKey] : []), ...affected.map((e) => e.ruleKey)]) {
    for (const c of consumedBy.get(key) ?? []) reached.set(c, (reached.get(c) ?? new Set()).add(key));
  }
  const consumers = [...reached].sort(([a], [b]) => a.localeCompare(b)).map(([consumer, keys]) => {
    return { consumer, name: consumerName(consumer), ruleKeys: [...keys].sort() };
  });
  return { target: t, affected, consumers };
}

export interface DependsResult {
  ruleKey: string;
  /** Rules relied on, nearest first; each once, at its nearest depth. */
  rules: ImpactEdge[];
  /** Provisions relied on: the rule's own, and those it or a rule it relies on cites. */
  provisions: Array<{ provisionId: string; citation: string; kind: string; from: string }>;
}

/** Everything `ruleKey` relies on, directly and transitively. */
export function ruleDepends(db: AppDatabase, params: { companyId: string; ruleKey: string }): DependsResult {
  const links = activeLinks(db, params.companyId);
  const byFrom = new Map<string, typeof links>();
  for (const l of links) byFrom.set(l.fromKey, [...(byFrom.get(l.fromKey) ?? []), l]);

  const seen = new Set([params.ruleKey]);
  const rules: ImpactEdge[] = [];
  const provisions = new Map<string, DependsResult['provisions'][number]>();
  const ownProvisions = (key: string) => db.select({ provisionId: irishTaxRules.provisionId }).from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, key))).all();

  let ring: Array<{ key: string; depth: number }> = [{ key: params.ruleKey, depth: 0 }];
  while (ring.length > 0) {
    const next: Array<{ key: string; depth: number }> = [];
    for (const { key, depth } of ring) {
      for (const { provisionId } of ownProvisions(key)) {
        if (!provisions.has(provisionId)) {
          provisions.set(provisionId, { provisionId, citation: provisionLabel(db, provisionId), kind: 'derived_from', from: key });
        }
      }
      const out = [...(byFrom.get(key) ?? [])].sort((a, b) => (a.toKey ?? '').localeCompare(b.toKey ?? '') || a.kind.localeCompare(b.kind));
      for (const l of out) {
        if (l.kind === 'consumed_by') continue;
        if (l.toProvisionId && !provisions.has(l.toProvisionId)) {
          provisions.set(l.toProvisionId, { provisionId: l.toProvisionId, citation: provisionLabel(db, l.toProvisionId), kind: l.kind, from: key });
        }
        if (l.toKey === null || seen.has(l.toKey)) continue;
        seen.add(l.toKey);
        rules.push({ ruleKey: l.toKey, depth: depth + 1, kind: l.kind, through: key, note: l.note });
        next.push({ key: l.toKey, depth: depth + 1 });
      }
    }
    ring = next;
  }
  return { ruleKey: params.ruleKey, rules, provisions: [...provisions.values()] };
}

/** For each rule something relies on, how many rules rely on it directly and transitively; most first. */
export function mostReliedOn(db: AppDatabase, params: { companyId: string; limit?: number }): Array<{ ruleKey: string; affected: number }> {
  const links = activeLinks(db, params.companyId);
  const byTo = new Map<string, string[]>();
  for (const l of links) if (l.toKey !== null && l.kind !== 'consumed_by') byTo.set(l.toKey, [...(byTo.get(l.toKey) ?? []), l.fromKey]);
  const counts = [...byTo.keys()].map((ruleKey) => {
    const seen = new Set([ruleKey]);
    const queue = [...(byTo.get(ruleKey) ?? [])];
    while (queue.length > 0) {
      const k = queue.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(...(byTo.get(k) ?? []));
    }
    return { ruleKey, affected: seen.size - 1 };
  });
  return counts.sort((a, b) => b.affected - a.affected || a.ruleKey.localeCompare(b.ruleKey)).slice(0, params.limit ?? 10);
}

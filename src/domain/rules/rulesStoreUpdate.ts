/**
 * The check a book runs against every rules store it opens (ADR-0021 §5,
 * delivery step 4). It replaces "load statutory rules": a book no longer
 * loads rules, it reads the store the install shipped, and an update to that
 * store is checked here rather than taken silently.
 *
 * The book records every store it has opened in `rules_store_seen`, with the
 * content hash of each version the store held. On the first open of a store
 * whose signature differs from the last one recorded:
 *
 * - **Missing versions.** `checkCatalogueVersions` runs for every company. A
 *   version the book references that the store lacks becomes a review item.
 * - **Changed keys.** Each rule key whose versions differ between the two
 *   stores (a version added, a version saying something else, or a version
 *   gone) becomes a review item for every company (ADR-0020 §7). A release
 *   never changes or drops a shipped version (ADR-0021 §3), so in practice
 *   these are new versions; the other two are raised as warnings if they occur.
 *   When the earlier store's versions were not recorded (a book that last
 *   opened a store before this check existed), the change cannot be listed,
 *   and one review item per company says so.
 * - **The store seen.** The new signature is recorded with its versions.
 *
 * A book that has never opened a store has nothing to compare: its
 * references are checked and the store is recorded. Nothing is switched to
 * another version (AGENTS.md #7).
 */
import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, rulesStoreSeen } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { upsertReviewItem } from '../extraction/service';
import { checkCatalogueVersions } from './ruleDecisions';
import { storeVersionHashes } from './rulesStore';
import { RULES_STORE_SCHEMA, attachedRulesStoreMeta } from './visibleRules';

/** How one rule key differs between the store a book last opened and the one it opens now. */
export interface RuleKeyChange {
  ruleKey: string;
  /** Versions the new store holds that the earlier one did not. */
  added: number[];
  /** Versions both hold that say different things. */
  changed: number[];
  /** Versions the earlier store held that the new one does not. */
  removed: number[];
}

export interface RulesStoreUpdateResult {
  signature: string;
  /** The store the book last opened, or null when it had opened none. */
  previousSignature: string | null;
  /** Whether the earlier store's versions were on record, so its changes could be listed. */
  compared: boolean;
  changedKeys: RuleKeyChange[];
  /** Versions each company references that the store lacks (`checkCatalogueVersions`). */
  missing: Array<{ companyId: string; versionIds: string[] }>;
}

/**
 * Check the book against the store attached to it, if the book has not
 * checked itself against that store before. Returns null when it has, or
 * when no store is attached.
 */
export function checkRulesStoreUpdate(db: AppDatabase): RulesStoreUpdateResult | null {
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  const meta = attachedRulesStoreMeta(sqlite);
  if (!meta) return null;

  return db.transaction((tx) => {
    // Insertion order: the table is append-only, and a timestamp ties within a millisecond.
    const previous = tx.select().from(rulesStoreSeen).orderBy(sql`rowid DESC`).get();
    if (previous?.signature === meta.signature) return null;

    const book = tx.select({ id: companies.id }).from(companies).all();
    const versions = storeVersionHashes(sqlite, RULES_STORE_SCHEMA);
    const compared = previous?.versionHashes != null;
    const changedKeys = compared ? diffVersions(previous.versionHashes!, versions) : [];
    const dates = storeDates(sqlite);

    const missing: RulesStoreUpdateResult['missing'] = [];
    for (const { id: companyId } of book) {
      missing.push({ companyId, versionIds: checkCatalogueVersions(tx, { companyId }).map((m) => m.versionId) });
      if (previous && !compared) {
        upsertReviewItem(tx, {
          companyId,
          kind: 'other',
          severity: 'info',
          title: 'The rules store has changed since this book last opened it',
          detail: 'This version of Leabhar ships a different rules store from the one this book last opened, and the '
            + 'earlier version of Leabhar did not record which rule versions its store held, so the rules that changed '
            + 'cannot be listed. Every figure and suggestion from now on reads the new store; entries already posted '
            + 'keep the versions they applied. Any version this book refers to that the new store lacks is raised '
            + 'separately. Nothing was switched to another version.',
          entityType: 'rules_store',
          entityId: meta.signature,
          dedupeKey: `rules_store_update:${meta.signature}:unlisted`,
          context: { signature: meta.signature, previousSignature: previous.signature },
        });
      }
      for (const change of changedKeys) raiseKeyChange(tx, companyId, change, meta.signature, previous!.signature, dates);
    }

    tx.insert(rulesStoreSeen).values({
      id: ids.rulesStoreSeen(), signature: meta.signature, format: meta.format, catalogueDigest: meta.catalogueDigest,
      versions: meta.versions, versionHashes: Object.fromEntries(versions), seenAt: nowIso(),
    }).run();

    return { signature: meta.signature, previousSignature: previous?.signature ?? null, compared, changedKeys, missing };
  });
}

/** The keys whose versions differ between two stores' version hashes, by key. */
export function diffVersions(before: Record<string, string>, after: ReadonlyMap<string, string>): RuleKeyChange[] {
  const byKey = new Map<string, RuleKeyChange>();
  const of = (versionId: string) => {
    const at = versionId.lastIndexOf('@');
    const ruleKey = versionId.slice(0, at);
    const change = byKey.get(ruleKey) ?? byKey.set(ruleKey, { ruleKey, added: [], changed: [], removed: [] }).get(ruleKey)!;
    return { change, version: Number(versionId.slice(at + 1)) };
  };
  for (const [versionId, hash] of after) {
    if (!(versionId in before)) { const { change, version } = of(versionId); change.added.push(version); }
    else if (before[versionId] !== hash) { const { change, version } = of(versionId); change.changed.push(version); }
  }
  for (const versionId of Object.keys(before)) {
    if (!after.has(versionId)) { const { change, version } = of(versionId); change.removed.push(version); }
  }
  const byNumber = (a: number, b: number) => a - b;
  return [...byKey.values()]
    .map((c) => ({ ...c, added: c.added.sort(byNumber), changed: c.changed.sort(byNumber), removed: c.removed.sort(byNumber) }))
    .sort((a, b) => a.ruleKey.localeCompare(b.ruleKey));
}

type StoreDates = Map<string, { name: string; effectiveFrom: string; effectiveTo: string | null }>;

/** Each store version's name and dates, to say what an update added. */
function storeDates(sqlite: Database.Database): StoreDates {
  const rows = sqlite.prepare(`SELECT id, name, effective_from AS effectiveFrom, effective_to AS effectiveTo FROM ${RULES_STORE_SCHEMA}.irish_tax_rules`)
    .all() as Array<{ id: string; name: string; effectiveFrom: string; effectiveTo: string | null }>;
  return new Map(rows.map((r) => [r.id, r]));
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

function raiseKeyChange(tx: Tx, companyId: string, change: RuleKeyChange, signature: string, previousSignature: string, dates: StoreDates): void {
  const { ruleKey, added, changed, removed } = change;
  const id = (v: number) => `${ruleKey}@${v}`;
  const inForce = (v: number) => {
    const d = dates.get(id(v));
    return d ? `${id(v)} (in force from ${d.effectiveFrom}${d.effectiveTo ? ` to ${d.effectiveTo}` : ''})` : id(v);
  };
  const name = dates.get(id([...added, ...changed][0] ?? 0))?.name;
  const parts = [
    ...(added.length > 0 ? [`adds ${added.map(inForce).join(', ')}`] : []),
    ...(changed.length > 0 ? [`changes what ${changed.map(id).join(', ')} say${changed.length === 1 ? 's' : ''}`] : []),
    ...(removed.length > 0 ? [`no longer holds ${removed.map(id).join(', ')}`] : []),
  ];
  // A release never changes or drops a shipped version (ADR-0021 §3): when one has, say so plainly.
  const broken = changed.length > 0 || removed.length > 0;
  upsertReviewItem(tx, {
    companyId,
    kind: 'other',
    severity: broken ? 'warning' : 'info',
    title: `Rule ${ruleKey} changed in the rules store`,
    detail: `The rules store installed with this version of Leabhar ${parts.join('; ')}${name ? ` (${name})` : ''}, `
      + 'compared with the store this book last opened. Every figure and suggestion from now on reads the new store; '
      + 'entries already posted keep the versions they applied. '
      + (broken
        ? 'A release should never change or drop a version it has shipped, so check which version of Leabhar is installed before relying on this rule. '
        : 'Check the new version against its source before relying on it. ')
      + 'Nothing was switched to another version.',
    entityType: 'irish_rule_key',
    entityId: ruleKey,
    dedupeKey: `rules_store_update:${signature}:${ruleKey}`,
    context: { ruleKey, added: added.map(id), changed: changed.map(id), removed: removed.map(id), signature, previousSignature },
  });
}

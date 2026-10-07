import { describe, it, expect, beforeEach } from 'vitest';
import { chmodSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { eq, like } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { reviewItems, rulesStoreSeen } from '@/db/schema';
import { ids } from '@/lib/ids';
import { rulesStorePath } from '@/lib/paths';
import { createCompany } from '../config/setup';
import { recordRuleDecision } from './ruleDecisions';
import { attachRulesStore, detachRulesStore } from './visibleRules';
import { checkRulesStoreUpdate, diffVersions } from './rulesStoreUpdate';

/**
 * The check a book runs against each rules store it opens (ADR-0021 §5,
 * delivery step 4): a store new to the book is recorded with its versions,
 * the book's references are checked against it, and each rule key that
 * changed since the store the book last opened becomes a review item.
 */

const STANDARD = 'vat.rate_standard_current';
const REDUCED = 'vat.rate_reduced_current';
const dir = mkdtempSync(join(tmpdir(), 'leabhar-store-update-'));

/**
 * A copy of the test run's store, changed as a later release might change it:
 * a version added to one key, and, as no release may, a version of another
 * changed and one removed. Its signature is changed to match.
 */
function alteredStore(name: string): string {
  const path = join(dir, `${name}.db`);
  copyFileSync(rulesStorePath(), path);
  chmodSync(path, 0o644);
  const store = new Database(path);
  const columns = (store.prepare('PRAGMA table_info(irish_tax_rules)').all() as Array<{ name: string }>).map((c) => c.name);
  store.prepare(`INSERT INTO irish_tax_rules SELECT ${columns.map((c) => (c === 'id' ? `'${STANDARD}@99'` : c === 'rule_version' ? '99'
    : c === 'effective_from' ? `'2030-01-01'` : c === 'effective_to' ? 'NULL' : c)).join(', ')} FROM irish_tax_rules WHERE id = ?`)
    .run(`${STANDARD}@1`);
  store.prepare('UPDATE irish_tax_rules SET statement = statement || \' (amended)\' WHERE id = ?').run(`${REDUCED}@1`);
  const removed = (store.prepare('SELECT id FROM irish_tax_rules WHERE id NOT LIKE ? AND id NOT LIKE ? ORDER BY id LIMIT 1')
    .get(`${STANDARD}@%`, `${REDUCED}@%`) as { id: string }).id;
  store.prepare('DELETE FROM irish_tax_rule_tests WHERE rule_id = ?').run(removed);
  store.prepare('DELETE FROM irish_tax_rules WHERE id = ?').run(removed);
  store.prepare(`UPDATE rules_store_meta SET value = ? WHERE key = 'signature'`).run(`altered-${name}`);
  store.close();
  return path;
}

describe('checkRulesStoreUpdate', () => {
  let db: ReturnType<typeof createTestDatabase>['db'];
  let sqlite: ReturnType<typeof createTestDatabase>['sqlite'];
  let companyId: string;
  let otherId: string;

  beforeEach(() => {
    ({ db, sqlite } = createTestDatabase());
    companyId = createCompany(db, { legalName: 'Siopa Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }).companyId;
    otherId = createCompany(db, { legalName: 'Eile Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }).companyId;
  });

  const items = (id: string) => db.select().from(reviewItems).where(eq(reviewItems.companyId, id)).all();

  it('records a store the book has never opened, with its versions, and raises nothing to compare', () => {
    const result = checkRulesStoreUpdate(db)!;
    expect(result).toMatchObject({ previousSignature: null, compared: false, changedKeys: [] });
    const seen = db.select().from(rulesStoreSeen).all();
    expect(seen).toEqual([expect.objectContaining({ signature: result.signature })]);
    expect(Object.keys(seen[0]!.versionHashes!)).toContain(`${STANDARD}@1`);
    expect(Object.keys(seen[0]!.versionHashes!)).toHaveLength(seen[0]!.versions);
    expect(items(companyId)).toEqual([]);
  });

  it('does nothing on a store the book last checked itself against', () => {
    checkRulesStoreUpdate(db);
    expect(checkRulesStoreUpdate(db)).toBeNull();
    expect(db.select().from(rulesStoreSeen).all()).toHaveLength(1);
  });

  it('raises each changed key for every company, and records the new store', () => {
    const first = checkRulesStoreUpdate(db)!;
    detachRulesStore(sqlite);
    attachRulesStore(sqlite, { path: alteredStore('next') });

    const result = checkRulesStoreUpdate(db)!;
    expect(result).toMatchObject({ signature: 'altered-next', previousSignature: first.signature, compared: true });
    const byKey = new Map(result.changedKeys.map((c) => [c.ruleKey, c]));
    expect(byKey.get(STANDARD)).toEqual({ ruleKey: STANDARD, added: [99], changed: [], removed: [] });
    expect(byKey.get(REDUCED)).toEqual({ ruleKey: REDUCED, added: [], changed: [1], removed: [] });
    expect(result.changedKeys).toHaveLength(3);
    const gone = result.changedKeys.find((c) => c.removed.length > 0)!;

    for (const id of [companyId, otherId]) {
      const raised = items(id);
      expect(raised).toHaveLength(3);
      const added = raised.find((i) => i.dedupeKey === `rules_store_update:altered-next:${STANDARD}`)!;
      expect(added).toMatchObject({ severity: 'info', title: `Rule ${STANDARD} changed in the rules store`, entityId: STANDARD });
      expect(added.detail).toContain(`adds ${STANDARD}@99 (in force from 2030-01-01)`);
      expect(added.detail).toContain('Nothing was switched to another version.');
      const changed = raised.find((i) => i.entityId === REDUCED)!;
      expect(changed.severity).toBe('warning');
      expect(changed.detail).toContain(`changes what ${REDUCED}@1 says`);
      expect(raised.find((i) => i.entityId === gone.ruleKey)!.detail).toContain(`no longer holds ${gone.ruleKey}@${gone.removed[0]}`);
    }
    expect(db.select().from(rulesStoreSeen).all().map((s) => s.signature)).toEqual([first.signature, 'altered-next']);
    expect(checkRulesStoreUpdate(db)).toBeNull();
  });

  it('says once per company that it cannot list the changes when the earlier store’s versions were not recorded', () => {
    db.insert(rulesStoreSeen).values({
      id: ids.rulesStoreSeen(), signature: 'before-step-4', format: 1, catalogueDigest: 'x', versions: 1, seenAt: '2026-10-01T00:00:00.000Z',
    }).run();
    const result = checkRulesStoreUpdate(db)!;
    expect(result).toMatchObject({ previousSignature: 'before-step-4', compared: false, changedKeys: [] });
    for (const id of [companyId, otherId]) {
      expect(items(id)).toEqual([expect.objectContaining({
        title: 'The rules store has changed since this book last opened it', dedupeKey: `rules_store_update:${result.signature}:unlisted`,
      })]);
    }
  });

  it('raises a version the book refers to that the store lacks', () => {
    recordRuleDecision(db, {
      companyId, ruleKey: STANDARD, ruleVersion: 42, numbering: 'catalogue', status: 'approved', decidedBy: 'Aoife', decidedAt: '2026-10-01T09:00:00.000Z',
    });
    const result = checkRulesStoreUpdate(db)!;
    expect(result.missing).toEqual(expect.arrayContaining([{ companyId, versionIds: [`${STANDARD}@42`] }, { companyId: otherId, versionIds: [] }]));
    expect(db.select().from(reviewItems).where(like(reviewItems.dedupeKey, 'rule_version_missing:%')).all())
      .toEqual([expect.objectContaining({ companyId, dedupeKey: `rule_version_missing:catalogue:${STANDARD}@42` })]);
  });
});

describe('diffVersions', () => {
  it('groups added, changed and removed versions by key, in number order', () => {
    const before = { 'a@1': 'h1', 'a@2': 'h2', 'b@1': 'h3', 'c@1': 'h4' };
    const after = new Map([['a@1', 'h1'], ['a@3', 'h5'], ['a@2', 'changed'], ['c@1', 'h4'], ['d@1', 'h6'], ['a@10', 'h7']]);
    expect(diffVersions(before, after)).toEqual([
      { ruleKey: 'a', added: [3, 10], changed: [2], removed: [] },
      { ruleKey: 'b', added: [], changed: [], removed: [1] },
      { ruleKey: 'd', added: [1], changed: [], removed: [] },
    ]);
  });
});

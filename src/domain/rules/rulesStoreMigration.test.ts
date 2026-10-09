import { describe, it, expect, beforeAll, vi } from 'vitest';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openBook as openAppBook, openSqlite, type AppDatabase } from '@/db';
import * as schema from '@/db/schema';
import {
  irishActProvisions, irishKnowledgeSources, irishRuleBindings, irishRuleDecisions, irishRuleVersionMap, irishRuleVersionsRetained,
  irishTaxRules, invoiceLines, reviewItems, rulesStoreSeen, suppliers, taxRates, visibleActProvisionFields, visibleActProvisions,
  visibleKnowledgeSourceFields, visibleKnowledgeSources, visibleTaxRules,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { makeDate } from '../dates';
import { checkProvisionEvidence, deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { readCatalogueEntry } from './catalogue';
import { attachRulesStore, detachRulesStore } from './visibleRules';
import { buildRulesStore, RulesStoreOpenError, type RulesStoreBuildResult } from './rulesStore';
import { migrateBookToRulesStore, type RulesStoreMigrationResult } from './rulesStoreMigration';

/**
 * The one-time move of a book onto the rules store (ADR-0021 §6, delivery
 * step 2), on a book that holds a corrected version under a number other
 * than the catalogue's: the book applied an old wording as
 * `vat.rate_standard_current@3`, a correction closed it, and the corrected
 * wording, which the catalogue numbers 3, is 4 in the book.
 */

const STANDARD = 'vat.rate_standard_current';
const REDUCED = 'vat.rate_reduced_current';

const dir = mkdtempSync(join(tmpdir(), 'leabhar-store-migration-'));
let store: RulesStoreBuildResult;

/** A book in a file, as the app kept it before it read the store, so a backup copies it. */
function openBook(name: string) {
  const path = join(dir, `${name}.db`);
  const sqlite = openSqlite(path);
  const db = drizzle(sqlite, { schema }) as unknown as AppDatabase;
  migrate(db, { migrationsFolder: './drizzle' });
  const created = createCompany(db, { legalName: `${name} Ltd`, vatRegistrationStatus: 'registered', seedYears: [2025] });
  deriveStatutoryKnowledgeBase(db, { companyId: created.companyId });
  return { path, sqlite, db, ...created };
}

/** Give the book's row for `key@version` the number `to`, as a book that derived a correction later numbers it. */
function renumber(db: AppDatabase, companyId: string, key: string, version: number, to: number) {
  const row = db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, key), eq(irishTaxRules.ruleVersion, version))).get()!;
  db.update(irishTaxRules).set({ ruleVersion: to }).where(eq(irishTaxRules.id, row.id)).run();
  return row;
}

const versionsOf = (db: AppDatabase, companyId: string) => db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();

beforeAll(() => {
  store = buildRulesStore({ outPath: join(dir, 'rules.db') });
}, 60_000); // a full build, one lookup per active version (#727)

describe('moving a book that holds a corrected version under another number', () => {
  let book: ReturnType<typeof openBook>;
  let before: Array<typeof irishTaxRules.$inferSelect>;
  let result: RulesStoreMigrationResult;
  let lineId: string;
  let reducedVersion: number;
  const backups = join(dir, 'backups');

  beforeAll(async () => {
    book = openBook('corrected');
    const { db, companyId } = book;

    // The book applied the standard rate's version 3 on a purchase in March 2025.
    const supplierId = ids.supplier();
    db.insert(suppliers).values({ id: supplierId, companyId, name: 'Byrne', matchKey: 'byrne', countryCode: 'IE' }).run();
    attachRulesStore(book.sqlite, { path: store.path });
    const { invoiceId } = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2025, 3, 10), invoiceNumber: 'V-1', supplierId,
      lines: [{ description: 'Stationery', netMinor: 10_000, accountId: book.accountsByCode['6070']!, vatTreatmentId: book.treatmentsByCode['IE_STD']!, vatRuleKeys: [STANDARD] }],
    });
    detachRulesStore(book.sqlite);
    // Posted before the book read the store, so numbered as the book numbered it.
    db.update(invoiceLines).set({ vatRuleNumbering: 'book' }).where(eq(invoiceLines.invoiceId, invoiceId)).run();
    const line = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).get()!;
    lineId = line.id;
    expect(line.vatRuleVersions).toEqual([`${STANDARD}@3`]);

    // Version 3 then said something a later catalogue corrected: the correction
    // closed the old wording the day it opened and derived the corrected one as 4.
    const corrected = renumber(db, companyId, STANDARD, 3, 4);
    db.insert(irishTaxRules).values({
      ...corrected, id: ids.taxRule(), ruleVersion: 3, statement: `${corrected.statement} [as first transcribed]`,
      effectiveTo: corrected.effectiveFrom,
    }).run();
    const stdRate = db.select().from(taxRates).where(and(eq(taxRates.companyId, companyId), eq(taxRates.code, 'VAT_STD'))).get()!;
    db.update(irishTaxRules).set({ taxRateId: stdRate.id })
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, STANDARD), eq(irishTaxRules.ruleVersion, 3))).run();
    db.update(irishTaxRules).set({ taxRateId: stdRate.id })
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, STANDARD), eq(irishTaxRules.ruleVersion, 4))).run();
    for (const ruleVersion of [3, 4]) {
      db.insert(irishRuleDecisions).values({
        id: ids.taxRule(), companyId, ruleKey: STANDARD, ruleVersion, status: 'approved', decidedBy: 'Eimear', decidedAt: '2025-03-01',
      }).run();
    }

    // A figure corrected under the same dates and wording: the value alone tells the two apart.
    const reduced = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, REDUCED))).all()
      .sort((a, b) => b.ruleVersion - a.ruleVersion)[0]!;
    reducedVersion = reduced.ruleVersion;
    renumber(db, companyId, REDUCED, reducedVersion, reducedVersion + 1);
    db.insert(irishTaxRules).values({ ...reduced, id: ids.taxRule(), numericValue: (reduced.numericValue ?? 0) + 100 }).run();

    before = versionsOf(db, companyId);
    result = await migrateBookToRulesStore(db, { storePath: store.path, backup: { root: backups, dbPath: book.path, documentsPath: join(dir, 'no-documents') } });
  });

  it('takes a backup of the book as it stood first', () => {
    expect(result.backup.version).toBe(1);
    const copy = new Database(join(result.backup.path, 'database.db'), { readonly: true });
    expect((copy.prepare('SELECT count(*) AS n FROM irish_rule_version_map').get() as { n: number }).n).toBe(0);
    expect((copy.prepare('SELECT count(*) AS n FROM irish_tax_rules').get() as { n: number }).n).toBe(before.length);
    copy.close();
  });

  it('maps the corrected version to the catalogue’s number, by what it says', () => {
    const map = book.db.select().from(irishRuleVersionMap).where(eq(irishRuleVersionMap.companyId, book.companyId)).all();
    const of = (key: string) => Object.fromEntries(map.filter((m) => m.ruleKey === key).map((m) => [m.bookVersion, m.catalogueVersion]));
    expect(of(STANDARD)).toEqual({ 1: 1, 2: 2, 4: 3 });
    expect(of(REDUCED)[reducedVersion + 1]).toBe(reducedVersion);
    expect(of(REDUCED)[reducedVersion]).toBeUndefined();
    // Every other version the book holds is the catalogue's, under the same number.
    expect(map).toHaveLength(before.length - 2);
    for (const m of map.filter((m) => m.ruleKey !== STANDARD && m.ruleKey !== REDUCED)) expect(m.catalogueVersion, m.ruleKey).toBe(m.bookVersion);
    expect(new Set(map.map((m) => m.storeSignature))).toEqual(new Set([store.signature]));
  });

  it('keeps the versions the store does not hold, frozen, and raises them for review', () => {
    const retained = book.db.select().from(irishRuleVersionsRetained).where(eq(irishRuleVersionsRetained.companyId, book.companyId)).all();
    expect(retained.map((r) => [`${r.ruleKey}@${r.ruleVersion}`, r.reason]).sort())
      .toEqual([[`${STANDARD}@3`, 'never_in_force'], [`${REDUCED}@${reducedVersion}`, 'no_store_version']].sort());
    const old = retained.find((r) => r.ruleKey === STANDARD)!;
    const row = before.find((r) => r.ruleKey === STANDARD && r.ruleVersion === 3)!;
    expect(old).toMatchObject({ bookRuleId: row.id, statement: row.statement, numericValue: row.numericValue, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, conditions: row.conditions });
    expect(old.sourceSha256).toMatch(/^[0-9a-f]{64}$/);

    const items = book.db.select().from(reviewItems).where(eq(reviewItems.companyId, book.companyId)).all()
      .filter((i) => i.dedupeKey.startsWith('rule_version_retained:'));
    expect(items.map((i) => i.dedupeKey).sort()).toEqual([`rule_version_retained:${REDUCED}@${reducedVersion}`, `rule_version_retained:${STANDARD}@3`].sort());
    const standard = items.find((i) => i.dedupeKey.endsWith(`${STANDARD}@3`))!;
    expect(standard.detail).toContain('the 1 review decision and 1 invoice line that refer to it can still be explained');
    expect(standard.detail).toContain('the binding is not moved');
    expect(standard.detail).toContain('Nothing was switched to another version');
  });

  it('rewrites neither the posted line nor the decisions', () => {
    expect(book.db.select().from(invoiceLines).where(eq(invoiceLines.id, lineId)).get()!.vatRuleVersions).toEqual([`${STANDARD}@3`]);
    const decisions = book.db.select().from(irishRuleDecisions).where(and(eq(irishRuleDecisions.companyId, book.companyId), eq(irishRuleDecisions.ruleKey, STANDARD))).all();
    expect(decisions.map((d) => d.ruleVersion).sort()).toEqual([3, 4]);
  });

  it('moves the binding under the catalogue’s number, and not one on a version the store lacks', () => {
    const bindings = book.db.select().from(irishRuleBindings).where(eq(irishRuleBindings.companyId, book.companyId)).all();
    const corrected = before.find((r) => r.ruleKey === STANDARD && r.ruleVersion === 4)!;
    expect(bindings).toEqual([expect.objectContaining({
      ruleKey: STANDARD, ruleVersion: 3, taxRateId: corrected.taxRateId, vatTreatmentId: null,
      effectiveFrom: corrected.effectiveFrom, effectiveTo: corrected.effectiveTo, recordedBy: 'rules_store_migration',
    })]);
    expect(result.companies[0]!.unmovedBindings).toEqual([{ ruleKey: STANDARD, ruleVersion: 3, taxRateId: corrected.taxRateId, vatTreatmentId: null }]);
  });

  it('leaves the copied rule tables as they were, and the store for the check after it to record', () => {
    expect(result.store).toMatchObject({ signature: store.signature, versions: store.versions.size });
    expect(book.db.select().from(rulesStoreSeen).all()).toEqual([]);
    expect(versionsOf(book.db, book.companyId)).toEqual(before);
  });

  it('writes nothing more when run again, beyond a new backup', async () => {
    const counts = () => [irishRuleVersionMap, irishRuleVersionsRetained, irishRuleBindings, rulesStoreSeen, reviewItems]
      .map((t) => book.db.select().from(t).all().length);
    const held = counts();
    const again = await migrateBookToRulesStore(book.db, { storePath: store.path, backup: { root: backups, dbPath: book.path, documentsPath: join(dir, 'no-documents') } });
    expect(again.backup.version).toBe(2);
    expect(again.companies).toEqual([expect.objectContaining({ mapped: [], retained: [], bindings: 0 })]);
    expect(counts()).toEqual(held);
  });

  it('records a binding again only when it changed', async () => {
    const other = book.db.select().from(taxRates).where(and(eq(taxRates.companyId, book.companyId), eq(taxRates.code, 'VAT_RED'))).get()!;
    book.db.update(irishTaxRules).set({ taxRateId: other.id })
      .where(and(eq(irishTaxRules.companyId, book.companyId), eq(irishTaxRules.ruleKey, STANDARD), eq(irishTaxRules.ruleVersion, 4))).run();
    await migrateBookToRulesStore(book.db, { storePath: store.path, backup: { root: backups, dbPath: book.path, documentsPath: join(dir, 'no-documents') } });
    const bindings = book.db.select().from(irishRuleBindings).where(eq(irishRuleBindings.companyId, book.companyId)).all();
    expect(bindings.map((b) => b.taxRateId)).toEqual([expect.any(String), other.id]);
    expect(bindings[0]!.taxRateId).not.toBe(other.id);
  });
});

describe('a store the migration cannot use', () => {
  let book: ReturnType<typeof openBook>;
  beforeAll(() => {
    book = openBook('refused');
  });

  const thrown = (run: () => unknown): RulesStoreOpenError => {
    try {
      run();
    } catch (e) {
      return e as RulesStoreOpenError;
    }
    throw new Error('expected the migration to fail');
  };
  const nothingWritten = (backups: string) => {
    expect(existsSync(backups) ? readdirSync(backups) : []).toEqual([]);
    for (const t of [irishRuleVersionMap, irishRuleVersionsRetained, irishRuleBindings, rulesStoreSeen]) expect(book.db.select().from(t).all()).toEqual([]);
  };

  it('fails on a missing store before the backup, writing nothing', async () => {
    const backups = join(dir, 'refused-missing');
    const error = thrown(() => migrateBookToRulesStore(book.db, { storePath: join(dir, 'nowhere', 'rules.db'), backup: { root: backups, dbPath: book.path } }));
    expect(error).toBeInstanceOf(RulesStoreOpenError);
    expect(error).toMatchObject({ reason: 'missing' });
    expect(error.message).toContain('npm run rules:build');
    nothingWritten(backups);
  });

  it('fails on a store built from another catalogue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'leabhar-store-root-'));
    cpSync('catalogue', join(root, 'catalogue'), { recursive: true });
    appendFileSync(join(root, 'catalogue', 'vatca-2010-revised', 's046.json'), '\n');
    const backups = join(dir, 'refused-stale');
    const error = thrown(() => migrateBookToRulesStore(book.db, { storePath: store.path, root, backup: { root: backups, dbPath: book.path } }));
    expect(error).toMatchObject({ name: 'RulesStoreOpenError', reason: 'stale' });
    nothingWritten(backups);
  });
});

describe('a book version more than one store version says the same as', () => {
  it('maps to neither, and is kept for review', async () => {
    // A store holding two versions of a key that say the same thing: never built, but nothing may pick one silently.
    const path = join(dir, 'twice.db');
    copyFileSync(store.path, path);
    const twice = new Database(path);
    twice.prepare(`INSERT INTO irish_tax_rules SELECT * FROM irish_tax_rules WHERE id = ?`.replace('SELECT *', `SELECT ${
      (twice.prepare('PRAGMA table_info(irish_tax_rules)').all() as Array<{ name: string }>)
        .map((c) => (c.name === 'id' ? `'${REDUCED}@99'` : c.name === 'rule_version' ? '99' : c.name)).join(', ')}`)).run(`${REDUCED}@1`);
    twice.close();

    const book = openBook('ambiguous');
    const result = await migrateBookToRulesStore(book.db, { storePath: path, backup: { root: join(dir, 'ambiguous-backups'), dbPath: book.path } });
    expect(result.companies[0]!.retained).toEqual([{ ruleKey: REDUCED, ruleVersion: 1, reason: 'ambiguous' }]);
    expect(book.db.select().from(irishRuleVersionMap)
      .where(and(eq(irishRuleVersionMap.ruleKey, REDUCED), eq(irishRuleVersionMap.bookVersion, 1))).all()).toEqual([]);
    const item = book.db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `rule_version_retained:${REDUCED}@1`)).get()!;
    expect(item.title).toBe(`Rule version ${REDUCED}@1 matches more than one version in the rules store`);
    expect(item.detail).toContain(`${REDUCED}@1, ${REDUCED}@99`);
  });
});

describe('a book that read a statute copy before its catalogue port (#698, #700)', () => {
  const DISTANCE = 'vat.distance_sales_goods_eu_consumers';
  const ENTRY = 'vatca-2010-revised/s030.json';

  it('reads the footnote date from the store, and the viewer names the entry that replaced the copy', async () => {
    // As #698 left such a book: s.30 read from its Markdown copy (deleted by
    // the port), and the footnote date lost, so version 1 closed the day it
    // opened and version 2 claims the rule from 2010.
    const book = openBook('pre-port');
    const { db, companyId } = book;
    const v1 = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, DISTANCE))).get()!;
    const provision = db.select().from(irishActProvisions).where(eq(irishActProvisions.id, v1.provisionId)).get()!;
    db.update(irishKnowledgeSources).set({ localPath: 'docs/statutes/vatca-2010-revised/s030.md', sha256: 'f'.repeat(64) })
      .where(eq(irishKnowledgeSources.id, provision.sourceId)).run();
    db.update(irishTaxRules).set({ effectiveTo: '2021-07-01' }).where(eq(irishTaxRules.id, v1.id)).run();
    db.insert(irishTaxRules).values({ ...v1, id: ids.taxRule(), ruleVersion: 2, effectiveFrom: '2010-11-01', effectiveTo: null }).run();

    const result = await migrateBookToRulesStore(db, { storePath: store.path, backup: { root: join(dir, 'pre-port-backups'), dbPath: book.path } });
    expect(result.companies[0]!.retained.filter((r) => r.ruleKey === DISTANCE)).toEqual([
      { ruleKey: DISTANCE, ruleVersion: 1, reason: 'never_in_force' },
      { ruleKey: DISTANCE, ruleVersion: 2, reason: 'no_store_version' },
    ]);

    // #698: what the book applies is the store's version, dated by the footnote.
    attachRulesStore(book.sqlite, { path: store.path });
    const visible = db.select({ version: visibleTaxRules.ruleVersion, from: visibleTaxRules.effectiveFrom, to: visibleTaxRules.effectiveTo, origin: visibleTaxRules.origin })
      .from(visibleTaxRules).where(and(eq(visibleTaxRules.companyId, companyId), eq(visibleTaxRules.ruleKey, DISTANCE))).all();
    expect(visible.filter((r) => r.origin === 'store')).toEqual([{ version: 1, from: '2021-07-01', to: null, origin: 'store' }]);

    // #700: a frozen version still names the deleted copy. The viewer keeps
    // its path and hash, and checks the entry with the same words instead.
    const retained = db.select({ provision: visibleActProvisionFields, source: visibleKnowledgeSourceFields })
      .from(visibleActProvisions)
      .innerJoin(visibleKnowledgeSources, eq(visibleActProvisions.sourceId, visibleKnowledgeSources.id))
      .where(and(eq(visibleActProvisions.slug, DISTANCE), eq(visibleActProvisions.origin, 'retained'))).all();
    expect(retained).toHaveLength(2);
    const entry = readCatalogueEntry(ENTRY);
    for (const row of retained) {
      expect(row.source.localPath).toBe('docs/statutes/vatca-2010-revised/s030.md');
      const file = checkProvisionEvidence(row.source, row.provision);
      expect(file.exists).toBe(false);
      expect(file.replacedBy?.entry).toBe(`catalogue/${ENTRY}`);
      expect(file.replacedBy?.check).toMatchObject({ exists: true, sha256Matches: true });
      expect(file.replacedBy?.check.slice).toBe(entry.provisions.find((p) => p.sectionNumber === provision.sectionNumber)!.excerpt);
    }

    // Words the entry does not hold are not vouched for by it.
    const changed = checkProvisionEvidence(retained[0]!.source, { ...retained[0]!.provision, provisionText: 'Other words.' });
    expect(changed).toMatchObject({ exists: false, replacedBy: null });
    detachRulesStore(book.sqlite);
  });
});

describe('opening a book that has not moved onto the store', () => {
  it('moves it once, after a backup, and not again on the next open', () => {
    const backups = join(dir, 'open-backups');
    vi.stubEnv('BACKUP_PATH', backups);
    vi.stubEnv('DOCUMENT_STORAGE_PATH', join(dir, 'no-documents'));
    try {
      const old = openBook('opened');
      old.sqlite.close();

      const db = openAppBook(old.path);
      expect(readdirSync(backups)).toEqual(['v1']);
      expect(db.select().from(rulesStoreSeen).all()).toHaveLength(1);
      expect(db.select().from(irishRuleVersionMap).where(eq(irishRuleVersionMap.companyId, old.companyId)).all().length).toBeGreaterThan(0);
      db.$client.close();

      openAppBook(old.path).$client.close();
      expect(readdirSync(backups)).toEqual(['v1']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

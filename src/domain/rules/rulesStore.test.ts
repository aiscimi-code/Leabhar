import { describe, it, expect, beforeAll } from 'vitest';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { readCatalogueEntry, serialiseCatalogueEntry } from './catalogue';
import {
  buildRulesStore, checkReleasedVersions, readReleasedVersions, ruleVersionContentHash,
  RulesStoreBuildError, RULES_STORE_FORMAT, type RulesStoreBuildResult,
} from './rulesStore';

/**
 * The install-level rules store (ADR-0021, delivery step 1): built by the
 * derive pipeline that loads a book today, it must hold, by content, exactly
 * what a freshly loaded book holds, less what belongs to the book.
 */

type Row = Record<string, unknown>;

const dir = mkdtempSync(join(tmpdir(), 'leabhar-rules-store-'));
let built: RulesStoreBuildResult;
let store: Database.Database;
let book: ReturnType<typeof createTestDatabase>['sqlite'];
let companyId: string;

beforeAll(() => {
  built = buildRulesStore({ outPath: join(dir, 'rules.db') });
  store = new Database(built.path, { readonly: true });
  const test = createTestDatabase();
  book = test.sqlite;
  ({ companyId } = createCompany(test.db, { legalName: 'Fresh Book Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  loadStatutoryKnowledgeBase(test.db, { companyId });
});

/** A row with the columns that differ between any two loads (IDs and timestamps) and the book's own columns left out. */
function content(row: Row, drop: string[] = []): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (['id', 'company_id', 'tax_rate_id', 'vat_treatment_id', 'created_at', 'updated_at', ...drop].includes(k)) continue;
    // Some curated rules stamp `source_date` with the moment they were derived; a stated date is compared as it is.
    out[k] = k === 'source_date' && typeof v === 'string' && /T\d{2}:\d{2}/.test(v) ? 'time of the load' : v;
  }
  return out;
}

const byKey = (rows: Row[], key: (r: Row) => string) => new Map(rows.map((r) => [key(r), r]));
const sorted = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).sort();

/** Where a provision sits, the same in any database: its source's citation and hash, and its section. */
const PROVISION_REF = `(SELECT ref_s.citation || '|' || ref_s.sha256 || '|' || ref_p.section_number
  FROM irish_act_provisions ref_p JOIN irish_knowledge_sources ref_s ON ref_s.id = ref_p.source_id WHERE ref_p.id = %s)`;
const provisionRef = (column: string) => PROVISION_REF.replace('%s', column);

describe('the rules store', () => {
  it('holds no column that belongs to a book', () => {
    for (const table of ['irish_knowledge_sources', 'irish_act_provisions', 'irish_tax_rules', 'irish_tax_rule_tests', 'irish_rule_links']) {
      const columns = (store.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(columns.length, table).toBeGreaterThan(0);
      expect(columns, table).not.toContain('company_id');
      expect(columns, table).not.toContain('tax_rate_id');
      expect(columns, table).not.toContain('vat_treatment_id');
    }
  });

  it('numbers every rule `key@version`, as the catalogue does', () => {
    const rules = store.prepare('SELECT id, rule_key, rule_version FROM irish_tax_rules').all() as Array<{ id: string; rule_key: string; rule_version: number }>;
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.id).toBe(`${r.rule_key}@${r.rule_version}`);
    const versions = (store.prepare('SELECT supersedes_rule_id AS id FROM irish_tax_rules WHERE supersedes_rule_id IS NOT NULL').all() as Array<{ id: string }>);
    const ids = new Set(rules.map((r) => r.id));
    for (const v of versions) expect(ids.has(v.id), v.id).toBe(true);
  });

  it('holds every rule version a freshly loaded book holds, saying the same thing', () => {
    const query = (where: string) => `SELECT t.*, ${provisionRef('t.provision_id')} AS provision_ref,
      (SELECT x.rule_key || '@' || x.rule_version FROM irish_tax_rules x WHERE x.id = t.supersedes_rule_id) AS supersedes_ref
      FROM irish_tax_rules t ${where}`;
    const inBook = book.prepare(query('WHERE t.company_id = ?')).all(companyId) as Row[];
    const inStore = store.prepare(query('')).all() as Row[];
    const versionOf = (r: Row) => `${r.rule_key}@${r.rule_version}`;
    const bookRules = byKey(inBook, versionOf);
    const storeRules = byKey(inStore, versionOf);
    expect([...storeRules.keys()].sort()).toEqual([...bookRules.keys()].sort());
    for (const [id, r] of bookRules) {
      expect(content(storeRules.get(id)!, ['provision_id', 'supersedes_rule_id']), id)
        .toEqual(content(r, ['provision_id', 'supersedes_rule_id']));
    }
    expect(built.versions.size).toBe(inBook.length);
  });

  it('holds the same sources, provisions, links and rule tests', () => {
    const sources = (db: Database.Database) => byKey(db.prepare('SELECT * FROM irish_knowledge_sources').all() as Row[], (r) => `${r.citation}|${r.sha256}`);
    const bookSources = sources(book);
    const storeSources = sources(store);
    expect([...storeSources.keys()].sort()).toEqual([...bookSources.keys()].sort());
    for (const [ref, s] of bookSources) expect(content(storeSources.get(ref)!), ref).toEqual(content(s));

    const provisions = (db: Database.Database) => byKey(
      db.prepare(`SELECT p.*, ${provisionRef('p.id')} AS ref FROM irish_act_provisions p`).all() as Row[], (r) => r.ref as string);
    const bookProvisions = provisions(book);
    const storeProvisions = provisions(store);
    expect([...storeProvisions.keys()].sort()).toEqual([...bookProvisions.keys()].sort());
    for (const [ref, p] of bookProvisions) expect(content(storeProvisions.get(ref)!, ['source_id']), ref).toEqual(content(p, ['source_id']));

    const links = (db: Database.Database, where: string, ...args: unknown[]) => (db.prepare(
      `SELECT l.*, ${provisionRef('l.to_provision_id')} AS to_provision_ref FROM irish_rule_links l ${where}`).all(...args) as Row[])
      .map((l) => content(l, ['to_provision_id']));
    const bookLinks = links(book, 'WHERE l.company_id = ?', companyId);
    expect(bookLinks.length).toBeGreaterThan(0);
    expect(sorted(links(store, ''))).toEqual(sorted(bookLinks));

    const tests = (db: Database.Database) => (db.prepare(`SELECT t.*, r.rule_key || '@' || r.rule_version AS rule_ref
      FROM irish_tax_rule_tests t JOIN irish_tax_rules r ON r.id = t.rule_id`).all() as Row[]).map((t) => content(t, ['rule_id']));
    expect(sorted(tests(store))).toEqual(sorted(tests(book)));
  });

  it('records its format, signature and version count', () => {
    const meta = Object.fromEntries((store.prepare('SELECT key, value FROM rules_store_meta').all() as Array<{ key: string; value: string }>).map((m) => [m.key, m.value]));
    expect(meta).toMatchObject({ format: String(RULES_STORE_FORMAT), signature: built.signature, versions: String(built.versions.size) });
    expect(meta.catalogue_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('still holds every released version, saying what it said when released', () => {
    // A change to a released version fails here, in the gate, before it fails a package build.
    expect(checkReleasedVersions(readReleasedVersions(), built.versions)).toMatchObject({ missing: [], changed: [] });
  });
});

describe('the released-versions check', () => {
  const released = { format: 1 as const, versions: { 'a@1': 'h1', 'a@2': 'h2', 'b@1': 'h3' } };

  it('passes a build that adds versions, and names them', () => {
    expect(checkReleasedVersions(released, new Map([['a@1', 'h1'], ['a@2', 'h2'], ['b@1', 'h3'], ['b@2', 'h4']])))
      .toEqual({ missing: [], changed: [], added: ['b@2'] });
  });

  it('names a released version the build dropped, and one that now says something else', () => {
    expect(checkReleasedVersions(released, new Map([['a@1', 'h1'], ['a@2', 'changed']])))
      .toEqual({ missing: ['b@1'], changed: ['a@2'], added: [] });
  });

  it('hashes what a version says, not its review', () => {
    const v = {
      effectiveFrom: '2025-01-01', effectiveTo: null, statement: 'the rate is 13.5 per cent', numericValue: 1350, unit: 'basis_points', ruleType: 'rate', qualifier: null,
      conditions: [], exceptions: [], accountingEffect: null, taxEffect: null, vatEffect: 'reduced rate', reportingEffect: null,
    };
    const hash = ruleVersionContentHash(v);
    expect(ruleVersionContentHash({ ...v, reviewStatus: 'approved', reviewedBy: 'Dara' } as typeof v)).toBe(hash);
    for (const change of [{ numericValue: 900 }, { unit: 'percent' }, { ruleType: 'threshold' }, { qualifier: 'rate_bp:900' }, { effectiveTo: '2026-01-01' }, { statement: 'the rate is 9 per cent' },
      { conditions: [{ field: 'x', operator: 'equals', value: 1 }] }, { exceptions: [{ condition: 'c', effect: 'e' }] }, { vatEffect: 'standard rate' }]) {
      expect(ruleVersionContentHash({ ...v, ...change }), JSON.stringify(change)).not.toBe(hash);
    }
  });

  it('fails the build on a missing or changed released version, and leaves the store in place untouched', () => {
    const path = join(dir, 'kept.db');
    copyFileSync(built.path, path);
    const before = readFileSync(path);
    const committed = readReleasedVersions();
    const key = [...built.versions.keys()][0]!;
    let error: unknown;
    try {
      buildRulesStore({ outPath: path, released: { format: 1, versions: { ...committed.versions, [key]: 'f'.repeat(64), 'vat.no_such_rule@1': 'e'.repeat(64) } } });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RulesStoreBuildError);
    expect((error as RulesStoreBuildError).detail).toMatchObject({ missing: ['vat.no_such_rule@1'], changed: [key] });
    expect((error as Error).message).toContain('Add the change as a new version instead');
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(existsSync(`${path}.building`)).toBe(false);
  });

  it('passes a catalogue that ships an approval, under the same version number', () => {
    const root = mkdtempSync(join(tmpdir(), 'leabhar-rules-root-'));
    cpSync('catalogue', join(root, 'catalogue'), { recursive: true });
    const name = 'vatca-2010-revised/s046.json';
    const entry = readCatalogueEntry(name, root);
    entry.rules = entry.rules.map((r) => (r.key !== 'vat.rate_reduced_current' ? r : {
      ...r,
      versions: r.versions.map((v) => ({ ...v, review: { status: 'approved' as const, by: 'Dara (tax adviser)', at: '2026-09-01', sourceSha256: entry.source.sha256, note: null } })),
    }));
    writeFileSync(join(root, 'catalogue', name), serialiseCatalogueEntry(entry));

    const approved = buildRulesStore({ outPath: join(root, 'rules.db'), root });
    expect(approved.versions.get('vat.rate_reduced_current@1')).toBe(built.versions.get('vat.rate_reduced_current@1'));
    expect(approved.signature).toBe(built.signature);
  });
});

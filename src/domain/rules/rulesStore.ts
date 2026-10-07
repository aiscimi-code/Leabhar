/**
 * The install-level rules store, `rules.db` (ADR-0021, delivery step 1).
 *
 * The store is built once, at package time (`scripts/build-package.mjs`) or by
 * `npm run rules:build` in development: the existing derive pipeline
 * (`deriveStatutoryKnowledgeBase`) runs against an empty, in-memory book, the
 * default test cases are generated for what it derived (`generateDefaultTestCases`),
 * and the five rule tables are copied out of it into a separate SQLite file. The
 * copy drops what belongs to a book rather than to a rule: `company_id` on
 * every table, and the bindings to the book's own configuration
 * (`tax_rate_id`, `vat_treatment_id`), which move to a book table in step 2.
 * Nothing writes the store after the build.
 *
 * A store rule's ID is `key@version` as the catalogue numbers it (ADR-0021
 * §3). Releases never drop or change a shipped version, so the build compares
 * every version with `catalogue/released-versions.json`, the committed hash of
 * what each released version says, and fails on a missing or changed one. The
 * hash covers what the rule says, never its review: an approval ships under
 * the same version number.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { openSqlite, type AppDatabase } from '@/db';
import * as schema from '@/db/schema';
import { irishActProvisions, irishKnowledgeSources, irishRuleLinks, irishTaxRules, irishTaxRuleTests } from '@/db/schema';
import { sha256Hex } from '@/lib/hash';
import { appRoot, migrationsFolder } from '@/lib/paths';
import { createCompany } from '../config/setup';
import { CATALOGUE_DIR } from './catalogue';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { generateDefaultTestCases } from './testCases';
import { RULES_STORE_FORMAT, attachRulesStore, catalogueDigest, detachRulesStore, type RulesStoreMeta } from './visibleRules';

export const RELEASED_VERSIONS_FORMAT = 1;

/** A failed store build: a released version is missing or says something else. */
export class RulesStoreBuildError extends Error {
  constructor(message: string, readonly detail: ReleasedVersionsCheck) {
    super(message);
    this.name = new.target.name;
  }
}

/** The columns a store table leaves out: they belong to a book, not to a rule. */
const BOOK_COLUMNS = new Set(['company_id', 'tax_rate_id', 'vat_treatment_id']);

/** The rule tables the store holds, in an order that copies a referenced row first. */
const STORE_TABLES: SQLiteTable[] = [irishKnowledgeSources, irishActProvisions, irishTaxRules, irishTaxRuleTests, irishRuleLinks];

const STORE_INDEXES = [
  'CREATE UNIQUE INDEX irish_tax_rules_key_version_unique ON irish_tax_rules (rule_key, rule_version)',
  'CREATE INDEX irish_tax_rules_lookup_idx ON irish_tax_rules (rule_key, effective_from)',
  'CREATE INDEX irish_tax_rules_topic_idx ON irish_tax_rules (topic, active)',
  'CREATE INDEX irish_tax_rules_provision_idx ON irish_tax_rules (provision_id)',
  'CREATE INDEX irish_act_provisions_source_idx ON irish_act_provisions (source_id, section_number)',
  'CREATE INDEX irish_tax_rule_tests_rule_idx ON irish_tax_rule_tests (rule_id)',
  'CREATE INDEX irish_rule_links_from_idx ON irish_rule_links (from_key, kind)',
  'CREATE INDEX irish_rule_links_to_idx ON irish_rule_links (to_key, kind)',
];

/**
 * The rows of one company's derived rules, and what they refer to, per table.
 * A source is shared by every company that loaded it (unique by citation and
 * hash), so sources and provisions are taken by reference as well as by company.
 */
const COMPANY_PROVISIONS = `SELECT id FROM main.irish_act_provisions WHERE company_id = @companyId OR company_id IS NULL
  OR id IN (SELECT provision_id FROM main.irish_tax_rules WHERE company_id = @companyId)
  OR id IN (SELECT to_provision_id FROM main.irish_rule_links WHERE company_id = @companyId)`;
const STORE_SCOPE: Record<string, string> = {
  irish_knowledge_sources: `t.company_id = @companyId OR t.company_id IS NULL
    OR t.id IN (SELECT source_id FROM main.irish_act_provisions WHERE id IN (${COMPANY_PROVISIONS}))`,
  irish_act_provisions: `t.id IN (${COMPANY_PROVISIONS})`,
  irish_tax_rules: 't.company_id = @companyId',
  irish_tax_rule_tests: 't.rule_id IN (SELECT id FROM main.irish_tax_rules WHERE company_id = @companyId)',
  irish_rule_links: 't.company_id = @companyId',
};

const ruleIdOf = (alias: string) => `${alias}.rule_key || '@' || ${alias}.rule_version`;

/** A store column: its name, and how it is read from the book it is built from. */
function storeColumns(table: SQLiteTable): Array<{ name: string; ddl: string; select: string }> {
  const { name: tableName, columns } = getTableConfig(table);
  return columns.filter((c) => !BOOK_COLUMNS.has(c.name)).map((c) => {
    const ddl = `${c.name} ${c.getSQLType()}${c.primary ? ' PRIMARY KEY' : ''}${c.notNull && !c.primary ? ' NOT NULL' : ''}`;
    let select = `t.${c.name}`;
    // A rule is `key@version` in the store, and so is every reference to one.
    if (tableName === 'irish_tax_rules' && c.name === 'id') select = ruleIdOf('t');
    if (tableName === 'irish_tax_rules' && c.name === 'supersedes_rule_id') {
      select = `(SELECT ${ruleIdOf('s')} FROM main.irish_tax_rules s WHERE s.id = t.supersedes_rule_id)`;
    }
    if (tableName === 'irish_tax_rule_tests' && c.name === 'rule_id') {
      select = `(SELECT ${ruleIdOf('s')} FROM main.irish_tax_rules s WHERE s.id = t.rule_id)`;
    }
    return { name: c.name, ddl, select };
  });
}

/** What a rule version says, as the content hash reads it. */
export interface RuleVersionContent {
  effectiveFrom: string;
  effectiveTo: string | null;
  statement: string | null;
  numericValue: number | null;
  unit: string | null;
  /** What the number means (a rate, a threshold, ...). */
  ruleType: string;
  /** A figure's qualifier as stored; a band's rate is read from it (`rate_bp:N`, `resolveRuleFigure`). */
  qualifier: string | null;
  conditions: unknown;
  exceptions: unknown;
  accountingEffect: string | null;
  taxEffect: string | null;
  vatEffect: string | null;
  reportingEffect: string | null;
}

/**
 * The hash of what a rule version says: its dates, quote, value and unit,
 * the type and qualifier that say what the value means, conditions,
 * exceptions and effects (ADR-0021 §3). Its review, its name and its gloss are
 * not part of it, so an approval never changes it.
 */
export function ruleVersionContentHash(v: RuleVersionContent): string {
  return sha256Hex(JSON.stringify([
    v.effectiveFrom, v.effectiveTo, v.statement, v.numericValue, v.unit, v.ruleType, v.qualifier,
    v.conditions, v.exceptions, v.accountingEffect, v.taxEffect, v.vatEffect, v.reportingEffect,
  ]));
}

/** Every version released so far, by `key@version`, with the hash of what it says. */
export interface ReleasedVersions {
  format: typeof RELEASED_VERSIONS_FORMAT;
  versions: Record<string, string>;
}

export function releasedVersionsPath(root: string = appRoot()): string {
  return join(root, CATALOGUE_DIR, 'released-versions.json');
}

export function readReleasedVersions(root?: string): ReleasedVersions {
  const path = releasedVersionsPath(root);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReleasedVersions;
  if (parsed.format !== RELEASED_VERSIONS_FORMAT || typeof parsed.versions !== 'object' || parsed.versions === null) {
    throw new Error(`${path} is not a released-versions list (format ${RELEASED_VERSIONS_FORMAT}).`);
  }
  return parsed;
}

/** The list as committed: versions in key order and a trailing newline, so a release diffs cleanly. */
export function serialiseReleasedVersions(versions: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ format: RELEASED_VERSIONS_FORMAT, versions: sorted }, null, 2)}\n`;
}

export interface ReleasedVersionsCheck {
  /** Released versions the build no longer holds. */
  missing: string[];
  /** Released versions the build holds but that now say something else. */
  changed: string[];
  /** Versions the build holds that no release has shipped yet. */
  added: string[];
}

/** Compare a build's versions with every released one. Only `added` may be non-empty for the build to pass. */
export function checkReleasedVersions(released: ReleasedVersions, built: ReadonlyMap<string, string>): ReleasedVersionsCheck {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [id, hash] of Object.entries(released.versions)) {
    const now = built.get(id);
    if (now === undefined) missing.push(id);
    else if (now !== hash) changed.push(id);
  }
  const added = [...built.keys()].filter((id) => !(id in released.versions));
  return { missing: missing.sort(), changed: changed.sort(), added: added.sort() };
}


export interface RulesStoreBuildResult {
  path: string;
  /** The hash of every version the store holds, by `key@version`. */
  versions: Map<string, string>;
  /** Versions no release has shipped yet. */
  added: string[];
  /** The store's signature: the hash of every version it holds and what each says. */
  signature: string;
}

/**
 * Build `rules.db` at `outPath`. The build writes to a temporary file and
 * moves it into place only once the released-versions check passes, so a
 * failed build never leaves a store behind, nor replaces a good one.
 *
 * `root` is where the catalogue is read from (the app root by default);
 * `released` replaces the committed released-versions list, for a test.
 */
export function buildRulesStore(params: {
  outPath: string;
  root?: string;
  released?: ReleasedVersions;
}): RulesStoreBuildResult {
  const released = params.released ?? readReleasedVersions(params.root);
  const sqlite = openSqlite(':memory:');
  try {
    // The derive pipeline, unchanged, against an empty book.
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: migrationsFolder() });
    const { companyId } = createCompany(db, { legalName: 'Rules store build', vatRegistrationStatus: 'registered', seedYears: [] });
    deriveStatutoryKnowledgeBase(db, { companyId, root: params.root });
    // The cases ship with the versions they test (#723). They are not part of
    // a version's content hash, so adding one changes no signature.
    generateDefaultTestCases(db, { companyId });
    let added: string[] = [];
    const written = writeRulesStore(sqlite, {
      outPath: params.outPath, root: params.root, companyId,
      check: (versions) => {
        const check = checkReleasedVersions(released, versions);
        if (check.missing.length > 0 || check.changed.length > 0) {
          throw new RulesStoreBuildError([
            'The rules store was not built: a release never drops or changes a version it shipped (ADR-0021 §3).',
            ...(check.missing.length > 0 ? [`Released versions no longer derived: ${check.missing.join(', ')}.`] : []),
            ...(check.changed.length > 0 ? [`Released versions that now say something else: ${check.changed.join(', ')}. Add the change as a new version instead.`] : []),
          ].join(' '), check);
        }
        added = check.added;
      },
    });
    return { path: params.outPath, versions: written.versions, added, signature: written.signature };
  } finally {
    if (sqlite.open) sqlite.close();
  }
}

/**
 * Copy one company's derived rule tables out of a book into a store file at
 * `outPath`: the copy step of the build. Written to a temporary file and moved
 * into place only once `check` passes.
 */
function writeRulesStore(
  sqlite: Database.Database,
  params: { outPath: string; root?: string; companyId: string; check?: (versions: ReadonlyMap<string, string>) => void },
): { versions: Map<string, string>; signature: string } {
  const temp = `${params.outPath}.building`;
  mkdirSync(dirname(params.outPath), { recursive: true });
  rmSync(temp, { force: true });
  try {
    sqlite.prepare('ATTACH DATABASE ? AS store').run(temp);
    sqlite.transaction(() => {
      for (const table of STORE_TABLES) {
        const { name } = getTableConfig(table);
        const columns = storeColumns(table);
        const scoped = `WHERE ${STORE_SCOPE[name]}`;
        sqlite.exec(`CREATE TABLE store.${name} (${columns.map((c) => c.ddl).join(', ')})`);
        sqlite.prepare(`INSERT INTO store.${name} (${columns.map((c) => c.name).join(', ')}) `
          + `SELECT ${columns.map((c) => c.select).join(', ')} FROM main.${name} t ${scoped}`).run({ companyId: params.companyId });
      }
      for (const index of STORE_INDEXES) sqlite.exec(index.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX store.'));
    })();

    const versions = storeVersionHashes(sqlite, 'store');
    params.check?.(versions);

    const signature = sha256Hex([...versions].map(([id, hash]) => `${id}:${hash}`).join('\n'));
    sqlite.exec('CREATE TABLE store.rules_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const meta = sqlite.prepare('INSERT INTO store.rules_store_meta (key, value) VALUES (?, ?)');
    meta.run('format', String(RULES_STORE_FORMAT));
    meta.run('signature', signature);
    meta.run('catalogue_digest', catalogueDigest(params.root));
    meta.run('versions', String(versions.size));
    sqlite.exec('DETACH DATABASE store');
    // Read-only on disk too: nothing writes the store after the build. A
    // store being replaced is made writable first, which Windows needs to
    // rename over it.
    chmodSync(temp, 0o444);
    if (existsSync(params.outPath)) chmodSync(params.outPath, 0o644);
    renameSync(temp, params.outPath);
    return { versions, signature };
  } finally {
    if ((sqlite.prepare('PRAGMA database_list').all() as Array<{ name: string }>).some((d) => d.name === 'store')) sqlite.exec('DETACH DATABASE store');
    rmSync(temp, { force: true });
  }
}

/**
 * The content hash of every version in a store attached under `schema`, by
 * `key@version` (`ruleVersionContentHash`). The store's signature is the hash
 * of this list, and a book records it to tell what an update changed
 * (`checkRulesStoreUpdate`).
 */
export function storeVersionHashes(sqlite: Database.Database, schema: string): Map<string, string> {
  const versions = new Map<string, string>();
  type StoredRule = {
    id: string; effective_from: string; effective_to: string | null; statement: string | null; numeric_value: number | null;
    unit: string | null; rule_type: string; qualifier: string | null; conditions: string; exceptions: string;
    accounting_effect: string | null; tax_effect: string | null; vat_effect: string | null; reporting_effect: string | null;
  };
  for (const r of sqlite.prepare(`SELECT id, effective_from, effective_to, statement, numeric_value, unit, rule_type, qualifier, conditions, exceptions,
      accounting_effect, tax_effect, vat_effect, reporting_effect FROM ${schema}.irish_tax_rules ORDER BY id`).all() as StoredRule[]) {
    versions.set(r.id, ruleVersionContentHash({
      effectiveFrom: r.effective_from, effectiveTo: r.effective_to, statement: r.statement,
      numericValue: r.numeric_value, unit: r.unit, ruleType: r.rule_type, qualifier: r.qualifier,
      conditions: JSON.parse(r.conditions), exceptions: JSON.parse(r.exceptions),
      accountingEffect: r.accounting_effect, taxEffect: r.tax_effect, vatEffect: r.vat_effect, reportingEffect: r.reporting_effect,
    }));
  }
  return versions;
}

/** Temporary stores built from a book, removed when the process exits. */
const bookStoreDirs = new Set<string>();

/**
 * Attach, in place of the installed store, one built from the rules a book
 * derived itself, for one company: for a test that derives its own rules or
 * ships its own catalogue, and for the developer scripts that read a freshly
 * derived catalogue (`catalogue:extract`). Never used by the app, which reads
 * only the store the install shipped (ADR-0021, "Forbidden"). The file goes
 * to a temporary directory and is removed when the process exits.
 */
export function attachRulesStoreFromBook(db: AppDatabase, params: { companyId: string; root?: string }): RulesStoreMeta {
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  const dir = mkdtempSync(join(tmpdir(), 'leabhar-book-rules-'));
  if (bookStoreDirs.size === 0) process.once('exit', () => { for (const d of bookStoreDirs) rmSync(d, { recursive: true, force: true }); });
  bookStoreDirs.add(dir);
  const outPath = join(dir, 'rules.db');
  detachRulesStore(sqlite);
  writeRulesStore(sqlite, { outPath, root: params.root, companyId: params.companyId });
  return attachRulesStore(sqlite, { path: outPath, root: params.root });
}

/**
 * Add a build's new versions to the released-versions list, at release time.
 * Only ever adds: a released version is never removed or rehashed here, and a
 * build that would need that has already failed.
 */
export function recordReleasedVersions(build: RulesStoreBuildResult, root?: string): string[] {
  const path = releasedVersionsPath(root);
  const released = existsSync(path) ? readReleasedVersions(root).versions : {};
  const next = { ...released };
  for (const id of build.added) next[id] = build.versions.get(id)!;
  writeFileSync(path, serialiseReleasedVersions(next));
  return build.added;
}

export { RULES_STORE_FORMAT, RulesStoreOpenError, catalogueDigest, openRulesStore, type RulesStoreMeta } from './visibleRules';

/**
 * The rules a book can see (ADR-0021 §2, delivery step 3).
 *
 * The book's connection attaches the install-level rules store, `rules.db`,
 * as the schema `rules`, and `attachRulesStore` creates one temporary view
 * per rule table over it: `visible_irish_tax_rules` and its sources,
 * provisions, tests and links (`visibleTaxRules` and the others in
 * `src/db/schema/irishRules.ts`). This is the one place that says where a
 * book's rules come from. Every reader queries the views, never `rules.*` and
 * never the book's copied tables. A view holds:
 *
 * - **The store's rows**, for every company in the book. A store row has no
 *   company; it is the same for all of them. A rule row's `tax_rate_id` and
 *   `vat_treatment_id` are the company's latest binding
 *   (`irish_rule_bindings`), since a binding belongs to the book.
 * - **The book's frozen versions** (`irish_rule_versions_retained`), each
 *   with its provision and source as the book held them. A posted line that
 *   applied an old wording can still be explained. `origin` says which a row
 *   is; a retained version is never applied again.
 * - **A practice's own rules**, later, when one exists (ADR-0021, "Out of
 *   scope"): a third arm of each view.
 *
 * The store is opened read-only. This SQLite build does not take URI
 * filenames, so `ATTACH '…?mode=ro'` is not available. Instead, temporary
 * triggers refuse every row write to a store table on the connection, and
 * the build leaves the file read-only (`buildRulesStore`). A store that is
 * missing, unreadable, of another format or built from another catalogue
 * stops the open, naming the command that rebuilds it. There is no fallback
 * to the rules copied into a book.
 */
import { existsSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { irishActProvisions, irishKnowledgeSources, irishRuleLinks, irishTaxRules, irishTaxRuleTests } from '@/db/schema';
import { sha256Hex } from '@/lib/hash';
import { rulesStorePath } from '@/lib/paths';
import { CATALOGUE_ENTRIES, catalogueEntryPath } from './catalogueEntries';

export const RULES_STORE_FORMAT = 1;

/** The schema name the store is attached under. */
export const RULES_STORE_SCHEMA = 'rules';

/** What a store says about itself (`rules_store_meta`). */
export interface RulesStoreMeta {
  format: number;
  signature: string;
  catalogueDigest: string;
  versions: number;
}

/** A store that cannot be opened: missing, unreadable, of another format, or built from an older catalogue. */
export class RulesStoreOpenError extends Error {
  constructor(message: string, readonly reason: 'missing' | 'unreadable' | 'format' | 'stale') {
    super(message);
    this.name = new.target.name;
  }
}

/** The catalogue a store was built from: the SHA-256 of every entry file, so a later catalogue is recognised. */
export function catalogueDigest(root?: string): string {
  return sha256Hex(CATALOGUE_ENTRIES.map((name) => `${name}:${sha256Hex(readFileSync(catalogueEntryPath(name, root)))}`).join('\n'));
}

const REBUILD = 'Run `npm run rules:build` to build it (a packaged install ships it).';

/** Read and check a store's meta through `read`, which runs a query against the store. */
function checkedMeta(path: string, root: string | undefined, read: () => Array<{ key: string; value: string }>, close: () => void): RulesStoreMeta {
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = read();
  } catch (e) {
    close();
    throw new RulesStoreOpenError(`The rules store at ${path} cannot be read (${(e as Error).message}). ${REBUILD}`, 'unreadable');
  }
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const meta: RulesStoreMeta = {
    format: Number(values.format), signature: values.signature ?? '', catalogueDigest: values.catalogue_digest ?? '', versions: Number(values.versions),
  };
  const fail = (message: string, reason: RulesStoreOpenError['reason']) => {
    close();
    return new RulesStoreOpenError(`${message} ${REBUILD}`, reason);
  };
  if (meta.format !== RULES_STORE_FORMAT) throw fail(`The rules store at ${path} is format ${values.format ?? 'unknown'}; this version of Leabhar reads format ${RULES_STORE_FORMAT}.`, 'format');
  if (meta.catalogueDigest !== catalogueDigest(root)) throw fail(`The rules store at ${path} was built from a catalogue other than the one installed beside it.`, 'stale');
  return meta;
}

function assertExists(path: string): void {
  // ATTACH would otherwise create an empty file there.
  if (!existsSync(path)) throw new RulesStoreOpenError(`The rules store is missing at ${path}. ${REBUILD}`, 'missing');
}

/**
 * Open the rules store on its own read-only connection (ADR-0021 §1–2), for
 * a caller that compares it with a book rather than reading rules through
 * one: the migration onto the store.
 */
export function openRulesStore(params: { path?: string; root?: string } = {}): { sqlite: Database.Database; meta: RulesStoreMeta } {
  const path = params.path ?? rulesStorePath();
  assertExists(path);
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw new RulesStoreOpenError(`The rules store at ${path} cannot be read (${(e as Error).message}). ${REBUILD}`, 'unreadable');
  }
  const meta = checkedMeta(path, params.root,
    () => sqlite.prepare('SELECT key, value FROM rules_store_meta').all() as Array<{ key: string; value: string }>,
    () => sqlite.close());
  return { sqlite, meta };
}

/** The tables the store holds, as the views name them. */
const VIEWED: Array<{ table: SQLiteTable; view: string; store: string }> = [
  { table: irishKnowledgeSources, view: 'visible_irish_knowledge_sources', store: 'irish_knowledge_sources' },
  { table: irishActProvisions, view: 'visible_irish_act_provisions', store: 'irish_act_provisions' },
  { table: irishTaxRules, view: 'visible_irish_tax_rules', store: 'irish_tax_rules' },
  { table: irishTaxRuleTests, view: 'visible_irish_tax_rule_tests', store: 'irish_tax_rule_tests' },
  { table: irishRuleLinks, view: 'visible_irish_rule_links', store: 'irish_rule_links' },
];

/** The company's latest binding of a store rule version: the last recorded (`irish_rule_bindings`, insertion order). */
const binding = (column: string) => `(SELECT b.${column} FROM main.irish_rule_bindings b
  WHERE b.company_id = c.id AND b.rule_key = s.rule_key AND b.rule_version = s.rule_version ORDER BY b.rowid DESC LIMIT 1)`;

/** How a store row's book columns are read; every other column is the store's own. */
const STORE_ARM: Record<string, Record<string, string>> = {
  irish_knowledge_sources: { company_id: 'c.id' },
  irish_act_provisions: { company_id: 'c.id' },
  irish_tax_rules: { company_id: 'c.id', tax_rate_id: binding('tax_rate_id'), vat_treatment_id: binding('vat_treatment_id') },
  irish_rule_links: { company_id: 'c.id' },
};

/** A retained version's provision and source carry its own ID, so each is found from its rule alone. */
const RETAINED_COMMON = {
  source: "'derived'", confidence: 'NULL', provenance_status: "'system_rule'", source_note: 'NULL', source_date: 'NULL',
  created_at: 't.created_at', updated_at: 't.created_at',
};

/**
 * How a frozen version (`irish_rule_versions_retained t`) reads as a row of
 * each view. Every column of the copied table must be named here: a column
 * added to the table and not to this map fails the attach, not a reader.
 */
const RETAINED_ARM: Record<string, Record<string, string>> = {
  irish_knowledge_sources: {
    ...RETAINED_COMMON,
    id: 't.id', company_id: 't.company_id', source_type: "COALESCE(t.source_type, 'legislation')",
    title: 'COALESCE(t.source_title, t.source_citation)', citation: 't.source_citation', jurisdiction: "'IE'",
    source_url: "COALESCE(t.source_url, '')", local_path: 't.source_local_path', sha256: 't.source_sha256',
    ingest_version: "'retained'", publication_date: 'NULL', retrieved_at: 't.created_at',
    effective_from: 't.effective_from', effective_to: 't.effective_to', active: '0',
  },
  irish_act_provisions: {
    ...RETAINED_COMMON,
    id: 't.id', company_id: 't.company_id', source_id: 't.id', section_number: 't.section_number', part: 'NULL', chapter: 'NULL',
    slug: 't.rule_key', heading: "COALESCE(t.provision_heading, '')", principal_act: 'NULL', provision_text: 't.provision_text',
    source_start: 'NULL', source_end: 'NULL', locator: 't.provision_locator', human_explanation: 'NULL',
    category: "COALESCE(t.provision_category, 'other')", amends_section: 'NULL', effective_clue: 'NULL', cited_acts: "'[]'",
    relevant: '1', relevance_reason: 'NULL',
  },
  irish_tax_rules: {
    ...RETAINED_COMMON,
    id: 't.id', company_id: 't.company_id', provision_id: 't.id', tax_rate_id: 'NULL', vat_treatment_id: 'NULL',
    rule_key: 't.rule_key', rule_type: 't.rule_type', topic: 't.topic', tax_heads: 't.tax_heads', name: 't.name',
    statement: 't.statement', extracted_fact: 't.extracted_fact', human_explanation: 'NULL', numeric_value: 't.numeric_value',
    unit: 't.unit', qualifier: 't.qualifier', conditions: 't.conditions', exceptions: 't.exceptions', cross_references: "'[]'",
    accounting_effect: 't.accounting_effect', tax_effect: 't.tax_effect', vat_effect: 't.vat_effect', reporting_effect: 't.reporting_effect',
    requires_guidance: '0', human_review_required: '1', review_status: 't.review_status',
    reviewed_by: 'NULL', reviewed_at: 'NULL', review_notes: 'NULL', rule_version: 't.rule_version', supersedes_rule_id: 'NULL',
    // Never applied again: a lookup reads the store's version in force.
    priority: '100', enabled: '1', effective_from: 't.effective_from', effective_to: 't.effective_to', active: '0',
  },
};

function columnsOf(table: SQLiteTable): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

/** The SQL of one view: the store's rows for every company, then the book's frozen versions. */
export function visibleViewSql(entry: (typeof VIEWED)[number]): string {
  const columns = columnsOf(entry.table);
  const storeArm = STORE_ARM[entry.store] ?? {};
  const companies = 'company_id' in storeArm;
  const arms = [`SELECT ${[...columns.map((c) => `${storeArm[c] ?? `s.${c}`} AS ${c}`), `'store' AS origin`].join(', ')}
    FROM ${RULES_STORE_SCHEMA}.${entry.store} s${companies ? ' CROSS JOIN main.companies c' : ''}`];
  const retained = RETAINED_ARM[entry.store];
  if (retained) {
    const unmapped = columns.filter((c) => !(c in retained));
    if (unmapped.length > 0) throw new Error(`visibleRules: ${entry.store} has columns a retained version does not map: ${unmapped.join(', ')}.`);
    arms.push(`SELECT ${[...columns.map((c) => `${retained[c]} AS ${c}`), `'retained' AS origin`].join(', ')}
    FROM main.irish_rule_versions_retained t`);
  }
  return `CREATE TEMP VIEW ${entry.view} AS ${arms.join('\n  UNION ALL ')}`;
}

/**
 * Attach the rules store to a book's connection and create the views readers
 * query (see the module comment). Throws `RulesStoreOpenError`, leaving the
 * connection as it was, when the store cannot be used. Attaching again
 * replaces the store, for a test that builds its own.
 */
export function attachRulesStore(sqlite: Database.Database, params: { path?: string; root?: string } = {}): RulesStoreMeta {
  const path = params.path ?? rulesStorePath();
  assertExists(path);
  detachRulesStore(sqlite);
  try {
    sqlite.prepare(`ATTACH DATABASE ? AS ${RULES_STORE_SCHEMA}`).run(path);
  } catch (e) {
    throw new RulesStoreOpenError(`The rules store at ${path} cannot be read (${(e as Error).message}). ${REBUILD}`, 'unreadable');
  }
  const meta = checkedMeta(path, params.root,
    () => sqlite.prepare(`SELECT key, value FROM ${RULES_STORE_SCHEMA}.rules_store_meta`).all() as Array<{ key: string; value: string }>,
    () => detachRulesStore(sqlite));
  try {
    sqlite.transaction(() => {
      for (const entry of VIEWED) {
        for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
          sqlite.exec(`CREATE TEMP TRIGGER rules_store_read_only_${entry.store}_${op.toLowerCase()} BEFORE ${op} ON ${RULES_STORE_SCHEMA}.${entry.store}
            BEGIN SELECT RAISE(ABORT, 'The rules store is read-only (ADR-0021).'); END`);
        }
        sqlite.exec(visibleViewSql(entry));
      }
    })();
  } catch (e) {
    detachRulesStore(sqlite);
    throw e;
  }
  return meta;
}

/** Drop the views and triggers and detach the store, when one is attached. */
export function detachRulesStore(sqlite: Database.Database): void {
  for (const entry of VIEWED) {
    sqlite.exec(`DROP VIEW IF EXISTS temp.${entry.view}`);
    for (const op of ['insert', 'update', 'delete']) sqlite.exec(`DROP TRIGGER IF EXISTS temp.rules_store_read_only_${entry.store}_${op}`);
  }
  const attached = (sqlite.prepare('PRAGMA database_list').all() as Array<{ name: string }>).some((d) => d.name === RULES_STORE_SCHEMA);
  if (attached) sqlite.exec(`DETACH DATABASE ${RULES_STORE_SCHEMA}`);
}

/** The store attached to a connection, if any. */
export function attachedRulesStoreMeta(sqlite: Database.Database): RulesStoreMeta | null {
  const attached = (sqlite.prepare('PRAGMA database_list').all() as Array<{ name: string }>).some((d) => d.name === RULES_STORE_SCHEMA);
  if (!attached) return null;
  const values = Object.fromEntries((sqlite.prepare(`SELECT key, value FROM ${RULES_STORE_SCHEMA}.rules_store_meta`).all() as Array<{ key: string; value: string }>)
    .map((r) => [r.key, r.value]));
  return { format: Number(values.format), signature: values.signature ?? '', catalogueDigest: values.catalogue_digest ?? '', versions: Number(values.versions) };
}

/**
 * The one-time move of a book onto the install-level rules store (ADR-0021
 * §6, delivery step 2).
 *
 * A book holds a copy of every rule, numbered as it derived them. The store
 * holds every rule, numbered as the catalogue numbers it. This migration
 * writes what the book needs to keep once readers move to the store, and
 * nothing else:
 *
 * - **The version map.** Each of the book's rule versions is matched to the
 *   store version that says the same thing: the same dates, quote, value and
 *   unit. The pair goes to `irish_rule_version_map`. Decisions and posted
 *   lines keep the book's numbers and are read through the map; neither is
 *   rewritten.
 * - **Retained versions.** A book version no store version says the same as
 *   (a wording a later catalogue corrected, say) is copied, frozen, into
 *   `irish_rule_versions_retained` and raised as a review item. So is one
 *   that more than one store version matches: nothing picks between them
 *   silently (AGENTS.md #7).
 * - **Bindings.** `tax_rate_id` and `vat_treatment_id` move from the rule row
 *   to `irish_rule_bindings`, under the catalogue's version number.
 * - **The store seen.** The store's signature goes to `rules_store_seen`.
 *
 * It needs the store, so it is code rather than SQL, and it runs after a
 * backup (`createBackupSync`). It is append-only and safe to run again: a book
 * version already mapped or retained is left as it is, and a binding is
 * recorded again only when it changed. The book's copied tables are not
 * touched; they are dropped a release later (ADR-0021 §6).
 */
import type Database from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  auditEvents, invoiceLines, irishRuleBindings, irishRuleDecisions, irishRuleVersionMap,
  irishRuleVersionsRetained, irishTaxRules, rulesStoreSeen,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { createBackupSync, type BackupResult } from '../backup/backup';
import { upsertReviewItem } from '../extraction/service';
import { openRulesStore, type RulesStoreMeta } from './rulesStore';

type RetainedReason = (typeof irishRuleVersionsRetained.$inferInsert)['reason'];

export interface RulesStoreMigrationCompany {
  companyId: string;
  /** Book versions mapped to a catalogue version in this run, as `key@book → key@catalogue`. */
  mapped: Array<{ ruleKey: string; bookVersion: number; catalogueVersion: number }>;
  /** Book versions kept frozen in this run. */
  retained: Array<{ ruleKey: string; ruleVersion: number; reason: RetainedReason }>;
  /** Bindings recorded in this run. */
  bindings: number;
  /** Bindings on a retained version: not moved, since the store has no version to bind. Named in its review item. */
  unmovedBindings: Array<{ ruleKey: string; ruleVersion: number; taxRateId: string | null; vatTreatmentId: string | null }>;
}

export interface RulesStoreMigrationResult {
  backup: BackupResult;
  store: RulesStoreMeta;
  companies: RulesStoreMigrationCompany[];
}

/**
 * Back the book up, then move it onto the rules store. A store that cannot be
 * opened fails before the backup and before anything is written.
 */
export function migrateBookToRulesStore(
  db: AppDatabase,
  params: { storePath?: string; root?: string; backup?: Parameters<typeof createBackupSync>[1] } = {},
): RulesStoreMigrationResult {
  const store = openRulesStore({ path: params.storePath, root: params.root });
  try {
    const backup = createBackupSync(db, params.backup);
    const companies = applyRulesStoreMigration(db, store.sqlite, store.meta, backup);
    return { backup, store: store.meta, companies };
  } finally {
    store.sqlite.close();
  }
}

/**
 * Whether the book holds a copied rule row the move onto the store has not
 * yet mapped or kept: a book from before the store, or one whose copies were
 * loaded again since (loading stops in ADR-0021 delivery step 4).
 */
export function bookNeedsRulesStoreMigration(db: AppDatabase): boolean {
  return db.get<{ n: number } | undefined>(sql`SELECT 1 AS n FROM main.irish_tax_rules r
    WHERE NOT EXISTS (SELECT 1 FROM irish_rule_version_map m
        WHERE m.company_id = r.company_id AND m.rule_key = r.rule_key AND m.book_version = r.rule_version)
      AND NOT EXISTS (SELECT 1 FROM irish_rule_versions_retained t
        WHERE t.company_id = r.company_id AND t.rule_key = r.rule_key AND t.rule_version = r.rule_version)
    LIMIT 1`) !== undefined;
}

/**
 * Move the book onto the rules store when it is opened, if it needs it
 * (`bookNeedsRulesStoreMigration`): once, after a backup, before anything
 * reads it (`getDb`, `openBook`). A book with nothing to move is left as it is.
 */
export function moveBookOntoRulesStore(db: AppDatabase, params: { dbPath: string }): RulesStoreMigrationResult | null {
  if (!bookNeedsRulesStoreMigration(db)) return null;
  return migrateBookToRulesStore(db, { backup: { dbPath: params.dbPath } });
}

/** One of the book's rule rows, with where its provision sits. */
interface BookRuleRow {
  id: string;
  companyId: string;
  ruleKey: string;
  ruleVersion: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  statement: string | null;
  numericValue: number | null;
  unit: string | null;
  taxRateId: string | null;
  vatTreatmentId: string | null;
  citation: string;
  sha256: string;
  sectionNumber: string;
  sourceTitle: string;
  sourceType: (typeof irishRuleVersionsRetained.$inferInsert)['sourceType'];
  sourceUrl: string;
  sourceLocalPath: string | null;
  provisionHeading: string;
  provisionText: string | null;
  provisionLocator: string | null;
  provisionCategory: (typeof irishRuleVersionsRetained.$inferInsert)['provisionCategory'];
}

function applyRulesStoreMigration(
  db: AppDatabase,
  store: Database.Database,
  meta: RulesStoreMeta,
  backup: BackupResult,
): RulesStoreMigrationCompany[] {
  // The store versions of a key that say the same thing: dates, quote, value and unit.
  const sameContent = store.prepare(`SELECT rule_version AS version FROM irish_tax_rules
    WHERE rule_key = ? AND effective_from = ? AND effective_to IS ? AND statement IS ? AND numeric_value IS ? AND unit IS ?
    ORDER BY rule_version`);

  return db.transaction((tx) => {
    const now = nowIso();
    const latestSeen = tx.select({ signature: rulesStoreSeen.signature }).from(rulesStoreSeen)
      .orderBy(sql`rowid DESC`).get(); // insertion order: append-only, and a timestamp ties within a second
    if (latestSeen?.signature !== meta.signature) {
      tx.insert(rulesStoreSeen).values({
        id: ids.rulesStoreSeen(), signature: meta.signature, format: meta.format,
        catalogueDigest: meta.catalogueDigest, versions: meta.versions, seenAt: now,
      }).run();
    }

    const rows = tx.all<BookRuleRow>(sql`SELECT r.id, r.company_id AS companyId, r.rule_key AS ruleKey, r.rule_version AS ruleVersion,
        r.effective_from AS effectiveFrom, r.effective_to AS effectiveTo, r.statement, r.numeric_value AS numericValue, r.unit,
        r.tax_rate_id AS taxRateId, r.vat_treatment_id AS vatTreatmentId,
        s.citation, s.sha256, p.section_number AS sectionNumber,
        s.title AS sourceTitle, s.source_type AS sourceType, s.source_url AS sourceUrl, s.local_path AS sourceLocalPath,
        p.heading AS provisionHeading, p.provision_text AS provisionText, p.locator AS provisionLocator, p.category AS provisionCategory
      FROM irish_tax_rules r
      JOIN irish_act_provisions p ON p.id = r.provision_id
      JOIN irish_knowledge_sources s ON s.id = p.source_id
      ORDER BY r.company_id, r.rule_key, r.rule_version`);

    const results = new Map<string, RulesStoreMigrationCompany>();
    const resultFor = (companyId: string) => results.get(companyId)
      ?? results.set(companyId, { companyId, mapped: [], retained: [], bindings: 0, unmovedBindings: [] }).get(companyId)!;

    for (const row of rows) {
      const result = resultFor(row.companyId);
      const mapped = tx.select({ catalogueVersion: irishRuleVersionMap.catalogueVersion }).from(irishRuleVersionMap)
        .where(and(eq(irishRuleVersionMap.companyId, row.companyId), eq(irishRuleVersionMap.ruleKey, row.ruleKey), eq(irishRuleVersionMap.bookVersion, row.ruleVersion)))
        .get();
      const retained = tx.select({ id: irishRuleVersionsRetained.id }).from(irishRuleVersionsRetained)
        .where(and(eq(irishRuleVersionsRetained.companyId, row.companyId), eq(irishRuleVersionsRetained.ruleKey, row.ruleKey), eq(irishRuleVersionsRetained.ruleVersion, row.ruleVersion)))
        .get();

      let catalogueVersion = mapped?.catalogueVersion ?? null;
      if (!mapped && !retained) {
        const matches = (sameContent.all(row.ruleKey, row.effectiveFrom, row.effectiveTo, row.statement, row.numericValue, row.unit) as Array<{ version: number }>)
          .map((m) => m.version);
        if (matches.length === 1) {
          catalogueVersion = matches[0]!;
          tx.insert(irishRuleVersionMap).values({
            id: ids.ruleVersionMap(), companyId: row.companyId, ruleKey: row.ruleKey,
            bookVersion: row.ruleVersion, catalogueVersion, storeSignature: meta.signature,
          }).run();
          result.mapped.push({ ruleKey: row.ruleKey, bookVersion: row.ruleVersion, catalogueVersion });
        } else {
          const reason: RetainedReason = matches.length > 1 ? 'ambiguous'
            : row.effectiveTo !== null && row.effectiveTo <= row.effectiveFrom ? 'never_in_force' : 'no_store_version';
          retain(tx, row, reason, matches, meta, backup);
          result.retained.push({ ruleKey: row.ruleKey, ruleVersion: row.ruleVersion, reason });
        }
      }

      if (row.taxRateId === null && row.vatTreatmentId === null) continue;
      if (catalogueVersion === null) {
        result.unmovedBindings.push({ ruleKey: row.ruleKey, ruleVersion: row.ruleVersion, taxRateId: row.taxRateId, vatTreatmentId: row.vatTreatmentId });
        continue;
      }
      const held = tx.select().from(irishRuleBindings)
        .where(and(eq(irishRuleBindings.companyId, row.companyId), eq(irishRuleBindings.ruleKey, row.ruleKey), eq(irishRuleBindings.ruleVersion, catalogueVersion)))
        .orderBy(sql`rowid DESC`).get();
      if (held && held.taxRateId === row.taxRateId && held.vatTreatmentId === row.vatTreatmentId) continue;
      tx.insert(irishRuleBindings).values({
        id: ids.ruleBinding(), companyId: row.companyId, ruleKey: row.ruleKey, ruleVersion: catalogueVersion,
        taxRateId: row.taxRateId, vatTreatmentId: row.vatTreatmentId,
        effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, recordedBy: 'rules_store_migration',
      }).run();
      result.bindings += 1;
    }

    for (const result of results.values()) {
      if (result.mapped.length === 0 && result.retained.length === 0 && result.bindings === 0) continue;
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: result.companyId, occurredAt: now,
        entityType: 'rules_store', entityId: meta.signature, action: 'mapped',
        newValue: JSON.stringify({ mapped: result.mapped.length, retained: result.retained.length, bindings: result.bindings, backupVersion: backup.version }),
        source: 'system', actor: 'rules-store-migration',
        reason: `Moved onto the rules store (ADR-0021) after backup v${backup.version}.`,
      }).run();
    }
    return [...results.values()];
  });
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** Copy a book version, frozen, and raise it for review unless it was never in force and nothing refers to it. */
function retain(tx: Tx, row: BookRuleRow, reason: RetainedReason, matches: number[], meta: RulesStoreMeta, backup: BackupResult): void {
  const full = tx.select().from(irishTaxRules).where(eq(irishTaxRules.id, row.id)).get()!;
  const id = ids.ruleVersionRetained();
  tx.insert(irishRuleVersionsRetained).values({
    id, companyId: row.companyId, ruleKey: row.ruleKey, ruleVersion: row.ruleVersion, bookRuleId: row.id, reason,
    sourceCitation: row.citation, sourceSha256: row.sha256, sectionNumber: row.sectionNumber,
    ruleType: full.ruleType, topic: full.topic, taxHeads: full.taxHeads, name: full.name, statement: full.statement,
    extractedFact: full.extractedFact, numericValue: full.numericValue, unit: full.unit, qualifier: full.qualifier,
    conditions: full.conditions, exceptions: full.exceptions, accountingEffect: full.accountingEffect, taxEffect: full.taxEffect,
    vatEffect: full.vatEffect, reportingEffect: full.reportingEffect, reviewStatus: full.reviewStatus,
    effectiveFrom: full.effectiveFrom, effectiveTo: full.effectiveTo,
    sourceTitle: row.sourceTitle, sourceType: row.sourceType, sourceUrl: row.sourceUrl, sourceLocalPath: row.sourceLocalPath,
    provisionHeading: row.provisionHeading, provisionText: row.provisionText, provisionLocator: row.provisionLocator,
    provisionCategory: row.provisionCategory,
  }).run();
  const versionId = `${row.ruleKey}@${row.ruleVersion}`;
  const decisions = tx.select({ id: irishRuleDecisions.id }).from(irishRuleDecisions)
    .where(and(eq(irishRuleDecisions.companyId, row.companyId), eq(irishRuleDecisions.ruleKey, row.ruleKey), eq(irishRuleDecisions.ruleVersion, row.ruleVersion)))
    .all().length;
  const lines = tx.select({ versions: invoiceLines.vatRuleVersions }).from(invoiceLines)
    .where(eq(invoiceLines.companyId, row.companyId)).all()
    .filter((l) => l.versions.includes(versionId)).length;
  const used = [
    ...(decisions > 0 ? [`${decisions} review decision${decisions === 1 ? '' : 's'}`] : []),
    ...(lines > 0 ? [`${lines} invoice line${lines === 1 ? '' : 's'}`] : []),
  ];
  const binding = row.taxRateId !== null || row.vatTreatmentId !== null;
  // A version closed the day it opened (a correction closes the old wording so) has nothing to check,
  // unless something applied it, or was decided on it, before it was closed.
  if (reason === 'never_in_force' && used.length === 0 && !binding) return;
  upsertReviewItem(tx, {
    companyId: row.companyId,
    kind: 'other',
    severity: 'warning',
    title: reason === 'ambiguous'
      ? `Rule version ${versionId} matches more than one version in the rules store`
      : `Rule version ${versionId} is not in the rules store`,
    detail: `This book holds ${versionId} (${row.citation} s.${row.sectionNumber}, in force from ${row.effectiveFrom}${row.effectiveTo ? ` to ${row.effectiveTo}` : ''}). `
      + (reason === 'ambiguous'
        ? `The rules store installed with this version of Leabhar holds more than one version saying the same thing (${matches.map((m) => `${row.ruleKey}@${m}`).join(', ')}), so none was chosen. `
        : reason === 'never_in_force'
          ? 'It was closed the day it opened, as a correction closes an old wording, and the rules store installed with this version of Leabhar does not carry it. '
          : 'The rules store installed with this version of Leabhar holds no version with the same dates, wording, value and unit; a later catalogue may have corrected it. ')
      + 'The version is kept in the book, frozen as it was, so '
      + (used.length > 0 ? `the ${used.join(' and ')} that refer to it can still be explained. ` : 'anything that applied it can still be explained. ')
      + (binding ? 'It was bound to this book\'s rate or VAT treatment; the binding is not moved, since the store has no version to bind. ' : '')
      + `Nothing was switched to another version. A backup was taken first (v${backup.version}). `
      + 'Check the version against the source before relying on it.',
    entityType: 'irish_rule_version_retained',
    entityId: id,
    dedupeKey: `rule_version_retained:${versionId}`,
    context: {
      versionId, reason, storeVersions: matches.map((m) => `${row.ruleKey}@${m}`), storeSignature: meta.signature,
      decisions, invoiceLines: lines, taxRateId: row.taxRateId, vatTreatmentId: row.vatTreatmentId, backupVersion: backup.version,
    },
  });
}

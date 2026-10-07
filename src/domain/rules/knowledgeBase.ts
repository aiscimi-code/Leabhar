/**
 * The statutory knowledge base's derive pipeline (issue #200 step 3), and the
 * checks on the files it cites.
 *
 * `deriveStatutoryKnowledgeBase` runs every ingest and derive step from the
 * rules catalogue (`catalogue/`, #556) into a book's own rule tables. That is
 * how the rules store is built (`buildRulesStore`, ADR-0021 §1): against an
 * empty book, at package time or by `npm run rules:build`. A book no longer
 * loads rules (ADR-0021 §7); it reads the store the install shipped.
 *
 * Every step is idempotent by content (a source already ingested with the
 * same SHA-256 is a no-op, and an unchanged curated rule is left alone). It
 * never approves a rule: everything it derives starts `ai_extracted`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { sha256Hex } from '@/lib/hash';
import { appRoot } from '@/lib/paths';
import { irishTaxRules } from '@/db/schema';
import { ensureDefaultVatTreatments } from '../config/setup';
import { deriveTaxRules } from './irishRules';
import { deriveVatcaRules } from './vatcaIngestion';
import { deriveVatcaScheduleRules } from './vatcaScheduleIngestion';
import { deriveRctRules } from './rctIngestion';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules } from './vatcaRevisedIngestion';
import { deriveCapitalAllowancesRules } from './capitalAllowancesIngestion';
import { deriveSi639Rules } from './si639Ingestion';
import { deriveSi156CapacityExclusionRule, deriveSi156Rules } from './si156Ingestion';
import { deriveSi692025Rules } from './si692025Ingestion';
import { deriveFinanceAct2024VatThresholds } from './financeAct2024VatThresholdsIngestion';
import { deriveTdm3801_03bCapacityExclusionRule } from './tdm3801_03bIngestion';
import { deriveVatScopeRules } from './vatScopeIngestion';
import { deriveCorporationTaxRules } from './tcaNfgIngestion';
import { deriveIncomeTaxRules } from './incomeTaxIngestion';
import { deriveCompaniesAct2014Rules } from './companiesAct2014Ingestion';
import { deriveVat3RtdRules } from './vat3RtdIngestion';
import { deriveEbriefRules } from './ebriefIngestion';
import { deriveEu282Rules } from './eu282Ingestion';
import { derivePayrollRules } from './payrollIngestion';
import { deriveSizeCriteriaRules } from './sizeCriteriaIngestion';
import { deriveCuratedRuleFamilies } from './incomeTaxIngestion';
import { CAR_EMISSIONS_CURATED_RULES } from './carEmissionsCuration';
import { syncRuleLinks } from './ruleLinks';
import { taxHeadsFor } from './taxHeads';
import { CATALOGUE_DIR, CATALOGUE_ENTRIES, catalogueEntryPath, catalogueOfficialFilePath, ingestCatalogueFile, readCatalogueEntry } from './catalogue';

/** Derive steps, in the order the CLI documents them (thresholds after FA 2024 is ingested). */
const DERIVES: Array<(db: AppDatabase, params: { companyId: string }) => unknown> = [
  deriveTaxRules,
  deriveVatcaRules,
  (db, p) => deriveVatcaScheduleRules(db, { ...p, scheduleNumber: '2' }),
  (db, p) => deriveVatcaScheduleRules(db, { ...p, scheduleNumber: '3' }),
  deriveRctRules,
  deriveVatcaRevisedRules,
  deriveCapitalAllowancesRules,
  deriveSi639Rules,
  deriveSi156Rules,
  deriveSi692025Rules,
  deriveFinanceAct2024VatThresholds,
  deriveTdm3801_03bCapacityExclusionRule,
  deriveSi156CapacityExclusionRule,
  deriveCompaniesAct2014Rules,
  deriveVatScopeRules,
  deriveCorporationTaxRules,
  deriveIncomeTaxRules,
  deriveVat3RtdRules,
  deriveEbriefRules,
  deriveEu282Rules,
  derivePayrollRules,
  deriveSizeCriteriaRules,
  (db, p) => deriveCuratedRuleFamilies(db, { companyId: p.companyId, rules: CAR_EMISSIONS_CURATED_RULES, label: 'capital allowances' }),
];

/** Resolve a repo-relative statute path against the running app's root (the install directory when packaged). */
export function statuteFilePath(localPath: string, root: string = appRoot()): string {
  // Older ingests stored absolute build-machine paths; anchor on docs/statutes/.
  const at = localPath.indexOf('docs/statutes/');
  return join(root, at >= 0 ? localPath.slice(at) : localPath);
}

/** How many rule versions the book's own copied tables hold for a company: what the derive pipeline wrote. */
export function countStatutoryRules(db: AppDatabase, companyId: string): number {
  return db.select({ n: sql<number>`count(*)` }).from(irishTaxRules)
    .where(eq(irishTaxRules.companyId, companyId)).get()?.n ?? 0;
}

/**
 * Give a rule stored before tax heads were recorded (issue #686 step 9) its
 * heads. Only an empty list is filled; a stated one is never overwritten.
 */
export function fillTaxHeads(db: AppDatabase, params: { companyId: string }): number {
  let filled = 0;
  for (const r of db.select({ id: irishTaxRules.id, ruleKey: irishTaxRules.ruleKey, topic: irishTaxRules.topic, taxHeads: irishTaxRules.taxHeads })
    .from(irishTaxRules).where(eq(irishTaxRules.companyId, params.companyId)).all()) {
    if (r.taxHeads.length > 0) continue;
    const heads = taxHeadsFor(r.ruleKey, r.topic);
    if (heads.length === 0) continue;
    db.update(irishTaxRules).set({ taxHeads: heads }).where(eq(irishTaxRules.id, r.id)).run();
    filled += 1;
  }
  return filled;
}

/**
 * Run the derive pipeline into the book's own rule tables: the copies the
 * store is built from (`buildRulesStore`). Writes only; it reads no rules
 * through the store, so it runs where none is attached. The app never runs it
 * against a book: a book reads the store the install shipped (ADR-0021 §7).
 */
export function deriveStatutoryKnowledgeBase(
  db: AppDatabase,
  params: { companyId: string; root?: string; ingestVersion?: string },
): { sourcesProcessed: number; rulesBefore: number; rulesAfter: number } {
  const rulesBefore = countStatutoryRules(db, params.companyId);
  // A rule can only suggest a treatment the company has: add any seeded since
  // it was created (issue #205, the livestock treatment).
  ensureDefaultVatTreatments(db, params.companyId);
  const ingestVersion = params.ingestVersion ?? 'v1';
  // Every source loads from the rules catalogue (#443, #556); none reads a
  // statute copy. A copy a book loaded before its port stays held, and is
  // superseded by its entry (catalogueSupersession.ts, #706).
  for (const entry of CATALOGUE_ENTRIES) {
    ingestCatalogueFile(db, { companyId: params.companyId, entry, ingestVersion, root: params.root });
  }
  for (const derive of DERIVES) derive(db, { companyId: params.companyId });
  // The links between rules (ADR-0020), after every rule they name exists.
  syncRuleLinks(db, { companyId: params.companyId });
  fillTaxHeads(db, { companyId: params.companyId });
  return { sourcesProcessed: CATALOGUE_ENTRIES.length, rulesBefore, rulesAfter: countStatutoryRules(db, params.companyId) };
}

export interface StatuteFileCheck {
  /** Where the file was looked for. */
  path: string | null;
  exists: boolean;
  /** SHA-256 of the file now, compared with the one recorded at ingest. */
  computedSha256: string | null;
  sha256Matches: boolean;
  /** The file's text between the provision's stored offsets. */
  slice: string | null;
}

/**
 * Re-check a cited statute file rather than trusting the stored row
 * (AGENTS.md #5): does it still exist, is it byte-for-byte what was ingested,
 * and what do the stored offsets actually slice?
 */
export function verifyStatuteFile(
  localPath: string | null,
  expectedSha256: string,
  sourceStart: number | null,
  sourceEnd: number | null,
  root?: string,
  sectionNumber?: string,
): StatuteFileCheck {
  if (!localPath) return { path: null, exists: false, computedSha256: null, sha256Matches: false, slice: null };
  // A source ported to the catalogue: re-hash the official file kept beside
  // its entry, and slice the provision's excerpt. Whether the publisher's
  // file still matches is `verify-sources` (online, opt-in).
  if (localPath.startsWith(`${CATALOGUE_DIR}/`)) {
    const entryName = localPath.slice(CATALOGUE_DIR.length + 1);
    const path = catalogueOfficialFilePath(entryName, root);
    if (!existsSync(path) || !existsSync(catalogueEntryPath(entryName, root))) {
      return { path, exists: false, computedSha256: null, sha256Matches: false, slice: null };
    }
    const computedSha256 = sha256Hex(readFileSync(path));
    const entry = readCatalogueEntry(entryName, root);
    const provision = entry.provisions.find((p) => p.sectionNumber === sectionNumber) ?? (entry.provisions.length === 1 ? entry.provisions[0] : undefined);
    return {
      path,
      exists: true,
      computedSha256,
      sha256Matches: computedSha256 === expectedSha256 && entry.source.sha256 === expectedSha256,
      slice: provision?.excerpt ?? null,
    };
  }
  const path = statuteFilePath(localPath, root);
  if (!existsSync(path)) return { path, exists: false, computedSha256: null, sha256Matches: false, slice: null };
  const text = readFileSync(path, 'utf8');
  const computedSha256 = sha256Hex(text);
  return {
    path,
    exists: true,
    computedSha256,
    sha256Matches: computedSha256 === expectedSha256,
    slice: sourceStart != null && sourceEnd != null ? text.slice(sourceStart, sourceEnd) : null,
  };
}

/**
 * Load the whole statutory knowledge base for a company in one call
 * (issue #200 step 3).
 *
 * Until this existed, the only way to get `irish_tax_rules` rows into a
 * company's database was to run about forty `npm run cli:rules -- ingest` /
 * `extract` commands by hand, in the right order, and nothing in the import →
 * match → classify workflow ever did — so the lookup the transaction screen
 * now uses had nothing to look up. This function runs exactly the set of
 * ingest and derive steps the CLI exposes, from the same `docs/statutes`
 * files, so the web app, the agent CLI and the traceability audit
 * (`scripts/rule-traceability-dump.ts`) all see the same 68 rules.
 *
 * Every step is idempotent by content (a source already ingested with the
 * same SHA-256 is a no-op, and an unchanged curated rule is left alone), so
 * calling this again is safe and is how a company picks up newly curated
 * rules. It never approves a rule: everything it derives starts
 * `ai_extracted`, exactly as the individual CLI steps do.
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
import { deriveSi156Rules } from './si156Ingestion';
import { deriveSi692025Rules } from './si692025Ingestion';
import { deriveFinanceAct2024VatThresholds } from './financeAct2024VatThresholdsIngestion';
import { deriveTdm3801_03bCapacityExclusionRule } from './tdm3801_03bIngestion';
import { deriveVatScopeRules } from './vatScopeIngestion';
import { deriveCorporationTaxRules } from './tcaNfgIngestion';
import { ingestSwcaSection, deriveIncomeTaxRules, SWCA_SECTIONS, swcaPath } from './incomeTaxIngestion';
import { deriveCompaniesAct2014Rules } from './companiesAct2014Ingestion';
import { ingestVat3ReturnGuidance, ingestRtdTdm, deriveVat3RtdRules } from './vat3RtdIngestion';
import { ingestEbrief168_25, deriveEbriefRules } from './ebriefIngestion';
import { ingestEu282Articles, deriveEu282Rules, EU_282_2011_MD_PATH } from './eu282Ingestion';
import { ingestPayrollSource, derivePayrollRules, PAYROLL_SOURCES } from './payrollIngestion';
import { ingestSizeCriteriaSource, deriveSizeCriteriaRules, SIZE_CRITERIA_SOURCES } from './sizeCriteriaIngestion';
import { ingestSlicedSource } from './slicedSourceIngestion';
import { deriveCuratedRuleFamilies } from './incomeTaxIngestion';
import { CAR_EMISSIONS_SOURCES, CAR_EMISSIONS_CURATED_RULES } from './carEmissionsCuration';
import { syncRuleLinks } from './ruleLinks';
import { taxHeadsFor } from './taxHeads';
import { CATALOGUE_DIR, CATALOGUE_ENTRIES, catalogueEntryPath, catalogueOfficialFilePath, ingestCatalogueFile, readCatalogueEntry } from './catalogue';
import { checkCatalogueVersions } from './ruleDecisions';

type IngestParams = { companyId: string; markdown: string; ingestVersion: string; localPath: string };
type IngestFn = (db: AppDatabase, params: IngestParams) => unknown;

/**
 * Every source file, as a path relative to the repository root. Stored as
 * `localPath` in that relative form (not an absolute build-machine path), so
 * the provision viewer can resolve it wherever the app runs.
 */
const SOURCES: Array<{ path: string; ingest: IngestFn }> = [
  ...SWCA_SECTIONS.map((n) => ({ path: swcaPath(n), ingest: ingestSwcaSection as IngestFn })),
  { path: 'docs/statutes/vat3-rtd/completing-vat3-return.md', ingest: ingestVat3ReturnGuidance },
  { path: 'docs/statutes/vat3-rtd/VAT-RTD-S76.md', ingest: ingestRtdTdm },
  { path: 'docs/statutes/ebriefs/2025/no-168-25.md', ingest: ingestEbrief168_25 },
  { path: EU_282_2011_MD_PATH, ingest: ingestEu282Articles },
  ...PAYROLL_SOURCES.map((s) => ({ path: s.path, ingest: ingestPayrollSource as IngestFn })),
  ...SIZE_CRITERIA_SOURCES.map((s) => ({ path: s.path, ingest: ingestSizeCriteriaSource as IngestFn })),
  ...CAR_EMISSIONS_SOURCES.map((s) => ({
    path: s.path,
    ingest: ((db, p) => ingestSlicedSource(db, CAR_EMISSIONS_SOURCES,
      'Emissions-based limits on capital allowances for cars (TCA Part 11C; issue #466).', p)) as IngestFn,
  })),
];

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

/** Every path `loadStatutoryKnowledgeBase` ingests, unique, repo-relative. */
export function statuteSourcePaths(): string[] {
  return [...new Set(SOURCES.map((s) => s.path))];
}

/** Resolve a repo-relative statute path against the running app's root (the install directory when packaged). */
export function statuteFilePath(localPath: string, root: string = appRoot()): string {
  // Older ingests stored absolute build-machine paths; anchor on docs/statutes/.
  const at = localPath.indexOf('docs/statutes/');
  return join(root, at >= 0 ? localPath.slice(at) : localPath);
}

export interface KnowledgeBaseLoadResult {
  sourcesProcessed: number;
  rulesBefore: number;
  rulesAfter: number;
  /** Rule versions the book references that the installed catalogue does not ship; each raised as a review item. */
  catalogueVersionsMissing: string[];
}

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

export function loadStatutoryKnowledgeBase(
  db: AppDatabase,
  params: { companyId: string; root?: string; ingestVersion?: string },
): KnowledgeBaseLoadResult {
  const rulesBefore = countStatutoryRules(db, params.companyId);
  // A rule can only suggest a treatment the company has: add any seeded since
  // it was created (issue #205, the livestock treatment).
  ensureDefaultVatTreatments(db, params.companyId);
  const ingestVersion = params.ingestVersion ?? 'v1';
  // Sources ported to the rules catalogue (#443, #556) load from it; the rest
  // still read their statute copy until they are ported.
  for (const entry of CATALOGUE_ENTRIES) {
    ingestCatalogueFile(db, { companyId: params.companyId, entry, ingestVersion, root: params.root });
  }
  for (const source of SOURCES) {
    const markdown = readFileSync(statuteFilePath(source.path, params.root), 'utf8');
    source.ingest(db, { companyId: params.companyId, markdown, ingestVersion, localPath: source.path });
  }
  for (const derive of DERIVES) derive(db, { companyId: params.companyId });
  // The links between rules (ADR-0020), after every rule they name exists.
  syncRuleLinks(db, { companyId: params.companyId });
  fillTaxHeads(db, { companyId: params.companyId });
  const missing = checkCatalogueVersions(db, { companyId: params.companyId, root: params.root });
  return {
    sourcesProcessed: CATALOGUE_ENTRIES.length + SOURCES.length,
    rulesBefore,
    rulesAfter: countStatutoryRules(db, params.companyId),
    catalogueVersionsMissing: missing.map((m) => m.versionId),
  };
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

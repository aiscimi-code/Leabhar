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
import { ingestFinanceAct2024, ingestFinanceAct2025, deriveTaxRules } from './irishRules';
import { ingestVatca2010, deriveVatcaRules } from './vatcaIngestion';
import { ingestVatcaSchedule, deriveVatcaScheduleRules } from './vatcaScheduleIngestion';
import {
  ingestTca1997S530, ingestTca1997S530A, ingestTca1997S530E, ingestTca1997S530G, ingestTca1997S530H,
  ingestTca1997S530I, ingestRctTdm18_02_04, ingestRctTdm18_02_05, ingestRctTdm18_02_11, deriveRctRules,
} from './rctIngestion';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules } from './vatcaRevisedIngestion';
import { ingestTca1997S284, ingestFinanceAct2003S23, deriveCapitalAllowancesRules } from './capitalAllowancesIngestion';
import { ingestSi639, deriveSi639Rules } from './si639Ingestion';
import { ingestSi156, deriveSi156Rules } from './si156Ingestion';
import {
  ingestSi692025Reg5, ingestSi692025Reg7, ingestSi692025Reg8, ingestSi692025Reg9, deriveSi692025Rules,
} from './si692025Ingestion';
import { deriveFinanceAct2024VatThresholds } from './financeAct2024VatThresholdsIngestion';
import { ingestTdm3801_03bCapacityExclusion, deriveTdm3801_03bCapacityExclusionRule } from './tdm3801_03bIngestion';
import { deriveVatScopeRules } from './vatScopeIngestion';
import {
  ingestCompaniesAct2014Section, deriveCompaniesAct2014Rules, COMPANIES_ACT_2014_SECTION_NUMBERS,
} from './companiesAct2014Ingestion';

type IngestParams = { companyId: string; markdown: string; ingestVersion: string; localPath: string };
type IngestFn = (db: AppDatabase, params: IngestParams) => unknown;

/**
 * Every source file, as a path relative to the repository root. Stored as
 * `localPath` in that relative form (not an absolute build-machine path), so
 * the provision viewer can resolve it wherever the app runs.
 */
const SOURCES: Array<{ path: string; ingest: IngestFn }> = [
  { path: 'docs/statutes/finance-act-2024/2024-act-43-enacted.md', ingest: ingestFinanceAct2024 },
  { path: 'docs/statutes/finance-act-2025/2025-act-18-enacted.md', ingest: ingestFinanceAct2025 },
  { path: 'docs/statutes/vatca-2010/vatca-2010-enacted.md', ingest: ingestVatca2010 },
  {
    path: 'docs/statutes/vatca-2010-revised/schedule-1.md',
    ingest: (db, p) => ingestVatcaSchedule(db, { ...p, scheduleNumber: '1' }),
  },
  {
    path: 'docs/statutes/vatca-2010-revised/schedule-2.md',
    ingest: (db, p) => ingestVatcaSchedule(db, { ...p, scheduleNumber: '2' }),
  },
  {
    path: 'docs/statutes/vatca-2010-revised/schedule-3.md',
    ingest: (db, p) => ingestVatcaSchedule(db, { ...p, scheduleNumber: '3' }),
  },
  { path: 'docs/statutes/tca-1997/s530.md', ingest: ingestTca1997S530 },
  { path: 'docs/statutes/tca-1997/s530A.md', ingest: ingestTca1997S530A },
  { path: 'docs/statutes/tca-1997/s530E.md', ingest: ingestTca1997S530E },
  { path: 'docs/statutes/tca-1997/s530G.md', ingest: ingestTca1997S530G },
  { path: 'docs/statutes/tca-1997/s530H.md', ingest: ingestTca1997S530H },
  { path: 'docs/statutes/tca-1997/s530I.md', ingest: ingestTca1997S530I },
  { path: 'docs/statutes/rct/tdm-18-02-04.md', ingest: ingestRctTdm18_02_04 },
  { path: 'docs/statutes/rct/tdm-18-02-05.md', ingest: ingestRctTdm18_02_05 },
  { path: 'docs/statutes/rct/tdm-18-02-11.md', ingest: ingestRctTdm18_02_11 },
  { path: 'docs/statutes/vatca-2010-revised/s046.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s047.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s009.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s010.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s030.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s035.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s016.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s080.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s094.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s097.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s064.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s043.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s059.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s060.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s061.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s062.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s066.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s086.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s087.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s088.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s089.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s002.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s003.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/vatca-2010-revised/s034.md', ingest: ingestVatcaRevisedSection },
  { path: 'docs/statutes/tca-1997/s284.md', ingest: ingestTca1997S284 },
  { path: 'docs/statutes/finance-act-2003/s23.md', ingest: ingestFinanceAct2003S23 },
  { path: 'docs/statutes/si-639-2010/2010-si-639.md', ingest: ingestSi639 },
  { path: 'docs/statutes/si-156-2012/2012-si-156.md', ingest: ingestSi156 },
  { path: 'docs/statutes/si-69-2025/2025-si-69.md', ingest: ingestSi692025Reg5 },
  { path: 'docs/statutes/si-69-2025/2025-si-69.md', ingest: ingestSi692025Reg7 },
  { path: 'docs/statutes/si-69-2025/2025-si-69.md', ingest: ingestSi692025Reg8 },
  { path: 'docs/statutes/si-69-2025/2025-si-69.md', ingest: ingestSi692025Reg9 },
  { path: 'docs/statutes/tdm-38-01-03b/38-01-03b.md', ingest: ingestTdm3801_03bCapacityExclusion },
  ...COMPANIES_ACT_2014_SECTION_NUMBERS.map((n) => ({
    path: `docs/statutes/companies-act-2014/s${n}.md`,
    ingest: ingestCompaniesAct2014Section as IngestFn,
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
];

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
}

export function countStatutoryRules(db: AppDatabase, companyId: string): number {
  return db.select({ n: sql<number>`count(*)` }).from(irishTaxRules)
    .where(eq(irishTaxRules.companyId, companyId)).get()?.n ?? 0;
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
  for (const source of SOURCES) {
    const markdown = readFileSync(statuteFilePath(source.path, params.root), 'utf8');
    source.ingest(db, { companyId: params.companyId, markdown, ingestVersion, localPath: source.path });
  }
  for (const derive of DERIVES) derive(db, { companyId: params.companyId });
  return {
    sourcesProcessed: SOURCES.length,
    rulesBefore,
    rulesAfter: countStatutoryRules(db, params.companyId),
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
): StatuteFileCheck {
  if (!localPath) return { path: null, exists: false, computedSha256: null, sha256Matches: false, slice: null };
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

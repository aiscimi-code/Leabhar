/**
 * Golden accounting test case suite (docs/trust TRUST_MODEL.md, Work Package 03).
 *
 * Loads every JSON case from `./cases/*.json` via vitest's import.meta.glob,
 * seeds a fresh in-memory database with the rule KB ingested, and runs each
 * case through the golden runner.
 *
 * Each case is a separate `it` block so failures are individually traceable
 * in the test output. The case id and description appear as the test name.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import {
  ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH,
} from '@/domain/rules/irishRules';
import {
  ingestVatca2010, deriveVatcaRules, VATCA_2010_MD_PATH,
} from '@/domain/rules/vatcaIngestion';
import {
  ingestVatcaRevisedSection, deriveVatcaRevisedRules,
  VATCA_REVISED_S046_MD_PATH,
} from '@/domain/rules/vatcaRevisedIngestion';
import {
  ingestVatcaSchedule, deriveVatcaScheduleRules,
  VATCA_SCHEDULE_2_MD_PATH, VATCA_SCHEDULE_3_MD_PATH,
} from '@/domain/rules/vatcaScheduleIngestion';
import {
  ingestSi692025Reg5, ingestSi692025Reg8, ingestSi692025Reg9,
  deriveSi692025Rules, SI_69_2025_MD_PATH,
} from '@/domain/rules/si692025Ingestion';
import {
  deriveFinanceAct2024VatThresholds,
} from '@/domain/rules/financeAct2024VatThresholdsIngestion';
import {
  ingestSi639, deriveSi639Rules, SI_639_2010_MD_PATH,
} from '@/domain/rules/si639Ingestion';
import {
  ingestSi156, deriveSi156Rules, SI_156_2012_MD_PATH,
} from '@/domain/rules/si156Ingestion';
import {
  ingestTca1997S284, deriveCapitalAllowancesRules,
  TCA_1997_S284_MD_PATH,
} from '@/domain/rules/capitalAllowancesIngestion';
import {
  ingestRctTdm18_02_04, ingestRctTdm18_02_05, ingestRctTdm18_02_11,
  deriveRctRules, TCA_1997_S530_MD_PATH,
} from '@/domain/rules/rctIngestion';
import {
  ingestTdm3801_03bCapacityExclusion,
  deriveTdm3801_03bCapacityExclusionRule,
  TDM_38_01_03B_MD_PATH,
} from '@/domain/rules/tdm3801_03bIngestion';
import { deriveVatScopeRules } from '@/domain/rules/vatScopeIngestion';
import { runGoldenCase } from './runner';
import type { GoldenCase } from './types';
import type { AppDatabase } from '@/db';

// Load all golden case JSON files.
// import.meta.glob with query:'raw' returns the raw file content wrapped in
// an object under `.default` in vitest.
const caseModules = import.meta.glob('./cases/*.json', { eager: true, query: 'raw' }) as Record<string, { default: string }>;
const caseFiles = Object.entries(caseModules);

let db: AppDatabase;
let companyId: string;
let accountsByCode: Record<string, string>;
let accountsByKey: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Golden Case Ltd',
    vatRegistrationStatus: 'registered',
    vatNumber: 'IE1234567T',
    seedYears: [2025, 2026],
  });
  companyId = created.companyId;
  accountsByCode = created.accountsByCode;
  accountsByKey = created.accountsByKey;

  // Ingest the full rule KB so every golden case has the rules it references.
  // This mirrors the setup used by src/domain/rules/transactionLookup.test.ts
  // plus the additional sources (RCT, TCA s.284, TDM 38-01-03b) that some
  // golden cases reference.
  const faMd = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
  ingestFinanceAct2024(db, { companyId, markdown: faMd, ingestVersion: 'v1' });
  deriveTaxRules(db, { companyId });

  const vatcaMd = readFileSync(VATCA_2010_MD_PATH, 'utf8');
  ingestVatca2010(db, { companyId, markdown: vatcaMd, ingestVersion: 'v1' });
  deriveVatcaRules(db, { companyId });

  const s46Md = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');
  ingestVatcaRevisedSection(db, { companyId, markdown: s46Md, ingestVersion: 'v1' });
  deriveVatcaRevisedRules(db, { companyId });
  // Input VAT recovery comes from the revised s.59/s.60 (issue #209).
  for (const n of ['059', '060']) {
    ingestVatcaRevisedSection(db, { companyId, markdown: readFileSync(`docs/statutes/vatca-2010-revised/s${n}.md`, 'utf8'), ingestVersion: 'v1' });
  }
  deriveVatScopeRules(db, { companyId });

  const sch2Md = readFileSync(VATCA_SCHEDULE_2_MD_PATH, 'utf8');
  const sch3Md = readFileSync(VATCA_SCHEDULE_3_MD_PATH, 'utf8');
  ingestVatcaSchedule(db, { companyId, scheduleNumber: '2', markdown: sch2Md, ingestVersion: 'v1' });
  deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '2' });
  ingestVatcaSchedule(db, { companyId, scheduleNumber: '3', markdown: sch3Md, ingestVersion: 'v1' });
  deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '3' });

  const si69Md = readFileSync(SI_69_2025_MD_PATH, 'utf8');
  ingestSi692025Reg5(db, { companyId, markdown: si69Md, ingestVersion: 'v1' });
  ingestSi692025Reg8(db, { companyId, markdown: si69Md, ingestVersion: 'v1' });
  ingestSi692025Reg9(db, { companyId, markdown: si69Md, ingestVersion: 'v1' });
  deriveSi692025Rules(db, { companyId });

  deriveFinanceAct2024VatThresholds(db, { companyId });

  const si639Md = readFileSync(SI_639_2010_MD_PATH, 'utf8');
  ingestSi639(db, { companyId, markdown: si639Md, ingestVersion: 'v1' });
  deriveSi639Rules(db, { companyId });

  const si156Md = readFileSync(SI_156_2012_MD_PATH, 'utf8');
  ingestSi156(db, { companyId, markdown: si156Md, ingestVersion: 'v1' });
  deriveSi156Rules(db, { companyId });

  const tca284Md = readFileSync(TCA_1997_S284_MD_PATH, 'utf8');
  ingestTca1997S284(db, { companyId, markdown: tca284Md, ingestVersion: 'v1' });
  deriveCapitalAllowancesRules(db, { companyId });

  const rctMd = readFileSync(TCA_1997_S530_MD_PATH, 'utf8');
  ingestRctTdm18_02_04(db, { companyId, markdown: rctMd, ingestVersion: 'v1' });
  ingestRctTdm18_02_05(db, { companyId, markdown: rctMd, ingestVersion: 'v1' });
  ingestRctTdm18_02_11(db, { companyId, markdown: rctMd, ingestVersion: 'v1' });
  deriveRctRules(db, { companyId });

  const tdmMd = readFileSync(TDM_38_01_03B_MD_PATH, 'utf8');
  ingestTdm3801_03bCapacityExclusion(db, { companyId, markdown: tdmMd, ingestVersion: 'v1' });
  deriveTdm3801_03bCapacityExclusionRule(db, { companyId });
});

describe('golden accounting cases', () => {
  for (const [path, module] of caseFiles) {
    const rawStr = typeof module === 'string'
      ? module
      : (module as { default?: string })?.default ?? JSON.stringify(module);
    const testCase = JSON.parse(rawStr) as GoldenCase;

    it(`[${testCase.authority}] ${testCase.id}`, () => {
      const result = runGoldenCase(
        db, companyId, accountsByCode, accountsByKey, {},
        testCase,
      );

      if (!result.pass) {
        const detail = result.failures.join('\n  - ');
        const lookup = result.lookupResult
          ? `Rules: ${JSON.stringify(result.lookupResult.applicableRules.map((r) => r.ruleKey))}\n  Review: ${result.lookupResult.reviewRequired}\n  Reasons: ${result.lookupResult.reviewReasons.join('; ')}`
          : 'lookup threw';
        throw new Error(`Golden case failed (${testCase.id}):\n  - ${detail}\nLookup:\n  ${lookup}`);
      }

      expect(result.pass).toBe(true);
    });
  }
});

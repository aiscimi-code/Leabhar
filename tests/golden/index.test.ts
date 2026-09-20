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
import { createCompany, addBankAccount } from '@/domain/config/setup';
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
  ingestFinanceAct2024VatThresholds,
} from '@/domain/rules/financeAct2024VatThresholdsIngestion';
import {
  ingestSi639, deriveSi639Rules,
} from '@/domain/rules/si639Ingestion';
import {
  ingestSi156, deriveSi156Rules,
} from '@/domain/rules/si156Ingestion';
import {
  ingestTca1997S284, deriveTca1997S284Rules,
} from '@/domain/rules/tca1997Ingestion';
import {
  ingestRct, deriveRctRules,
} from '@/domain/rules/rctIngestion';
import {
  ingestTdm380103b, deriveTdm380103bRules,
} from '@/domain/rules/tdm3801_03bIngestion';
import { runGoldenCase } from './runner';
import type { GoldenCase } from './types';
import type { AppDatabase } from '@/db';

// Load all golden case JSON files.
const caseModules = import.meta.glob<RawGoldenCase>('./cases/*.json', { eager: true, query: 'raw' });
const caseFiles = Object.entries(caseModules);

type RawGoldenCase = GoldenCase;

let db: AppDatabase;
let companyId: string;
let accountsByCode: Record<string, string>;
let accountsByKey: Record<string, string>;
let treatmentsByCode: Record<string, string>;
let bankAccountId: string;

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
  treatmentsByCode = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId,
    bankName: 'BOI',
    accountName: 'Current',
    openingDate: '2025-01-01',
    accountId: accountsByKey['bank_control'],
  });

  // Ingest the full rule KB so every golden case has the rules it references.
  const faMd = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
  ingestFinanceAct2024(db, { companyId, markdown: faMd, ingestVersion: 'v1' });
  deriveTaxRules(db, { companyId });
  ingestVatca2010(db, { companyId, markdown: readFileSync(VATCA_2010_MD_PATH, 'utf8'), ingestVersion: 'v1' });
  deriveVatcaRules(db, { companyId });

  const s46Md = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');
  ingestVatcaRevisedSection(db, { companyId, markdown: s46Md, ingestVersion: 'v1' });
  deriveVatcaRevisedRules(db, { companyId });

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

  // RCT, S.I. 639/2010, S.I. 156/2012, TCA 1997 s.284, TDM 38-01-03b — all
  // sources the golden cases may reference.
  ingestSi639(db, { companyId });
  deriveSi639Rules(db, { companyId });
  ingestSi156(db, { companyId });
  deriveSi156Rules(db, { companyId });
  ingestTca1997S284(db, { companyId });
  deriveTca1997S284Rules(db, { companyId });
  ingestRct(db, { companyId });
  deriveRctRules(db, { companyId });
  ingestTdm380103b(db, { companyId });
  deriveTdm380103bRules(db, { companyId });
});

describe('golden accounting cases', () => {
  it.fails('sanity: unbalanced journals are rejected', () => {
    expect(() => {
      // This test exists to demonstrate the golden-case framework can assert
      // rejection. The actual case is in unbalanced-journal-rejected.json.
      postJournalEntry(db, {
        companyId,
        entryDate: '2026-09-18',
        narrative: 'Deliberately unbalanced',
        sourceType: 'manual_adjustment',
        baseCurrency: 'EUR',
        lines: [
          { accountId: accountsByCode['6010']!, debitMinor: 10000 },
          { accountId: accountsByCode['bank_control']!, creditMinor: 9999 },
        ],
      });
    }).toThrow();
  });

  for (const [path, rawContent] of caseFiles) {
    const caseId = path.split('/').pop()!.replace('.json', '');
    const testCase = JSON.parse(rawContent) as GoldenCase;

    it(`[${testCase.authority}] ${testCase.id}: ${testCase.description}`, () => {
      const result = runGoldenCase(
        db, companyId, accountsByCode, accountsByKey, treatmentsByCode,
        testCase,
      );

      if (!result.pass) {
        const detail = result.failures.join('\n  - ');
        const lookup = result.lookupResult
          ? `Rules: ${JSON.stringify(result.lookupResult!.applicableRules.map((r) => r.ruleKey))}\n  Review: ${result.lookupResult!.reviewRequired}\n  Reasons: ${result.lookupResult!.reviewReasons.join('; ')}`
          : 'lookup threw';
        throw new Error(`Golden case failed (${testCase.id}):\n  - ${detail}\nLookup:\n  ${lookup}`);
      }

      expect(result.pass).toBe(true);
    });
  }
});

/**
 * Double-entry integrity: every posted journal entry must have
 * SUM(debits) == SUM(credits) in base currency. This is invariant #3.
 */
describe('double-entry integrity — all journals balance', () => {
  it('passes for all standard accounting scenarios', () => {
    // Post a set of representative journal entries and verify each balances.
    const entries = [
      {
        narrative: 'Income',
        lines: [
          { accountId: accountsByCode['bank_control']!, debitMinor: 500000 },
          { accountId: accountsByCode['4000']!, creditMinor: 500000 },
        ],
      },
      {
        narrative: 'Expense',
        lines: [
          { accountId: accountsByCode['6010']!, debitMinor: 100000 },
          { accountId: accountsByCode['bank_control']!, creditMinor: 100000 },
        ],
      },
    ];

    for (const e of entries) {
      const posted = postJournalEntry(db, {
        companyId,
        entryDate: '2026-09-18',
        narrative: e.narrative,
        sourceType: 'manual_adjustment',
        baseCurrency: 'EUR',
        lines: e.lines,
      });
      const lines = db.select().from(journalLines).where(eq(journalLines.journalEntryId, posted.id)).all();
      const totalDebit = lines.reduce((s, l) => s + (l.baseDebitMinor ?? 0), 0);
      const totalCredit = lines.reduce((s, l) => s + (l.baseCreditMinor ?? 0), 0);
      expect(totalDebit).toBe(totalCredit);
    }
  });

  it('rejects an unbalanced journal', () => {
    expect(() => {
      postJournalEntry(db, {
        companyId,
        entryDate: '2026-09-18',
        narrative: 'Unbalanced',
        sourceType: 'manual_adjustment',
        baseCurrency: 'EUR',
        lines: [
          { accountId: accountsByCode['6010']!, debitMinor: 10000 },
          { accountId: accountsByCode['bank_control']!, creditMinor: 9999 },
        ],
      });
    }).toThrow();
  });
});

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, getFlag, hasFlag } from './args';
import { print, type Format } from './format';
import { getAgentDb, requireCompany } from '@/agent/context';
import type { AppDatabase } from '@/db';
import {
  ingestFinanceAct2024, deriveTaxRules, lookupTaxRule, listTaxRulesByTopic,
  FINANCE_ACT_2024_MD_PATH,
  ingestFinanceAct2025, FINANCE_ACT_2025,
} from '@/domain/rules/irishRules';
import { ingestVatca2010, deriveVatcaRules, VATCA_2010_MD_PATH } from '@/domain/rules/vatcaIngestion';
import {
  ingestVatcaSchedule, deriveVatcaScheduleRules,
  VATCA_SCHEDULE_1_MD_PATH, VATCA_SCHEDULE_2_MD_PATH, VATCA_SCHEDULE_3_MD_PATH, type VatcaScheduleNumber,
} from '@/domain/rules/vatcaScheduleIngestion';
import {
  ingestTca1997S530, ingestTca1997S530A, ingestTca1997S530E, ingestTca1997S530G, ingestTca1997S530H,
  ingestTca1997S530I, tca1997RctSectionMdPath, ingestRctTdm18_02_04, ingestRctTdm18_02_05, ingestRctTdm18_02_11,
  deriveRctRules,
  TCA_1997_S530_MD_PATH,
} from '@/domain/rules/rctIngestion';
import {
  ingestVatcaRevisedSection, deriveVatcaRevisedRules, VATCA_REVISED_S046_MD_PATH,
} from '@/domain/rules/vatcaRevisedIngestion';
import {
  ingestTca1997S284, ingestFinanceAct2003S23, deriveCapitalAllowancesRules,
} from '@/domain/rules/capitalAllowancesIngestion';
import { ingestSi639, deriveSi639Rules, SI_639_2010_MD_PATH } from '@/domain/rules/si639Ingestion';
import { ingestSi156, deriveSi156Rules, SI_156_2012_MD_PATH } from '@/domain/rules/si156Ingestion';
import {
  ingestSi692025Reg5, ingestSi692025Reg7, ingestSi692025Reg8, ingestSi692025Reg9, deriveSi692025Rules,
  SI_69_2025_MD_PATH,
} from '@/domain/rules/si692025Ingestion';
import { deriveFinanceAct2024VatThresholds } from '@/domain/rules/financeAct2024VatThresholdsIngestion';
import {
  ingestTdm3801_03bCapacityExclusion, deriveTdm3801_03bCapacityExclusionRule, TDM_38_01_03B_MD_PATH,
} from '@/domain/rules/tdm3801_03bIngestion';
import {
  ingestAllCompaniesAct2014Sections, deriveCompaniesAct2014Rules,
} from '@/domain/rules/companiesAct2014Ingestion';
import { syncTaxRatesFromIrishRules } from '@/domain/rules/taxRateSync';
import { loadStatutoryKnowledgeBase, statuteFilePath } from '@/domain/rules/knowledgeBase';
import { deriveVatScopeRules } from '@/domain/rules/vatScopeIngestion';
import { lookupTransactionRules, type TransactionContext } from '@/domain/rules/transactionLookup';
import { setRuleReviewStatus } from '@/domain/rules/review';
import { generateDefaultTestCases, runTestCases } from '@/domain/rules/testCases';
import { generateAuditReport } from '@/domain/rules/audit';
import { irishActProvisions, irishTaxRules } from '@/db/schema';
import { eq } from 'drizzle-orm';

const USAGE = `\
Leabhar Irish rules knowledge base CLI

Usage: npm run cli:rules -- <command> [flags]

Commands:
  ingest [--source <s>] [--file <path>]
                                       Ingest a source's Markdown (--source: finance-act-2024
                                       [default] | finance-act-2025 | vatca-2010 | vatca-2010-sch1 | vatca-2010-sch2 | vatca-2010-sch3 |
                                       rct-tca530 | rct-fa2011-a | rct-fa2011-e | rct-fa2011-g |
                                       rct-fa2011-h | rct-fa2011-i | rct-tdm | rct-tdm-05 | rct-tdm-11 |
                                       vatca-2010-revised | tca1997-s284 | finance-act-2003-s23 | si639 | si156 |
                                       si69-2025 (alias si69-2025-reg8) | si69-2025-reg5 | si69-2025-reg7 |
                                       si69-2025-reg9 | tdm-38-01-03b |
                                       companies-act-2014 (ingests all eight fetched sections; no --file);
                                       --file overrides
                                       its default path, e.g. to ingest a different revised section)
  ingest-all                          Ingest every source and derive every rule in one step
                                       (same as the ingest/extract sequence below; idempotent)
  extract [--source <s>]              Derive irish_tax_rules from ingested provisions
                                       (--source as above, but rct-tca530/rct-fa2011-*/rct-tdm/rct-tdm-05/
                                       rct-tdm-11 all use --source rct, and finance-act-2003-s23 uses --source
                                       tca1997-s284; also finance-act-2024-vat-thresholds, which requires
                                       finance-act-2024 already ingested (no separate document); and vat-scope,
                                       the exempt/outside-scope rules, which need vatca-2010-sch1 and the revised
                                       s002.md/s003.md ingested via vatca-2010-revised --file; default
                                       finance-act-2024)
  list-provisions [--category <c>] [--relevant-only]
                                       List ingested provisions
  show-provision --section <n>        Print one provision's full text + source offsets
  list-rules [--topic <t>] [--status <s>]
                                       List derived rules
  review --rule <id> --status <s>     Move a rule through the review lifecycle
         --by <name> [--notes "..."]  (draft|ai_extracted|human_review|approved|active|superseded|rejected)
  sync-tax-rates                      Sync tax_rates VAT rows from approved irish_tax_rules facts
                                       (standard/reduced/livestock only — see taxRateSync.ts; a rule
                                       must be reviewed to approved/active first, via the review command
                                       above, before it can supersede live config)
  lookup --json <transactionContextJson>
                                       Run the deterministic transaction lookup
  generate-tests                      Write default positive/effective-date test cases
  test                                Run all stored test cases, print pass/fail
  audit                               Print the QC/audit report

Flags:
  --format <json|human>  Output format (default: json)
  --help                 Show this message
`;

export interface CliOptions {
  db?: AppDatabase;
  companyId?: string;
}

export async function main(argv: string[], options: CliOptions = {}): Promise<number> {
  const { command, flags } = parseArgs(argv);
  const format: Format = getFlag(flags, 'format') === 'human' ? 'human' : 'json';

  if (command === '' || hasFlag(flags, 'help', 'h')) {
    process.stdout.write(USAGE);
    return command === '' ? 2 : 0;
  }

  try {
    const db = options.db ?? getAgentDb();
    const companyId = options.companyId ?? requireCompany(db).id;

    switch (command) {
      case 'ingest': {
        const source = getFlag(flags, 'source') ?? 'finance-act-2024';
        if (source === 'vatca-2010') {
          const file = getFlag(flags, 'file') ?? VATCA_2010_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestVatca2010(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'vatca-2010-sch1' || source === 'vatca-2010-sch2' || source === 'vatca-2010-sch3') {
          const scheduleNumber = source.slice(-1) as VatcaScheduleNumber;
          const defaultFile = { '1': VATCA_SCHEDULE_1_MD_PATH, '2': VATCA_SCHEDULE_2_MD_PATH, '3': VATCA_SCHEDULE_3_MD_PATH }[scheduleNumber];
          const file = getFlag(flags, 'file') ?? defaultFile;
          const markdown = readFileSync(file, 'utf8');
          print(
            ingestVatcaSchedule(db, { companyId, scheduleNumber, markdown, ingestVersion: 'v1', localPath: file }),
            format,
          );
          return 0;
        }
        if (source === 'rct-tca530') {
          const file = getFlag(flags, 'file') ?? TCA_1997_S530_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestTca1997S530(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source.startsWith('rct-fa2011-')) {
          const letter = source.slice('rct-fa2011-'.length).toUpperCase();
          const ingestFns: Record<string, typeof ingestTca1997S530A> = {
            A: ingestTca1997S530A, E: ingestTca1997S530E, G: ingestTca1997S530G,
            H: ingestTca1997S530H, I: ingestTca1997S530I,
          };
          const ingestFn = ingestFns[letter];
          if (!ingestFn) throw new Error(`Unknown --source: ${source} (supported: rct-fa2011-a/e/g/h/i)`);
          const file = getFlag(flags, 'file') ?? tca1997RctSectionMdPath(`530${letter}`);
          const markdown = readFileSync(file, 'utf8');
          print(ingestFn(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'rct-tdm' || source === 'rct-tdm-05' || source === 'rct-tdm-11') {
          const rctTdmFiles: Record<string, string> = {
            'rct-tdm': 'tdm-18-02-04.md',
            'rct-tdm-05': 'tdm-18-02-05.md',
            'rct-tdm-11': 'tdm-18-02-11.md',
          };
          const defaultFile = new URL(`../../docs/statutes/rct/${rctTdmFiles[source]}`, import.meta.url).pathname;
          const file = getFlag(flags, 'file') ?? defaultFile;
          const markdown = readFileSync(file, 'utf8');
          const ingestFn = source === 'rct-tdm'
            ? ingestRctTdm18_02_04
            : source === 'rct-tdm-05' ? ingestRctTdm18_02_05 : ingestRctTdm18_02_11;
          print(ingestFn(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'vatca-2010-revised') {
          const file = getFlag(flags, 'file') ?? VATCA_REVISED_S046_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestVatcaRevisedSection(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'tca1997-s284') {
          const file = getFlag(flags, 'file');
          print(
            ingestTca1997S284(db, { companyId, markdown: file ? readFileSync(file, 'utf8') : undefined, ingestVersion: 'v1', localPath: file }),
            format,
          );
          return 0;
        }
        if (source === 'finance-act-2003-s23') {
          const file = getFlag(flags, 'file');
          print(
            ingestFinanceAct2003S23(db, { companyId, markdown: file ? readFileSync(file, 'utf8') : undefined, ingestVersion: 'v1', localPath: file }),
            format,
          );
          return 0;
        }
        if (source === 'si639') {
          const file = getFlag(flags, 'file') ?? SI_639_2010_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestSi639(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'si156') {
          const file = getFlag(flags, 'file') ?? SI_156_2012_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestSi156(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'si69-2025' || source === 'si69-2025-reg8') {
          const file = getFlag(flags, 'file') ?? SI_69_2025_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestSi692025Reg8(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'si69-2025-reg5') {
          const file = getFlag(flags, 'file') ?? SI_69_2025_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestSi692025Reg5(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'si69-2025-reg7') {
          const file = getFlag(flags, 'file') ?? SI_69_2025_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestSi692025Reg7(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'si69-2025-reg9') {
          const file = getFlag(flags, 'file') ?? SI_69_2025_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestSi692025Reg9(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'tdm-38-01-03b') {
          const file = getFlag(flags, 'file') ?? TDM_38_01_03B_MD_PATH;
          const markdown = readFileSync(file, 'utf8');
          print(ingestTdm3801_03bCapacityExclusion(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source === 'companies-act-2014') {
          // No single default file (eight sections, each its own source) — --file is not supported here.
          print(ingestAllCompaniesAct2014Sections(db, { companyId, ingestVersion: 'v1' }), format);
          return 0;
        }
        if (source === 'finance-act-2025') {
          // Its s.71 is cited by the s.46 hospitality and hairdressing rates: ingest before extracting vatca-2010-revised.
          const file = getFlag(flags, 'file') ?? statuteFilePath(FINANCE_ACT_2025.localPath!);
          const markdown = readFileSync(file, 'utf8');
          print(ingestFinanceAct2025(db, { companyId, markdown, ingestVersion: 'v1', localPath: file }), format);
          return 0;
        }
        if (source !== 'finance-act-2024') throw new Error(`Unknown --source: ${source}`);
        const file = getFlag(flags, 'file') ?? FINANCE_ACT_2024_MD_PATH;
        const markdown = readFileSync(file, 'utf8');
        const result = ingestFinanceAct2024(db, {
          companyId, markdown, ingestVersion: 'v1', localPath: file,
        });
        print(result, format);
        return 0;
      }

      case 'ingest-all': {
        print(loadStatutoryKnowledgeBase(db, { companyId }), format);
        return 0;
      }

      case 'extract': {
        const source = getFlag(flags, 'source') ?? 'finance-act-2024';
        if (source === 'vatca-2010') {
          print(deriveVatcaRules(db, { companyId }), format);
          return 0;
        }
        if (source === 'vatca-2010-sch2' || source === 'vatca-2010-sch3') {
          const scheduleNumber: VatcaScheduleNumber = source === 'vatca-2010-sch2' ? '2' : '3';
          print(deriveVatcaScheduleRules(db, { companyId, scheduleNumber }), format);
          return 0;
        }
        if (source === 'vat-scope') {
          print(deriveVatScopeRules(db, { companyId }), format);
          return 0;
        }
        if (source === 'rct') {
          print(deriveRctRules(db, { companyId }), format);
          return 0;
        }
        if (source === 'vatca-2010-revised') {
          print(deriveVatcaRevisedRules(db, { companyId }), format);
          return 0;
        }
        if (source === 'tca1997-s284') {
          print(deriveCapitalAllowancesRules(db, { companyId }), format);
          return 0;
        }
        if (source === 'si639') {
          print(deriveSi639Rules(db, { companyId }), format);
          return 0;
        }
        if (source === 'si156') {
          print(deriveSi156Rules(db, { companyId }), format);
          return 0;
        }
        if (source === 'si69-2025') {
          print(deriveSi692025Rules(db, { companyId }), format);
          return 0;
        }
        if (source === 'finance-act-2024-vat-thresholds') {
          print(deriveFinanceAct2024VatThresholds(db, { companyId }), format);
          return 0;
        }
        if (source === 'tdm-38-01-03b') {
          print(deriveTdm3801_03bCapacityExclusionRule(db, { companyId }), format);
          return 0;
        }
        if (source === 'companies-act-2014') {
          print(deriveCompaniesAct2014Rules(db, { companyId }), format);
          return 0;
        }
        if (source !== 'finance-act-2024') throw new Error(`Unknown --source: ${source}`);
        const result = deriveTaxRules(db, { companyId });
        print(result, format);
        return 0;
      }

      case 'list-provisions': {
        const category = getFlag(flags, 'category');
        const relevantOnly = hasFlag(flags, 'relevant-only', 'relevantOnly');
        let rows = db.select({
          sectionNumber: irishActProvisions.sectionNumber,
          heading: irishActProvisions.heading,
          category: irishActProvisions.category,
          relevant: irishActProvisions.relevant,
          relevanceReason: irishActProvisions.relevanceReason,
        }).from(irishActProvisions).all();
        if (category) rows = rows.filter((r) => r.category === category);
        if (relevantOnly) rows = rows.filter((r) => r.relevant);
        rows.sort((a, b) => Number(a.sectionNumber) - Number(b.sectionNumber));
        print(rows, format);
        return 0;
      }

      case 'show-provision': {
        const section = getFlag(flags, 'section');
        if (!section) throw new Error('Missing required flag: --section');
        const row = db.select().from(irishActProvisions)
          .where(eq(irishActProvisions.sectionNumber, section)).get();
        if (!row) throw new Error(`No ingested provision for section ${section}.`);
        print(row, format);
        return 0;
      }

      case 'list-rules': {
        const topic = getFlag(flags, 'topic');
        const status = getFlag(flags, 'status');
        const rows: Array<{ reviewStatus: string }> = topic
          ? listTaxRulesByTopic(db, { companyId, topic })
          : db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
        print(status ? rows.filter((r) => r.reviewStatus === status) : rows, format);
        return 0;
      }

      case 'review': {
        const ruleId = getFlag(flags, 'rule', 'rule-id', 'ruleId');
        const status = getFlag(flags, 'status');
        const by = getFlag(flags, 'by');
        if (!ruleId || !status || !by) {
          throw new Error('Usage: review --rule <id> --status <status> --by <name> [--notes "..."]');
        }
        setRuleReviewStatus(db, {
          ruleId,
          status: status as Parameters<typeof setRuleReviewStatus>[1]['status'],
          reviewedBy: by,
          notes: getFlag(flags, 'notes'),
        });
        print({ ruleId, status, updated: true }, format);
        return 0;
      }

      case 'sync-tax-rates': {
        print(syncTaxRatesFromIrishRules(db, { companyId, actor: getFlag(flags, 'actor') }), format);
        return 0;
      }

      case 'lookup': {
        const json = getFlag(flags, 'json');
        if (!json) throw new Error('Usage: lookup --json \'{"transactionDate":"2026-09-18","amountMinor":1000,...}\'');
        const transaction = JSON.parse(json) as TransactionContext;
        const result = lookupTransactionRules(db, { companyId, transaction });
        print(result, format);
        return 0;
      }

      case 'generate-tests': {
        const result = generateDefaultTestCases(db, { companyId });
        print(result, format);
        return 0;
      }

      case 'test': {
        const result = runTestCases(db, { companyId });
        print(result, format);
        return result.failed > 0 ? 1 : 0;
      }

      case 'audit': {
        const report = generateAuditReport(db, { companyId });
        print(report, format);
        return 0;
      }

      default:
        process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}

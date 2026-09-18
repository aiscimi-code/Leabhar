import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs, getFlag, hasFlag } from './args';
import { print, type Format } from './format';
import { getAgentDb, requireCompany } from '@/agent/context';
import type { AppDatabase } from '@/db';
import {
  ingestFinanceAct2024, deriveTaxRules, lookupTaxRule, listTaxRulesByTopic,
  FINANCE_ACT_2024_MD_PATH,
} from '@/domain/rules/irishRules';
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
  ingest [--file <path>]              Ingest the Finance Act 2024 Markdown
                                       (default: docs/statutes/2024-act-43/2024-act-43-enacted.md)
  extract                             Derive irish_tax_rules from ingested provisions
  list-provisions [--category <c>] [--relevant-only]
                                       List ingested provisions
  show-provision --section <n>        Print one provision's full text + source offsets
  list-rules [--topic <t>] [--status <s>]
                                       List derived rules
  review --rule <id> --status <s>     Move a rule through the review lifecycle
         --by <name> [--notes "..."]  (draft|ai_extracted|human_review|approved|active|superseded|rejected)
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
        const file = getFlag(flags, 'file') ?? FINANCE_ACT_2024_MD_PATH;
        const markdown = readFileSync(file, 'utf8');
        const result = ingestFinanceAct2024(db, {
          companyId, markdown, ingestVersion: 'v1', localPath: file,
        });
        print(result, format);
        return 0;
      }

      case 'extract': {
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

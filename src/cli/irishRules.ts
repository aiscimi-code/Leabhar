import { pathToFileURL } from 'node:url';
import { parseArgs, getFlag, hasFlag } from './args';
import { print, type Format } from './format';
import { getAgentDb, requireCompany } from '@/agent/context';
import type { AppDatabase } from '@/db';
import { listTaxRulesByTopic } from '@/domain/rules/irishRules';
import { syncTaxRatesFromIrishRules } from '@/domain/rules/taxRateSync';
import { lookupTransactionRules, type TransactionContext } from '@/domain/rules/transactionLookup';
import { compareRuleVersions } from '@/domain/rules/versionCompare';
import { setRuleReviewStatus } from '@/domain/rules/review';
import { generateDefaultTestCases, runTestCases } from '@/domain/rules/testCases';
import { generateAuditReport } from '@/domain/rules/audit';
import { resolveRuleDependencies, resolveAllRuleDependencies } from '@/domain/rules/dependencies';
import { resolveImpactTarget, ruleDepends, ruleImpact } from '@/domain/rules/ruleImpact';
import { traceSourceChange, verifySources, type SourceFetcher } from '@/domain/rules/sourceDrift';
import { visibleActProvisions, visibleKnowledgeSources, visibleTaxRuleFields, visibleTaxRules } from '@/db/schema';
import { visibleToCompany } from '@/domain/rules/visibleRules';
import { ruleReviewResolver } from '@/domain/rules/effectiveReview';
import { and, eq } from 'drizzle-orm';

const USAGE = `\
Leabhar Irish rules knowledge base CLI

Usage: npm run cli:rules -- <command> [flags]

The rules come from the rules store installed with Leabhar; a book does not
load them (ADR-0021). In development, npm run rules:build builds the store.

Commands:
  list-provisions [--category <c>] [--relevant-only]
                                       List the provisions in the rules store
  show-provision --section <n>        Print one provision's full text + source offsets
  list-rules [--topic <t>] [--status <s>]
                                       List the rules
  review --rule <id> --status <s>     Move a rule through the review lifecycle
         --by <name> [--notes "..."]  (draft|ai_extracted|human_review|approved|active|superseded|rejected)
  sync-tax-rates                      Sync tax_rates VAT rows from approved irish_tax_rules facts
                                       (standard/reduced/livestock only — see taxRateSync.ts; a rule
                                       must be reviewed to approved/active first, via the review command
                                       above, before it can supersede live config)
  lookup --json <transactionContextJson>
                                       Run the deterministic transaction lookup
  versions --rule-key <k>              Compare every version of a rule: what
                                       changed between each version and the one
                                       it supersedes, oldest first
  impact <ruleKey|provision>          Everything that relies on a rule, or on a provision (an id or a
                                       reference such as "VATCA 2010 s.46"), directly and transitively
  depends <ruleKey>                   Everything a rule relies on: rules, and the provisions behind them
  verify-sources [--entry <e>] [--trace]
                                       Fetch each rules catalogue entry's official file (online) and
                                       report whether it has changed since it was curated, and which
                                       rule quotes are no longer in it. --trace puts every affected
                                       rule, and everything relying on it, in front of this book as a
                                       review item. Exits 1 when a source has changed or is unreachable
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
  /** verify-sources: fetches the official files (tests pass a fake). */
  fetchSource?: SourceFetcher;
}

export async function main(argv: string[], options: CliOptions = {}): Promise<number> {
  const { command, flags, positionals } = parseArgs(argv);
  const format: Format = getFlag(flags, 'format') === 'human' ? 'human' : 'json';

  if (command === '' || hasFlag(flags, 'help', 'h')) {
    process.stdout.write(USAGE);
    return command === '' ? 2 : 0;
  }

  try {
    const db = options.db ?? getAgentDb();
    const companyId = options.companyId ?? requireCompany(db).id;

    switch (command) {
      case 'list-provisions': {
        const category = getFlag(flags, 'category');
        const relevantOnly = hasFlag(flags, 'relevant-only', 'relevantOnly');
        let rows = db.select({
          sectionNumber: visibleActProvisions.sectionNumber,
          heading: visibleActProvisions.heading,
          category: visibleActProvisions.category,
          relevant: visibleActProvisions.relevant,
          relevanceReason: visibleActProvisions.relevanceReason,
        }).from(visibleActProvisions).where(visibleToCompany(visibleActProvisions.companyId, companyId)).all();
        if (category) rows = rows.filter((r) => r.category === category);
        if (relevantOnly) rows = rows.filter((r) => r.relevant);
        rows.sort((a, b) => Number(a.sectionNumber) - Number(b.sectionNumber));
        print(rows, format);
        return 0;
      }

      case 'show-provision': {
        const section = getFlag(flags, 'section');
        if (!section) throw new Error('Missing required flag: --section');
        const row = db.select().from(visibleActProvisions)
          .where(and(eq(visibleActProvisions.sectionNumber, section), visibleToCompany(visibleActProvisions.companyId, companyId))).get();
        if (!row) throw new Error(`No ingested provision for section ${section}.`);
        print(row, format);
        return 0;
      }

      case 'list-rules': {
        const topic = getFlag(flags, 'topic');
        const status = getFlag(flags, 'status');
        // Each with the review the book follows: its own decision, else the catalogue's (issue #718).
        const review = ruleReviewResolver(db, { companyId });
        const rows: Array<{ reviewStatus: string }> = topic
          ? listTaxRulesByTopic(db, { companyId, topic })
          : db.select({ rule: visibleTaxRuleFields, sourceSha256: visibleKnowledgeSources.sha256 }).from(visibleTaxRules)
            .innerJoin(visibleActProvisions, eq(visibleTaxRules.provisionId, visibleActProvisions.id))
            .innerJoin(visibleKnowledgeSources, eq(visibleActProvisions.sourceId, visibleKnowledgeSources.id))
            .where(eq(visibleTaxRules.companyId, companyId)).all()
            .map(({ rule, sourceSha256 }) => ({ ...rule, reviewStatus: review({ ...rule, sourceSha256 }).status }));
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
          companyId,
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

      case 'dependencies': {
        const ruleId = getFlag(flags, 'rule');
        if (ruleId) {
          print(resolveRuleDependencies(db, { companyId, ruleId }), format);
          return 0;
        }
        print(resolveAllRuleDependencies(db, { companyId }), format);
        return 0;
      }

      case 'versions': {
        const ruleKey = getFlag(flags, 'rule-key');
        if (!ruleKey) throw new Error('Usage: versions --rule-key <ruleKey>');
        const comparison = compareRuleVersions(db, { companyId, ruleKey });
        if (!comparison) {
          print({ ruleKey, error: `No rule with key "${ruleKey}" exists for this company.` }, format);
          return 1;
        }
        print(comparison, format);
        return 0;
      }

      case 'impact': {
        const target = positionals.join(' ') || getFlag(flags, 'rule-key', 'provision');
        if (!target) throw new Error('Usage: impact <ruleKey|provisionId|reference>');
        print(ruleImpact(db, { companyId, target: resolveImpactTarget(db, { companyId, target }) }), format);
        return 0;
      }

      case 'depends': {
        const ruleKey = positionals[0] ?? getFlag(flags, 'rule-key');
        if (!ruleKey) throw new Error('Usage: depends <ruleKey>');
        const target = resolveImpactTarget(db, { companyId, target: ruleKey });
        if (target.kind !== 'rule') throw new Error(`"${ruleKey}" is not a rule key in this book.`);
        print(ruleDepends(db, { companyId, ruleKey }), format);
        return 0;
      }

      case 'verify-sources': {
        const entry = getFlag(flags, 'entry');
        const reports = await verifySources({
          entries: entry ? [entry.endsWith('.json') ? entry : `${entry}.json`] : undefined,
          fetch: options.fetchSource,
        });
        const traces = hasFlag(flags, 'trace')
          ? reports.filter((r) => r.status === 'changed').map((report) => traceSourceChange(db, { companyId, report }))
          : [];
        print({ reports, traces }, format);
        return reports.every((r) => r.status === 'unchanged' || r.status === 'page_state_only') ? 0 : 1;
      }

      case 'generate-tests': {
        const result = generateDefaultTestCases(db, { companyId });
        print(result, format);
        return 0;
      }

      case 'test': {
        const result = runTestCases(db, { companyId });
        print(result, format);
        if (result.total === 0) {
          // The cases are read from the rules store (ADR-0021); `generate-tests`
          // still writes them into the book, where no run reads them. No case
          // run is not a pass.
          process.stderr.write('No rule test cases in the rules store, so nothing was tested.\n');
          return 1;
        }
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

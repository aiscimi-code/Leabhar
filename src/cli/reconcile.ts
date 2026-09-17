import { parseArgs, getFlag, hasFlag } from './args';
import { print, error, type Format } from './format';
import { getAgentDb, requireCompany } from '@/agent/context';
import type { AppDatabase } from '@/db';
import { pathToFileURL } from 'node:url';
import {
  listBankAccounts,
  listReconciliations,
  importStatementFile,
  reconcile,
  signOff,
  runPipeline,
} from '@/agent/reconcile';
import { autoClassifyFromRules } from '@/agent/classify';
import {
  runMatch, listMatches, acceptMatchCandidate, linkDocumentToTransaction,
  rejectMatchCandidate, unmatchDocumentLink,
} from '@/agent/match';
import { createSupplierFromExtraction } from '@/domain/extraction/service';
import {
  importInput,
  autoClassifyInput,
  reconcileInput,
  runPipelineInput,
  matchInput,
  listMatchesInput,
  acceptMatchInput,
  linkInput,
  rejectMatchInput,
  unmatchInput,
  createSupplierInput,
} from '@/agent/schema';

const USAGE = `\
Leabhar reconciliation CLI

Usage: npm run cli -- <command> [flags]

Commands:
  list-accounts                          List bank accounts (id, name, currency)
  list-reconciliations                   Past reconciliation records
  import    --account <id> --file <path> Import a statement (CSV/XLSX)
  auto-classify --account <id>           Classify unclassified txns from rules
  match                                  Run document<->bank matching for all docs
  list-matches [--decision pending]      List match candidates (default: pending)
  accept-match --document <id> --transaction <id>  Accept a scored candidate
  link --document <id> --transaction <id>          Manually link a doc to a txn
  reject-match --document <id> --transaction <id>  Reject a scored candidate
  unmatch --document <id> --reason "..."           Remove a link
  create-supplier --name "..." [--country <IE>]    Create a supplier (ai_suggestion)
  reconcile --account <id>               Compute reconciliation (read-only)
            --from <date> --to <date>
  reconcile ... --sign-off               Record the reconciliation
  reconcile ... --sign-off               Sign off despite a difference
            --accept-difference "reason"
  run --account <id> [--file <path>]     import (optional) -> auto-classify -> reconcile
     --from <date> --to <date>

Agent workflow:
  1. import a statement (or run over already-imported data)
  2. create suppliers for extracted names that have no supplier yet
  3. match documents to bank transactions (evidence linking; does not post)
  4. auto-classify unclassified txns from rules (posts journal entries)
  5. reconcile; --sign-off when reconciled

Matching links evidence to a transaction but does NOT classify or post it.
Classification (auto-classify or the UI) posts the journal entry that the
reconciliation then agrees with.

Flags:
  --account <id>      Bank account id
  --file <path>       Statement file path (optional for 'run')
  --from <date>       Period start (YYYY-MM-DD)
  --to <date>         Period end (YYYY-MM-DD)
  --document <id>     Document id
  --transaction <id>  Bank transaction id
  --name <name>       Supplier name
  --country <code>    Supplier country code (e.g. IE)
  --reason <text>     Reason for accept/reject/unmatch
  --sign-off          Record the reconciliation (not just compute it)
  --accept-difference  Reason to sign off despite an unexplained difference
  --statement-balance <amount>  Closing balance from the paper statement
  --format <json|human>  Output format (default: json)
  --help              Show this message

Exit codes: 0 on success, 1 on error, 2 on usage error.
`;

export interface CliOptions {
  /** Inject a DB handle and company id (tests). Defaults to getAgentDb()/requireCompany(). */
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
      case 'list-accounts': {
        print(listBankAccounts(db, companyId), format);
        return 0;
      }

      case 'list-reconciliations': {
        print(listReconciliations(db, companyId), format);
        return 0;
      }

      case 'import': {
        const parsed = importInput.parse({
          companyId,
          accountId: requireFlag(flags, 'account', 'account-id', 'accountId'),
          file: requireFlag(flags, 'file'),
        });
        const result = await importStatementFile(db, parsed);
        print(result, format);
        return 0;
      }

      case 'auto-classify': {
        const parsed = autoClassifyInput.parse({
          companyId,
          bankAccountId: requireFlag(flags, 'account', 'account-id', 'accountId'),
        });
        const result = autoClassifyFromRules(db, parsed);
        print(result, format);
        return 0;
      }

      case 'reconcile': {
        const parsed = reconcileInput.parse({
          companyId,
          bankAccountId: requireFlag(flags, 'account', 'account-id', 'accountId'),
          from: requireFlag(flags, 'from'),
          to: requireFlag(flags, 'to'),
          signOff: hasFlag(flags, 'sign-off'),
          acceptDifference: getFlag(flags, 'accept-difference', 'acceptDifference'),
          statementClosingBalance: getFlag(flags, 'statement-balance', 'statementBalance'),
        });

        if (parsed.signOff) {
          print(signOff(db, parsed), format);
        } else {
          print(reconcile(db, parsed), format);
        }
        return 0;
      }

      case 'run': {
        const parsed = runPipelineInput.parse({
          companyId,
          bankAccountId: requireFlag(flags, 'account', 'account-id', 'accountId'),
          file: getFlag(flags, 'file'),
          from: requireFlag(flags, 'from'),
          to: requireFlag(flags, 'to'),
          statementClosingBalance: getFlag(flags, 'statement-balance', 'statementBalance'),
          signOff: hasFlag(flags, 'sign-off'),
          acceptDifference: getFlag(flags, 'accept-difference', 'acceptDifference'),
        });
        const result = await runPipeline(db, parsed);
        print(result, format);
        return 0;
      }

      case 'match': {
        matchInput.parse({ companyId });
        // Run matching across all unmatched documents. Matching links
        // evidence; it does not classify. Run auto-classify afterwards.
        print(runMatch(db, { companyId }), format);
        return 0;
      }

      case 'list-matches': {
        const parsed = listMatchesInput.parse({
          companyId,
          decision: getFlag(flags, 'decision'),
        });
        print(listMatches(db, parsed), format);
        return 0;
      }

      case 'accept-match': {
        const parsed = acceptMatchInput.parse({
          companyId,
          documentId: requireFlag(flags, 'document', 'document-id', 'documentId'),
          bankTransactionId: requireFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId'),
          reason: getFlag(flags, 'reason'),
        });
        acceptMatchCandidate(db, parsed);
        print({ accepted: true, documentId: parsed.documentId, bankTransactionId: parsed.bankTransactionId }, format);
        return 0;
      }

      case 'link': {
        const parsed = linkInput.parse({
          companyId,
          documentId: requireFlag(flags, 'document', 'document-id', 'documentId'),
          bankTransactionId: requireFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId'),
          reason: getFlag(flags, 'reason'),
        });
        linkDocumentToTransaction(db, parsed);
        print({ linked: true, documentId: parsed.documentId, bankTransactionId: parsed.bankTransactionId }, format);
        return 0;
      }

      case 'reject-match': {
        const parsed = rejectMatchInput.parse({
          companyId,
          documentId: requireFlag(flags, 'document', 'document-id', 'documentId'),
          bankTransactionId: requireFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId'),
          reason: getFlag(flags, 'reason'),
        });
        rejectMatchCandidate(db, parsed);
        print({ rejected: true, documentId: parsed.documentId, bankTransactionId: parsed.bankTransactionId }, format);
        return 0;
      }

      case 'unmatch': {
        const parsed = unmatchInput.parse({
          companyId,
          documentId: requireFlag(flags, 'document', 'document-id', 'documentId'),
          reason: requireFlag(flags, 'reason'),
        });
        unmatchDocumentLink(db, parsed);
        print({ unmatched: true, documentId: parsed.documentId }, format);
        return 0;
      }

      case 'create-supplier': {
        const parsed = createSupplierInput.parse({
          companyId,
          name: requireFlag(flags, 'name'),
          countryCode: getFlag(flags, 'country', 'country-code', 'countryCode'),
          vatNumber: getFlag(flags, 'vat-number', 'vatNumber', 'vat'),
          documentId: getFlag(flags, 'document', 'document-id', 'documentId'),
        });
        const result = createSupplierFromExtraction(db, {
          companyId: parsed.companyId,
          name: parsed.name,
          countryCode: parsed.countryCode ?? null,
          vatNumber: parsed.vatNumber ?? null,
          documentId: parsed.documentId,
          actor: 'cli',
        });
        print(result, format);
        return 0;
      }

      default:
        error(`Unknown command: ${command}. Use --help for usage.`, format);
        return 2;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    error(message, format);
    return 1;
  }
}

function requireFlag(
  flags: Record<string, string | boolean>,
  ...names: string[]
): string {
  const value = getFlag(flags, ...names);
  if (value === undefined) {
    throw new Error(`Missing required flag: --${names[0]}`);
  }
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}

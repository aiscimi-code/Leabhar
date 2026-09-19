import { parseArgs, getFlag, hasFlag } from './args';
import { print, error, type Format } from './format';
import { getAgentDb, requireCompany } from '@/agent/context';
import type { AppDatabase } from '@/db';
import { parseAmount } from '@/domain/money';
import { pathToFileURL } from 'node:url';
import {
  listBankAccounts,
  listReconciliations,
  importStatementFile,
  reconcile,
  signOff,
  runPipeline,
  listChartOfAccounts,
  listVatTreatments,
  resolveAccountId,
  resolveVatTreatmentId,
  classifyTransactionManual,
  createRuleManual,
  setTransactionFx,
} from '@/agent/reconcile';
import { autoClassifyFromRules } from '@/agent/classify';
import {
  runMatch, listMatches, acceptMatchCandidate, linkDocumentToTransaction,
  rejectMatchCandidate, unmatchDocumentLink,
} from '@/agent/match';
import { createSupplierFromExtraction } from '@/domain/extraction/service';
import {
  initCompany, addBank, addAccount, addCustomer,
} from '@/agent/induction';
import {
  createInvoicesFromCsv, recordPaymentCli, journalCli,
  listTransactionsCli, showInvoiceCli, yearEndCli, vatReturnCli,
} from '@/agent/books';
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
  classifyTxnInput,
  createRuleCliInput,
  setFxInput,
  initCompanyInput,
  addBankInput,
  addAccountInput,
  addCustomerInput,
  createInvoiceCsvInput,
  recordPaymentInput,
  journalCliInput,
  listTransactionsInput,
  showInvoiceInput,
  yearEndCliInput,
  vatReturnCliInput,
  type CreateRuleCliInput,
} from '@/agent/schema';

const USAGE = `\
Leabhar reconciliation CLI

Usage: npm run cli -- <command> [flags]

Commands:
  list-accounts                          List bank accounts (id, name, currency)
  list-chart                             List chart of accounts (code, name, type)
  list-vat-treatments                    List VAT treatments (code, name, jurisdiction)
  list-reconciliations                   Past reconciliation records
  import    --account <id> --file <path> Import a statement (CSV/XLSX)
  auto-classify --account <id>           Classify unclassified txns from rules
  classify --transaction <id>            Manually classify + post a transaction
           --account <code> --vat-treatment <code>
           [--supplier <id>] [--fx-rate <num>/<den>]
  create-rule --name "..."               Create a rule (JSON conditions/actions)
            --conditions <json> --actions <json> [--auto-apply]
  set-fx --transaction <id>              Set FX rate / settled base amount on a
        [--base-amount <amount>]         foreign line already imported
        [--fx-rate <num>/<den>]
  match                                  Run document<->bank matching for all docs
  list-matches [--decision pending]      List match candidates (default: all)
  accept-match --document <id> --transaction <id>  Accept a scored candidate
  link --document <id> --transaction <id>          Manually link a doc to a txn
  reject-match --document <id> --transaction <id>  Reject a scored candidate
  unmatch --document <id> --reason "..."           Remove a link
  create-supplier --name "..." [--country <IE>]    Create a supplier (ai_suggestion)
  reconcile --account <id>               Compute reconciliation (read-only)
            --from <date> --to <date>
  reconcile ... --sign-off               Record the reconciliation
            [--accept-difference "reason"]
  run --account <id> [--file <path>]     import (optional) -> auto-classify -> reconcile
     --from <date> --to <date>

Induction (no company/bank/chart yet):
  init-company --name "..."              Create a company + default chart
      [--vat-basis invoice|cash_receipts] [--vat-frequency bi_monthly]
      [--year-end MM-DD] [--base-currency EUR] [--seed-years "2024,2025"]
  add-bank --name "..."                  Add a bank account
      [--iban ...] [--currency EUR] [--account-type current]
      [--opening <amount> --opening-date <date>]  Also journals the opening
      balance (Dr this account / Cr retained earnings) — not just stored.
  add-account --code <code> --name "..." --type asset|liability|equity|income|expense
      [--subtype ...] [--report-section current_assets|current_liabilities|
      fixed_assets|revenue|cost_of_sales|operating_expenses|equity]
      [--vat-applicable=false]
  add-customer --name "..." [--country <IE>] [--default-account <code>]

Books (once induction is done):
  create-invoice --direction sales|purchase --file <invoices.csv>
      One row per invoice/bill. Columns: invoiceNumber, date, party (a
      customer/supplier name or id), description, net, account, vatTreatment,
      and optionally dueDate, supplyDate, statedVat, currency, creditNote,
      reference.
  record-payment [--transaction <id>] [--invoices "INV-1,INV-2"]
      [--amount <amount>] [--date <date>] [--unallocated] [--method ...]
      [--direction received|made]  Needed only if neither --invoices nor
      --transaction implies it (e.g. an --unallocated payment with no evidence).
      Exact: one invoice, no --amount (pays it in full). Lump: several
      --invoices, paid off in the order given until the amount runs out.
      Part: one invoice with --amount below its outstanding balance.
      --unallocated leaves the whole payment on account, on purpose.
  journal --date <date> --narrative "..." --lines <json>
      [--reason "..."]  A multi-line manual adjustment (Stripe payout splits,
      a loan repayment's capital/interest split, a VAT3 settlement, an
      own-account transfer). --lines is a JSON array of
      {"account":"code","debit":"100.00"} / {"account":"code","credit":"100.00"}
      objects, amounts in major units; at least two lines, and they must balance.

Inspect:
  list-transactions [--account <id>] [--unposted] [--unclassified]
  show-invoice <number>                  Full detail incl. lines and payments
  year-end --from <date> --to <date>     P&L, balance sheet, tax worksheet,
                                          fixed assets, VAT periods, issues
  vat-return --period <id-or-name>       VAT3 box figures for one period

Agent workflow:
  1. init-company, add-bank --opening, add-account for anything the default
     chart does not cover, add-customer for sales counterparties
  2. import a statement (or run over already-imported data)
  3. create-invoice from CSV (sales/purchase), create suppliers for names
     that have no supplier yet
  4. match documents to bank transactions (evidence linking; does not post)
  5. classify transactions (manually via classify, auto-classify from rules,
     or record-payment where a transaction settles an invoice) and journal
     anything that is not a single-account posting
  6. set-fx on foreign lines that lack a settled base amount
  7. reconcile; --sign-off when reconciled; year-end / vat-return to inspect

Matching links evidence to a transaction but does NOT classify or post it.
Classification (classify, auto-classify, or the UI) posts the journal entry
that the reconciliation then agrees with. Foreign-currency lines need an FX
rate before classify or reconcile — use set-fx or pass --fx-rate to classify.

Flags:
  --account <code/id>  Bank account id (list-accounts) or account code/id (classify)
  --file <path>       Statement file path (optional for 'run')
  --from <date>       Period start (YYYY-MM-DD)
  --to <date>         Period end (YYYY-MM-DD)
  --document <id>     Document id
  --transaction <id>  Bank transaction id
  --vat-treatment <code/id>  VAT treatment code or id (classify)
  --supplier <id>     Supplier id (classify, optional)
  --fx-rate <num>/<den>  Exchange rate as a rational (e.g. 113/100)
  --base-amount <amount>  Settled base-currency amount (set-fx)
  --conditions <json>  Rule conditions as JSON array (create-rule)
  --actions <json>     Rule actions as JSON array (create-rule)
  --auto-apply        Rule should auto-apply on match (create-rule)
  --name <name>       Supplier name (create-supplier) or rule name (create-rule)
  --country <code>    Supplier country code (e.g. IE)
  --reason <text>     Reason for accept/reject/unmatch
  --sign-off          Record the reconciliation (not just compute it)
  --accept-difference  Reason to sign off despite an unexplained difference
  --statement-balance <amount>  Closing balance from the paper statement
  --vat-basis, --vat-frequency, --year-end, --base-currency, --seed-years  init-company
  --opening, --opening-date  Opening balance amount/date (add-bank)
  --code, --type, --subtype, --report-section, --vat-applicable  add-account
  --default-account <code>  Customer's default sales account (add-customer)
  --direction sales|purchase  Invoice direction (create-invoice)
  --invoices "A,B"    Comma-separated invoice numbers (record-payment)
  --amount <amount>   Payment amount, or override a journal line's account (record-payment)
  --unallocated       Leave the payment unallocated, on account (record-payment)
  --narrative, --lines <json>  Journal narrative and lines (journal)
  --unposted, --unclassified   Filter for list-transactions
  --period <id-or-name>  VAT period id or exact name (vat-return)
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
  const { command, flags, positionals } = parseArgs(argv);
  const format: Format = getFlag(flags, 'format') === 'human' ? 'human' : 'json';

  if (command === '' || hasFlag(flags, 'help', 'h')) {
    process.stdout.write(USAGE);
    return command === '' ? 2 : 0;
  }

  try {
    const db = options.db ?? getAgentDb();

    // init-company runs before any company exists, so it cannot go through
    // requireCompany() like every other command below.
    if (command === 'init-company') {
      const parsed = initCompanyInput.parse({
        legalName: requireFlag(flags, 'name'),
        tradingName: getFlag(flags, 'trading-name'),
        croNumber: getFlag(flags, 'cro-number'),
        vatNumber: getFlag(flags, 'vat-number'),
        vatRegistrationStatus: getFlag(flags, 'vat-registration-status'),
        vatAccountingBasis: getFlag(flags, 'vat-basis'),
        vatPeriodFrequency: getFlag(flags, 'vat-frequency'),
        yearEnd: getFlag(flags, 'year-end'),
        baseCurrency: getFlag(flags, 'base-currency'),
        seedYears: getFlag(flags, 'seed-years'),
      });
      print(initCompany(db, parsed), format);
      return 0;
    }

    const companyId = options.companyId ?? requireCompany(db).id;

    switch (command) {
      case 'list-accounts': {
        print(listBankAccounts(db, companyId), format);
        return 0;
      }

      case 'list-chart': {
        print(listChartOfAccounts(db, companyId), format);
        return 0;
      }

      case 'list-vat-treatments': {
        print(listVatTreatments(db, companyId), format);
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

      case 'classify': {
        const parsed = classifyTxnInput.parse({
          companyId,
          bankTransactionId: requireFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId'),
          accountId: requireFlag(flags, 'account', 'account-id', 'accountId'),
          vatTreatmentId: requireFlag(flags, 'vat-treatment', 'vat-treatment-id', 'vatTreatmentId'),
          supplierId: getFlag(flags, 'supplier', 'supplier-id', 'supplierId'),
          fxRateNumerator: parseFxRateFlag(flags, 'fx-rate')?.numerator,
          fxRateDenominator: parseFxRateFlag(flags, 'fx-rate')?.denominator,
          notes: getFlag(flags, 'notes'),
        });
        const accountId = resolveAccountId(db, companyId, parsed.accountId);
        const vatTreatmentId = resolveVatTreatmentId(db, companyId, parsed.vatTreatmentId);
        const result = classifyTransactionManual(db, {
          companyId,
          bankTransactionId: parsed.bankTransactionId,
          accountId,
          vatTreatmentId,
          supplierId: parsed.supplierId,
          fxRate: parsed.fxRateNumerator !== undefined && parsed.fxRateDenominator !== undefined
            ? { numerator: parsed.fxRateNumerator, denominator: parsed.fxRateDenominator }
            : undefined,
          notes: parsed.notes,
        });
        print(result, format);
        return 0;
      }

      case 'create-rule': {
        const conditionsJson = requireFlag(flags, 'conditions');
        const actionsJson = requireFlag(flags, 'actions');
        let conditions: unknown;
        let actions: unknown;
        try {
          conditions = JSON.parse(conditionsJson);
          actions = JSON.parse(actionsJson);
        } catch (e) {
          throw new Error(`Could not parse --conditions or --actions as JSON: ${e instanceof Error ? e.message : e}`);
        }
        const parsed = createRuleCliInput.parse({
          companyId,
          name: requireFlag(flags, 'name'),
          conditions: conditions as CreateRuleCliInput['conditions'],
          actions: actions as CreateRuleCliInput['actions'],
          autoApply: hasFlag(flags, 'auto-apply', 'autoApply'),
          priority: getFlag(flags, 'priority') ? Number(getFlag(flags, 'priority')) : undefined,
        });
        // Resolve account/treatment codes in actions to IDs.
        const resolvedActions = parsed.actions.map((a) => {
          if (a.field === 'accountId' && a.value) {
            return { ...a, value: resolveAccountId(db, companyId, a.value) };
          }
          if (a.field === 'vatTreatmentId' && a.value) {
            return { ...a, value: resolveVatTreatmentId(db, companyId, a.value) };
          }
          return a;
        });
        const ruleId = createRuleManual(db, {
          companyId,
          name: parsed.name,
          conditions: parsed.conditions,
          actions: resolvedActions,
          autoApply: parsed.autoApply,
          priority: parsed.priority,
        });
        print({ ruleId, created: true }, format);
        return 0;
      }

      case 'set-fx': {
        const baseAmountRaw = getFlag(flags, 'base-amount', 'baseAmount');
        const company = requireCompany(db);
        const parsed = setFxInput.parse({
          companyId,
          bankTransactionId: requireFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId'),
          baseAmount: baseAmountRaw !== undefined
            ? parseAmount(baseAmountRaw, company.baseCurrency)
            : undefined,
          fxRateNumerator: parseFxRateFlag(flags, 'fx-rate')?.numerator,
          fxRateDenominator: parseFxRateFlag(flags, 'fx-rate')?.denominator,
        });
        const result = setTransactionFx(db, {
          companyId,
          bankTransactionId: parsed.bankTransactionId,
          baseAmountMinor: parsed.baseAmount,
          fxRateNumerator: parsed.fxRateNumerator,
          fxRateDenominator: parsed.fxRateDenominator,
        });
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

      case 'add-bank': {
        const parsed = addBankInput.parse({
          companyId,
          bankName: requireFlag(flags, 'name', 'bank-name'),
          accountName: getFlag(flags, 'account-name'),
          iban: getFlag(flags, 'iban'),
          bic: getFlag(flags, 'bic'),
          currency: getFlag(flags, 'currency'),
          accountType: getFlag(flags, 'account-type'),
          opening: getFlag(flags, 'opening'),
          openingDate: getFlag(flags, 'opening-date'),
        });
        print(addBank(db, parsed), format);
        return 0;
      }

      case 'add-account': {
        const parsed = addAccountInput.parse({
          companyId,
          code: requireFlag(flags, 'code'),
          name: requireFlag(flags, 'name'),
          type: requireFlag(flags, 'type'),
          subtype: getFlag(flags, 'subtype'),
          reportSection: getFlag(flags, 'report-section'),
          vatApplicable: hasFlag(flags, 'vat-applicable') ? getFlag(flags, 'vat-applicable') !== 'false' : undefined,
        });
        print(addAccount(db, parsed), format);
        return 0;
      }

      case 'add-customer': {
        const parsed = addCustomerInput.parse({
          companyId,
          name: requireFlag(flags, 'name'),
          countryCode: getFlag(flags, 'country', 'country-code', 'countryCode'),
          vatNumber: getFlag(flags, 'vat-number', 'vatNumber', 'vat'),
          defaultAccount: getFlag(flags, 'default-account'),
        });
        print(addCustomer(db, parsed), format);
        return 0;
      }

      case 'create-invoice': {
        const parsed = createInvoiceCsvInput.parse({
          companyId,
          direction: requireFlag(flags, 'direction'),
          file: requireFlag(flags, 'file'),
        });
        print(await createInvoicesFromCsv(db, parsed), format);
        return 0;
      }

      case 'record-payment': {
        const parsed = recordPaymentInput.parse({
          companyId,
          bankTransactionId: getFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId'),
          invoices: getFlag(flags, 'invoices', 'invoice'),
          amount: getFlag(flags, 'amount'),
          date: getFlag(flags, 'date'),
          unallocated: hasFlag(flags, 'unallocated'),
          direction: getFlag(flags, 'direction'),
          method: getFlag(flags, 'method'),
          reference: getFlag(flags, 'reference'),
        });
        print(recordPaymentCli(db, parsed), format);
        return 0;
      }

      case 'journal': {
        const parsed = journalCliInput.parse({
          companyId,
          date: requireFlag(flags, 'date'),
          narrative: requireFlag(flags, 'narrative'),
          reason: getFlag(flags, 'reason'),
          lines: requireFlag(flags, 'lines'),
        });
        print(journalCli(db, parsed), format);
        return 0;
      }

      case 'list-transactions': {
        const parsed = listTransactionsInput.parse({
          companyId,
          bankAccountId: getFlag(flags, 'account', 'account-id', 'accountId'),
          unposted: hasFlag(flags, 'unposted'),
          unclassified: hasFlag(flags, 'unclassified'),
        });
        print(listTransactionsCli(db, parsed), format);
        return 0;
      }

      case 'show-invoice': {
        const parsed = showInvoiceInput.parse({
          companyId,
          number: positionals[0] ?? requireFlag(flags, 'number'),
        });
        print(showInvoiceCli(db, parsed), format);
        return 0;
      }

      case 'year-end': {
        const parsed = yearEndCliInput.parse({
          companyId,
          from: requireFlag(flags, 'from'),
          to: requireFlag(flags, 'to'),
        });
        print(yearEndCli(db, parsed), format);
        return 0;
      }

      case 'vat-return': {
        const parsed = vatReturnCliInput.parse({
          companyId,
          period: requireFlag(flags, 'period'),
        });
        print(vatReturnCli(db, parsed), format);
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

/** Parse an --fx-rate flag of the form "num/den" (e.g. "113/100"). */
function parseFxRateFlag(
  flags: Record<string, string | boolean>,
  ...names: string[]
): { numerator: number; denominator: number } | undefined {
  const raw = getFlag(flags, ...names);
  if (raw === undefined) return undefined;
  const parts = raw.split('/');
  if (parts.length !== 2) {
    throw new Error(`--fx-rate must be "numerator/denominator", e.g. "113/100". Got: ${raw}`);
  }
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1]);
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator)) {
    throw new Error(`--fx-rate numerator and denominator must be integers. Got: ${raw}`);
  }
  return { numerator, denominator };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}

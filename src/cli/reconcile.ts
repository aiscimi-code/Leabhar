import { parseArgs, getFlag, hasFlag } from './args';
import { print, error, type Format } from './format';
import { getAgentDb, requireCompany } from '@/agent/context';
import type { AppDatabase } from '@/db';
import { parseAmount, parseRate } from '@/domain/money';
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
  initCompany, addBank, addAccount, addCustomer, listSuppliersCli, listCustomersCli,
  ensureDefaultAccountsCli, installRulePackCli,
} from '@/agent/induction';
import {
  createInvoicesFromCsv, importInvoicesFromCsv, recordPaymentCli, journalCli,
  listTransactionsCli, showInvoiceCli, yearEndCli, vatReturnCli,
  voidInvoiceCli, reverseJournalCli,
} from '@/agent/books';
import { scanAnomaliesCli, listReviewQueueCli } from '@/agent/review';
import {
  showDocumentCli, confirmDocumentCli, lineChoicesCli, postDocumentCli, settleCli, traceCli,
} from '@/agent/consolidate';
import { suggestVatTreatment } from '@/domain/rules/vatSuggestion';
import { confirmEstablishment, confirmCustomerTaxableStatus, checkVatNumberWithVies } from '@/domain/parties/status';
import { confirmRctPrincipal, recordCashBasisAuthorisation } from '@/domain/config/companyStatus';
import {
  registerCapitalGood, recordIntervalUse, recordCapitalGoodDisposal, postCapitalGoodAdjustment,
  postCapitalGoodDisposalAdjustment, capitalGoodsOverview,
} from '@/domain/vat/capitalGoods';
import { eq } from 'drizzle-orm';
import { resolveVatPeriodId } from '@/agent/books';
import { reconcileVatReturn } from '@/domain/vat/reconcile';
import { buildRtdReturn } from '@/domain/vat/rtd';
import { buildViesStatement } from '@/domain/vat/vies';
import { computeCorporationTax, recordCtDecision } from '@/domain/corporationTax/computation';
import { asIsoDate } from '@/domain/dates';
import { companies } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from '@/domain/rules/knowledgeBase';
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
  importInvoicesCsvInput,
  recordPaymentInput,
  journalCliInput,
  listTransactionsInput,
  showInvoiceInput,
  yearEndCliInput,
  vatReturnCliInput,
  voidInvoiceCliInput,
  reverseJournalCliInput,
  scanAnomaliesCliInput,
  listReviewQueueInput,
  listPartiesInput,
  ensureDefaultAccountsInput,
  installRulePackInput,
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
      [--taxable-status taxable_person|non_taxable_person]  (VATCA s.34: business or consumer)
  ensure-default-accounts                Add any default chart accounts
      introduced since this company was created (e.g. 6180/6190/5030/2210/
      1020) — a new company gets them all already; this is only for one
      induced earlier.
  install-rule-pack [--employee "Name"] [--second-bank-account <code>]
      [--rent-account <code>]            Starter Irish SME bank-narrative
      rules (wages, employer PRSI, a Revenue PAYE remittance, VAT3, rent, an
      own-account transfer to savings, director drawings) — every rule is a
      normal, editable row, not a fixed behaviour. A Stripe payout or a
      loan's capital/interest split is a multi-line journal --transaction,
      not something a single-account rule can point at.

Books (once induction is done):
  create-invoice --direction sales|purchase --file <invoices.csv>
      One row per invoice/bill. Columns: invoiceNumber, date, party (a
      customer/supplier name or id), description, net, account, vatTreatment,
      and optionally dueDate, supplyDate, statedVat, currency, creditNote,
      reference.
  import-invoices --direction sales|purchase --file <invoices.csv>
      --account <code> --vat-treatment <code>
      The intake version: also creates a documents row (a real CSV/PDF if
      the row's own "document" column points to one, else a synthetic text
      stand-in) linked to the invoice, so match() and missingDocuments can
      actually find it — create-invoice alone posts the invoice with no
      evidence behind it. Creates or reuses the customer/supplier by name.
      Every row posts to the SAME --account/--vat-treatment (no per-row
      account column, unlike create-invoice --file). Columns: invoiceNumber,
      date, party, net, and optionally vat (stated, trusted over
      recomputing), gross (cross-checked; a mismatch is a warning, not a
      failure), due, description, currency, reference, document, and type
      (contains "credit", or a number starting "CN-", -> credit note; net/
      vat/gross are still given as positive amounts either way).
  record-payment [--transaction <id>] [--invoices "INV-1,INV-2"]
      [--amount <amount>] [--date <date>] [--unallocated] [--method ...]
      [--direction received|made]  Needed only if neither --invoices nor
      --transaction implies it (e.g. an --unallocated payment with no evidence).
      Exact: one invoice, no --amount (pays it in full). Lump: several
      --invoices, paid off in the order given until the amount runs out.
      Part: one invoice with --amount below its outstanding balance.
      --unallocated leaves the whole payment on account, on purpose.
  journal --date <date> --narrative "..." --lines <json> [--reason "..."]
      A standalone multi-line manual adjustment (a VAT3 settlement, an
      own-account transfer). --lines is a JSON array of
      {"account":"code","debit":"100.00"} / {"account":"code","credit":"100.00"}
      objects, amounts in major units; at least two lines, and they must balance.
  journal --transaction <id> --lines <json> [--vat <json>]
      A split for ONE statement line instead (a Stripe payout's fee
      breakdown, a loan repayment's capital/interest split) — posted and
      linked (bank_transactions.journalEntryId/status) in the same call,
      dated at the transaction's own date. --date/--narrative/--reason do
      not apply here. --vat additionally records this transaction's own VAT
      position: {"direction":"sales","treatment":"IE_STD","net":"1744.94",
      "statedVat":"401.34"}. Output VAT only: input VAT comes only from a
      confirmed supplier invoice, so a "purchases" --vat, or a line debiting
      VAT on purchases, is refused.

Supplier and customer VAT status (issue #207) — never decided from a country code:
  confirm-establishment (--supplier <id> | --customer <id>) --establishment outside_state|in_state
      --basis "<what it rests on>" --confirmed-by "<name>"
      Records where the business is established (EU Reg 282/2011 arts.10-11).
      A person's decision: an agent must never confirm it on its own judgement.
  confirm-customer-status --customer <id> --status taxable_person|non_taxable_person --confirmed-by "<name>"
  check-vies (--supplier <id> | --customer <id>)
      Checks the party's VAT number with VIES and stores the answer; anything
      but a clear yes or no is stored as "unavailable", never as valid.

The company's own VAT status (issue #208) — a person's record, never inferred:
  confirm-rct-principal --status principal|not_principal [--from YYYY-MM-DD]
      --basis "<what it rests on>" --confirmed-by "<name>"
      Whether the company is an RCT principal (TCA 1997 s.530A); from that date,
      construction services it receives are reverse-charged (VATCA s.16(3)).
  record-cash-basis --eligibility turnover_threshold|supplies_to_unregistered
      --from YYYY-MM-DD --reference "<Revenue reference>" --confirmed-by "<name>"
      Revenue's authorisation for the cash receipts basis (s.80, S.I. 639/2010 reg.25).

Capital goods scheme (VATCA ss.63-64, issue #208) — figures calculated, never typed:
  capital-goods                                     list each good, its intervals and adjustments
  register-capital-good --description "<text>" --kind acquisition_or_development|refurbishment
      --start YYYY-MM-DD --invoices <id,id> --deducted <amount> --registered-by "<name>"
      The total tax incurred comes from the invoices; --deducted is the part claimed when incurred.
  record-cgs-interval --good <id> --interval <n> (--use <percent> | --not-used) --recorded-by "<name>"
  record-cgs-disposal --good <id> --date YYYY-MM-DD --taxable true|false --recorded-by "<name>"
  post-cgs-adjustment (--interval-record <id> | --good <id> --disposal) --account <code> --posted-by "<name>"

Invoice-led workflow (issue #222) — the same domain functions as the web screens:
  show-document <id>                     The document's values (draft or confirmed, minor
                                          units), its lines, VAT totals and checks
  confirm-document <id> --confirmed-by "<name>" [--values <json>] [--ack <codes>]
      [--supplier <id> | --create-supplier] [--customer <id> | --create-customer]
      [--note "..."]
      Records that the NAMED PERSON checked the document against the page.
      Confirmation is a person's decision: an agent must never confirm on its
      own judgement. --values corrects the draft (JSON object, minor units;
      lines/vatTotals replace the whole list). --ack accepts warnings by code.
  line-choices <documentId>              Per-line VAT treatment options with the reasons
                                          and rules behind each; a suggestion only
                                          where every source agrees
  post-document <documentId> --coding <json> [--fx <rate>] [--declare-in <date>] [--hold-vat]
      Posts the confirmed document as an invoice, line by line, with the VAT
      as printed. --coding: [{"account":"6120","treatment":"IE_STD"}, ...],
      one per line; a line may omit treatment/account only where line-choices
      suggested one. --fx: base per 1 unit of the document's currency
      (1.0842 or 10842/10000).
  settle <transactionId> --allocations <json> [--fx <rate>] [--declare-in <date>]
      Settles the bank line against invoices:
      [{"invoice":"MOS-5120","amount":"24.60"}], amounts in the bank line's
      currency. A remainder is held on account and flagged.
  trace <transactionId>                  Bank line -> payment -> invoices -> document lines
                                          -> rules -> VAT entries -> VAT3 box

Inspect:
  list-transactions [--account <id>] [--unposted] [--unclassified]
  show-invoice <number>                  Full detail incl. lines and payments
  year-end --from <date> --to <date>     P&L, balance sheet, tax worksheet,
                                          fixed assets, VAT periods, issues
  vat-return --period <id-or-name>       VAT3 box figures for one period
  vat-reconcile --period <id-or-name>    Boxes vs entries, VAT accounts vs return,
                                          and what the return excludes
  rtd --date <date>                      Return of trading details for the
                                          accounting year containing the date
  vies --month <YYYY-MM> [--quarterly]   VIES statement for the month (or the
                                          quarter ending that month)
  ct-computation --from <date> --to <date>
                                         Corporation tax computation for the
                                          accounting period, with open decisions
  ct-decide --subject-type <journal_line|income_account> --subject <id>
            --period-end <date> --choice <choice> --by <name>
                                         Record a treatment the computation suggested
  list-suppliers                         Every supplier (id, name, country, VAT no.)
  list-customers                         Every customer (id, name, country, VAT no.)

Statutory VAT rules (issue #200):
  load-statutory-rules                   Ingest every docs/statutes source and derive the
                                         statutory rules for this company (idempotent)
  suggest-vat --transaction <id>         Suggest a VAT treatment for one bank transaction
      from the statutory rules, with the provision, source file, SHA-256 and
      quoted text that justify it. A suggestion only: nothing is posted.

Review queue:
  scan-anomalies [--from <date>] [--to <date>] [--sync]
      Runs the deterministic anomaly scan (duplicate invoices, hospitality-
      rate mismatches, an unidentified supplier, ...). --sync also writes
      the findings into the review queue; without it, this only reports them.
  list-review-queue [--status open|resolved|dismissed|snoozed|superseded|all]
      [--severity info|warning|error|blocking] [--kind <kind>]
      Defaults to open items, sorted blocking -> error -> warning -> info.

Corrections:
  void-invoice <number> --date <date> --reason "..."
      Reverses the invoice's journal entry and any VAT entries (dated at
      --date, not the invoice date) and marks it void. Refuses an invoice
      that already has a payment allocated — unallocate it first.
  reverse-journal <entry-id> --date <date> --reason "..."
      Reverses any journal entry (debits/credits swapped), for a mistake
      made via journal or any other posting path.

Agent workflow:
  1. init-company, add-bank --opening, add-account for anything the default
     chart does not cover, add-customer for sales counterparties.
     ensure-default-accounts if this company was induced before a code
     existed; install-rule-pack for common Irish SME bank narratives.
  2. import a statement (or run over already-imported data)
  3. import-invoices from CSV (sales/purchase) if the pack is invoice-led —
     also creates the matchable document create-invoice alone does not;
     create-invoice where a per-row account/vatTreatment is needed instead.
     create suppliers for names that have no supplier yet.
  4. for each extracted document: show-document, then a PERSON checks it
     against the page and it is confirmed (confirm-document --confirmed-by);
     line-choices, then post-document. match only reads confirmed documents.
  5. settle bank lines against their invoices (the VAT comes from the
     invoice); classify the rest (manually via classify, auto-classify from
     rules — a purchase without an invoice claims no input VAT and is
     flagged) and journal anything that is not a single-account posting
  6. set-fx on foreign lines that lack a settled base amount
  7. reconcile; --sign-off when reconciled; year-end / vat-return to inspect
  8. scan-anomalies --sync periodically; void-invoice / reverse-journal to
     correct a mistake rather than editing or deleting the original posting

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
  --sync              Also write scan-anomalies findings to the review queue
  --status, --severity, --kind  Filters for list-review-queue
  --entry <id>         Journal entry id (reverse-journal)
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
          taxableStatus: getFlag(flags, 'taxable-status'),
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

      case 'import-invoices': {
        const parsed = importInvoicesCsvInput.parse({
          companyId,
          direction: requireFlag(flags, 'direction'),
          file: requireFlag(flags, 'file'),
          account: requireFlag(flags, 'account', 'account-id', 'accountId'),
          vatTreatment: requireFlag(flags, 'vat-treatment', 'vat-treatment-id', 'vatTreatmentId'),
        });
        print(await importInvoicesFromCsv(db, parsed), format);
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
          date: getFlag(flags, 'date'),
          narrative: getFlag(flags, 'narrative'),
          reason: getFlag(flags, 'reason'),
          lines: requireFlag(flags, 'lines'),
          transaction: getFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId'),
          vat: getFlag(flags, 'vat'),
        });
        print(journalCli(db, parsed), format);
        return 0;
      }

      case 'show-document': {
        print(showDocumentCli(db, { companyId, documentId: positionals[0] ?? requireFlag(flags, 'document') }), format);
        return 0;
      }

      case 'confirm-establishment': {
        const supplierId = getFlag(flags, 'supplier');
        const party = supplierId ? 'supplier' as const : 'customer' as const;
        const establishment = requireFlag(flags, 'establishment');
        if (establishment !== 'outside_state' && establishment !== 'in_state') {
          throw new Error('--establishment must be outside_state or in_state.');
        }
        confirmEstablishment(db, {
          companyId, party, partyId: supplierId ?? requireFlag(flags, 'customer'), establishment,
          basis: requireFlag(flags, 'basis'), confirmedBy: requireFlag(flags, 'confirmed-by'),
        });
        print({ ok: true, party, establishment }, format);
        return 0;
      }

      case 'confirm-rct-principal': {
        const status = requireFlag(flags, 'status');
        if (status !== 'principal' && status !== 'not_principal') throw new Error('--status must be principal or not_principal.');
        confirmRctPrincipal(db, {
          companyId, status, from: getFlag(flags, 'from') ?? null,
          basis: requireFlag(flags, 'basis'), confirmedBy: requireFlag(flags, 'confirmed-by'),
        });
        print({ ok: true, status }, format);
        return 0;
      }

      case 'record-cash-basis': {
        const eligibility = requireFlag(flags, 'eligibility');
        if (eligibility !== 'turnover_threshold' && eligibility !== 'supplies_to_unregistered') {
          throw new Error('--eligibility must be turnover_threshold or supplies_to_unregistered.');
        }
        recordCashBasisAuthorisation(db, {
          companyId, eligibility, authorisedFrom: requireFlag(flags, 'from'),
          reference: requireFlag(flags, 'reference'), confirmedBy: requireFlag(flags, 'confirmed-by'),
        });
        print({ ok: true, eligibility }, format);
        return 0;
      }

      case 'capital-goods': {
        print(capitalGoodsOverview(db, { companyId }), format);
        return 0;
      }

      case 'register-capital-good': {
        const kind = requireFlag(flags, 'kind');
        if (kind !== 'acquisition_or_development' && kind !== 'refurbishment') {
          throw new Error('--kind must be acquisition_or_development or refurbishment.');
        }
        const id = registerCapitalGood(db, {
          companyId, description: requireFlag(flags, 'description'), kind, initialIntervalStart: requireFlag(flags, 'start'),
          sourceInvoiceIds: requireFlag(flags, 'invoices').split(',').map((x) => x.trim()).filter(Boolean),
          deductedMinor: parseAmount(requireFlag(flags, 'deducted'), 'EUR'), registeredBy: requireFlag(flags, 'registered-by'),
        });
        print({ ok: true, capitalGoodId: id }, format);
        return 0;
      }

      case 'record-cgs-interval': {
        const notUsed = flags['not-used'] !== undefined;
        const use = getFlag(flags, 'use');
        if (!notUsed && use === undefined) throw new Error('Give --use <percent> or --not-used.');
        const row = recordIntervalUse(db, {
          companyId, capitalGoodId: requireFlag(flags, 'good'), intervalNumber: Number(requireFlag(flags, 'interval')),
          proportionBp: notUsed ? undefined : parseRate(use!), notUsed, recordedBy: requireFlag(flags, 'recorded-by'),
        });
        print(row, format);
        return 0;
      }

      case 'record-cgs-disposal': {
        const taxable = requireFlag(flags, 'taxable');
        if (taxable !== 'true' && taxable !== 'false') throw new Error('--taxable must be true or false.');
        print(recordCapitalGoodDisposal(db, {
          companyId, capitalGoodId: requireFlag(flags, 'good'), disposedOn: requireFlag(flags, 'date'),
          taxable: taxable === 'true', recordedBy: requireFlag(flags, 'recorded-by'),
        }), format);
        return 0;
      }

      case 'post-cgs-adjustment': {
        const accountId = resolveAccountId(db, companyId, requireFlag(flags, 'account'));
        const postedBy = requireFlag(flags, 'posted-by');
        const result = flags['disposal'] !== undefined
          ? postCapitalGoodDisposalAdjustment(db, { companyId, capitalGoodId: requireFlag(flags, 'good'), accountId, postedBy })
          : postCapitalGoodAdjustment(db, { companyId, intervalId: requireFlag(flags, 'interval-record'), accountId, postedBy });
        print({ ok: true, ...result }, format);
        return 0;
      }

      case 'confirm-customer-status': {
        const status = requireFlag(flags, 'status');
        if (status !== 'taxable_person' && status !== 'non_taxable_person') {
          throw new Error('--status must be taxable_person or non_taxable_person.');
        }
        confirmCustomerTaxableStatus(db, {
          companyId, customerId: requireFlag(flags, 'customer'), taxableStatus: status,
          confirmedBy: requireFlag(flags, 'confirmed-by'),
        });
        print({ ok: true, status }, format);
        return 0;
      }

      case 'check-vies': {
        const supplierId = getFlag(flags, 'supplier');
        const company = db.select({ vatNumber: companies.vatNumber }).from(companies).where(eq(companies.id, companyId)).get();
        print(await checkVatNumberWithVies(db, {
          companyId, party: supplierId ? 'supplier' : 'customer', partyId: supplierId ?? requireFlag(flags, 'customer'),
          requesterVatNumber: company?.vatNumber ?? null, actor: 'cli',
        }), format);
        return 0;
      }

      case 'confirm-document': {
        print(confirmDocumentCli(db, {
          companyId,
          documentId: positionals[0] ?? requireFlag(flags, 'document'),
          confirmedBy: requireFlag(flags, 'confirmed-by'),
          values: getFlag(flags, 'values'),
          ack: getFlag(flags, 'ack'),
          supplierId: getFlag(flags, 'supplier'),
          customerId: getFlag(flags, 'customer'),
          createSupplier: hasFlag(flags, 'create-supplier'),
          createCustomer: hasFlag(flags, 'create-customer'),
          note: getFlag(flags, 'note'),
        }), format);
        return 0;
      }

      case 'line-choices': {
        print(lineChoicesCli(db, { companyId, documentId: positionals[0] ?? requireFlag(flags, 'document') }), format);
        return 0;
      }

      case 'post-document': {
        print(postDocumentCli(db, {
          companyId,
          documentId: positionals[0] ?? requireFlag(flags, 'document'),
          coding: requireFlag(flags, 'coding'),
          fx: getFlag(flags, 'fx'),
          vatDeclarationDate: getFlag(flags, 'declare-in'),
          holdVat: flags['hold-vat'] !== undefined,
        }), format);
        return 0;
      }

      case 'settle': {
        print(settleCli(db, {
          companyId,
          bankTransactionId: positionals[0] ?? requireFlag(flags, 'transaction'),
          allocations: requireFlag(flags, 'allocations'),
          fx: getFlag(flags, 'fx'),
          vatDeclarationDate: getFlag(flags, 'declare-in'),
        }), format);
        return 0;
      }

      case 'trace': {
        print(traceCli(db, { companyId, bankTransactionId: positionals[0] ?? requireFlag(flags, 'transaction') }), format);
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

      case 'vat-reconcile': {
        const vatPeriodId = resolveVatPeriodId(db, companyId, requireFlag(flags, 'period'));
        print(reconcileVatReturn(db, { companyId, vatPeriodId }), format);
        return 0;
      }

      case 'rtd': {
        print(buildRtdReturn(db, { companyId, date: requireFlag(flags, 'date') }), format);
        return 0;
      }

      case 'vies': {
        const month = requireFlag(flags, 'month');
        const m = /^(\d{4})-(\d{2})$/.exec(month);
        if (!m) throw new Error('--month takes YYYY-MM.');
        print(buildViesStatement(db, {
          companyId, frequency: hasFlag(flags, 'quarterly') ? 'Q' : 'M', year: Number(m[1]), month: Number(m[2]),
        }), format);
        return 0;
      }

      case 'ct-computation': {
        print(computeCorporationTax(db, {
          companyId, from: asIsoDate(requireFlag(flags, 'from')), to: asIsoDate(requireFlag(flags, 'to')),
        }), format);
        return 0;
      }

      case 'ct-decide': {
        const subjectType = requireFlag(flags, 'subject-type');
        if (subjectType !== 'journal_line' && subjectType !== 'income_account') {
          throw new Error('--subject-type is journal_line or income_account.');
        }
        const id = recordCtDecision(db, {
          companyId, subjectType, subjectId: requireFlag(flags, 'subject'), periodEnd: requireFlag(flags, 'period-end'),
          choice: requireFlag(flags, 'choice'), decidedBy: requireFlag(flags, 'by'), note: getFlag(flags, 'note'),
        });
        print({ decisionId: id }, format);
        return 0;
      }

      case 'void-invoice': {
        const parsed = voidInvoiceCliInput.parse({
          companyId,
          number: positionals[0] ?? requireFlag(flags, 'invoice', 'number'),
          date: requireFlag(flags, 'date'),
          reason: requireFlag(flags, 'reason'),
        });
        print(voidInvoiceCli(db, parsed), format);
        return 0;
      }

      case 'reverse-journal': {
        const parsed = reverseJournalCliInput.parse({
          companyId,
          entryId: positionals[0] ?? requireFlag(flags, 'entry', 'entry-id', 'entryId'),
          date: requireFlag(flags, 'date'),
          reason: requireFlag(flags, 'reason'),
        });
        print(reverseJournalCli(db, parsed), format);
        return 0;
      }

      case 'load-statutory-rules': {
        print(loadStatutoryKnowledgeBase(db, { companyId }), format);
        return 0;
      }

      case 'suggest-vat': {
        const bankTransactionId = requireFlag(flags, 'transaction');
        const suggestion = suggestVatTreatment(db, { companyId, bankTransactionId });
        if (!suggestion) throw new Error(`Bank transaction ${bankTransactionId} not found.`);
        print(suggestion, format);
        return 0;
      }

      case 'scan-anomalies': {
        const parsed = scanAnomaliesCliInput.parse({
          companyId,
          from: getFlag(flags, 'from'),
          to: getFlag(flags, 'to'),
          sync: hasFlag(flags, 'sync'),
        });
        print(scanAnomaliesCli(db, parsed), format);
        return 0;
      }

      case 'list-review-queue': {
        const parsed = listReviewQueueInput.parse({
          companyId,
          status: getFlag(flags, 'status'),
          severity: getFlag(flags, 'severity'),
          kind: getFlag(flags, 'kind'),
        });
        print(listReviewQueueCli(db, parsed), format);
        return 0;
      }

      case 'list-suppliers': {
        const parsed = listPartiesInput.parse({ companyId });
        print(listSuppliersCli(db, parsed), format);
        return 0;
      }

      case 'list-customers': {
        const parsed = listPartiesInput.parse({ companyId });
        print(listCustomersCli(db, parsed), format);
        return 0;
      }

      case 'ensure-default-accounts': {
        const parsed = ensureDefaultAccountsInput.parse({ companyId });
        print(ensureDefaultAccountsCli(db, parsed), format);
        return 0;
      }

      case 'install-rule-pack': {
        const parsed = installRulePackInput.parse({
          companyId,
          employee: getFlag(flags, 'employee'),
          secondBankAccount: getFlag(flags, 'second-bank-account', 'second-bank', 'secondBankAccount'),
          rentAccount: getFlag(flags, 'rent-account', 'rentAccount'),
        });
        print(installRulePackCli(db, parsed), format);
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

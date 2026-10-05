import { parseArgs, getFlag, hasFlag } from './args';
import { print, error, type Format } from './format';
import { getAgentDb, requireCompany } from '@/agent/context';
import type { AppDatabase } from '@/db';
import { parseAmount, parseRate, parsePercentBasisPoints } from '@/domain/money';
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
  ensureDefaultAccountsCli, installRulePackCli, addLoanCli, installFarmChartCli,
} from '@/agent/induction';
import {
  createInvoicesFromCsv, importInvoicesFromCsv, recordPaymentCli, journalCli,
  listTransactionsCli, showInvoiceCli, yearEndCli, vatReturnCli,
  voidInvoiceCli, reverseJournalCli,
} from '@/agent/books';
import { scanAnomaliesCli, listReviewQueueCli } from '@/agent/review';
import { PAYROLL_COMMANDS, PAYROLL_USAGE, runPayrollCommand } from '@/agent/payroll';
import { ASSET_COMMANDS, ASSET_USAGE, runAssetCommand } from '@/agent/assets';
import { INVENTORY_COMMANDS, INVENTORY_USAGE, runInventoryCommand } from '@/agent/inventory';
import { FARM_COMMANDS, FARM_USAGE, runFarmCommand } from '@/agent/farm';
import { FARM_TAX_COMMANDS, FARM_TAX_USAGE, runFarmTaxCommand } from '@/agent/farmTax';
import { CONSTRUCTION_COMMANDS, CONSTRUCTION_USAGE, runConstructionCommand } from '@/agent/construction';
import { FORECAST_COMMANDS, FORECAST_USAGE, runForecastCommand } from '@/agent/forecast';
import { REPORT_COMMANDS, REPORT_USAGE, runReportCommand } from '@/agent/reports';
import {
  listUsersCli, listRolesCli, inviteUserCli, removeUserCli, setUserRoleCli, resetUserPasswordCli,
} from '@/agent/users';
import {
  showDocumentCli, confirmDocumentCli, lineChoicesCli, postDocumentCli, settleCli, traceCli, resolveInvoiceId,
} from '@/agent/consolidate';
import { suggestVatTreatment } from '@/domain/rules/vatSuggestion';
import { confirmEstablishment, confirmCustomerTaxableStatus, checkVatNumberWithVies } from '@/domain/parties/status';
import { confirmRctPrincipal, recordCashBasisAuthorisation } from '@/domain/config/companyStatus';
import { archiveAccount, restoreAccount } from '@/domain/config/mutations';
import {
  setAccountMapping, clearAccountMapping, listAccountMappings, mappedTrialBalance,
} from '@/domain/config/accountMappings';
import {
  registerCapitalGood, recordIntervalUse, recordCapitalGoodDisposal, postCapitalGoodAdjustment,
  postCapitalGoodDisposalAdjustment, capitalGoodsOverview,
} from '@/domain/vat/capitalGoods';
import { and, eq } from 'drizzle-orm';
import { suggestJournalMatches, linkBankTransactionToJournal } from '@/domain/banking/journalLink';
import { withdrawMatchRejection } from '@/domain/matching/service';
import { allocatePaymentOnAccount, paymentsOnAccount } from '@/domain/invoicing/onAccount';
import { reconciliationStatement } from '@/domain/banking/reconciliationStatement';
import { salesInvoiceDocument } from '@/domain/invoicing/invoiceDocument';
import { createInvoice } from '@/domain/invoicing/invoices';
import { writeOffBadDebt, reverseBadDebtWriteOff, claimBadDebtRelief } from '@/domain/invoicing/badDebts';
import { recordDeemedSupply } from '@/domain/vat/deemedSupply';
import { setSupplierTerms } from '@/domain/parties/supplierAccount';
import {
  overdueInvoices, customerStatement, produceReminderLetter, reminderLetter, receivablesSummary,
} from '@/domain/invoicing/receivables';
import { renderStatementPdf, renderReminderPdf } from '@/lib/receivablesPdf';
import { applyCreditNote, unapplyCreditNote, refundOnAccount, customerCredit } from '@/domain/invoicing/customerCredit';
import { renderInvoicePdf } from '@/lib/invoicePdf';
import { renderPurchaseOrderPdf } from '@/lib/purchaseOrderPdf';
import { supplierStatement, reconcileSupplierStatement } from '@/domain/invoicing/supplierStatements';
import {
  createPurchaseOrder, listPurchaseOrders, getPurchaseOrder, linkBillToPurchaseOrder, unlinkBillFromPurchaseOrder,
  cancelPurchaseOrder, purchaseOrderDocument,
} from '@/domain/invoicing/purchaseOrders';
import { purchaseOrders } from '@/db/schema';
import {
  createRecurringBill, runExpectedBills, listRecurringBills, matchExpectedBill, unmatchExpectedBill,
  dismissExpectedBill, deactivateRecurringBill,
} from '@/domain/invoicing/expectedBills';
import { writeFileSync } from 'node:fs';
import {
  createRecurringInvoice, postDueRecurringInvoices, listRecurringInvoices,
} from '@/domain/invoicing/recurringInvoices';
import {
  setCustomerTerms, addCustomerContact, listCustomerContacts, customerExposure,
} from '@/domain/parties/customerAccount';
import { toCsv, amountFor } from '@/lib/csv';
import { resolveVatPeriodId } from '@/agent/books';
import { reconcileVatReturn } from '@/domain/vat/reconcile';
import { buildRtdReturn } from '@/domain/vat/rtd';
import { buildViesStatement } from '@/domain/vat/vies';
import { computeCorporationTax, recordCtDecision, CT_SUBJECT_TYPES, isCtSubjectType } from '@/domain/corporationTax/computation';
import { buildCt1Worksheet } from '@/domain/corporationTax/ct1';
import { computeIncomeTax } from '@/domain/incomeTax/computation';
import { addPartner, setPartnerShare, partnerSharesOn } from '@/domain/config/partners';
import { recordPartnerLoan } from '@/domain/partnerships/loans';
import { recordPartnerLoanInterest } from '@/domain/partnerships/interest';
import { partnerAllocationStatement, form1Firms } from '@/domain/partnerships/report';
import { partners, bankAccounts, invoices } from '@/db/schema';
import { recordManualTransaction, rollbackStatementImport, listStatementImports } from '@/domain/banking/import';
import { asIsoDate, today } from '@/domain/dates';
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
  addLoanInput,
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
  inviteUserInput,
  userRefInput,
  setUserRoleInput,
  listPartiesInput,
  ensureDefaultAccountsInput,
  installRulePackInput,
  archiveAccountInput,
  restoreAccountInput,
  mapAccountInput,
  unmapAccountInput,
  listAccountMappingsInput,
  mappedTrialBalanceInput,
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
  list-users [--as <user>]               The book's users and their roles
  list-roles                             The roles and what each may do
  invite-user --username <name> --role <role> [--display-name "..."] [--as <user>]
                                         Create a user with a one-time password
  remove-user (--user <name>) [--as <user>]
                                         Remove a user's access to the book
  set-user-role --user <name> --role <role> [--as <user>]
                                         Change what a user may do
  reset-user-password --user <name> [--as <user>]
                                         Issue a fresh one-time password
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
  withdraw-rejection --document <id> --transaction <id> --reason "..." --actor "Name"
      Undo a rejected match, so matching may suggest the pairing again
  suggest-journal --transaction <id> [--window-days 7]
      Posted journals this line may already be, e.g. a transfer classified
      from the other account; nothing is written
  link-journal --transaction <id> --journal <id> --reason "..." --actor "Name"
      Mark the line as the evidence for that journal (posts nothing new)
  create-supplier --name "..." [--country <IE>]    Create a supplier (ai_suggestion)
  reconcile --account <id>               Compute reconciliation (read-only)
            --from <date> --to <date>
  reconcile ... --sign-off               Record the reconciliation
  reconcile ... --csv                    Print the bank reconciliation statement
                                         as CSV (statement, items, ledger, sign-off)
            [--accept-difference "reason"]
  list-imports                           The import history, newest first
  rollback-import --import <id> --reason "..." --actor "Name"
      Undo an import that went wrong; refused while the books rest on a line
  record-manual --account <id> --date <date> --description "..." --amount <-12.30>
      --recorded-by "Name" [--reference ...]  A movement with no statement
      line, e.g. petty cash; negative is money out
  run --account <id> [--file <path>]     import (optional) -> auto-classify -> reconcile
     --from <date> --to <date>

Induction (no company/bank/chart yet):
  init-company --name "..."              Create a company + default chart
      [--vat-basis invoice|cash_receipts] [--vat-frequency bi_monthly]
      [--year-end MM-DD] [--base-currency EUR] [--seed-years "2024,2025"]
      [--chart sm|farm]  Farm installs the farm chart (issue #360): the base
      chart with farm income accounts (sales, scheme income, contract work),
      livestock and crops on hand, farm machinery, and the farm cost lines.
  add-bank --name "..."                  Add a bank account
      [--iban ...] [--currency EUR] [--account-type current]
      Types: current, deposit, savings, credit_card, loan, merchant, cash, other.
      Each account gets its own ledger account; a card or loan is a liability.
      [--loan <loan id>]  For a loan account: post to that loan's liability
      [--opening <amount> --opening-date <date>]  Also journals the opening
      balance (Dr this account / Cr retained earnings) — not just stored.
  add-account --code <code> --name "..." --type asset|liability|equity|income|expense
      [--subtype ...] [--report-section current_assets|current_liabilities|
      fixed_assets|revenue|cost_of_sales|operating_expenses|finance_costs|
      long_term_liabilities|equity]
      [--vat-applicable=false]
  add-loan --lender "..." --date <drawdown date>
      [--loan "Term loan"] [--kind term_loan|hire_purchase|mortgage|
      credit_line|other] [--account <code>] [--principal <amount>]
      [--maturity <date>] [--notes "..."]
      Registers a loan and links it to a liability account — its own account
      (2211, 2212, ... after the seeded 2210) unless --account names an
      existing liability. --principal journals the drawdown (Dr bank / Cr the
      loan account) at --date: give it only when the drawdown predates the
      first imported statement — a drawdown that is a statement line of its
      own is classified there instead, and journaling it twice counts it twice.
  add-customer --name "..." [--country <IE>] [--default-account <code>]
      [--taxable-status taxable_person|non_taxable_person]  (VATCA s.34: business or consumer)
  ensure-default-accounts                Add any default chart accounts
      introduced since this company was created (e.g. 6180/6190/5030/2210/
      1020/2445), plus any default VAT rates and treatments and the civil
      service mileage and subsistence expense rates — a new company gets
      them all already; this is only for one induced earlier.
  install-farm-chart                    Turn an existing book's chart into the
      farm chart: adds the farm accounts and renames the base accounts that
      are still under their seeded names — one the user has already renamed
      is theirs and is reported as skipped, never touched.
  archive-account --account <code> --reason "..."
      [--date <date>]  Retire an account from the chart: no new postings, not
      offered when classifying, history untouched, effective window closed on
      --date (default today). A live balance is flagged on the review queue.
  restore-account --account <code> --reason "..."
      Reopen an archived account. Both need a reason, both are audited.
  map-account --account <code> --chart "..." --external-code <code>
      [--external-name "..."] [--notes "..."]  Record (or replace) how one
      account is coded in one external chart — the accountant's chart, or
      another package's. One mapping per account per chart.
  unmap-account --account <code> --chart "..."  Remove one mapping.
  list-account-mappings [--chart "..."]  Every mapping, or one chart's.
  mapped-trial-balance --chart "..." [--as-of <date>]
      The posted trial balance restated in the external chart's codes.
      Accounts with balances but no mapping are listed with a blank external
      code — never dropped silently.
  install-rule-pack [--employee "Name"] [--second-bank-account <code>]
      [--rent-account <code>]            Starter Irish SME bank-narrative
      rules (wages, employer PRSI, a Revenue PAYE remittance, VAT3, rent, an
      own-account transfer to savings, director drawings) — every rule is a
      normal, editable row, not a fixed behaviour. A Stripe payout or a
      loan's capital/interest split is a multi-line journal --transaction,
      not something a single-account rule can point at.

Books (once induction is done):
  set-customer-terms --customer <id> --actor "Name" [--terms-days 30]
      [--credit-limit <5000.00|none>]  Due dates of new invoices follow the
      terms; going over the limit is flagged, never refused
  set-supplier-terms --supplier <id> --terms-days <30> --actor "Name"
      Bills with no due date of their own are due this long after the invoice
  add-contact --customer <id> --name "..." --actor "Name" [--email ...]
      [--role ...] [--phone ...] [--billing]  --billing: invoices go to them
  list-contacts --customer <id>
  create-recurring-invoice --customer <id> --name "..." --frequency monthly|quarterly|yearly
      --start <date> [--end <date>] --actor "Name" --lines <json>
      [{"description":"Retainer","net":"1000.00","account":"4020","vatTreatment":"IE_STD",
        "discountPercent":"10"}]  A template; nothing is raised until:
  post-recurring-invoices --actor "Name" [--up-to <date>]
      Raise every due occurrence once; one in a locked period is skipped and flagged
  list-recurring-invoices
  create-debit-note --invoice <number|id> --description "..." --net <12.30>
      --account <code> --vat-treatment <code> --actor "Name" [--date <date>]
      An additional charge against that invoice, posted like an invoice
  overdue [--as-of <date>] [--customer <id>]   Overdue sales invoices, computed on the day
  receivables [--as-of <date>]           Owed, overdue, on account, top debtors, over limit
  customer-statement --customer <id> --from <date> --to <date> [--out file.pdf]
  produce-reminder --customer <id> --actor "Name" [--level 1|2|3] [--as-of <date>] [--out file.pdf]
      Records a reminder letter for the customer's overdue invoices
  write-off-bad-debt --invoice <number|id> --reason "..." --actor "Name" [--date <date>]
      [--account <expense code>]  Outstanding to bad debts; VAT handled per basis
  reverse-bad-debt --invoice <number|id> --reason "..." --actor "Name" [--date <date>]
      A relieved debt: the relief is charged back in T1 (S.I. 639/2010 reg.10(10))
  claim-bad-debt-relief --invoice <number|id> --actor "Name" [--date <date>]
      --reasonable-steps yes|no --allowable-s81 yes|no --records-kept yes|no
      --connected yes|no --s95-letting yes|no --hire-purchase yes|no
      VAT relief on a debt written off on the invoice basis, A x B / (100 + B),
      in T2 (VATCA s.39(2), S.I. 639/2010 reg.10); each fact must be stated
  record-deemed-supply --kind goods|property --date <date> --account <code> --description "..." --actor "Name"
      goods:    --use gift|private-use --cost <12.30> --vat-treatment <code> --tax-deducted yes|no
                (a gift also) --series yes|no --samples yes|no
      property: --acquired-on <date> --acquisition-amount <12.30> --private-area <n> --total-area <n>
                --business-asset yes|no
      Output VAT with no sale invoice (VATCA s.19(1)(g), s.21, s.27(2)); prints the
      reason when it is not a supply, and posts nothing
  apply-credit-note --credit-note <number|id> --invoice <number|id> --amount <12.30>
      --actor "Name" [--date <date>] [--reason ...]  No cash; nothing posted
  unapply-credit-note --payment <id> --actor "Name" --reason "..."
  refund-on-account --payment <id> --amount <12.30> --actor "Name" --reason "..."
      (--transaction <bank line id> | --date <date> --bank-account <id>)
  customer-credit --customer <id>        Open credit notes and money on account
  invoice-pdf --invoice <number|id> --out <file.pdf>
      The sales invoice or credit note as a PDF; marked DRAFT, with the gaps
      listed, while a reg.20 particular is missing
  create-purchase-order --supplier <id> --actor "Name" --lines <json>
      [--date <date>] [--expected <date>] [--notes "..."]
      [{"description":"Toner","quantity":"2","net":"80.00","account":"6120"}]
      Posts nothing and claims no VAT; net is the line total excluding VAT
  list-purchase-orders [--supplier <id>] [--open]
  link-bill --invoice <number|id> --purchase-order <PO-n|id> --actor "Name"
      Link a posted bill to the order it was raised against; billing over
      the order is flagged, never refused
  unlink-bill --invoice <number|id> --actor "Name"
  cancel-purchase-order --purchase-order <PO-n|id> --reason "..." --actor "Name"
  purchase-order-pdf --purchase-order <PO-n|id> --out <file.pdf>
  supplier-statement --supplier <id> --from <date> --to <date> [--out file.pdf]
      Our account with a supplier; closes at their share of creditors
  reconcile-supplier-statement --supplier <id> --as-of <date> --balance <1234.56>
      --actor "Name" [--invoices "INV-1,INV-2"]  Check their statement against
      our books: the difference, invoices we do not hold, ours they do not show.
      Flagged for review; nothing is adjusted
  create-recurring-bill --supplier <id> --name "..." --frequency monthly|quarterly|yearly
      --start <date> --net <1000.00> --actor "Name" [--end <date>]
      [--tolerance-percent 5] [--window-days 10]
      A bill expected on a schedule. Nothing is posted: the supplier's invoice is the bill
  run-expected-bills --actor "Name" [--as-of <date>]
      Expect what is due, match the bills posted from confirmed documents, flag the missing
  list-recurring-bills [--as-of <date>]
  match-expected-bill --expected <id> --invoice <number|id> --actor "Name"
  unmatch-expected-bill --expected <id> --reason "..." --actor "Name"
  dismiss-expected-bill --expected <id> --reason "..." --actor "Name"   No bill is due for it
  deactivate-recurring-bill --recurring-bill <id> --actor "Name"
  create-invoice --direction sales|purchase --file <invoices.csv>
      A purchase with no confirmed supplier document holds its input VAT back
      and is flagged (issue #234). [--vat-already-declared "reason"]: migrated
      invoices whose VAT was declared in the previous system — information
      only, no VAT entries (also on import-invoices)
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
      suggested one. A line shown with deductionBlocked (s.60(2)(a)) deducts
      no VAT unless its entry has "deductible": true. --fx: base per 1 unit
      of the document's currency (1.0842 or 10842/10000).
  settle <transactionId> --allocations <json> [--fx <rate>] [--declare-in <date>]
      Settles the bank line against invoices:
      [{"invoice":"MOS-5120","amount":"24.60"}], amounts in the bank line's
      currency. A remainder is held on account and flagged.
      [--write-off-invoice <number|id> --write-off-account <code>
       --write-off-reason bank_charges|discount|bad_debt]
                                        Close that invoice by writing off what the
      line leaves unpaid. bank_charges: the customer paid in full, so on the
      cash receipts basis all the invoice's VAT is released at the receipt;
      discount is refused (a credit note is needed, VATCA s.67(1)(b), s.80(5));
      bad_debt is refused (use the bad-debt path, issue #404).
  list-on-account [--customer <id>] [--supplier <id>]
      Payments still holding money on account
  allocate-on-account --payment <id> --invoice <number|id> --amount <12.30>
      --actor "Name" [--reason "..."] [--declare-in <date>]
                                         Apply money on account to a later
                                          invoice of the same party; posts no
                                          journal - unless the books are on the
                                          cash receipts basis and the invoice
                                          carries VAT, when its output VAT is
                                          released dated at the receipt
                                          (s.80(1), issue #389). --declare-in
                                          names an open period when the
                                          receipt's own is locked or filed
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
  ct1-worksheet --from <date> --to <date>
                                         CT1 computation worksheet: the tax
                                         reconciliation from accounting profit to
                                         the total liability, payment dates and
                                         what is still open
  it-computation --year <YYYY>           Income tax, USC and PRSI for a sole trader or
                                          partnership's year of assessment
  add-partner --name <n> --share <percent> --joined <date> --by <name> [--precedent] [--ppsn <p>]
  set-partner-share --partner <id> --share <percent> --from <date> --by <name> [--basis <text>]
  partners [--on <date>]                 Partners and the shares in force on a date
  record-partner-loan --partner <id> --amount <euro> --date <date> --by <name>
            [--direction advanced|repaid] [--narrative <text>]
                                         Money a partner lends the firm, or the
                                          firm repaying them (issue #314)
  record-partner-loan-interest --partner <id> --rate <percent> --from <date> --to <date> --by <name>
            [--narrative <text>]
                                         Interest accrued on a partner's loan
                                          over a period (issue #464); computed
                                          from the loan account, added back in
                                          the tax computation until decided
  partners-report [--from <date>] [--to <date>]
                                         Partner allocation statement for a period,
                                          with the Form 1 (Firms) figures for the
                                          year it ends in (issue #314)
  ct-decide --subject-type <type> --subject <id> --period-end <date>
            --choice <choice> --by <name> [--amount <amount>] [--note <text>]
                                         Record a treatment the computation suggested.
                                          --amount is the loss set against other
                                          income for an s.381 claim (issue #521).
                                          <type> is one of:
                                            ${CT_SUBJECT_TYPES.join(`\n${' '.repeat(44)}`)}
  list-suppliers                         Every supplier (id, name, country, VAT no.)
  list-customers                         Every customer (id, name, country, VAT no.)
${PAYROLL_USAGE}${ASSET_USAGE}${INVENTORY_USAGE}${FARM_USAGE}${FARM_TAX_USAGE}${CONSTRUCTION_USAGE}${FORECAST_USAGE}${REPORT_USAGE}
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
  --vat-basis, --vat-frequency, --year-end, --base-currency, --seed-years,
  --entity-type <company|sole_trader|partnership>, --commenced <date>  init-company
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
        entityType: getFlag(flags, 'entity-type'),
        tradeCommencedOn: getFlag(flags, 'commenced'),
        chartKind: getFlag(flags, 'chart'),
      });
      print(initCompany(db, parsed), format);
      return 0;
    }

    const companyId = options.companyId ?? requireCompany(db).id;

    if ((PAYROLL_COMMANDS as readonly string[]).includes(command)) {
      print(runPayrollCommand(db, companyId, command, flags), format);
      return 0;
    }
    if ((ASSET_COMMANDS as readonly string[]).includes(command)) {
      print(runAssetCommand(db, companyId, command, flags), format);
      return 0;
    }
    if ((INVENTORY_COMMANDS as readonly string[]).includes(command)) {
      print(runInventoryCommand(db, companyId, command, flags), format);
      return 0;
    }
    if ((FARM_COMMANDS as readonly string[]).includes(command)) {
      print(runFarmCommand(db, companyId, command, flags), format);
      return 0;
    }
    if ((FARM_TAX_COMMANDS as readonly string[]).includes(command)) {
      print(runFarmTaxCommand(db, companyId, command, flags), format);
      return 0;
    }
    if ((CONSTRUCTION_COMMANDS as readonly string[]).includes(command)) {
      print(runConstructionCommand(db, companyId, command, flags), format);
      return 0;
    }
    if ((FORECAST_COMMANDS as readonly string[]).includes(command)) {
      print(runForecastCommand(db, companyId, command, flags), format);
      return 0;
    }
    if ((REPORT_COMMANDS as readonly string[]).includes(command)) {
      print(runReportCommand(db, companyId, command, flags), format);
      return 0;
    }

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

      case 'list-users': {
        print(listUsersCli(db, getFlag(flags, 'as')), format);
        return 0;
      }

      case 'list-roles': {
        print(listRolesCli(), format);
        return 0;
      }

      case 'invite-user': {
        const parsed = inviteUserInput.parse({
          companyId,
          username: requireFlag(flags, 'username'),
          role: requireFlag(flags, 'role'),
          displayName: getFlag(flags, 'display-name'),
          as: getFlag(flags, 'as'),
        });
        print(inviteUserCli(db, parsed), format);
        return 0;
      }

      case 'remove-user': {
        const parsed = userRefInput.parse({
          companyId,
          user: requireFlag(flags, 'user', 'username'),
          as: getFlag(flags, 'as'),
        });
        print(removeUserCli(db, parsed), format);
        return 0;
      }

      case 'set-user-role': {
        const parsed = setUserRoleInput.parse({
          companyId,
          user: requireFlag(flags, 'user', 'username'),
          role: requireFlag(flags, 'role'),
          as: getFlag(flags, 'as'),
        });
        print(setUserRoleCli(db, parsed), format);
        return 0;
      }

      case 'reset-user-password': {
        const parsed = userRefInput.parse({
          companyId,
          user: requireFlag(flags, 'user', 'username'),
          as: getFlag(flags, 'as'),
        });
        print(resetUserPasswordCli(db, parsed), format);
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

      case 'list-imports': {
        print(listStatementImports(db, companyId), format);
        return 0;
      }

      case 'rollback-import': {
        const result = rollbackStatementImport(db, {
          companyId,
          importId: requireFlag(flags, 'import', 'import-id', 'importId'),
          reason: requireFlag(flags, 'reason'),
          actor: requireFlag(flags, 'actor'),
        });
        print(result, format);
        return 0;
      }

      case 'record-manual': {
        const account = requireFlag(flags, 'account', 'account-id', 'accountId');
        const currency = db.select({ currency: bankAccounts.currency }).from(bankAccounts)
          .where(eq(bankAccounts.id, account)).get()?.currency ?? 'EUR';
        const result = recordManualTransaction(db, {
          companyId,
          bankAccountId: account,
          transactionDate: requireFlag(flags, 'date'),
          description: requireFlag(flags, 'description'),
          amountMinor: parseAmount(requireFlag(flags, 'amount'), currency),
          reference: getFlag(flags, 'reference'),
          recordedBy: requireFlag(flags, 'recorded-by'),
        });
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

        if (hasFlag(flags, 'csv')) {
          // The bank reconciliation statement as CSV, for filing (issue #387).
          const statement = reconciliationStatement(db, {
            companyId, bankAccountId: parsed.bankAccountId,
            periodStart: asIsoDate(parsed.from), periodEnd: asIsoDate(parsed.to),
            statementClosingBalanceMinor: parsed.statementClosingBalance,
          });
          const currency = statement.result.currency;
          process.stdout.write(toCsv(statement.rows, [
            { header: 'Section', value: (r) => r.section },
            { header: 'Date', value: (r) => r.date },
            { header: 'Description', value: (r) => r.description },
            { header: `Amount (${currency})`, money: true, value: (r) => amountFor(r.amountMinor, currency) },
            { header: 'Explanation', value: (r) => r.explanation },
          ]));
          return 0;
        }
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

      case 'withdraw-rejection': {
        const documentId = requireFlag(flags, 'document', 'document-id', 'documentId');
        const bankTransactionId = requireFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId');
        withdrawMatchRejection(db, {
          companyId, documentId, bankTransactionId,
          reason: requireFlag(flags, 'reason'),
          actor: requireFlag(flags, 'actor'),
        });
        print({ withdrawn: true, documentId, bankTransactionId }, format);
        return 0;
      }

      case 'suggest-journal': {
        const windowDays = getFlag(flags, 'window-days');
        print(suggestJournalMatches(db, {
          companyId,
          bankTransactionId: requireFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId'),
          windowDays: windowDays ? Number(windowDays) : undefined,
        }), format);
        return 0;
      }

      case 'link-journal': {
        const bankTransactionId = requireFlag(flags, 'transaction', 'transaction-id', 'transactionId', 'bank-transaction-id', 'bankTransactionId');
        const journalEntryId = requireFlag(flags, 'journal', 'journal-id', 'journalEntryId');
        linkBankTransactionToJournal(db, {
          companyId, bankTransactionId, journalEntryId,
          reason: requireFlag(flags, 'reason'),
          actor: requireFlag(flags, 'actor'),
        });
        print({ linked: true, bankTransactionId, journalEntryId }, format);
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
          loanId: getFlag(flags, 'loan'),
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

      case 'add-loan': {
        const parsed = addLoanInput.parse({
          companyId,
          lenderName: requireFlag(flags, 'lender'),
          loanName: getFlag(flags, 'loan', 'loan-name'),
          kind: getFlag(flags, 'kind'),
          currency: getFlag(flags, 'currency'),
          account: getFlag(flags, 'account'),
          principal: getFlag(flags, 'principal', 'opening'),
          date: requireFlag(flags, 'date', 'drawdown-date'),
          maturity: getFlag(flags, 'maturity', 'maturity-date'),
          notes: getFlag(flags, 'notes'),
        });
        print(addLoanCli(db, parsed), format);
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

      case 'set-customer-terms': {
        const customerId = requireFlag(flags, 'customer');
        const limit = getFlag(flags, 'credit-limit');
        setCustomerTerms(db, {
          companyId, customerId, actor: requireFlag(flags, 'actor'), reason: getFlag(flags, 'reason'),
          paymentTermsDays: getFlag(flags, 'terms-days') !== undefined ? Number(getFlag(flags, 'terms-days')) : undefined,
          creditLimitMinor: limit === undefined ? undefined : limit === 'none' ? null
            : parseAmount(limit, db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c),
        });
        print(customerExposure(db, { companyId, customerId }), format);
        return 0;
      }

      case 'set-supplier-terms': {
        setSupplierTerms(db, {
          companyId, supplierId: requireFlag(flags, 'supplier'), actor: requireFlag(flags, 'actor'),
          paymentTermsDays: Number(requireFlag(flags, 'terms-days')), reason: getFlag(flags, 'reason'),
        });
        print({ saved: true }, format);
        return 0;
      }

      case 'add-contact': {
        print(addCustomerContact(db, {
          companyId, customerId: requireFlag(flags, 'customer'), name: requireFlag(flags, 'name'),
          role: getFlag(flags, 'role'), email: getFlag(flags, 'email'), phone: getFlag(flags, 'phone'),
          isBilling: hasFlag(flags, 'billing'), actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'list-contacts': {
        print(listCustomerContacts(db, { companyId, customerId: requireFlag(flags, 'customer') }), format);
        return 0;
      }

      case 'create-recurring-invoice': {
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        const lines = JSON.parse(requireFlag(flags, 'lines')) as Array<{
          description: string; net: string; discountPercent?: string; account: string; vatTreatment: string;
        }>;
        if (!Array.isArray(lines)) throw new Error('--lines must be a JSON array.');
        print(createRecurringInvoice(db, {
          companyId, customerId: requireFlag(flags, 'customer'), name: requireFlag(flags, 'name'),
          frequency: requireFlag(flags, 'frequency') as 'monthly' | 'quarterly' | 'yearly',
          startDate: asIsoDate(requireFlag(flags, 'start')),
          endDate: getFlag(flags, 'end') ? asIsoDate(getFlag(flags, 'end')!) : null,
          lines: lines.map((line, i) => {
            const bp = line.discountPercent ? parsePercentBasisPoints(line.discountPercent) : null;
            if (line.discountPercent && bp === null) throw new Error(`Line ${i + 1}: "${line.discountPercent}" is not a percentage.`);
            return {
              description: line.description, netMinor: parseAmount(line.net, base),
              ...(bp !== null ? { discountBasisPoints: bp } : {}),
              accountId: resolveAccountId(db, companyId, line.account),
              vatTreatmentId: resolveVatTreatmentId(db, companyId, line.vatTreatment),
            };
          }),
          actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'post-recurring-invoices': {
        print(postDueRecurringInvoices(db, {
          companyId, upTo: asIsoDate(getFlag(flags, 'up-to') ?? today()), actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'create-debit-note': {
        const originalId = resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice'));
        const original = db.select().from(invoices).where(eq(invoices.id, originalId)).get()!;
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        print(createInvoice(db, {
          companyId, direction: original.direction, invoiceDate: asIsoDate(getFlag(flags, 'date') ?? today()),
          customerId: original.customerId, supplierId: original.supplierId,
          currency: original.currency !== base ? original.currency : undefined,
          isDebitNote: true, debitNoteOfId: original.id,
          lines: [{
            description: requireFlag(flags, 'description'),
            netMinor: parseAmount(requireFlag(flags, 'net'), original.currency),
            accountId: resolveAccountId(db, companyId, requireFlag(flags, 'account')),
            vatTreatmentId: resolveVatTreatmentId(db, companyId, requireFlag(flags, 'vat-treatment')),
          }],
          actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'overdue': {
        print(overdueInvoices(db, { companyId, asOf: asIsoDate(getFlag(flags, 'as-of') ?? today()), customerId: getFlag(flags, 'customer') }), format);
        return 0;
      }

      case 'receivables': {
        print(receivablesSummary(db, { companyId, asOf: asIsoDate(getFlag(flags, 'as-of') ?? today()) }), format);
        return 0;
      }

      case 'customer-statement': {
        const st = customerStatement(db, {
          companyId, customerId: requireFlag(flags, 'customer'),
          from: asIsoDate(requireFlag(flags, 'from')), to: asIsoDate(requireFlag(flags, 'to')),
        });
        const out = getFlag(flags, 'out');
        if (out) {
          const company = db.select().from(companies).where(eq(companies.id, companyId)).get()!;
          writeFileSync(out, await renderStatementPdf(st, { name: company.legalName, address: company.principalBusinessAddress ?? company.registeredOffice }));
          print({ written: out, closingBalanceMinor: st.closingBalanceMinor }, format);
        } else {
          print(st, format);
        }
        return 0;
      }

      case 'produce-reminder': {
        const result = produceReminderLetter(db, {
          companyId, customerId: requireFlag(flags, 'customer'), asOf: asIsoDate(getFlag(flags, 'as-of') ?? today()),
          level: Number(getFlag(flags, 'level') ?? '1'), actor: requireFlag(flags, 'actor'),
        });
        const out = getFlag(flags, 'out');
        if (out) writeFileSync(out, await renderReminderPdf(reminderLetter(db, { companyId, letterId: result.letterId })));
        print({ ...result, ...(out ? { written: out } : {}) }, format);
        return 0;
      }

      case 'write-off-bad-debt': {
        const account = getFlag(flags, 'account');
        print(writeOffBadDebt(db, {
          companyId, invoiceId: resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice')),
          date: asIsoDate(getFlag(flags, 'date') ?? today()), reason: requireFlag(flags, 'reason'),
          actor: requireFlag(flags, 'actor'), accountId: account ? resolveAccountId(db, companyId, account) : null,
        }), format);
        return 0;
      }

      case 'claim-bad-debt-relief': {
        print(claimBadDebtRelief(db, {
          companyId, invoiceId: resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice')),
          date: asIsoDate(getFlag(flags, 'date') ?? today()), actor: requireFlag(flags, 'actor'),
          facts: {
            reasonableStepsTaken: requireYesNo(flags, 'reasonable-steps'),
            allowableUnderTcaS81: requireYesNo(flags, 'allowable-s81'),
            recordsKept: requireYesNo(flags, 'records-kept'),
            debtorConnected: requireYesNo(flags, 'connected'),
            taxableLettingUnderS95: requireYesNo(flags, 's95-letting'),
            hirePurchase: requireYesNo(flags, 'hire-purchase'),
          },
        }), format);
        return 0;
      }

      case 'reverse-bad-debt': {
        print(reverseBadDebtWriteOff(db, {
          companyId, invoiceId: resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice')),
          date: asIsoDate(getFlag(flags, 'date') ?? today()), reason: requireFlag(flags, 'reason'),
          actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'record-deemed-supply': {
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        const kind = requireFlag(flags, 'kind');
        const common = {
          companyId, date: getFlag(flags, 'date') ?? today(),
          accountId: resolveAccountId(db, companyId, requireFlag(flags, 'account')),
          description: requireFlag(flags, 'description'), recordedBy: requireFlag(flags, 'actor'),
        };
        const wholeFlag = (name: string): number => {
          const value = requireFlag(flags, name);
          if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number.`);
          return Number(value);
        };
        if (kind === 'goods') {
          const use = requireFlag(flags, 'use');
          if (use !== 'gift' && use !== 'private-use') throw new Error('--use must be gift or private-use.');
          print(recordDeemedSupply(db, {
            ...common, kind: 'goods', use: use === 'gift' ? 'gift' : 'private_use',
            costMinor: parseAmount(requireFlag(flags, 'cost'), base),
            treatmentCode: requireFlag(flags, 'vat-treatment'),
            taxDeductedOrTransferred: requireYesNo(flags, 'tax-deducted'),
            ...(use === 'gift'
              ? { partOfSeriesToSamePerson: requireYesNo(flags, 'series'), industrialSamples: requireYesNo(flags, 'samples') }
              : {}),
          }), format);
        } else if (kind === 'property') {
          print(recordDeemedSupply(db, {
            ...common, kind: 'immovable_private_use', acquiredOn: requireFlag(flags, 'acquired-on'),
            acquisitionTaxableAmountMinor: parseAmount(requireFlag(flags, 'acquisition-amount'), base),
            privateFloorArea: wholeFlag('private-area'), totalFloorArea: wholeFlag('total-area'),
            treatedAsBusinessAsset: requireYesNo(flags, 'business-asset'),
          }), format);
        } else {
          throw new Error('--kind must be goods or property.');
        }
        return 0;
      }

      case 'apply-credit-note': {
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        print(applyCreditNote(db, {
          companyId,
          creditNoteId: resolveInvoiceId(db, companyId, requireFlag(flags, 'credit-note')),
          invoiceId: resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice')),
          amountMinor: parseAmount(requireFlag(flags, 'amount'), base),
          date: asIsoDate(getFlag(flags, 'date') ?? today()),
          actor: requireFlag(flags, 'actor'), reason: getFlag(flags, 'reason'),
        }), format);
        return 0;
      }

      case 'unapply-credit-note': {
        unapplyCreditNote(db, {
          companyId, paymentId: requireFlag(flags, 'payment'),
          actor: requireFlag(flags, 'actor'), reason: requireFlag(flags, 'reason'),
        });
        print({ unapplied: true }, format);
        return 0;
      }

      case 'refund-on-account': {
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        const line = getFlag(flags, 'transaction');
        print(refundOnAccount(db, {
          companyId, paymentId: requireFlag(flags, 'payment'),
          amountMinor: parseAmount(requireFlag(flags, 'amount'), base),
          ...(line ? { bankTransactionId: line } : {
            date: asIsoDate(requireFlag(flags, 'date')), bankAccountId: requireFlag(flags, 'bank-account'),
          }),
          actor: requireFlag(flags, 'actor'), reason: requireFlag(flags, 'reason'),
        }), format);
        return 0;
      }

      case 'customer-credit': {
        print(customerCredit(db, { companyId, customerId: requireFlag(flags, 'customer') }), format);
        return 0;
      }

      case 'invoice-pdf': {
        const doc = salesInvoiceDocument(db, { companyId, invoiceId: resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice')) });
        const out = requireFlag(flags, 'out');
        writeFileSync(out, await renderInvoicePdf(doc));
        print({ written: out, draft: doc.missing.length > 0, missing: doc.missing }, format);
        return 0;
      }

      case 'create-purchase-order': {
        const lines = JSON.parse(requireFlag(flags, 'lines')) as Array<{
          description: string; quantity?: string; net: string; account?: string;
        }>;
        if (!Array.isArray(lines)) throw new Error('--lines must be a JSON array.');
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        print(createPurchaseOrder(db, {
          companyId, supplierId: requireFlag(flags, 'supplier'), actor: requireFlag(flags, 'actor'),
          orderDate: asIsoDate(getFlag(flags, 'date') ?? new Date().toISOString().slice(0, 10)),
          expectedDate: getFlag(flags, 'expected') ? asIsoDate(getFlag(flags, 'expected')!) : null,
          notes: getFlag(flags, 'notes') ?? null,
          lines: lines.map((line, i) => {
            const quantityMilli = line.quantity !== undefined ? Math.round(Number(line.quantity) * 1000) : undefined;
            if (line.quantity !== undefined && Number(line.quantity) * 1000 !== quantityMilli) {
              throw new Error(`Line ${i + 1}: "${line.quantity}" is not a quantity (up to three decimal places).`);
            }
            return {
              description: line.description, quantityMilli, netMinor: parseAmount(line.net, base),
              accountId: line.account ? resolveAccountId(db, companyId, line.account) : null,
            };
          }),
        }), format);
        return 0;
      }

      case 'list-purchase-orders': {
        print(listPurchaseOrders(db, { companyId, supplierId: getFlag(flags, 'supplier'), openOnly: hasFlag(flags, 'open') }), format);
        return 0;
      }

      case 'link-bill': {
        print(linkBillToPurchaseOrder(db, {
          companyId, invoiceId: resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice')),
          purchaseOrderId: resolvePurchaseOrderId(db, companyId, requireFlag(flags, 'purchase-order')),
          actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'unlink-bill': {
        print(unlinkBillFromPurchaseOrder(db, {
          companyId, invoiceId: resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice')), actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'cancel-purchase-order': {
        const purchaseOrderId = resolvePurchaseOrderId(db, companyId, requireFlag(flags, 'purchase-order'));
        cancelPurchaseOrder(db, { companyId, purchaseOrderId, reason: requireFlag(flags, 'reason'), actor: requireFlag(flags, 'actor') });
        print(getPurchaseOrder(db, { companyId, purchaseOrderId }), format);
        return 0;
      }

      case 'purchase-order-pdf': {
        const docu = purchaseOrderDocument(db, { companyId, purchaseOrderId: resolvePurchaseOrderId(db, companyId, requireFlag(flags, 'purchase-order')) });
        const out = requireFlag(flags, 'out');
        writeFileSync(out, await renderPurchaseOrderPdf(docu));
        print({ written: out, number: docu.order.number }, format);
        return 0;
      }

      case 'supplier-statement': {
        const st = supplierStatement(db, {
          companyId, supplierId: requireFlag(flags, 'supplier'),
          from: asIsoDate(requireFlag(flags, 'from')), to: asIsoDate(requireFlag(flags, 'to')),
        });
        const out = getFlag(flags, 'out');
        if (out) {
          const company = db.select().from(companies).where(eq(companies.id, companyId)).get()!;
          writeFileSync(out, await renderStatementPdf({ ...st, customerName: st.supplierName }, {
            name: company.legalName, address: company.principalBusinessAddress ?? company.registeredOffice,
          }, { title: 'Supplier account', balanceLabel: 'Balance owed' }));
        }
        print(st, format);
        return 0;
      }

      case 'reconcile-supplier-statement': {
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        print(reconcileSupplierStatement(db, {
          companyId, supplierId: requireFlag(flags, 'supplier'), asOf: asIsoDate(requireFlag(flags, 'as-of')),
          statementBalanceMinor: parseAmount(requireFlag(flags, 'balance'), base),
          invoiceNumbers: (getFlag(flags, 'invoices') ?? '').split(',').map((n) => n.trim()).filter(Boolean),
          actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'create-recurring-bill': {
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        const tolerance = getFlag(flags, 'tolerance-percent');
        const toleranceBasisPoints = tolerance ? parsePercentBasisPoints(tolerance) : undefined;
        if (tolerance && toleranceBasisPoints === null) throw new Error(`"${tolerance}" is not a percentage.`);
        print(createRecurringBill(db, {
          companyId, supplierId: requireFlag(flags, 'supplier'), name: requireFlag(flags, 'name'),
          frequency: requireFlag(flags, 'frequency') as 'monthly' | 'quarterly' | 'yearly',
          startDate: asIsoDate(requireFlag(flags, 'start')),
          endDate: getFlag(flags, 'end') ? asIsoDate(getFlag(flags, 'end')!) : null,
          expectedNetMinor: parseAmount(requireFlag(flags, 'net'), base),
          ...(toleranceBasisPoints != null ? { toleranceBasisPoints } : {}),
          ...(getFlag(flags, 'window-days') ? { windowDays: Number(getFlag(flags, 'window-days')) } : {}),
          actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'run-expected-bills': {
        print(runExpectedBills(db, {
          companyId, asOf: asIsoDate(getFlag(flags, 'as-of') ?? new Date().toISOString().slice(0, 10)),
          actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'list-recurring-bills': {
        print(listRecurringBills(db, { companyId, asOf: asIsoDate(getFlag(flags, 'as-of') ?? new Date().toISOString().slice(0, 10)) }), format);
        return 0;
      }

      case 'match-expected-bill': {
        print(matchExpectedBill(db, {
          companyId, expectedBillId: requireFlag(flags, 'expected'),
          invoiceId: resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice')), actor: requireFlag(flags, 'actor'),
        }), format);
        return 0;
      }

      case 'unmatch-expected-bill': {
        unmatchExpectedBill(db, {
          companyId, expectedBillId: requireFlag(flags, 'expected'), reason: requireFlag(flags, 'reason'), actor: requireFlag(flags, 'actor'),
        });
        print({ unmatched: true }, format);
        return 0;
      }

      case 'dismiss-expected-bill': {
        dismissExpectedBill(db, {
          companyId, expectedBillId: requireFlag(flags, 'expected'), reason: requireFlag(flags, 'reason'), actor: requireFlag(flags, 'actor'),
        });
        print({ dismissed: true }, format);
        return 0;
      }

      case 'deactivate-recurring-bill': {
        deactivateRecurringBill(db, { companyId, recurringBillId: requireFlag(flags, 'recurring-bill'), actor: requireFlag(flags, 'actor') });
        print({ deactivated: true }, format);
        return 0;
      }

      case 'list-recurring-invoices': {
        print(listRecurringInvoices(db, { companyId }), format);
        return 0;
      }

      case 'create-invoice': {
        const parsed = createInvoiceCsvInput.parse({
          companyId,
          direction: requireFlag(flags, 'direction'),
          file: requireFlag(flags, 'file'),
          vatAlreadyDeclared: getFlag(flags, 'vat-already-declared'),
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
          vatAlreadyDeclared: getFlag(flags, 'vat-already-declared'),
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
          writeOff: getFlag(flags, 'write-off-invoice') ? {
            invoice: requireFlag(flags, 'write-off-invoice'),
            account: requireFlag(flags, 'write-off-account'),
            reason: requireFlag(flags, 'write-off-reason'),
          } : undefined,
        }), format);
        return 0;
      }

      case 'list-on-account': {
        print(paymentsOnAccount(db, {
          companyId, customerId: getFlag(flags, 'customer'), supplierId: getFlag(flags, 'supplier'),
        }), format);
        return 0;
      }

      case 'allocate-on-account': {
        const invoiceId = resolveInvoiceId(db, companyId, requireFlag(flags, 'invoice'));
        const currency = db.select({ c: invoices.currency }).from(invoices).where(eq(invoices.id, invoiceId)).get()!.c;
        print(allocatePaymentOnAccount(db, {
          companyId,
          paymentId: requireFlag(flags, 'payment'),
          invoiceId,
          amountMinor: parseAmount(requireFlag(flags, 'amount'), currency),
          actor: requireFlag(flags, 'actor'),
          reason: getFlag(flags, 'reason'),
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

      case 'ct1-worksheet': {
        print(buildCt1Worksheet(db, {
          companyId, from: asIsoDate(requireFlag(flags, 'from')), to: asIsoDate(requireFlag(flags, 'to')),
        }), format);
        return 0;
      }

      case 'it-computation': {
        print(computeIncomeTax(db, { companyId, year: Number(requireFlag(flags, 'year')) }), format);
        return 0;
      }

      case 'add-partner': {
        print(addPartner(db, {
          companyId, name: requireFlag(flags, 'name'), shareBasisPoints: Math.round(Number(requireFlag(flags, 'share')) * 100),
          joinedOn: requireFlag(flags, 'joined'), recordedBy: requireFlag(flags, 'by'),
          isPrecedentPartner: hasFlag(flags, 'precedent'), taxReference: getFlag(flags, 'ppsn') ?? null,
        }), format);
        return 0;
      }

      case 'set-partner-share': {
        setPartnerShare(db, {
          companyId, partnerId: requireFlag(flags, 'partner'), shareBasisPoints: Math.round(Number(requireFlag(flags, 'share')) * 100),
          effectiveFrom: requireFlag(flags, 'from'), recordedBy: requireFlag(flags, 'by'), basis: getFlag(flags, 'basis'),
        });
        print({ ok: true }, format);
        return 0;
      }

      case 'partners': {
        const on = getFlag(flags, 'on') ?? new Date().toISOString().slice(0, 10);
        print({
          partners: db.select().from(partners).where(eq(partners.companyId, companyId)).all(),
          sharesOn: on,
          shares: partnerSharesOn(db, companyId, on).map((s) => ({ partnerId: s.partner.id, name: s.partner.name, sharePercent: s.shareBasisPoints / 100 })),
        }, format);
        return 0;
      }

      case 'record-partner-loan': {
        const direction = getFlag(flags, 'direction') ?? 'advanced';
        if (direction !== 'advanced' && direction !== 'repaid') {
          throw new Error('--direction is advanced (the partner lends the firm) or repaid (the firm repays them).');
        }
        const result = recordPartnerLoan(db, {
          companyId, partnerId: requireFlag(flags, 'partner'), direction,
          amountMinor: parseAmount(requireFlag(flags, 'amount'),
            db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c),
          date: requireFlag(flags, 'date'), recordedBy: requireFlag(flags, 'by'),
          narrative: getFlag(flags, 'narrative'),
        });
        print(result, format);
        return 0;
      }

      case 'record-partner-loan-interest': {
        const result = recordPartnerLoanInterest(db, {
          companyId, partnerId: requireFlag(flags, 'partner'),
          rateBasisPoints: Math.round(Number(requireFlag(flags, 'rate')) * 100),
          from: requireFlag(flags, 'from'), to: requireFlag(flags, 'to'),
          recordedBy: requireFlag(flags, 'by'),
          narrative: getFlag(flags, 'narrative'),
        });
        print(result, format);
        return 0;
      }

      case 'partners-report': {
        const to = getFlag(flags, 'to') ?? new Date().toISOString().slice(0, 10);
        const from = getFlag(flags, 'from') ?? `${to.slice(0, 4)}-01-01`;
        print({
          allocation: partnerAllocationStatement(db, { companyId, from: asIsoDate(from), to: asIsoDate(to) }),
          form1: form1Firms(db, { companyId, year: Number(to.slice(0, 4)) }),
        }, format);
        return 0;
      }

      case 'ct-decide': {
        const subjectType = requireFlag(flags, 'subject-type');
        // The one list the year-end screen uses too (issue #521), so the two cannot drift.
        if (!isCtSubjectType(subjectType)) {
          throw new Error(`--subject-type is one of ${CT_SUBJECT_TYPES.join(', ')}.`);
        }
        const amountRaw = getFlag(flags, 'amount');
        const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, companyId)).get()!.c;
        const id = recordCtDecision(db, {
          companyId, subjectType, subjectId: requireFlag(flags, 'subject'), periodEnd: requireFlag(flags, 'period-end'),
          choice: requireFlag(flags, 'choice'), decidedBy: requireFlag(flags, 'by'), note: getFlag(flags, 'note'),
          amountMinor: amountRaw === undefined ? undefined : parseAmount(amountRaw, base),
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

      case 'install-farm-chart': {
        const parsed = ensureDefaultAccountsInput.parse({ companyId });
        print(installFarmChartCli(db, parsed), format);
        return 0;
      }

      case 'archive-account': {
        const parsed = archiveAccountInput.parse({
          companyId,
          account: requireFlag(flags, 'account'),
          reason: requireFlag(flags, 'reason'),
          date: getFlag(flags, 'date'),
        });
        const result = archiveAccount(db, {
          companyId,
          accountId: resolveAccountId(db, companyId, parsed.account),
          reason: parsed.reason,
          archivedOn: parsed.date ? asIsoDate(parsed.date) : undefined,
          actor: 'cli',
        });
        print({ account: parsed.account, ...result }, format);
        return 0;
      }

      case 'restore-account': {
        const parsed = restoreAccountInput.parse({
          companyId,
          account: requireFlag(flags, 'account'),
          reason: requireFlag(flags, 'reason'),
        });
        restoreAccount(db, {
          companyId,
          accountId: resolveAccountId(db, companyId, parsed.account),
          reason: parsed.reason,
          actor: 'cli',
        });
        print({ account: parsed.account, restored: true }, format);
        return 0;
      }

      case 'map-account': {
        const parsed = mapAccountInput.parse({
          companyId,
          account: requireFlag(flags, 'account'),
          chartName: requireFlag(flags, 'chart', 'chart-name'),
          externalCode: requireFlag(flags, 'external-code'),
          externalName: getFlag(flags, 'external-name'),
          notes: getFlag(flags, 'notes'),
        });
        const mapping = setAccountMapping(db, {
          companyId,
          accountId: resolveAccountId(db, companyId, parsed.account),
          chartName: parsed.chartName,
          externalCode: parsed.externalCode,
          externalName: parsed.externalName,
          notes: parsed.notes,
          actor: 'cli',
        });
        print({ ...mapping, account: parsed.account }, format);
        return 0;
      }

      case 'unmap-account': {
        const parsed = unmapAccountInput.parse({
          companyId,
          account: requireFlag(flags, 'account'),
          chartName: requireFlag(flags, 'chart', 'chart-name'),
        });
        clearAccountMapping(db, {
          companyId,
          accountId: resolveAccountId(db, companyId, parsed.account),
          chartName: parsed.chartName,
          actor: 'cli',
        });
        print({ account: parsed.account, chartName: parsed.chartName, unmapped: true }, format);
        return 0;
      }

      case 'list-account-mappings': {
        const parsed = listAccountMappingsInput.parse({
          companyId,
          chartName: getFlag(flags, 'chart', 'chart-name'),
        });
        print(listAccountMappings(db, parsed), format);
        return 0;
      }

      case 'mapped-trial-balance': {
        const parsed = mappedTrialBalanceInput.parse({
          companyId,
          chartName: requireFlag(flags, 'chart', 'chart-name'),
          asOf: getFlag(flags, 'as-of', 'date'),
        });
        print(mappedTrialBalance(db, {
          companyId,
          chartName: parsed.chartName,
          asOf: asIsoDate(parsed.asOf ?? today()),
        }), format);
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

/** A fact a person must state: --flag yes or --flag no, never assumed. */
function requireYesNo(flags: Record<string, string | boolean>, name: string): boolean {
  const value = requireFlag(flags, name).toLowerCase();
  if (value !== 'yes' && value !== 'no') throw new Error(`--${name} must be yes or no.`);
  return value === 'yes';
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

/** A purchase order by its number (PO-3) or its id. */
function resolvePurchaseOrderId(db: AppDatabase, companyId: string, numberOrId: string): string {
  const found = db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(and(
    eq(purchaseOrders.companyId, companyId),
    numberOrId.startsWith('po_') ? eq(purchaseOrders.id, numberOrId) : eq(purchaseOrders.number, numberOrId.toUpperCase()),
  )).get();
  if (!found) throw new Error(`Purchase order "${numberOrId}" not found.`);
  return found.id;
}

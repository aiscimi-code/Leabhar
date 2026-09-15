Project: Local-First Irish Accounting & Tax Preparation System

1. Project Objective

Build a local-first accounting and tax-preparation application for a small Irish limited company.

The application is intended to replace the unnecessary complexity, aggressive feature gating and subscription-driven workflow of mainstream accounting products.

This is not initially intended to be a general-purpose Xero/Sage replacement.

It should be a highly transparent, explainable accounting system for a small Irish LTD where:

- Bank transactions are imported periodically from bank statements.
- Invoices and receipts are stored in a local document repository.
- AI extracts structured information from invoices, receipts and statements.
- Documents are automatically matched to bank transactions.
- Currency, VAT treatment, VAT rate and VAT amount are detected.
- Transactions are categorised into accounting accounts.
- VAT periods are automatically summarised.
- Year-end accounting information is produced.
- Corporation-tax and annual-company-return preparation information is assembled.
- Everything remains inspectable and traceable back to the original transaction/document.
- The system should clearly distinguish between calculated information, AI suggestions and user-confirmed accounting decisions.

The application should favour clarity, transparency and automation over feature quantity.

---

2. Core Design Principle

The system must have a structured accounting database as its source of truth.

Do NOT use Excel or Google Sheets as the underlying database.

Documents are the evidence.

The accounting database is the structured record.

The web application is the user interface.

Spreadsheets are an export/reporting format.

Conceptually:

Documents
   ↓
Extraction
   ↓
Classification
   ↓
Reconciliation
   ↓
Accounting database
   ↓
VAT / P&L / Balance Sheet / Tax reports
   ↓
Export / filing preparation

---

3. Hosting Model

The initial version must be designed for local hosting.

Assume:

- One company
- One primary user
- Local computer/server
- Local database
- Local document storage
- Web UI accessible through localhost/LAN

Do not build cloud infrastructure unless required by a feature.

Do not introduce unnecessary SaaS dependencies.

The architecture should nevertheless be clean enough that cloud hosting could be added later.

Recommended architecture:

- Web application: Next.js/TypeScript or equivalent modern web framework
- Database: SQLite initially
- ORM/data layer: choose a mature solution appropriate to the selected stack
- Document storage: local filesystem
- PDF/document extraction: appropriate local tooling
- OCR: configurable
- AI: provider-agnostic API layer
- Authentication: simple local authentication initially
- Backups: local database + document backup mechanism

The database must not depend on an LLM being available.

AI is an assistant to the accounting system, not the accounting system itself.

---

4. Critical Accounting Principle

Use a proper accounting data model.

Do not design the application as:

bank transaction + VAT + category

and stop there.

The system should be capable of supporting double-entry accounting underneath even if the UI hides most of that complexity.

The architecture should distinguish between:

- Bank transaction
- Invoice
- Receipt
- Payment
- Accounting entry
- Journal entry
- Journal line
- VAT entry
- Supplier
- Customer
- Accounting account
- Accounting period
- Tax period
- Fixed asset
- Director's loan/current account
- Adjustment

A bank transaction is evidence of money movement.

It is not necessarily the accounting entry itself.

---

5. Component: Company Setup

Create a company setup section containing essential account information.

The application must provide fields for at least:

Company identity

- Legal company name
- Trading name
- CRO number
- Company type
- Date incorporated
- Accounting year-end
- Registered office
- Principal business address
- Records address
- Tax reference number
- VAT number
- VAT registration date
- VAT registration status
- EORI number, if applicable
- Revenue registration information

Banking

For each bank account:

- Bank name
- Account name
- IBAN
- BIC
- Currency
- Account type
- Opening balance
- Opening date
- Closing date if applicable

Tax configuration

- Corporation tax registration
- VAT registration
- VAT accounting basis
- VAT periods
- Tax year
- Relevant tax settings

Company officers

Provide fields for relevant company information such as:

- Directors
- Secretary
- Shareholders
- Share capital

Do not assume every company has the same structure.

---

6. Component: Tax Rate Configuration

Provide predefined Irish tax/VAT rates.

The application must ship with sensible predefined rates but every predefined rate must be editable.

Never hard-code tax rates into application logic.

Create a configuration table such as:

tax_rates

Fields should include:

- Name
- Rate
- Tax type
- Jurisdiction
- Effective-from date
- Effective-to date
- Active
- Notes
- Revenue/reporting classification
- Default status

The system must support historical rates.

Changing a rate today must not alter historical transactions.

Example:

VAT Standard
23%
effective_from: ...
effective_to: null

The user must be able to add/edit/deactivate rates.

Never delete a tax rate that is referenced by historical accounting records.

---

7. Component: VAT Configuration

Create a dedicated VAT configuration section.

Provide predefined VAT treatments/categories, editable by the user.

The system should distinguish between concepts such as:

- Irish standard-rate VAT
- Irish reduced-rate VAT
- Irish zero-rated
- Exempt
- Outside scope
- EU acquisition
- EU received services
- Reverse charge
- Import VAT
- Other applicable VAT treatments

Do not treat all zero-VAT transactions as equivalent.

A transaction should contain a VAT treatment, not merely a VAT percentage.

VAT fields should include:

- VAT treatment
- VAT rate
- Net amount
- VAT amount
- Gross amount
- VAT jurisdiction
- Recoverable VAT amount
- VAT reporting classification
- Confidence
- Source
- Confirmation status

---

8. Component: VAT Period Configuration

Provide predefined VAT periods based on common Irish VAT filing configurations.

The user must be able to edit them.

Do not hard-code quarterly periods.

VAT periods must be represented as actual date ranges.

Example:

Period
Start date
End date
Filing deadline
Status
Submitted
Submission date
Payment/refund amount

Support:

- Monthly
- Bi-monthly
- Four-monthly
- Other/custom periods

The system should allow the user to define the company's actual VAT periods.

Historical periods must remain unchanged when future configuration is edited.

---

9. Component: Accounting Periods

Create accounting periods independently from VAT periods.

Support:

- Financial year
- VAT period
- Month
- Custom reporting period

A transaction should be associated with the appropriate accounting period automatically based on date.

---

10. Component: Chart of Accounts

Provide a predefined but editable chart of accounts.

Start with sensible categories for a small Irish technology/software company.

Example:

Income

- Software sales
- Subscription revenue
- Consulting
- Other income

Cost of sales

- Direct service costs

Operating expenses

- Software
- Hosting
- Domains
- Telecommunications
- Advertising
- Marketing
- Professional fees
- Accounting
- Legal
- Insurance
- Bank charges
- Travel
- Office expenses
- Equipment
- Training
- Other expenses

Assets

- Bank
- Cash
- Computer equipment
- Other fixed assets

Liabilities

- VAT liability
- Corporation tax liability
- Creditors
- Director/current account

Equity

- Share capital
- Retained earnings

The user must be able to add accounts.

Accounts referenced by historical transactions must not simply disappear.

---

11. Component: Document Repository

Create a local document repository.

Documents include:

- Supplier invoices
- Sales invoices
- Receipts
- Bank statements
- Credit notes
- Tax documents
- Company documents
- Other supporting evidence

Documents should have metadata:

- Filename
- File type
- Upload date
- Document date
- Supplier/customer
- Invoice number
- Currency
- Amount
- VAT amount
- Document type
- SHA/hash
- Extraction status
- Classification status
- Matched transaction
- Notes

Support PDF and common image/document formats.

Detect duplicate documents.

Never silently overwrite an existing document.

---

12. Component: Document Extraction

When a document is added:

1. Identify its type.
2. Extract text.
3. Extract structured fields.
4. Detect supplier/customer.
5. Detect invoice number.
6. Detect date.
7. Detect currency.
8. Detect net amount.
9. Detect VAT amount.
10. Detect gross amount.
11. Detect VAT rate.
12. Suggest VAT treatment.
13. Suggest accounting category.
14. Attempt bank transaction matching.
15. Assign confidence levels.
16. Send uncertain results to the review queue.

The extraction system must preserve the original document.

Never modify the source document.

---

13. Component: Bank Statement Import

The first version should NOT depend on live banking APIs.

This is deliberate.

Bank integration is relatively limited/fragmented in Ireland and is not required for the MVP.

Support importing:

- CSV
- XLSX
- PDF where practical

The application should allow the user to map columns when importing unfamiliar bank statement formats.

For example:

Date → transaction_date
Description → description
Amount → amount
Currency → currency
Reference → bank_reference

Remember the bank's own transaction ID where available.

Generate a transaction fingerprint to prevent duplicate imports.

Example:

bank_account
transaction_date
amount
currency
bank_reference
description

If the same statement is imported twice:

«No duplicate transactions imported.»

---

14. Component: Manual Refresh / Import

The system should have a prominent:

REFRESH / IMPORT BANK DATA

action.

For now, "refresh" means:

- Look at configured local import source(s)
- Detect new bank statement files
- Process them
- Detect duplicates
- Add new transactions
- attempt reconciliation
- update dashboards

Do NOT build automatic bank feeds yet.

Design the architecture so a bank-feed connector could be added later.

---

15. Component: Transaction Ledger

The transaction ledger is one of the primary application screens.

Display one transaction per row.

Example:

Date| Description| Amount| Currency| Account| VAT| VAT Amount| Document| Match| Status

Clicking a transaction opens a detailed transaction view.

The detail view should show:

- Bank transaction
- Accounting classification
- VAT treatment
- Supporting document
- Matching information
- Journal entries
- Notes
- AI decisions
- User confirmations
- Audit history

The UI should be extremely easy to scan.

---

16. Component: Invoice / Receipt Matching

Automatically match documents against bank transactions.

Matching factors can include:

- Amount
- Currency
- Date
- Supplier
- Description
- Invoice number
- Bank reference
- Historical supplier behaviour

Return:

Matched
Probable match
Possible match
No match
Conflict

Show confidence.

Example:

Vercel invoice €42.17
Bank transaction €42.17
Date difference: 1 day

MATCH: 98%

[Accept] [Reject] [Review]

Never silently force an uncertain match.

---

17. Component: Supplier and Customer Profiles

Create persistent profiles.

Supplier fields:

- Name
- Country
- VAT number
- Currency
- Default accounting account
- Default VAT treatment
- Payment behaviour
- Notes
- Historical transactions

Customer fields should have equivalent functionality.

The system should learn from confirmed historical classifications.

For example:

Supplier: Anthropic

Previous treatment:
Software expense
Non-Irish supplier
VAT treatment: X

Future documents should automatically suggest the same treatment.

---

18. Component: Accounting Rules Engine

Create a deterministic rules engine.

Rules should be able to use:

- Supplier
- Customer
- Description
- Amount
- Currency
- Country
- VAT number
- Account
- Transaction type

Example:

IF supplier = X
THEN account = Software
AND suggest VAT treatment = Y

AI should suggest classifications.

Confirmed deterministic rules should take precedence where appropriate.

The user must be able to inspect and edit rules.

---

19. Component: AI Accounting Assistant

AI is used for:

- Document extraction
- Classification
- Matching
- Anomaly detection
- Explanation
- Suggestions

AI must NOT silently change confirmed accounting data.

Every AI-derived value should have:

- Source
- Confidence
- Status

Possible states:

AI suggestion
User confirmed
User rejected
System rule
Imported
Manually entered

The system should make this distinction visible.

---

20. Component: Review / Needs Attention Queue

Create a central review screen.

Examples:

⚠ 3 unmatched transactions
⚠ 2 invoices need classification
⚠ 1 VAT treatment uncertain
⚠ 1 duplicate suspected
⚠ 1 currency discrepancy
⚠ 2 transactions missing documents

Each item should provide the minimum information required to resolve it.

The objective is:

«The user should spend time only on exceptions.»

---

21. Component: Reconciliation

Provide bank reconciliation.

Show:

Bank statement balance
Accounting ledger balance
Difference
Unmatched transactions
Duplicate transactions
Missing transactions

The user should be able to reconcile a statement/period.

Do not alter imported bank evidence when reconciling.

---

22. Component: Currency and FX

Support multiple currencies.

Store:

original_amount
original_currency
exchange_rate
base_amount
base_currency

Never replace the original currency value with the converted value.

Allow exchange rates to be:

- Imported
- Manually entered
- AI-detected
- System-provided

Record the source.

FX differences should be separately identifiable.

---

23. Component: VAT Dashboard

Provide a VAT dashboard for each VAT period.

Show:

Sales
Purchases
VAT on sales
Reclaimable VAT
EU transactions
Reverse-charge transactions
Other relevant VAT categories
Net VAT payable/reclaimable

Every number must be drillable.

Example:

VAT reclaimable: €742.13

Clicking it should display the transactions making up that figure.

Clicking a transaction should display its document.

The entire chain should be traceable:

VAT report
    ↓
VAT entry
    ↓
transaction
    ↓
invoice
    ↓
source document

---

24. Component: VAT Period Close

Provide:

Open
Review
Ready
Locked
Submitted

Before marking a period ready, run validation.

Examples:

- Unmatched transactions
- Missing documents
- Invalid VAT treatments
- Missing VAT numbers where relevant
- Duplicate transactions
- Currency discrepancies
- Negative/invalid VAT
- Transactions outside period
- Unresolved AI suggestions

The system should say:

NOT READY

rather than allowing the user to assume the return is correct.

The system must never claim that a filing is legally compliant merely because internal checks passed.

---

25. Component: VAT Filing Pack

Generate a human-readable VAT period report.

Include:

- Period
- Transactions
- VAT breakdown
- Summary figures
- Exceptions
- Supporting transactions
- Supporting documents
- Reconciliation status
- User confirmations

Export to:

- PDF
- XLSX
- CSV

---

26. Component: Sales / Income

Support:

- Sales invoices
- Customer
- Invoice date
- Due date
- Currency
- Net
- VAT
- Gross
- Payment
- Payment date
- Outstanding amount

Although the initial business model generally involves payment upfront, do NOT hard-code the assumption that all invoices are paid immediately.

The accounting model should support:

Invoice
    ↓
Payment
    ↓
Bank transaction

---

27. Component: Expenses

Support:

- Supplier
- Invoice/receipt
- Date
- Description
- Category
- Net
- VAT
- Gross
- Currency
- Payment
- Bank transaction
- Accounting treatment

---

28. Component: Director / Current Account

Support transactions paid personally on behalf of the company.

Example:

Company expense €200
Paid personally by director

Create the appropriate director/current-account entry.

Also support:

- Money introduced into company
- Reimbursements
- Money withdrawn
- Running balance

This account must be visible on the balance sheet.

---

29. Component: Fixed Assets

Maintain an asset register.

Fields:

- Asset
- Purchase date
- Supplier
- Cost
- VAT
- Currency
- Accounting category
- Depreciation information
- Disposal date
- Disposal proceeds
- Supporting document

Flag potentially significant capital purchases for review rather than automatically deciding their tax treatment.

---

30. Component: Manual Adjustments

Provide controlled journal adjustments.

Fields:

- Date
- Description
- Debit account
- Credit account
- Amount
- VAT treatment
- Reason
- Supporting document
- Created by
- Approved status

Never rewrite historical transactions to make accounting figures balance.

Use adjustments.

---

31. Component: Audit History

Every significant change should be recorded.

Track:

- Created
- Edited
- Deleted/voided
- Classified
- VAT changed
- Document matched
- Document unmatched
- Period locked/unlocked
- Manual adjustment
- User confirmation

Record:

- timestamp
- previous value
- new value
- source
- reason where appropriate

Historical accounting data should be treated as append-only wherever practical.

---

32. Component: Financial Dashboard

Main dashboard should show:

Bank balance
Revenue
Expenses
Profit
VAT position
Outstanding invoices
Director/current account
Upcoming deadlines

Also show:

Accounting health

Example:

Bank reconciliation       ✓
Documents                 98%
VAT classifications       100%
Unmatched transactions      3
Missing documents           2
Duplicate warnings          0

---

33. Component: Year-End Summary

At year end generate a comprehensive summary.

Include:

Profit & Loss

- Revenue
- Cost of sales
- Gross profit
- Operating expenses
- Net profit/loss

Balance Sheet

- Bank
- Assets
- Liabilities
- VAT
- Corporation tax
- Director/current account
- Share capital
- Retained earnings

Supporting schedules

- Fixed assets
- Bank reconciliation
- VAT
- Director/current account
- Debtors
- Creditors
- Major expenses

Tax preparation

Provide information needed to assist with corporation-tax preparation.

Clearly distinguish:

Accounting profit

from:

Tax-adjusted profit

Do not automatically claim the final corporation-tax calculation is correct unless explicitly configured and verified.

---

34. Component: Company Return / Year-End Pack

Create a year-end "accountant pack".

It should contain:

- P&L
- Balance sheet
- Trial balance
- General ledger
- Transaction listing
- VAT summaries
- Fixed asset schedule
- Director/current account
- Bank reconciliation
- Supporting document index
- Tax-related information
- Accounting adjustments
- Outstanding issues

The objective is to give an accountant or tax adviser a clean package of evidence and figures.

---

35. Component: Tax Calendar

Create a tax/compliance calendar.

Track:

- VAT periods
- VAT filing deadlines
- Corporation tax
- CRO annual return
- Accounts deadlines
- Other configured deadlines

Deadlines must be configurable.

Never hard-code a deadline as though it applies to every company.

---

36. Component: Search

Provide global search.

Search across:

- Transactions
- Documents
- Suppliers
- Customers
- Invoice numbers
- Bank references
- Amounts
- VAT numbers
- Notes

Example:

Search: "Anthropic"

should find:

- supplier
- invoices
- bank transactions
- accounting entries
- VAT entries
- rules

---

37. Component: Reports

Provide standard reports:

- Transaction ledger
- General ledger
- Trial balance
- P&L
- Balance sheet
- VAT report
- VAT period report
- Supplier report
- Customer report
- Expense report
- Income report
- Bank reconciliation
- Fixed asset register
- Director/current account
- Year-end report

Every report should support:

- Date filtering
- Export
- Drill-down
- Document links

---

38. Component: Excel / Spreadsheet Export

Excel should be an export format, not the primary accounting system.

Provide exports for:

- Transactions
- VAT
- P&L
- Balance sheet
- Trial balance
- Year-end pack

Do not make application logic dependent on spreadsheet formulas.

---

39. Component: Help System

Every non-obvious field and accounting concept should have a tooltip.

Tooltips should answer:

- What is this?
- Why do I need it?
- What should I enter?
- Where does the value come from?

Example:

VAT treatment [ ? ]

"Describes how VAT applies to this transaction.
It is not the same thing as the VAT percentage."

---

40. Component: Help Centre

Create a dedicated Help section.

Organise it into:

Getting Started
Bank Transactions
Invoices
Receipts
VAT
Accounting
Reports
Year End
Tax
Company Information
Troubleshooting

Keep explanations practical.

---

41. Component: Glossary

Create a searchable glossary.

Terms should include at least:

- Accounting period
- Accrual
- Asset
- Balance sheet
- Bank reconciliation
- Corporation tax
- Credit note
- Creditor
- Debtor
- Director/current account
- Double-entry
- Expense
- Fixed asset
- Gross
- Income
- Journal
- Liability
- Net
- P&L
- Reconciliation
- Reverse charge
- Retained earnings
- Trial balance
- VAT
- VAT period
- VAT treatment

The glossary should be accessible from relevant screens.

---

42. UI Design Principles

The interface should be:

- Clean
- Dense enough to be useful
- Professional
- Fast
- Understandable
- Desktop-first
- Responsive where practical

Avoid:

- Marketing-style dashboards
- Excessive animations
- Huge cards
- Excessive whitespace
- Hiding important data behind multiple clicks
- Artificial feature gating
- "AI magic" without explanation

This is an accounting tool, not a consumer finance app.

Prioritise information density and traceability.

---

43. Global "Explain" functionality

Any important figure should be explainable.

Example:

VAT reclaimable
€742.13

Click:

Why €742.13?

Then show:

37 transactions
36 documents
1 adjustment

And allow drilling down to each source.

Likewise:

Why is profit €4,823?

should expose the underlying calculation.

The application should make accounting figures auditable by inspection.

---

44. Data Integrity Rules

Implement validation for:

- Duplicate transactions
- Duplicate invoices
- Impossible VAT calculations
- Missing currencies
- Invalid dates
- Invalid VAT rates
- Invoice total mismatches
- Currency mismatches
- Bank reconciliation discrepancies
- Unbalanced journal entries
- Missing accounting accounts
- Historical-period modifications

Never silently repair financial data.

Show the problem and require a deliberate action.

---

45. Backups

Because this is local-first, provide a simple backup mechanism.

A backup should contain:

- Database
- Documents
- Configuration
- Accounting rules

Provide:

Create Backup

and:

Restore Backup

Backups should be versioned rather than overwriting the previous backup.

---

46. Configuration Must Be Editable

Do not hard-code business assumptions.

The following should be configurable:

- Company details
- Bank accounts
- VAT periods
- Tax rates
- VAT treatments
- Chart of accounts
- Suppliers
- Customers
- Accounting rules
- Tax deadlines
- Base currency
- Reporting preferences

Historical accounting records must retain the configuration applicable when they were created.

---

47. Future Features — DO NOT BUILD YET

Design extension points for:

- Open banking
- Revolut integration
- Other bank integrations
- Automatic bank feeds
- Revenue integrations
- Stripe integration
- Payroll
- Multi-company support
- Multi-user support
- Cloud hosting
- Accountant portal
- Automated filing

Do not implement these in the MVP.

The architecture should not prevent them later.

---

48. Important Irish Context

The system is intended initially for an Irish LTD.

Do not assume that generic US/UK accounting conventions are appropriate.

Where Irish tax/accounting rules matter, make the relevant configuration explicit.

Do not invent Revenue requirements.

When implementing tax logic that depends on current Irish legislation or Revenue guidance, use authoritative current sources and make the source/date of the rule visible in the application where practical.

The application is a preparation and bookkeeping tool.

It should never falsely claim:

"You are compliant."

Instead it should say things like:

"Internal checks passed."

or:

"Ready for review."

---

49. Development Method

Before implementing the UI:

1. Design the domain model.
2. Design the database schema.
3. Define accounting entities and relationships.
4. Define VAT/tax configuration.
5. Define transaction lifecycle.
6. Define reconciliation lifecycle.
7. Define document lifecycle.
8. Define period lifecycle.
9. Define audit model.
10. Define reporting model.

Then implement.

Do not start by building attractive dashboard cards.

---

50. Testing

Create extensive automated tests around accounting logic.

Especially test:

- VAT calculations
- Currency conversion
- Invoice totals
- Bank matching
- Duplicate detection
- Period assignment
- Period locking
- Journal balancing
- P&L calculations
- Balance sheet balancing
- Director/current account
- Fixed assets
- Historical tax rates
- Historical VAT treatments
- Importing the same bank statement twice

Financial calculations must have deterministic tests.

Do not rely on LLM evaluation for arithmetic.

---

51. Seed Data

Provide realistic seed/demo data so the UI can be developed and tested.

Include:

- Irish company
- Irish suppliers
- EU suppliers
- Non-EU suppliers
- Irish customer
- EUR transactions
- USD transactions
- VAT transactions
- Non-VAT transactions
- Matched invoices
- Unmatched invoices
- Duplicate transaction
- FX discrepancy
- Director-paid expense
- Fixed asset purchase

Clearly label seed data as demo data.

---

52. Definition of Done for MVP

The MVP is successful when I can:

1. Create my company profile.
2. Configure my VAT periods.
3. Configure tax/VAT rates.
4. Configure my chart of accounts.
5. Add/import a bank statement.
6. See all transactions in one searchable ledger.
7. Upload invoices and receipts.
8. Have the system extract their data.
9. Automatically detect currency.
10. Automatically detect VAT information.
11. Automatically suggest accounting treatment.
12. Match invoices/receipts to bank transactions.
13. Review and approve uncertain matches.
14. See unmatched transactions.
15. See VAT for a selected period.
16. Drill from VAT figures to transactions.
17. Drill from transactions to source documents.
18. Reconcile bank transactions.
19. Produce P&L.
20. Produce balance sheet.
21. Produce a year-end summary.
22. Produce an accountant/year-end pack.
23. Export everything to Excel/PDF/CSV.
24. See all important deadlines.
25. Understand every field through tooltips/help.
26. Search the glossary.
27. Back up and restore the complete accounting dataset.

---

53. Most Important Product Principle

The application should answer this question for every number:

«"Where did this number come from?"»

A user should be able to start with:

VAT reclaimable: €742.13

and drill down:

€742.13
   ↓
VAT entries
   ↓
Transactions
   ↓
Invoice
   ↓
Original PDF

Likewise:

Net profit: €8,421

should be explainable down to the underlying accounting entries.

Transparency and traceability are more important than visual polish.

---

54. Build Order

Recommended implementation order:

Stage 1

Domain model + database + migrations

Stage 2

Company/configuration

Stage 3

Chart of accounts + accounting engine

Stage 4

Bank statement ingestion

Stage 5

Transaction ledger

Stage 6

Document repository

Stage 7

Document extraction

Stage 8

Matching/reconciliation

Stage 9

VAT engine

Stage 10

Reports

Stage 11

Year-end

Stage 12

Help/glossary

Stage 13

AI assistant/rules refinement

Stage 14

Testing, backup and packaging

Do not proceed blindly from stage to stage. After each major stage, run the test suite and inspect the resulting data model.

---

Final instruction to the coding agent

Act as a senior accounting-software architect as well as a senior software engineer.

Challenge assumptions that would produce an unreliable accounting system.

Do not blindly implement a spreadsheet disguised as a web application.

Do not over-engineer enterprise features.

Build a small, robust, local-first accounting engine with an exceptionally good document-to-transaction-to-VAT workflow.

When there is a choice between:

clever automation

and:

transparent, deterministic accounting

choose deterministic accounting.

When AI is uncertain:

ask the user.

When an accounting figure is produced:

make it explainable.

When historical data changes:

preserve the audit trail.

Build the system so that the user can eventually hand the resulting year-end pack to an Irish accountant and have them understand exactly where every important figure came from.
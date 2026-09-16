/**
 * Glossary (README §41). Seeded into the database so the user can edit and
 * extend it, and so terms can be linked from the screens where they appear.
 *
 * The tone is deliberately practical: these are explanations for a company
 * director doing their own bookkeeping, not definitions for an exam.
 */

export interface GlossaryTermSeed {
  term: string;
  slug: string;
  shortDefinition: string;
  longDefinition?: string;
  category?: string;
  relatedTerms?: string[];
  irishContext?: string;
}

export const GLOSSARY_TERMS: GlossaryTermSeed[] = [
  {
    term: 'Accounting period', slug: 'accounting-period', category: 'Accounting',
    shortDefinition: 'The span of time a set of accounts covers, usually your financial year.',
    longDefinition: 'Every transaction belongs to exactly one accounting period, assigned '
      + 'automatically from its date. Periods can be locked once finalised, after which '
      + 'corrections are made by dated adjustments rather than by editing history.',
    relatedTerms: ['financial-year', 'vat-period'], 
  },
  {
    term: 'Accrual', slug: 'accrual', category: 'Accounting',
    shortDefinition: 'A cost you have incurred but not yet been invoiced for or paid.',
    longDefinition: 'Recording an accrual puts the cost in the period it relates to rather '
      + 'than the period the invoice happens to arrive in, which is what makes a set of '
      + 'accounts comparable year to year.',
  },
  {
    term: 'Asset', slug: 'asset', category: 'Accounting',
    shortDefinition: 'Something the company owns or is owed.',
    longDefinition: 'Cash in the bank, money owed by customers, and equipment are all '
      + 'assets. They appear on the balance sheet, not the profit and loss account.',
    relatedTerms: ['balance-sheet', 'fixed-asset', 'liability'],
  },
  {
    term: 'Balance sheet', slug: 'balance-sheet', category: 'Accounting',
    shortDefinition: 'A snapshot of what the company owns and owes on one specific date.',
    longDefinition: 'Assets on one side, liabilities and equity on the other. The two '
      + 'sides must be equal — that is what "balance" means, and if they are not, '
      + 'something is wrong with the underlying entries rather than with the report.',
    relatedTerms: ['asset', 'liability', 'equity', 'double-entry'],
  },
  {
    term: 'Bank reconciliation', slug: 'bank-reconciliation', category: 'Bank',
    shortDefinition: 'Checking that your accounting records agree with your bank statement.',
    longDefinition: 'The two can legitimately differ — a payment recorded but not yet '
      + 'cleared, for instance — but every difference should be explainable. An '
      + 'unexplained difference usually means a missing, duplicated or miscoded transaction.',
    relatedTerms: ['bank-transaction', 'reconciliation'],
  },
  {
    term: 'Corporation tax', slug: 'corporation-tax', category: 'Tax',
    shortDefinition: 'Tax a company pays on its profits.',
    irishContext: 'Ireland applies different rates to trading and non-trading income, and '
      + 'the taxable profit is not the same as the accounting profit — depreciation is '
      + 'added back and capital allowances are given instead, among other adjustments. '
      + 'This application prepares the figures and shows the adjustments; it does not '
      + 'file your return or confirm your final liability.',
    relatedTerms: ['tax-adjusted-profit', 'capital-allowances'],
  },
  {
    term: 'Credit note', slug: 'credit-note', category: 'Invoices',
    shortDefinition: 'A document that cancels or reduces a previously issued invoice.',
    longDefinition: 'Used instead of deleting or editing the original invoice, so the '
      + 'record of what was originally issued survives.',
  },
  {
    term: 'Creditor', slug: 'creditor', category: 'Accounting',
    shortDefinition: 'Someone the company owes money to, typically a supplier.',
    relatedTerms: ['debtor', 'liability'],
  },
  {
    term: 'Debtor', slug: 'debtor', category: 'Accounting',
    shortDefinition: 'Someone who owes the company money, typically a customer.',
    relatedTerms: ['creditor', 'asset'],
  },
  {
    term: 'Director’s current account', slug: 'directors-current-account', category: 'Accounting',
    shortDefinition: 'A running record of money owed between the company and a director.',
    longDefinition: 'If a director pays a company expense personally, the company owes '
      + 'them and the balance goes up. If the director takes money out that is not salary '
      + 'or a dividend, the balance goes down.',
    irishContext: 'A balance owed BY a director to a close company can trigger a tax '
      + 'charge and a benefit-in-kind issue. This application flags a director-owes '
      + 'balance for attention; it does not calculate the charge. Raise it with your accountant.',
    relatedTerms: ['close-company'],
  },
  {
    term: 'Double-entry', slug: 'double-entry', category: 'Accounting',
    shortDefinition: 'Every transaction is recorded twice: once as a debit, once as a credit.',
    longDefinition: 'Paying €100 for hosting increases the hosting expense by €100 and '
      + 'decreases the bank balance by €100. Because the two sides always match, the books '
      + 'either balance or they visibly do not — which is the whole point.',
    relatedTerms: ['journal', 'trial-balance'],
  },
  {
    term: 'Equity', slug: 'equity', category: 'Accounting',
    shortDefinition: 'What would be left for the shareholders if all assets were realised and all debts paid.',
    relatedTerms: ['share-capital', 'retained-earnings'],
  },
  {
    term: 'Expense', slug: 'expense', category: 'Accounting',
    shortDefinition: 'A cost incurred in running the business.',
    relatedTerms: ['fixed-asset'],
  },
  {
    term: 'Fixed asset', slug: 'fixed-asset', category: 'Accounting',
    shortDefinition: 'Something substantial the company buys to use over several years.',
    longDefinition: 'A laptop the company will use for years is a fixed asset; a keyboard '
      + 'is usually just an expense. The cost of a fixed asset is spread over its useful '
      + 'life through depreciation rather than charged entirely to the year of purchase.',
    relatedTerms: ['depreciation', 'capital-allowances'],
  },
  {
    term: 'Depreciation', slug: 'depreciation', category: 'Accounting',
    shortDefinition: 'Spreading the cost of a fixed asset over the years you use it.',
    irishContext: 'Your own depreciation policy is not accepted for tax. In the tax '
      + 'computation it is added back and replaced with capital allowances, which are set '
      + 'by legislation rather than by you.',
    relatedTerms: ['fixed-asset', 'capital-allowances'],
  },
  {
    term: 'Capital allowances', slug: 'capital-allowances', category: 'Tax',
    shortDefinition: 'The tax equivalent of depreciation, at rates set by law rather than by you.',
    irishContext: 'Plant and machinery, including computer equipment, generally attracts '
      + 'wear-and-tear allowances spread over eight years. The rate is configurable in '
      + 'this application rather than hard-coded, because it is a matter of legislation '
      + 'that can change.',
    relatedTerms: ['depreciation', 'tax-adjusted-profit'],
  },
  {
    term: 'Gross', slug: 'gross', category: 'VAT',
    shortDefinition: 'The total including VAT.',
    longDefinition: 'Gross = net + VAT. The gross amount is what actually leaves your '
      + 'bank account, which is why bank transactions are gross and invoices are analysed '
      + 'into net and VAT.',
    relatedTerms: ['net', 'vat'],
  },
  {
    term: 'Net', slug: 'net', category: 'VAT',
    shortDefinition: 'The amount before VAT.',
    relatedTerms: ['gross', 'vat'],
  },
  {
    term: 'Income', slug: 'income', category: 'Accounting',
    shortDefinition: 'Money the company earns from its activities.',
  },
  {
    term: 'Journal', slug: 'journal', category: 'Accounting',
    shortDefinition: 'The underlying record of a transaction as debits and credits.',
    longDefinition: 'Every figure in every report in this application traces back to '
      + 'journal entries. A posted journal entry is never edited — a correction is a new '
      + 'reversing entry, so the original record survives.',
    relatedTerms: ['double-entry', 'trial-balance'],
  },
  {
    term: 'Liability', slug: 'liability', category: 'Accounting',
    shortDefinition: 'Something the company owes.',
    relatedTerms: ['asset', 'creditor'],
  },
  {
    term: 'Profit and loss account', slug: 'profit-and-loss', category: 'Reports',
    shortDefinition: 'A summary of income and expenses over a period, showing the profit or loss.',
    longDefinition: 'Unlike the balance sheet, which is a snapshot on one date, the P&L '
      + 'covers a span of time.',
    relatedTerms: ['balance-sheet', 'retained-earnings'],
  },
  {
    term: 'Reconciliation', slug: 'reconciliation', category: 'Bank',
    shortDefinition: 'Confirming that two independent records of the same thing agree.',
    relatedTerms: ['bank-reconciliation'],
  },
  {
    term: 'Reverse charge', slug: 'reverse-charge', category: 'VAT',
    shortDefinition: 'You account for the VAT on a purchase yourself instead of the supplier charging it.',
    longDefinition: 'The supplier invoices you without VAT. You then record both the VAT '
      + 'you would have been charged and the VAT you are reclaiming, so the two usually '
      + 'cancel out in cash terms — but both figures must still appear on your VAT return.',
    irishContext: 'This is the normal treatment for services bought from businesses in '
      + 'other EU member states and from outside the EU. It produces two VAT entries from '
      + 'one invoice, which is why this application stores VAT entries separately rather '
      + 'than as a column on the transaction.',
    relatedTerms: ['vat-treatment', 'vat3'],
  },
  {
    term: 'Retained earnings', slug: 'retained-earnings', category: 'Accounting',
    shortDefinition: 'Accumulated profits from all previous years that have not been paid out.',
    relatedTerms: ['equity', 'profit-and-loss'],
  },
  {
    term: 'Share capital', slug: 'share-capital', category: 'Accounting',
    shortDefinition: 'Money put into the company by shareholders in exchange for shares.',
    relatedTerms: ['equity'],
  },
  {
    term: 'Trial balance', slug: 'trial-balance', category: 'Reports',
    shortDefinition: 'A list of every account with its balance, used to check that debits equal credits.',
    longDefinition: 'If the two columns do not agree, there is an error in the underlying '
      + 'entries. It is the first thing an accountant looks at.',
    relatedTerms: ['double-entry', 'journal'],
  },
  {
    term: 'VAT', slug: 'vat', category: 'VAT',
    shortDefinition: 'Value Added Tax: a tax on sales that registered businesses collect and remit.',
    longDefinition: 'You charge VAT on what you sell, reclaim VAT on what you buy, and pay '
      + 'Revenue the difference. If you reclaimed more than you charged, you are due a refund.',
    relatedTerms: ['vat-treatment', 'vat-period', 'vat3'],
  },
  {
    term: 'VAT period', slug: 'vat-period', category: 'VAT',
    shortDefinition: 'The span of time one VAT return covers.',
    irishContext: 'Bi-monthly is the most common filing frequency for a small Irish '
      + 'company, but monthly, four-monthly, half-yearly and annual are all possible '
      + 'depending on your circumstances. Your actual periods are configurable here — '
      + 'nothing is assumed.',
    relatedTerms: ['vat', 'vat3'],
  },
  {
    term: 'VAT treatment', slug: 'vat-treatment', category: 'VAT',
    shortDefinition: 'How VAT applies to a transaction. Not the same thing as the VAT percentage.',
    longDefinition: 'Three transactions can all show €0 of VAT for entirely different '
      + 'reasons: a zero-rated sale, an exempt supply, and a bank transfer that is outside '
      + 'the scope of VAT altogether. They are reported differently and they affect what '
      + 'you can reclaim differently, so this application records the treatment rather '
      + 'than only the percentage.',
    relatedTerms: ['vat', 'reverse-charge', 'vat3'],
  },
  {
    term: 'VAT3', slug: 'vat3', category: 'VAT',
    shortDefinition: 'The Irish VAT return form, whose boxes are labelled T1, T2, T3, T4, E1, E2, ES1, ES2 and PA1.',
    longDefinition: 'T1 is VAT on your sales, T2 is VAT on your purchases, and T3 or T4 is '
      + 'the net amount payable or repayable. The E and ES boxes report the net value of '
      + 'goods and services traded with other EU member states, and PA1 covers goods '
      + 'imported under postponed accounting.',
    irishContext: 'Every VAT treatment in this application declares which box it reports '
      + 'into, so the VAT period report lines up with the form you actually file.',
    relatedTerms: ['vat', 'vat-period', 'vat-treatment'],
  },
  {
    term: 'Tax-adjusted profit', slug: 'tax-adjusted-profit', category: 'Tax',
    shortDefinition: 'Your accounting profit after the adjustments tax law requires.',
    longDefinition: 'Accounting profit and taxable profit are different numbers. '
      + 'Depreciation is added back, capital allowances are deducted, and certain costs '
      + 'such as client entertainment are not allowed at all.',
    irishContext: 'This application shows the bridge from one to the other as an explicit '
      + 'worksheet so you and your accountant can see each adjustment, rather than '
      + 'presenting a single figure to be taken on trust.',
    relatedTerms: ['corporation-tax', 'capital-allowances'],
  },
  {
    term: 'Close company', slug: 'close-company', category: 'Tax',
    shortDefinition: 'An Irish company controlled by five or fewer participators, or by its directors.',
    irishContext: 'Most small owner-managed Irish companies are close companies. Specific '
      + 'rules apply to loans to participators and to undistributed investment income. '
      + 'This application flags the situations where those rules may be relevant; it does '
      + 'not determine whether they apply to you.',
    relatedTerms: ['directors-current-account'],
  },
  {
    term: 'Tax point', slug: 'tax-point', category: 'VAT',
    shortDefinition: 'The date that decides which VAT period a transaction falls into.',
    longDefinition: 'It is not always the invoice date. On the cash receipts basis, the '
      + 'tax point for a sale is the date you are paid, so an invoice issued in one period '
      + 'and paid in the next belongs to the later period for VAT purposes.',
    relatedTerms: ['vat-period', 'cash-receipts-basis'],
  },
  {
    term: 'Cash receipts basis', slug: 'cash-receipts-basis', category: 'VAT',
    shortDefinition: 'Accounting for VAT on sales when you are paid, rather than when you invoice.',
    irishContext: 'Available to businesses under a turnover threshold, and helpful for '
      + 'cash flow because you do not pay VAT over before your customer has paid you. '
      + 'Note the asymmetry: it applies to VAT on your sales only. VAT on your purchases '
      + 'is still reclaimed by reference to the supplier’s invoice date.',
    relatedTerms: ['invoice-basis', 'tax-point'],
  },
  {
    term: 'Invoice basis', slug: 'invoice-basis', category: 'VAT',
    shortDefinition: 'Accounting for VAT on sales when you issue the invoice, whether or not you have been paid.',
    relatedTerms: ['cash-receipts-basis', 'tax-point'],
  },
  {
    term: 'Bank transaction', slug: 'bank-transaction', category: 'Bank',
    shortDefinition: 'A single line on your bank statement: evidence that money moved.',
    longDefinition: 'A bank transaction is evidence, not an accounting entry in itself. '
      + 'It tells you money moved but not why, which is why this application keeps the '
      + 'imported line untouched and records the accounting treatment alongside it.',
    relatedTerms: ['journal', 'bank-reconciliation'],
  },
  {
    term: 'Financial year', slug: 'financial-year', category: 'Accounting',
    shortDefinition: 'The twelve-month period your annual accounts cover.',
    longDefinition: 'It does not have to align with the calendar year. A company’s '
      + 'first financial year runs from incorporation and is often shorter or longer '
      + 'than twelve months.',
    relatedTerms: ['accounting-period'],
  },
];

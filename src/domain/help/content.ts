/**
 * Help centre content (README §40).
 *
 * Written for a company director doing their own bookkeeping, not for an
 * accountant. Practical, and honest about what the application does not do.
 */

export interface HelpArticle {
  slug: string;
  title: string;
  summary: string;
  body: string[];
}

export interface HelpSection {
  slug: string;
  title: string;
  articles: HelpArticle[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    slug: 'getting-started',
    title: 'Getting Started',
    articles: [
      {
        slug: 'what-this-is',
        title: 'What this application is, and is not',
        summary: 'A bookkeeping and preparation tool that runs on your own machine.',
        body: [
          'This is a double-entry accounting system for one small Irish company. It keeps a '
            + 'structured accounting database on this machine, stores your invoices and receipts '
            + 'alongside it, and produces the figures you or your accountant need for VAT '
            + 'returns and year-end accounts.',
          'It does not file anything. It has no connection to Revenue or the CRO, it does not '
            + 'submit your VAT3, and it will never tell you that you are compliant. What it '
            + 'will tell you is whether its own internal checks passed, which is a much '
            + 'narrower claim and the only one it is in a position to make.',
          'It also does not replace an accountant. What it is designed to do is hand an '
            + 'accountant a clean package of figures and evidence, so their time goes on '
            + 'judgement rather than on reconstructing your year from a bank statement.',
        ],
      },
      {
        slug: 'first-steps',
        title: 'Setting up for the first time',
        summary: 'Company details, VAT periods, bank accounts, then your first import.',
        body: [
          'Start in Setup → Company. Enter your legal name, CRO number, VAT number and '
            + 'registration date, and your accounting year end. These are used throughout, so '
            + 'it is worth getting them right before importing anything.',
          'Choose your VAT accounting basis carefully. On the cash receipts basis, VAT on your '
            + 'sales arises when you are paid; on the invoice basis it arises when you issue '
            + 'the invoice. This changes which period a sale falls into, so it is not a '
            + 'cosmetic setting.',
          'Then add your bank accounts, generate your VAT periods for the year, and import '
            + 'your first statement. The chart of accounts, tax rates and VAT treatments are '
            + 'already set up with sensible Irish defaults, all of which you can edit.',
        ],
      },
      {
        slug: 'daily-workflow',
        title: 'The day-to-day loop',
        summary: 'Import, upload, review exceptions, and nothing else.',
        body: [
          'The intended rhythm is: import your bank statement, upload the invoices and '
            + 'receipts for the period, and then work the review queue. Everything the system '
            + 'is confident about is handled without asking you.',
          'The review queue is the screen that matters. It holds the transactions that could '
            + 'not be classified, the documents that could not be matched confidently, the '
            + 'suspected duplicates and the integrity failures. If the queue is empty, there '
            + 'is nothing for you to do.',
        ],
      },
    ],
  },
  {
    slug: 'bank-transactions',
    title: 'Bank Transactions',
    articles: [
      {
        slug: 'importing',
        title: 'Importing statements',
        summary: 'CSV and XLSX, with duplicate protection that is safe to rely on.',
        body: [
          'Export a CSV from your online banking and upload it. Columns are recognised '
            + 'automatically where their names are conventional, and the mapping is shown for '
            + 'you to confirm rather than applied silently. Once confirmed, the mapping is '
            + 'remembered for that bank.',
          'Importing the same file twice does nothing at all. Importing an overlapping period '
            + 'imports only the rows you do not already have. You can re-import freely without '
            + 'worrying about duplicating your books.',
          'There is deliberately no live bank feed. Bank APIs in Ireland are fragmented, and a '
            + 'feed that silently misses or duplicates transactions is worse than a file you '
            + 'downloaded and can check.',
        ],
      },
      {
        slug: 'what-a-transaction-is',
        title: 'Why a bank transaction is not an accounting entry',
        summary: 'A statement line is evidence that money moved, not a record of why.',
        body: [
          'A line on your bank statement tells you €120 left your account on the 17th. It does '
            + 'not tell you whether that was an expense, an asset purchase, a loan repayment or '
            + 'a mistake. Those are accounting decisions, and they are recorded separately.',
          'This is why the imported line is never edited. It is evidence, and evidence is kept '
            + 'exactly as it arrived. Your classification, the VAT treatment, the matched '
            + 'invoice and the resulting journal entry all live alongside it.',
          'It is also why one bank transaction can produce several accounting entries. A '
            + 'reverse-charge purchase produces four journal lines and two VAT entries from a '
            + 'single statement line.',
        ],
      },
    ],
  },
  {
    slug: 'invoices-receipts',
    title: 'Invoices and Receipts',
    articles: [
      {
        slug: 'uploading',
        title: 'Uploading documents',
        summary: 'Files are read, never modified, and never overwritten.',
        body: [
          'Upload PDFs or images. Text is read out of PDFs automatically and the supplier, '
            + 'date, invoice number and amounts are extracted where they can be found reliably.',
          'Confidence is reported honestly. Where a field could not be read with confidence it '
            + 'is left blank and the document goes to the review queue, rather than being '
            + 'filled with a guess that looks like a fact.',
          'A file identical to one already stored is flagged as a duplicate and the original is '
            + 'left untouched. The same invoice legitimately arrives twice — once by email, once '
            + 'in a folder — so both are kept and you decide which is real.',
          'Scanned images without a text layer cannot be read without OCR, and the application '
            + 'says so plainly rather than returning empty fields as though it had tried.',
        ],
      },
      {
        slug: 'matching',
        title: 'How matching works',
        summary: 'Amount, date and identity — all three, or it asks you.',
        body: [
          'Each document is scored against the bank transactions around its date. The score is '
            + 'built from named factors — how close the amounts are, how close the dates are, '
            + 'whether the supplier appears in the bank narrative, whether the invoice number '
            + 'does — and every factor’s contribution is shown.',
          'A match is only applied automatically when all three legs are present: how much, '
            + 'when, and who. An amount and a date alone are coincidence; plenty of payments '
            + 'share an amount and plenty share a date. Without something identifying the '
            + 'counterparty, the match is proposed rather than applied.',
          'If two transactions match a document equally well, neither is applied. Choosing one '
            + 'would attach the invoice to the wrong payment and put its VAT against the wrong '
            + 'evidence.',
        ],
      },
    ],
  },
  {
    slug: 'vat',
    title: 'VAT',
    articles: [
      {
        slug: 'treatments',
        title: 'VAT treatments, and why the percentage is not enough',
        summary: 'Three transactions can show €0 of VAT for three different reasons.',
        body: [
          'A zero-rated sale, an exempt supply and a bank transfer outside the scope of VAT all '
            + 'show no VAT. They are not the same thing. Zero-rated supplies are taxable at 0% '
            + 'and are still reported, and input VAT on related costs stays recoverable. Exempt '
            + 'supplies are not taxable and can restrict what you reclaim. Outside-scope items '
            + 'do not appear on the return at all.',
          'That is why every transaction carries a VAT treatment rather than just a percentage. '
            + 'The treatment decides which box on the VAT3 the figures land in, and whether the '
            + 'VAT is recoverable.',
        ],
      },
      {
        slug: 'reverse-charge',
        title: 'The reverse charge',
        summary: 'Why a €120 invoice from a US supplier produces €27.60 of VAT.',
        body: [
          'When you buy services from a business outside Ireland, the supplier usually charges '
            + 'no VAT. You account for the Irish VAT yourself: you record the VAT you would '
            + 'have been charged as output VAT, and the same amount as input VAT you are '
            + 'reclaiming. In cash terms they normally cancel out, but both figures must appear '
            + 'on your return.',
          'The important consequence is that the invoice total is the NET amount, not the '
            + 'gross. A $120 invoice from a US supplier is €120 of cost plus €27.60 of VAT you '
            + 'self-account for — not €120 including VAT. Treating it as gross understates both '
            + 'the cost and the VAT, and it is the single most common reverse-charge mistake.',
          'This applies to most EU and US software, hosting and API suppliers an Irish company '
            + 'uses, so it is not an edge case.',
        ],
      },
      {
        slug: 'cash-receipts-basis',
        title: 'The cash receipts basis',
        summary: 'It applies to your sales only, which is easy to get wrong.',
        body: [
          'On the cash receipts basis you account for VAT on your sales when you are paid, '
            + 'rather than when you issue the invoice. It is available under a turnover '
            + 'threshold and helps cash flow, because you do not pay VAT over before your '
            + 'customer has paid you.',
          'The asymmetry catches people out: it applies to VAT on your SALES only. VAT on your '
            + 'purchases is still reclaimed by reference to the supplier’s invoice date '
            + 'under either basis.',
          'A practical consequence is that an invoice issued in February and paid in March '
            + 'belongs to the March–April VAT period, not January–February. If you part-pay an '
            + 'invoice, each payment creates its own VAT entry for the proportion settled.',
        ],
      },
      {
        slug: 'closing-a-period',
        title: 'Closing a VAT period',
        summary: 'What "Internal checks passed" does and does not mean.',
        body: [
          'A period moves from open, to review, to ready, to locked, to submitted. Marking it '
            + 'ready runs a set of validations: unclassified transactions, missing documents, '
            + 'suspected duplicates, unconfirmed AI suggestions, arithmetically impossible VAT, '
            + 'entries dated outside the period, and missing counterparty VAT numbers where the '
            + 'treatment depends on one.',
          'If any of those are outstanding, the period cannot be marked ready and the screen '
            + 'says NOT READY with the specific reasons.',
          'If none are, it says "Internal checks passed". That means this application found '
            + 'nothing wrong with its own data. It is not a statement that your return is '
            + 'correct, and it is certainly not a statement that you are compliant.',
          'When you record a period as submitted, the figures are snapshotted. If anything '
            + 'changes afterwards, the difference is shown rather than quietly rewriting what '
            + 'you filed.',
        ],
      },
    ],
  },
  {
    slug: 'accounting',
    title: 'Accounting',
    articles: [
      {
        slug: 'double-entry',
        title: 'Double entry, briefly',
        summary: 'Every transaction is recorded twice, which is what makes errors visible.',
        body: [
          'Paying €100 for hosting increases your hosting expense by €100 and decreases your '
            + 'bank balance by €100. Every transaction has two sides, and the two sides always '
            + 'match. That is the whole idea.',
          'You do not need to think in debits and credits to use this application — the '
            + 'screens ask which category something belongs to and how VAT applies, and the '
            + 'entries follow. But the entries are there, they are shown on every transaction, '
            + 'and they are what every report is built from.',
        ],
      },
      {
        slug: 'corrections',
        title: 'Correcting a mistake',
        summary: 'Nothing is edited. Corrections are new entries.',
        body: [
          'Once an entry is posted it is never edited or deleted. If you coded something to the '
            + 'wrong account, reclassifying it posts a reversing entry and then a new one. Both '
            + 'stay in the books.',
          'This can feel like clutter, but it is what makes the audit trail trustworthy. A set '
            + 'of books where entries can be silently changed after the fact is a set of books '
            + 'nobody can rely on, including you.',
          'The same applies to your evidence: bank transactions are never altered after import, '
            + 'and stored documents are never modified.',
        ],
      },
      {
        slug: 'directors-account',
        title: 'Paying for things personally',
        summary: 'The director’s current account, and when to be careful.',
        body: [
          'When a director pays a company expense from their own pocket, no company money '
            + 'moves, so there is no bank transaction. The expense is recorded and the '
            + 'company’s debt to the director goes up. That balance sits on the balance '
            + 'sheet as a liability.',
          'Money flowing the other way — the director taking funds out that are not salary or a '
            + 'dividend — reduces the balance and can push it into debit, meaning the director '
            + 'owes the company.',
          'For a close company, which most small owner-managed Irish companies are, a loan to a '
            + 'participator can trigger an income tax charge and a benefit-in-kind issue on any '
            + 'interest-free element. This application flags a debit balance so you notice it. '
            + 'It deliberately does not calculate any charge, because whether and how those '
            + 'rules apply is a judgement for your accountant.',
        ],
      },
    ],
  },
  {
    slug: 'reports',
    title: 'Reports',
    articles: [
      {
        slug: 'drilling-down',
        title: 'Finding out where a number came from',
        summary: 'Every figure is traceable to the document behind it.',
        body: [
          'Any figure shown as a link can be opened. A VAT box opens the entries behind it; an '
            + 'entry opens its transaction; a transaction opens its document. The same applies '
            + 'to profit and loss lines, which open the account, which opens every journal line '
            + 'posted to it.',
          'This is the point of the application. If you cannot trace a number to the evidence '
            + 'behind it, you cannot defend it, and neither can your accountant.',
        ],
      },
      {
        slug: 'balance-sheet-balancing',
        title: 'When the balance sheet does not balance',
        summary: 'It is a defect, not a rounding artefact.',
        body: [
          'Net assets must equal total equity exactly. If the balance sheet reports a '
            + 'difference, something is wrong in the underlying entries, and the application '
            + 'says so rather than hiding the difference in a rounding line.',
          'Do not rely on any figure until it is found.',
        ],
      },
    ],
  },
  {
    slug: 'year-end',
    title: 'Year End',
    articles: [
      {
        slug: 'the-pack',
        title: 'The accountant pack',
        summary: 'What to hand over, and what it deliberately leaves out.',
        body: [
          'The year-end pack gathers the profit and loss account, balance sheet, trial balance, '
            + 'VAT summaries, fixed asset schedule, director’s current account, the '
            + 'supporting document index with hashes, and a list of everything still '
            + 'outstanding. It exports to a spreadsheet.',
          'The corporation tax section is a worksheet showing the bridge from accounting profit '
            + 'to tax-adjusted profit: depreciation added back, capital allowances deducted. It '
            + 'does not apply a tax rate and does not produce a liability.',
          'It also lists, explicitly, the adjustments it does not make — disallowable '
            + 'entertainment, balancing allowances on disposals, losses forward, the trading '
            + 'and non-trading distinction, close company surcharges, and reliefs. Those need '
            + 'judgement, and presenting a confident-looking number without them would be worse '
            + 'than presenting nothing.',
        ],
      },
    ],
  },
  {
    slug: 'tax',
    title: 'Tax',
    articles: [
      {
        slug: 'rates-and-sources',
        title: 'Tax rates and where they come from',
        summary: 'Every rate is configuration you can see and change.',
        body: [
          'No tax rate is built into this application’s logic. Rates live in a table with '
            + 'effective-from and effective-to dates, and every seeded rate carries a note '
            + 'saying where it came from and when it was last checked.',
          'Rates change. When one does, you add a new row with its effective date rather than '
            + 'editing the old one, and historical transactions keep the rate that applied when '
            + 'they happened. Editing a rate today cannot silently restate last year.',
          'You should verify the seeded rates against current Revenue guidance before relying '
            + 'on them. They are a reasonable starting point, not an authority.',
        ],
      },
      {
        slug: 'deadlines',
        title: 'Deadlines',
        summary: 'Configurable, because they are not the same for everyone.',
        body: [
          'VAT filing deadlines differ depending on how you file, and annual return dates '
            + 'differ per company. Nothing here is hard-coded as though it applied to everyone: '
            + 'the calendar is generated from your own configuration and every entry can be '
            + 'edited.',
          'Confirm your own dates with Revenue, the CRO or your accountant. A deadline shown '
            + 'here is one you configured, not one this application knows to be correct.',
        ],
      },
    ],
  },
  {
    slug: 'troubleshooting',
    title: 'Troubleshooting',
    articles: [
      {
        slug: 'common-problems',
        title: 'Common problems',
        summary: 'Things that look wrong but usually are not, and things that are.',
        body: [
          'A transaction showing no VAT: check the treatment, not the rate. Outside-scope and '
            + 'exempt both produce no VAT and are meant to.',
          'A reverse-charge purchase showing more VAT than you expected: that is correct. The '
            + 'invoice total is the net, and the VAT is added on top and then reclaimed.',
          'A document that will not match: check the amount on the document against the bank. '
            + 'If they differ, the bank may have converted a foreign currency, in which case '
            + 'record the exchange rate rather than forcing the match.',
          'A bank account showing a credit balance in the trial balance: this is normal when '
            + 'money has been spent that has not yet been funded. It only matters if the '
            + 'balance disagrees with your actual statement.',
          'A balance sheet that does not balance: this is a genuine defect. Check the audit '
            + 'trail for recent manual adjustments and for anything in the suspense account.',
        ],
      },
      {
        slug: 'backups',
        title: 'Backups',
        summary: 'Versioned, verified, and not overwritten.',
        body: [
          'A backup contains the database, every stored document, and a manifest of hashes. '
            + 'Each one is a new numbered version — a backup that overwrites the previous one '
            + 'is a single point of failure, because a corrupted database backed up once '
            + 'destroys the only good copy.',
          'Backups are verifiable. Every file is re-hashed against the manifest, so you can '
            + 'tell a complete backup from a hopeful one before you need it.',
          'Restoring moves your current database and documents aside first rather than deleting '
            + 'them. Restoring over live data is exactly when you discover a backup was '
            + 'incomplete, and at that moment what you most need is the state you just replaced.',
        ],
      },
    ],
  },
];

export function findArticle(sectionSlug: string, articleSlug: string): HelpArticle | undefined {
  return HELP_SECTIONS.find((s) => s.slug === sectionSlug)
    ?.articles.find((a) => a.slug === articleSlug);
}

import { eq, and } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  suppliers, customers, companyOfficers, shareCapital, bankTransactions,
  documents, fixedAssets, invoices, vatPeriods, taxDeadlines, accounts,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { createCompany, addBankAccount, systemAccountId } from '@/domain/config/setup';
import { importStatement, saveImportProfile } from '@/domain/banking/import';
import { classifyTransaction } from '@/domain/banking/classify';
import { storeDocument } from '@/domain/documents/storage';
import { extractDocument } from '@/domain/extraction/service';
import { LocalExtractionProvider } from '@/domain/extraction/localProvider';
import { matchAllUnmatched } from '@/domain/matching/service';
import { documentReviewValues, confirmDocument, checkDocumentValues } from '@/domain/documents/review';
import { postDocumentAsInvoice, documentEvidenceLines } from '@/domain/consolidation/postDocument';
import { settleBankTransaction, settleInvoiceByDirector } from '@/domain/consolidation/settle';
import { createRule } from '@/domain/rules/engine';
import { postJournalEntry } from '@/domain/accounting/journal';
import { asIsoDate, makeDate } from '@/domain/dates';
import { normaliseName } from '@/domain/extraction/service';

/**
 * Realistic demo data (README §51).
 *
 * Every company created here is flagged `isDemo`, and the UI labels it
 * unmistakably, because the one thing worse than no demo data is demo data a
 * user mistakes for their own books.
 *
 * The dataset deliberately includes the awkward cases the system exists to
 * handle — a reverse charge, an EU acquisition, a USD payment needing
 * conversion, an unmatched transaction, a missing document, a director-paid
 * expense, a capital purchase and a duplicate — rather than a tidy set that
 * makes every screen look green.
 */

export interface SeedResult {
  companyId: string;
  bankAccountId: string;
  counts: Record<string, number>;
}

const STATEMENT_CSV = [
  'Date,Description,Amount,Balance,Currency',
  '06/01/2025,SHARE CAPITAL SUBSCRIPTION,100.00,100.00,EUR',
  '08/01/2025,DIRECTOR LOAN INTRODUCED,5000.00,5100.00,EUR',
  '15/01/2025,VERCEL INC,-42.17,5057.83,EUR',
  '17/01/2025,ANTHROPIC PBC,-120.00,4937.83,EUR',
  '20/01/2025,BYRNE ACCOUNTANCY SERVICES,-615.00,4322.83,EUR',
  '31/01/2025,MULLIGAN DIGITAL LTD INV-2025-001,4305.00,8627.83,EUR',
  '03/02/2025,AWS EMEA SARL,-210.50,8417.33,EUR',
  '11/02/2025,HETZNER ONLINE GMBH,-89.00,8328.33,EUR',
  '14/02/2025,VERCEL INC,-42.17,8286.16,EUR',
  '18/02/2025,BANK CHARGES,-12.50,8273.66,EUR',
  '21/02/2025,APPLE STORE DUBLIN,-2460.00,5813.66,EUR',
  '28/02/2025,MULLIGAN DIGITAL LTD INV-2025-002,2460.00,8273.66,EUR',
  '05/03/2025,GITHUB INC,-84.00,8189.66,EUR',
  '12/03/2025,VERCEL INC,-42.17,8147.49,EUR',
  '14/03/2025,UNKNOWN COUNTERPARTY REF 88213,-355.00,7792.49,EUR',
  '17/03/2025,ANTHROPIC PBC,-120.00,7672.49,EUR',
  '19/03/2025,INSURANCE IRELAND DAC,-480.00,7192.49,EUR',
  '25/03/2025,TRAIN TICKET IARNROD EIREANN,-38.50,7153.99,EUR',
  // An EU business-to-business service supply carries no Irish VAT, so the
  // receipt is the invoice total of 6,000.00 and not 6,000 plus 23%.
  '31/03/2025,CONTINENTAL DESIGN SRL,6000.00,13153.99,EUR',
  '02/04/2025,VERCEL INC,-42.17,13111.82,EUR',
  '04/04/2025,VERCEL INC,-42.17,13069.65,EUR',
  '09/04/2025,REVENUE VAT PAYMENT,-1204.00,11865.65,EUR',
].join('\n');

const COLUMN_MAP = {
  Date: 'transaction_date' as const,
  Description: 'description' as const,
  Amount: 'amount' as const,
  Balance: 'balance' as const,
  Currency: 'currency' as const,
};

/** Plain-text stand-ins for scanned invoices, so extraction has real input. */
const DEMO_DOCUMENTS: Array<{ filename: string; body: string }> = [
  {
    filename: 'vercel-2025-01.txt',
    body: [
      'Vercel Inc.', '440 N Barranca Ave #4133, Covina, CA 91723, United States',
      '', 'INVOICE', 'Invoice Number: VRC-2025-0115', 'Invoice Date: 15/01/2025',
      '', 'Pro plan — January 2025             42.17',
      'Total                                  EUR 42.17',
      '', 'VAT: Reverse charge. VAT to be accounted for by the recipient.',
    ].join('\n'),
  },
  {
    filename: 'anthropic-2025-01.txt',
    body: [
      'Anthropic PBC', '548 Market Street, San Francisco, CA 94104, United States',
      '', 'INVOICE', 'Invoice Number: ANT-2025-0117', 'Invoice Date: 17/01/2025',
      '', 'Claude API usage                     120.00',
      'Total                                  EUR 120.00',
      '', 'Reverse charge applies. No VAT has been charged.',
    ].join('\n'),
  },
  {
    filename: 'byrne-accountancy-2025-01.txt',
    body: [
      'Byrne Accountancy Services Limited', '14 Fitzwilliam Square, Dublin 2, Ireland',
      'VAT Number: IE9876543W', '', 'INVOICE',
      'Invoice Number: BAS-2025-0044', 'Invoice Date: 20/01/2025', 'Due Date: 19/02/2025',
      '', 'Annual accounts and CT1 preparation   500.00',
      'Subtotal                               500.00',
      'VAT @ 23%                              115.00',
      'Total Due                              615.00',
      'Currency: EUR',
    ].join('\n'),
  },
  {
    filename: 'aws-2025-02.txt',
    body: [
      'Amazon Web Services EMEA SARL', '38 Avenue John F. Kennedy, L-1855 Luxembourg',
      'VAT Number: LU26888617', '', 'INVOICE',
      'Invoice Number: AWS-EU-2025-0203', 'Invoice Date: 03/02/2025',
      '', 'Cloud services — January 2025        210.50',
      'Total                                  EUR 210.50',
      '', 'VAT 0.00 — Reverse charge, Article 196 of Council Directive 2006/112/EC.',
    ].join('\n'),
  },
  {
    filename: 'hetzner-2025-02.txt',
    body: [
      'Hetzner Online GmbH', 'Industriestr. 25, 91710 Gunzenhausen, Germany',
      'USt-IdNr: DE812871812', '', 'RECHNUNG',
      'Rechnungsnummer: HZ-2025-0211', 'Rechnungsdatum: 11/02/2025',
      '', 'Dedicated Server                      89,00',
      'Nettobetrag                            89,00',
      'MwSt 0%                                 0,00',
      'Gesamtbetrag                    EUR    89,00',
      '', 'Reverse-Charge-Verfahren. Steuerschuldnerschaft des Leistungsempfaengers.',
    ].join('\n'),
  },
  {
    filename: 'apple-store-2025-02.txt',
    body: [
      'Apple Distribution International Ltd', 'Hollyhill Industrial Estate, Cork, Ireland',
      'VAT Number: IE9700053D', '', 'TAX INVOICE',
      'Invoice Number: APL-2025-0221', 'Invoice Date: 21/02/2025',
      '', 'MacBook Pro 14-inch                  2000.00',
      'Subtotal                              2000.00',
      'VAT @ 23%                              460.00',
      'Total                                 2460.00',
      'Currency: EUR',
    ].join('\n'),
  },
  {
    filename: 'github-2025-03.txt',
    body: [
      'GitHub, Inc.', '88 Colin P Kelly Jr Street, San Francisco, CA 94107, United States',
      '', 'INVOICE', 'Invoice Number: GH-2025-0305', 'Invoice Date: 05/03/2025',
      '', 'Team plan                             84.00',
      'Total                                  EUR 84.00',
      '', 'Reverse charge applies.',
    ].join('\n'),
  },
  {
    // Paid on the director's personal card: settled from their current account.
    filename: 'namecheap-2025-03.txt',
    body: [
      'Namecheap, Inc.', '4600 East Washington Street, Suite 300, Phoenix, AZ 85034, United States',
      '', 'INVOICE', 'Invoice Number: NC-2025-0306', 'Invoice Date: 06/03/2025',
      '', 'Domain renewals (3 domains)           84.00',
      'Total                                  EUR 84.00',
      '', 'Reverse charge applies. No VAT has been charged.',
    ].join('\n'),
  },
  {
    filename: 'insurance-ireland-2025-03.txt',
    body: [
      'Insurance Ireland DAC', '5 Harbourmaster Place, IFSC, Dublin 1, Ireland',
      'VAT Number: IE4567891K', '', 'RENEWAL NOTICE',
      'Policy Number: PI-2025-77213', 'Invoice Date: 19/03/2025',
      '', 'Professional indemnity — annual      480.00',
      'Total                                  480.00',
      'Currency: EUR',
      '', 'Exempt from VAT (insurance services).',
    ].join('\n'),
  },
  {
    filename: 'sales-invoice-2025-001.txt',
    body: [
      'Acme Software Limited', 'VAT Number: IE3456789TA', '', 'SALES INVOICE',
      'Invoice Number: INV-2025-001', 'Invoice Date: 24/01/2025', 'Due Date: 23/02/2025',
      'Customer: Mulligan Digital Limited, Galway, Ireland',
      'Customer VAT: IE6543217L',
      '', 'Consulting — January                3500.00',
      'Subtotal                              3500.00',
      'VAT @ 23%                              805.00',
      'Total Due                             4305.00',
      'Currency: EUR',
    ].join('\n'),
  },
  {
    filename: 'sales-invoice-2025-003.txt',
    body: [
      'Acme Software Limited', 'VAT Number: IE3456789TA', '', 'SALES INVOICE',
      'Invoice Number: INV-2025-003', 'Invoice Date: 24/03/2025',
      'Customer: Continental Design SRL, Milan, Italy',
      'Customer VAT: IT12345678901',
      '', 'Software licence and integration     6000.00',
      'Subtotal                              6000.00',
      'VAT                                      0.00',
      'Total Due                             6000.00',
      'Currency: EUR',
      '', 'Reverse charge: VAT to be accounted for by the recipient under Article 196.',
    ].join('\n'),
  },
];

export async function seedDemoCompany(
  db: AppDatabase, options: { storageRoot?: string } = {},
): Promise<SeedResult> {
  const created = createCompany(db, {
    legalName: 'Acme Software Limited',
    tradingName: 'Acme Software',
    croNumber: '123456',
    companyType: 'Private company limited by shares (LTD)',
    dateIncorporated: '2023-06-12',
    registeredOffice: '27 Pearse Street, Dublin 2, D02 XY45, Ireland',
    vatNumber: 'IE3456789TA',
    vatRegistrationDate: '2023-07-01',
    vatRegistrationStatus: 'registered',
    taxReferenceNumber: '3456789TA',
    vatAccountingBasis: 'cash_receipts',
    vatPeriodFrequency: 'bi_monthly',
    financialYearEndDay: 31,
    financialYearEndMonth: 12,
    baseCurrency: 'EUR',
    isDemo: true,
    seedYears: [2024, 2025],
  });

  const { companyId, accountsByKey: acc, accountsByCode: byCode, treatmentsByCode: tr } = created;

  // ---- Officers and share capital ----
  const directorId = ids.officer();
  db.insert(companyOfficers).values({
    id: directorId, companyId, name: 'Joseph O’Sullivan', role: 'director',
    address: '27 Pearse Street, Dublin 2, Ireland', nationality: 'Irish',
    appointedOn: '2023-06-12', sharesHeld: 100, shareClass: 'Ordinary',
    currentAccountId: acc['directors_current_account'],
  }).run();
  db.insert(companyOfficers).values({
    id: ids.officer(), companyId, name: 'Maria Lynch', role: 'secretary',
    appointedOn: '2023-06-12',
  }).run();
  db.insert(shareCapital).values({
    id: ids.shareCapital(), companyId, shareClass: 'Ordinary',
    authorisedShares: 1000, issuedShares: 100, nominalValueMinor: 100, currency: 'EUR',
  }).run();

  // ---- Bank account ----
  const bankAccountId = addBankAccount(db, {
    companyId, bankName: 'Bank of Ireland', accountName: 'Business Current Account',
    iban: 'IE29AIBK93115212345678', bic: 'BOFIIE2D', currency: 'EUR',
    accountType: 'current', openingBalanceMinor: 0, openingDate: '2025-01-01',
    accountId: acc['bank_control'],
  });

  saveImportProfile(db, {
    companyId, name: 'Bank of Ireland CSV export', bankAccountId,
    headers: ['Date', 'Description', 'Amount', 'Balance', 'Currency'],
    columnMap: COLUMN_MAP, defaultCurrency: 'EUR',
  });

  // ---- Suppliers ----
  const supplier = (
    name: string, country: string, vatNumber: string | null,
    accountCode: string, treatmentCode: string, aliases: string[] = [],
  ): string => {
    const id = ids.supplier();
    db.insert(suppliers).values({
      id, companyId, name, matchKey: normaliseName(name), aliases,
      countryCode: country, vatNumber, defaultCurrency: 'EUR',
      defaultAccountId: byCode[accountCode], defaultVatTreatmentId: tr[treatmentCode],
      typicalPaymentDays: 0,
    }).run();
    return id;
  };

  const vercel = supplier('Vercel Inc', 'US', null, '6010', 'NON_EU_SERVICES_RCV', ['VERCEL']);
  const anthropic = supplier('Anthropic PBC', 'US', null, '6000', 'NON_EU_SERVICES_RCV', ['ANTHROPIC']);
  const github = supplier('GitHub Inc', 'US', null, '6000', 'NON_EU_SERVICES_RCV', ['GITHUB']);
  const namecheap = supplier('Namecheap Inc', 'US', null, '6020', 'NON_EU_SERVICES_RCV', ['NAMECHEAP']);
  const aws = supplier('Amazon Web Services EMEA SARL', 'LU', 'LU26888617', '6010',
    'EU_SERVICES_RCV', ['AWS EMEA', 'AWS']);
  const hetzner = supplier('Hetzner Online GmbH', 'DE', 'DE812871812', '6010',
    'EU_SERVICES_RCV', ['HETZNER']);
  const byrne = supplier('Byrne Accountancy Services Limited', 'IE', 'IE9876543W', '6070',
    'IE_STD', ['BYRNE ACCOUNTANCY']);
  const apple = supplier('Apple Distribution International Ltd', 'IE', 'IE9700053D', '1500',
    'IE_STD', ['APPLE STORE']);
  const insurance = supplier('Insurance Ireland DAC', 'IE', 'IE4567891K', '6090',
    'IE_EXEMPT', ['INSURANCE IRELAND']);
  // Passenger transport is exempt (VATCA Sch.1 para 14(3)), not zero-rated.
  const irishRail = supplier('Iarnród Éireann', 'IE', null, '6110',
    'IE_EXEMPT', ['IARNROD EIREANN']);

  // ---- Customers ----
  const mulligan = ids.customer();
  db.insert(customers).values({
    id: mulligan, companyId, name: 'Mulligan Digital Limited',
    matchKey: normaliseName('Mulligan Digital Limited'), aliases: ['MULLIGAN DIGITAL'],
    countryCode: 'IE', vatNumber: 'IE6543217L', taxableStatus: 'taxable_person', defaultCurrency: 'EUR',
    defaultAccountId: byCode['4020'], defaultVatTreatmentId: tr['IE_STD'],
    defaultPaymentTermsDays: 30,
  }).run();

  const continental = ids.customer();
  db.insert(customers).values({
    id: continental, companyId, name: 'Continental Design SRL',
    matchKey: normaliseName('Continental Design SRL'), aliases: ['CONTINENTAL DESIGN'],
    countryCode: 'IT', vatNumber: 'IT12345678901', taxableStatus: 'taxable_person', defaultCurrency: 'EUR',
    defaultAccountId: byCode['4000'], defaultVatTreatmentId: tr['EU_SERVICES_SUPPLY'],
    defaultPaymentTermsDays: 30,
  }).run();

  const usCustomer = ids.customer();
  db.insert(customers).values({
    id: usCustomer, companyId, name: 'Redwood Analytics Inc',
    matchKey: normaliseName('Redwood Analytics Inc'), aliases: ['REDWOOD'],
    countryCode: 'US', taxableStatus: 'taxable_person', defaultCurrency: 'USD',
    defaultAccountId: byCode['4010'], defaultVatTreatmentId: tr['NON_EU_SERVICES_SUPPLY'],
  }).run();

  // ---- Rules learned from confirmed history ----
  createRule(db, {
    companyId, name: 'Vercel → hosting, reverse charge',
    description: 'Learned from confirmed history. Vercel is a US supplier of services, '
      + 'so the reverse charge applies and you self-account for the VAT.',
    conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
    actions: [
      { field: 'accountId', value: byCode['6010']! },
      { field: 'vatTreatmentId', value: tr['NON_EU_SERVICES_RCV']! },
      { field: 'supplierId', value: vercel },
    ],
    priority: 10, autoApply: true, supplierId: vercel, derivedFromHistory: true,
  });
  createRule(db, {
    companyId, name: 'Bank charges → exempt',
    description: 'Charges for operating a bank account and making payments are exempt '
      + '(VATCA Sch.1 para 6(1)(c)), and carry no recoverable VAT.',
    conditions: [{ field: 'description', operator: 'contains', value: 'BANK CHARGES' }],
    actions: [
      { field: 'accountId', value: byCode['6100']! },
      { field: 'vatTreatmentId', value: tr['IE_EXEMPT']! },
    ],
    priority: 20, autoApply: true,
  });
  createRule(db, {
    companyId, name: 'Large purchases need a capital review',
    description: 'Anything over €1,000 may be a fixed asset rather than an expense. '
      + 'This rule flags it for a decision rather than making one.',
    conditions: [
      { field: 'direction', operator: 'equals', value: 'out' },
      { field: 'absAmountMinor', operator: 'gt', value: 100_000 },
    ],
    actions: [{ field: 'notes', value: 'Possible capital purchase — review before posting.' }],
    priority: 5, autoApply: false, stopOnMatch: false,
  });

  // ---- Bank statement ----
  await importStatement(db, {
    companyId, bankAccountId, filename: 'boi-statement-2025-q1.csv',
    content: STATEMENT_CSV, fileFormat: 'csv', columnMap: COLUMN_MAP,
    importedBy: 'demo',
  });

  // A duplicate import, which must add nothing (README §51 asks for a duplicate).
  await importStatement(db, {
    companyId, bankAccountId, filename: 'boi-statement-2025-q1-redownload.csv',
    content: STATEMENT_CSV, fileFormat: 'csv', columnMap: COLUMN_MAP,
    importedBy: 'demo',
  });

  // ---- Classify most of the transactions ----
  const transactions = db.select().from(bankTransactions)
    .where(eq(bankTransactions.companyId, companyId)).all();

  const find = (needle: string) =>
    transactions.find((t) => t.description.includes(needle));

  const classify = (
    needle: string, accountCode: string, treatmentCode: string,
    party?: { supplierId?: string; customerId?: string },
  ): void => {
    const tx = find(needle);
    if (!tx) return;
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode[accountCode]!, vatTreatmentId: tr[treatmentCode]!,
      supplierId: party?.supplierId ?? null,
      customerId: party?.customerId ?? null,
      source: 'user', provenanceStatus: 'user_confirmed', actor: 'demo',
    });
  };

  // Share capital and director's loan: equity and liability, not income.
  const shareTx = find('SHARE CAPITAL');
  if (shareTx) {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 1, 6),
      narrative: 'Share capital subscribed', sourceType: 'bank_transaction',
      sourceId: shareTx.id, baseCurrency: 'EUR', createdBy: 'demo', createdVia: 'user',
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 10_000 },
        { accountId: acc['share_capital']!, creditMinor: 10_000 },
      ],
    });
    db.update(bankTransactions).set({
      status: 'posted', accountId: acc['share_capital'],
      vatTreatmentId: tr['OUT_OF_SCOPE'], provenanceStatus: 'user_confirmed', source: 'user',
    }).where(eq(bankTransactions.id, shareTx.id)).run();
  }

  const loanTx = find('DIRECTOR LOAN');
  if (loanTx) {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 1, 8),
      narrative: 'Funds introduced by director', sourceType: 'bank_transaction',
      sourceId: loanTx.id, baseCurrency: 'EUR', createdBy: 'demo', createdVia: 'user',
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 500_000 },
        { accountId: acc['directors_current_account']!, creditMinor: 500_000, officerId: directorId },
      ],
    });
    db.update(bankTransactions).set({
      status: 'posted', accountId: acc['directors_current_account'],
      vatTreatmentId: tr['OUT_OF_SCOPE'], provenanceStatus: 'user_confirmed', source: 'user',
    }).where(eq(bankTransactions.id, loanTx.id)).run();
  }

  // ---- Documents: read, confirmed, posted as invoices, settled from the bank ----
  // The workflow a person follows (issue #203): the invoice proves the supply
  // and its VAT, the bank line proves payment, and the payment ties them
  // together. VAT comes from the confirmed invoice lines, never the bank amount.
  const DOCUMENT_POSTING: Record<string, {
    party: { supplierId?: string; customerId?: string };
    account: string; treatment: string;
    /** 'date|needle' of the bank line that paid it, or the director who paid it personally. */
    bank?: string; paidByDirectorOn?: string;
  }> = {
    'vercel-2025-01.txt': { party: { supplierId: vercel }, account: '6010', treatment: 'NON_EU_SERVICES_RCV', bank: '2025-01-15|VERCEL' },
    'anthropic-2025-01.txt': { party: { supplierId: anthropic }, account: '6000', treatment: 'NON_EU_SERVICES_RCV', bank: '2025-01-17|ANTHROPIC' },
    'byrne-accountancy-2025-01.txt': { party: { supplierId: byrne }, account: '6070', treatment: 'IE_STD', bank: '2025-01-20|BYRNE' },
    'aws-2025-02.txt': { party: { supplierId: aws }, account: '6010', treatment: 'EU_SERVICES_RCV', bank: '2025-02-03|AWS EMEA' },
    'hetzner-2025-02.txt': { party: { supplierId: hetzner }, account: '6010', treatment: 'EU_SERVICES_RCV', bank: '2025-02-11|HETZNER' },
    // Capital purchase: to the asset account, not an expense.
    'apple-store-2025-02.txt': { party: { supplierId: apple }, account: '1500', treatment: 'IE_STD', bank: '2025-02-21|APPLE STORE' },
    'github-2025-03.txt': { party: { supplierId: github }, account: '6000', treatment: 'NON_EU_SERVICES_RCV', bank: '2025-03-05|GITHUB' },
    'namecheap-2025-03.txt': { party: { supplierId: namecheap }, account: '6020', treatment: 'NON_EU_SERVICES_RCV', paidByDirectorOn: '2025-03-06' },
    'insurance-ireland-2025-03.txt': { party: { supplierId: insurance }, account: '6090', treatment: 'IE_EXEMPT', bank: '2025-03-19|INSURANCE IRELAND' },
    'sales-invoice-2025-001.txt': { party: { customerId: mulligan }, account: '4020', treatment: 'IE_STD', bank: '2025-01-31|MULLIGAN DIGITAL LTD INV-2025-001' },
    'sales-invoice-2025-003.txt': { party: { customerId: continental }, account: '4000', treatment: 'EU_SERVICES_SUPPLY', bank: '2025-03-31|CONTINENTAL DESIGN' },
  };
  const findOn = (key: string) => {
    const [date, needle] = key.split('|') as [string, string];
    return transactions.find((t) => t.transactionDate === date && t.description.includes(needle));
  };

  const outstandingOf = (invoiceId: string) => db.select({ o: invoices.outstandingMinor }).from(invoices)
    .where(eq(invoices.id, invoiceId)).get()!.o;
  let documentCount = 0;
  for (const demo of DEMO_DOCUMENTS) {
    const posting = DOCUMENT_POSTING[demo.filename]!;
    const stored = storeDocument(db, {
      companyId, filename: demo.filename,
      content: Buffer.from(demo.body, 'utf8'),
      root: options.storageRoot, uploadedBy: 'demo',
    });
    await extractDocument(db, {
      companyId, documentId: stored.documentId,
      storageRootPath: options.storageRoot,
      providers: [new LocalExtractionProvider()], actor: 'demo',
    });
    // The demo stands in for a person checking each document against the page.
    const { values } = documentReviewValues(db, { companyId, documentId: stored.documentId });
    confirmDocument(db, {
      companyId, documentId: stored.documentId, values, reviewedBy: 'demo',
      acknowledgedCheckCodes: checkDocumentValues(values).map((c) => c.code),
      supplierId: posting.party.supplierId ?? null,
      customerId: posting.party.customerId ?? null,
    });
    const { lines } = documentEvidenceLines(db, { companyId, documentId: stored.documentId });
    const invoice = postDocumentAsInvoice(db, {
      companyId, documentId: stored.documentId, actor: 'demo',
      coding: lines.map(() => ({ accountId: byCode[posting.account]!, vatTreatmentId: tr[posting.treatment]! })),
    });
    if (posting.paidByDirectorOn) {
      settleInvoiceByDirector(db, {
        companyId, officerId: directorId, paymentDate: asIsoDate(posting.paidByDirectorOn), actor: 'demo',
        reference: 'Paid on personal card',
        allocations: [{ invoiceId: invoice.invoiceId, amountMinor: outstandingOf(invoice.invoiceId) }],
      });
    }
    const paid = posting.bank ? findOn(posting.bank) : undefined;
    if (paid) {
      settleBankTransaction(db, {
        companyId, bankTransactionId: paid.id, actor: 'demo',
        allocations: [{ invoiceId: invoice.invoiceId, amountMinor: Math.abs(paid.amountMinor) }],
      });
    }
    documentCount += 1;
  }

  // A duplicate document upload (README §51).
  storeDocument(db, {
    companyId, filename: 'vercel-2025-01-copy.txt',
    content: Buffer.from(DEMO_DOCUMENTS[0]!.body, 'utf8'),
    root: options.storageRoot, uploadedBy: 'demo',
  });
  documentCount += 1;

  // ---- Bank lines with no invoice on file ----
  // Classified, but a purchase without its invoice claims no input VAT (and a
  // reverse charge is not self-assessed without the invoice's net): each is
  // flagged "no invoice" in the review queue, as it would be for a real company.
  const unposted = (needle: string) => db.select().from(bankTransactions)
    .where(eq(bankTransactions.companyId, companyId)).all()
    .filter((t) => t.description.includes(needle) && !t.journalEntryId);
  for (const [needle, account, treatment, party, source] of [
    ['VERCEL', '6010', 'NON_EU_SERVICES_RCV', { supplierId: vercel }, 'rule'],
    ['ANTHROPIC', '6000', 'NON_EU_SERVICES_RCV', { supplierId: anthropic }, 'user'],
  ] as const) {
    for (const tx of unposted(needle)) {
      classifyTransaction(db, {
        companyId, bankTransactionId: tx.id, accountId: byCode[account]!, vatTreatmentId: tr[treatment]!,
        supplierId: party.supplierId, source,
        provenanceStatus: source === 'rule' ? 'system_rule' : 'user_confirmed', confidence: 100, actor: 'demo',
      });
    }
  }
  classify('BANK CHARGES', '6100', 'IE_EXEMPT');
  classify('IARNROD EIREANN', '6110', 'IE_EXEMPT', { supplierId: irishRail });
  classify('MULLIGAN DIGITAL LTD INV-2025-002', '4020', 'IE_STD', { customerId: mulligan });

  // The VAT payment settles the liability; it is not an expense.
  const vatPaymentTx = find('REVENUE VAT PAYMENT');
  if (vatPaymentTx) {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 4, 9),
      narrative: 'VAT paid to Revenue for Jan–Feb 2025',
      sourceType: 'bank_transaction', sourceId: vatPaymentTx.id,
      baseCurrency: 'EUR', createdBy: 'demo', createdVia: 'user',
      lines: [
        { accountId: acc['vat_on_sales']!, debitMinor: 120_400 },
        { accountId: acc['bank_control']!, creditMinor: 120_400 },
      ],
    });
    db.update(bankTransactions).set({
      status: 'posted', accountId: acc['vat_on_sales'],
      vatTreatmentId: tr['OUT_OF_SCOPE'], provenanceStatus: 'user_confirmed', source: 'user',
    }).where(eq(bankTransactions.id, vatPaymentTx.id)).run();
  }

  // 'UNKNOWN COUNTERPARTY' is deliberately left unclassified and unmatched,
  // so the review queue has something real in it.

  // ---- Fixed asset from the capital purchase ----
  const appleTx = find('APPLE STORE');
  db.insert(fixedAssets).values({
    id: ids.fixedAsset(), companyId, name: 'MacBook Pro 14-inch',
    description: 'Primary development machine',
    assetCategory: 'computer_equipment', purchaseDate: '2025-02-21',
    supplierId: apple, costMinor: 200_000, vatMinor: 46_000, currency: 'EUR',
    baseCostMinor: 200_000, baseCurrency: 'EUR',
    accountId: acc['computer_equipment'],
    accumulatedDepreciationAccountId: acc['accumulated_depreciation'],
    depreciationExpenseAccountId: acc['depreciation_expense'],
    depreciationMethod: 'straight_line', usefulLifeMonths: 36,
    depreciationStartDate: '2025-03-01',
    capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8,
    capitalAllowanceNotes: 'Wear and tear at 12.5% straight line over 8 years. '
      + 'Confirm the current rate before relying on it.',
    status: 'active', source: 'user', provenanceStatus: 'user_confirmed',
  }).run();

  // Nothing left to match: every confirmed document was posted and settled above.
  matchAllUnmatched(db, { companyId });

  // ---- Tax calendar ----
  const periods = db.select().from(vatPeriods)
    .where(and(eq(vatPeriods.companyId, companyId))).all()
    .filter((p) => p.startDate.startsWith('2025'));

  for (const period of periods) {
    db.insert(taxDeadlines).values({
      id: ids.audit(), companyId,
      title: `VAT3 return — ${period.name}`,
      kind: 'vat_return',
      dueDate: period.filingDeadline ?? period.endDate,
      periodStart: period.startDate, periodEnd: period.endDate,
      vatPeriodId: period.id, status: 'upcoming',
      sourceNote: 'Deadline generated from the VAT period configuration. Confirm your '
        + 'own filing dates — they differ depending on how you file.',
    }).run();
  }

  db.insert(taxDeadlines).values({
    id: ids.audit(), companyId,
    title: 'Corporation tax return (CT1) for the year ended 31 December 2025',
    kind: 'corporation_tax_return', dueDate: '2026-09-23',
    periodStart: '2025-01-01', periodEnd: '2025-12-31', status: 'upcoming',
    sourceNote: 'Indicative date only. Confirm your own filing deadline with Revenue '
      + 'or your accountant.',
  }).run();

  db.insert(taxDeadlines).values({
    id: ids.audit(), companyId,
    title: 'CRO annual return (Form B1)', kind: 'cro_annual_return',
    dueDate: '2026-03-12', status: 'upcoming',
    sourceNote: 'Based on the company’s annual return date. Confirm with the CRO.',
  }).run();

  const counts = {
    transactions: db.select().from(bankTransactions)
      .where(eq(bankTransactions.companyId, companyId)).all().length,
    documents: documentCount,
    suppliers: db.select().from(suppliers).where(eq(suppliers.companyId, companyId)).all().length,
    customers: db.select().from(customers).where(eq(customers.companyId, companyId)).all().length,
  };

  return { companyId, bankAccountId, counts };
}

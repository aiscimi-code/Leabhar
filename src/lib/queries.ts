import { and, eq, desc, sql, isNull, ne, or, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  companies, bankAccounts, bankTransactions, accounts, vatTreatments, vatPeriods,
  documents, reviewItems, suppliers, customers, accountingPeriods, taxDeadlines,
  journalEntries, journalLines, auditEvents, rules, fixedAssets, taxRates,
  documentMatches, statementImports, companyOfficers, documentExtractions,
  invoices, invoiceLines, payments, paymentAllocations,
  irishActProvisions, irishKnowledgeSources, irishTaxRules,
} from '@/db/schema';
import { trialBalance, balancesBySystemKey, accountBalance } from '@/domain/accounting/ledger';
import { buildVat3Return, vatPositionSummary } from '@/domain/vat/report';
import { validateVatPeriod } from '@/domain/vat/periodClose';
import { profitAndLoss, balanceSheet } from '@/domain/reports/financial';
import { unmatchedTransactions } from '@/domain/matching/service';
import { listAdjustments } from '@/domain/accounting/adjustments';
import { agedAnalysis } from '@/domain/invoicing/payments';
import { reconcileBankAccount, reconciliationHistory } from '@/domain/banking/reconciliation';
import { search } from '@/domain/search/search';
import { suggestVatTreatment } from '@/domain/rules/vatSuggestion';
import { verifyStatuteFile } from '@/domain/rules/knowledgeBase';
import { documentReviewValues } from '@/domain/documents/review';
import { asIsoDate, today, makeDate, type IsoDate } from '@/domain/dates';
import { money } from '@/lib/format';

/**
 * Read-side queries for the UI.
 *
 * Every figure here comes from the domain layer rather than being recomputed in
 * a page, so a report and the screen showing it can never disagree.
 */

export function activeCompany() {
  const db = getDb();
  return db.select().from(companies).orderBy(desc(companies.createdAt)).get();
}

export function requireCompany() {
  const company = activeCompany();
  if (!company) throw new Error('No company has been set up yet.');
  return company;
}

export function companyContext() {
  const db = getDb();
  const company = requireCompany();
  const years = db.select().from(accountingPeriods)
    .where(and(
      eq(accountingPeriods.companyId, company.id),
      eq(accountingPeriods.kind, 'financial_year'),
    )).orderBy(desc(accountingPeriods.startDate)).all();

  const current = years.find((y) => today() >= y.startDate && today() <= y.endDate) ?? years[0];

  return {
    company,
    financialYears: years,
    currentYear: current,
    currency: company.baseCurrency,
  };
}

export interface DashboardData {
  company: typeof companies.$inferSelect;
  bankBalanceMinor: number;
  bankAccounts: Array<{ account: typeof bankAccounts.$inferSelect; balanceMinor: number }>;
  revenueMinor: number;
  expensesMinor: number;
  profitMinor: number;
  vatPositionMinor: number;
  currentVatPeriod: typeof vatPeriods.$inferSelect | undefined;
  directorsAccountMinor: number;
  debtorsMinor: number;
  creditorsMinor: number;
  health: {
    transactionsTotal: number;
    unclassified: number;
    unmatched: number;
    missingDocuments: number;
    duplicateWarnings: number;
    documentsTotal: number;
    documentsMatched: number;
    documentCoveragePercent: number;
    vatClassifiedPercent: number;
    reconciled: boolean;
    openReviewItems: number;
  };
  upcomingDeadlines: Array<typeof taxDeadlines.$inferSelect>;
  yearStart: IsoDate;
  yearEnd: IsoDate;
}

export function dashboardData(): DashboardData {
  const db = getDb();
  const { company, currentYear } = companyContext();
  const yearStart = asIsoDate(currentYear?.startDate ?? `${new Date().getFullYear()}-01-01`);
  const yearEnd = asIsoDate(currentYear?.endDate ?? `${new Date().getFullYear()}-12-31`);

  const accountRows = db.select().from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, company.id), eq(bankAccounts.active, true))).all();

  const bankAccountBalances = accountRows.map((account) => ({
    account,
    balanceMinor: account.accountId
      ? accountBalance(db, { companyId: company.id, accountId: account.accountId, asOf: yearEnd })
      : 0,
  }));

  const pl = profitAndLoss(db, { companyId: company.id, from: yearStart, to: yearEnd });

  const systemBalances = balancesBySystemKey(db, {
    companyId: company.id,
    keys: ['directors_current_account', 'debtors', 'creditors', 'vat_on_sales', 'vat_on_purchases'],
    asOf: yearEnd,
  });

  const periods = db.select().from(vatPeriods)
    .where(eq(vatPeriods.companyId, company.id)).orderBy(vatPeriods.startDate).all();
  const currentVatPeriod = periods.find((p) => today() >= p.startDate && today() <= p.endDate)
    ?? [...periods].reverse().find((p) => p.startDate <= today());

  const vatPositionMinor = currentVatPeriod
    ? buildVat3Return(db, { companyId: company.id, vatPeriodId: currentVatPeriod.id }).netPositionMinor
    : 0;

  const transactions = db.select({
    id: bankTransactions.id, status: bankTransactions.status,
    vatTreatmentId: bankTransactions.vatTreatmentId,
    isDuplicateOf: bankTransactions.isDuplicateOf,
  }).from(bankTransactions).where(eq(bankTransactions.companyId, company.id)).all();

  const unclassified = transactions.filter((t) => t.status === 'unclassified').length;
  const withTreatment = transactions.filter((t) => t.vatTreatmentId !== null).length;
  const duplicates = transactions.filter((t) => t.isDuplicateOf !== null).length;

  const documentRows = db.select({
    id: documents.id, matchStatus: documents.matchStatus,
  }).from(documents).where(and(
    eq(documents.companyId, company.id), eq(documents.archived, false),
  )).all();
  const documentsMatched = documentRows.filter((d) => d.matchStatus === 'matched').length;

  const missingDocuments = unmatchedTransactions(db, { companyId: company.id })
    .filter((t) => t.status !== 'unclassified' && t.status !== 'ignored').length;

  const openReviewItems = db.select({ id: reviewItems.id }).from(reviewItems)
    .where(and(eq(reviewItems.companyId, company.id), eq(reviewItems.status, 'open'))).all().length;

  const deadlines = db.select().from(taxDeadlines)
    .where(and(
      eq(taxDeadlines.companyId, company.id),
      ne(taxDeadlines.status, 'submitted'),
    ))
    .orderBy(taxDeadlines.dueDate).limit(6).all();

  return {
    company,
    bankBalanceMinor: bankAccountBalances.reduce((s, b) => s + b.balanceMinor, 0),
    bankAccounts: bankAccountBalances,
    revenueMinor: pl.revenue.valueMinor,
    expensesMinor: pl.operatingExpenses.valueMinor + pl.costOfSales.valueMinor,
    profitMinor: pl.netProfit.valueMinor,
    vatPositionMinor,
    currentVatPeriod,
    directorsAccountMinor: systemBalances['directors_current_account'] ?? 0,
    debtorsMinor: systemBalances['debtors'] ?? 0,
    creditorsMinor: systemBalances['creditors'] ?? 0,
    health: {
      transactionsTotal: transactions.length,
      unclassified,
      unmatched: missingDocuments,
      missingDocuments,
      duplicateWarnings: duplicates,
      documentsTotal: documentRows.length,
      documentsMatched,
      documentCoveragePercent: documentRows.length === 0
        ? 100 : Math.round((documentsMatched / documentRows.length) * 100),
      vatClassifiedPercent: transactions.length === 0
        ? 100 : Math.round((withTreatment / transactions.length) * 100),
      reconciled: unclassified === 0,
      openReviewItems,
    },
    upcomingDeadlines: deadlines,
    yearStart,
    yearEnd,
  };
}

export interface LedgerFilters {
  status?: string;
  accountId?: string;
  bankAccountId?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

export function ledgerRows(filters: LedgerFilters = {}) {
  const db = getDb();
  const company = requireCompany();

  const conditions = [eq(bankTransactions.companyId, company.id)];
  if (filters.status && filters.status !== 'all') {
    conditions.push(eq(bankTransactions.status, filters.status as 'unclassified'));
  }
  if (filters.accountId) conditions.push(eq(bankTransactions.accountId, filters.accountId));
  if (filters.bankAccountId) conditions.push(eq(bankTransactions.bankAccountId, filters.bankAccountId));
  if (filters.from) conditions.push(sql`${bankTransactions.transactionDate} >= ${filters.from}`);
  if (filters.to) conditions.push(sql`${bankTransactions.transactionDate} <= ${filters.to}`);
  if (filters.search) {
    const needle = `%${filters.search.toLowerCase()}%`;
    conditions.push(sql`(
      LOWER(${bankTransactions.description}) LIKE ${needle}
      OR LOWER(COALESCE(${bankTransactions.bankReference}, '')) LIKE ${needle}
      OR LOWER(COALESCE(${bankTransactions.counterpartyName}, '')) LIKE ${needle}
    )`);
  }

  return db.select({
    transaction: bankTransactions,
    accountCode: accounts.code,
    accountName: accounts.name,
    treatmentCode: vatTreatments.code,
    treatmentName: vatTreatments.name,
    supplierName: suppliers.name,
    customerName: customers.name,
    documentId: documents.id,
    documentName: documents.originalFilename,
    vatMinor: sql<number | null>`(
      SELECT SUM(ve.base_vat_minor) FROM vat_entries ve
      WHERE ve.source_id = ${bankTransactions.id}
        AND ve.source_type = 'bank_transaction'
        AND ve.is_reverse_charge_leg = 0
    )`,
  })
    .from(bankTransactions)
    .leftJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .leftJoin(vatTreatments, eq(bankTransactions.vatTreatmentId, vatTreatments.id))
    .leftJoin(suppliers, eq(bankTransactions.supplierId, suppliers.id))
    .leftJoin(customers, eq(bankTransactions.customerId, customers.id))
    .leftJoin(documents, eq(documents.matchedTransactionId, bankTransactions.id))
    .where(and(...conditions))
    .orderBy(desc(bankTransactions.transactionDate), desc(bankTransactions.createdAt))
    .limit(filters.limit ?? 500)
    .all();
}

export function transactionDetail(transactionId: string) {
  const db = getDb();
  const company = requireCompany();

  const transaction = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.id, transactionId),
      eq(bankTransactions.companyId, company.id),
    )).get();
  if (!transaction) return null;

  const account = transaction.accountId
    ? db.select().from(accounts).where(eq(accounts.id, transaction.accountId)).get() : undefined;
  const treatment = transaction.vatTreatmentId
    ? db.select().from(vatTreatments).where(eq(vatTreatments.id, transaction.vatTreatmentId)).get()
    : undefined;
  const supplier = transaction.supplierId
    ? db.select().from(suppliers).where(eq(suppliers.id, transaction.supplierId)).get() : undefined;
  const customer = transaction.customerId
    ? db.select().from(customers).where(eq(customers.id, transaction.customerId)).get() : undefined;

  const entry = transaction.journalEntryId
    ? db.select().from(journalEntries).where(eq(journalEntries.id, transaction.journalEntryId)).get()
    : undefined;

  const lines = entry
    ? db.select({ line: journalLines, accountCode: accounts.code, accountName: accounts.name })
        .from(journalLines)
        .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
        .where(eq(journalLines.journalEntryId, entry.id))
        .orderBy(journalLines.lineNumber).all()
    : [];

  const vatRows = db.select({
    entry: sql`v.*`, treatmentName: sql<string>`t.name`, treatmentCode: sql<string>`t.code`,
  }).from(sql`vat_entries v`)
    .innerJoin(sql`vat_treatments t`, sql`t.id = v.vat_treatment_id`)
    .where(sql`v.source_id = ${transactionId} AND v.source_type = 'bank_transaction'`)
    .all() as unknown as Array<Record<string, unknown>>;

  const matchedDocument = db.select().from(documents)
    .where(eq(documents.matchedTransactionId, transactionId)).get();

  const candidates = db.select({ match: documentMatches, documentName: documents.originalFilename })
    .from(documentMatches)
    .innerJoin(documents, eq(documentMatches.documentId, documents.id))
    .where(eq(documentMatches.bankTransactionId, transactionId))
    .orderBy(desc(documentMatches.score)).all();

  const audit = db.select().from(auditEvents)
    .where(and(
      eq(auditEvents.entityType, 'bank_transaction'),
      eq(auditEvents.entityId, transactionId),
    )).orderBy(desc(auditEvents.occurredAt)).all();

  const bankAccount = db.select().from(bankAccounts)
    .where(eq(bankAccounts.id, transaction.bankAccountId)).get();

  const statementImport = transaction.statementImportId
    ? db.select().from(statementImports)
        .where(eq(statementImports.id, transaction.statementImportId)).get()
    : undefined;

  return {
    transaction, account, treatment, supplier, customer, entry, lines,
    vatEntries: vatRows, matchedDocument, candidates, audit, bankAccount, statementImport,
    company,
  };
}

export function reviewQueue() {
  const db = getDb();
  const company = requireCompany();
  const items = db.select().from(reviewItems)
    .where(and(eq(reviewItems.companyId, company.id), eq(reviewItems.status, 'open')))
    .orderBy(reviewItems.severity, desc(reviewItems.createdAt)).all();

  const order: Record<string, number> = { blocking: 0, error: 1, warning: 2, info: 3 };
  return items.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
}

export function vatPeriodList() {
  const db = getDb();
  const company = requireCompany();
  return vatPositionSummary(db, company.id);
}

export function vatPeriodDetail(periodId: string) {
  const db = getDb();
  const company = requireCompany();
  const period = db.select().from(vatPeriods)
    .where(and(eq(vatPeriods.id, periodId), eq(vatPeriods.companyId, company.id))).get();
  if (!period) return null;

  return {
    period,
    report: buildVat3Return(db, { companyId: company.id, vatPeriodId: periodId }),
    validation: validateVatPeriod(db, { companyId: company.id, vatPeriodId: periodId }),
    company,
  };
}

export function documentList(filters: { status?: string; review?: string; search?: string } = {}) {
  const db = getDb();
  const company = requireCompany();

  const conditions = [
    eq(documents.companyId, company.id),
    eq(documents.archived, false),
  ];
  if (filters.status && filters.status !== 'all') {
    conditions.push(eq(documents.matchStatus, filters.status as 'matched'));
  }
  if (filters.review && ['unreviewed', 'confirmed', 'rejected'].includes(filters.review)) {
    conditions.push(eq(documents.reviewStatus, filters.review as 'confirmed'));
  }
  if (filters.search) {
    const needle = `%${filters.search.toLowerCase()}%`;
    conditions.push(sql`(
      LOWER(${documents.originalFilename}) LIKE ${needle}
      OR LOWER(COALESCE(${documents.invoiceNumber}, '')) LIKE ${needle}
    )`);
  }

  return db.select({
    document: documents,
    supplierName: suppliers.name,
    transactionDescription: bankTransactions.description,
  })
    .from(documents)
    .leftJoin(suppliers, eq(documents.supplierId, suppliers.id))
    .leftJoin(bankTransactions, eq(documents.matchedTransactionId, bankTransactions.id))
    .where(and(...conditions))
    .orderBy(desc(documents.uploadedAt)).limit(300).all();
}

export function chartOfAccounts() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(accounts)
    .where(eq(accounts.companyId, company.id))
    .orderBy(accounts.code).all();
}

export function taxRateList() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(taxRates)
    .where(eq(taxRates.companyId, company.id))
    .orderBy(taxRates.taxType, desc(taxRates.effectiveFrom)).all();
}

export function vatTreatmentList() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(vatTreatments)
    .where(eq(vatTreatments.companyId, company.id))
    .orderBy(vatTreatments.jurisdiction, vatTreatments.code).all();
}

export function ruleList() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(rules)
    .where(eq(rules.companyId, company.id))
    .orderBy(rules.priority).all();
}

export function supplierList() {
  const db = getDb();
  const company = requireCompany();
  return db.select({
    supplier: suppliers,
    accountName: accounts.name,
    treatmentName: vatTreatments.name,
    transactionCount: sql<number>`(
      SELECT COUNT(*) FROM bank_transactions bt WHERE bt.supplier_id = ${suppliers.id}
    )`,
    totalMinor: sql<number>`(
      SELECT COALESCE(SUM(ABS(bt.amount_minor)), 0) FROM bank_transactions bt
      WHERE bt.supplier_id = ${suppliers.id}
    )`,
  })
    .from(suppliers)
    .leftJoin(accounts, eq(suppliers.defaultAccountId, accounts.id))
    .leftJoin(vatTreatments, eq(suppliers.defaultVatTreatmentId, vatTreatments.id))
    .where(eq(suppliers.companyId, company.id))
    .orderBy(suppliers.name).all();
}

export function customerList() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(customers)
    .where(eq(customers.companyId, company.id)).orderBy(customers.name).all();
}

export function officerList() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(companyOfficers)
    .where(eq(companyOfficers.companyId, company.id)).orderBy(companyOfficers.role).all();
}

export function bankAccountList() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(bankAccounts)
    .where(eq(bankAccounts.companyId, company.id)).orderBy(bankAccounts.bankName).all();
}

/**
 * Documents not yet linked to a transaction, for the manual-link picker on the
 * transaction page. Only unmatched, non-archived documents are offered — the
 * user is deciding which document evidences this payment.
 */
export function unmatchedDocumentOptions() {
  const db = getDb();
  const company = requireCompany();
  const rows = db.select().from(documents)
    .where(and(
      eq(documents.companyId, company.id),
      eq(documents.archived, false),
      isNull(documents.matchedTransactionId),
    ))
    .orderBy(desc(documents.uploadedAt)).limit(200).all();
  return rows.map((d) => ({
    value: d.id,
    label: [
      d.originalFilename,
      d.invoiceNumber ? `#${d.invoiceNumber}` : '',
      d.documentDate ? `(${d.documentDate})` : '',
    ].filter(Boolean).join(' '),
  }));
}

/**
 * Bank transactions not yet posted, for the manual-link picker on the document
 * page and the payment form. A posted transaction is already accounted for, so
 * linking it would record the same money twice.
 */
export function unpostedTransactionOptions(bankAccountId?: string) {
  const db = getDb();
  const company = requireCompany();
  const conditions = [
    eq(bankTransactions.companyId, company.id),
    ne(bankTransactions.status, 'ignored'),
    ne(bankTransactions.status, 'duplicate'),
    isNull(bankTransactions.journalEntryId),
    sql`NOT EXISTS (
      SELECT 1 FROM ${payments} p WHERE p.bank_transaction_id = ${bankTransactions.id}
    )`,
  ];
  if (bankAccountId) conditions.push(eq(bankTransactions.bankAccountId, bankAccountId));
  const rows = db.select().from(bankTransactions)
    .where(and(...conditions))
    .orderBy(desc(bankTransactions.transactionDate)).limit(200).all();
  return rows.map((t) => ({
    value: t.id,
    label: `${t.transactionDate} · ${t.description} · ${money(t.amountMinor, t.currency)}`,
    currency: t.currency,
  }));
}

export function fixedAssetList() {
  const db = getDb();
  const company = requireCompany();
  return db.select({ asset: fixedAssets, supplierName: suppliers.name })
    .from(fixedAssets)
    .leftJoin(suppliers, eq(fixedAssets.supplierId, suppliers.id))
    .where(eq(fixedAssets.companyId, company.id))
    .orderBy(desc(fixedAssets.purchaseDate)).all();
}

export function deadlineList() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(taxDeadlines)
    .where(eq(taxDeadlines.companyId, company.id))
    .orderBy(taxDeadlines.dueDate).all();
}

export function reportsData(from: IsoDate, to: IsoDate, yearStart: IsoDate) {
  const db = getDb();
  const company = requireCompany();
  return {
    company,
    profitAndLoss: profitAndLoss(db, { companyId: company.id, from, to }),
    balanceSheet: balanceSheet(db, {
      companyId: company.id, asOf: to, financialYearStart: yearStart,
    }),
    trialBalance: trialBalance(db, {
      companyId: company.id, asOf: to, baseCurrency: company.baseCurrency,
    }),
  };
}

export function auditTrail(limit = 200) {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(auditEvents)
    .where(eq(auditEvents.companyId, company.id))
    .orderBy(desc(auditEvents.occurredAt)).limit(limit).all();
}

/**
 * VAT treatments with the rate that applied on a given date.
 *
 * Resolved here rather than in the browser, so the rate always comes from the
 * effective-dated configuration table. A transaction dated before a rate change
 * therefore previews at the rate that was in force when it happened.
 */
export function treatmentsWithRates(onDate: IsoDate) {
  const db = getDb();
  const company = requireCompany();

  const rows = db.select({
    treatment: vatTreatments,
    rateBasisPoints: taxRates.rateBasisPoints,
  })
    .from(vatTreatments)
    .leftJoin(taxRates, eq(vatTreatments.defaultTaxRateId, taxRates.id))
    .where(and(
      eq(vatTreatments.companyId, company.id),
      eq(vatTreatments.active, true),
      sql`${vatTreatments.effectiveFrom} <= ${onDate}`,
      sql`(${vatTreatments.effectiveTo} IS NULL OR ${vatTreatments.effectiveTo} >= ${onDate})`,
    ))
    .orderBy(vatTreatments.jurisdiction, vatTreatments.code)
    .all();

  return rows.map(({ treatment, rateBasisPoints }) => {
    // Where the treatment's own rate row has been superseded, find the row for
    // the same code whose effective window contains the date.
    let resolved = rateBasisPoints ?? 0;
    if (treatment.appliesRate && treatment.defaultTaxRateId) {
      const current = db.select({ code: taxRates.code, bp: taxRates.rateBasisPoints,
                                  from: taxRates.effectiveFrom, to: taxRates.effectiveTo })
        .from(taxRates).where(eq(taxRates.id, treatment.defaultTaxRateId)).get();
      if (current && (current.from > onDate || (current.to !== null && current.to < onDate))) {
        const historical = db.select({ bp: taxRates.rateBasisPoints }).from(taxRates)
          .where(and(
            eq(taxRates.companyId, company.id),
            eq(taxRates.code, current.code),
            sql`${taxRates.effectiveFrom} <= ${onDate}`,
            sql`(${taxRates.effectiveTo} IS NULL OR ${taxRates.effectiveTo} >= ${onDate})`,
          )).orderBy(desc(taxRates.effectiveFrom)).get();
        resolved = historical?.bp ?? 0;
      }
    }

    return {
      id: treatment.id,
      code: treatment.code,
      name: treatment.name,
      description: treatment.description,
      isReverseCharge: treatment.isReverseCharge,
      rateBasisPoints: treatment.appliesRate ? resolved : 0,
    };
  });
}

/** One document with its extraction history and match candidates. */
export function documentDetail(documentId: string) {
  const db = getDb();
  const company = requireCompany();

  const document = db.select().from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, company.id))).get();
  if (!document) return null;

  const supplier = document.supplierId
    ? db.select().from(suppliers).where(eq(suppliers.id, document.supplierId)).get() : undefined;

  const extractions = db.select().from(documentExtractions)
    .where(eq(documentExtractions.documentId, documentId))
    .orderBy(desc(documentExtractions.createdAt)).all();

  const matches = db.select({ match: documentMatches, description: bankTransactions.description,
                              amountMinor: bankTransactions.amountMinor,
                              transactionDate: bankTransactions.transactionDate,
                              currency: bankTransactions.currency })
    .from(documentMatches)
    .leftJoin(bankTransactions, eq(documentMatches.bankTransactionId, bankTransactions.id))
    .where(eq(documentMatches.documentId, documentId))
    .orderBy(desc(documentMatches.score)).all();

  const matchedTransaction = document.matchedTransactionId
    ? db.select().from(bankTransactions)
        .where(eq(bankTransactions.id, document.matchedTransactionId)).get()
    : undefined;

  const audit = db.select().from(auditEvents)
    .where(and(eq(auditEvents.entityType, 'document'), eq(auditEvents.entityId, documentId)))
    .orderBy(desc(auditEvents.occurredAt)).all();

  const duplicateOf = document.isDuplicateOf
    ? db.select().from(documents).where(eq(documents.id, document.isDuplicateOf)).get()
    : undefined;

  const review = documentReviewValues(db, { companyId: company.id, documentId });
  // Open review items about this document, other than "please confirm it":
  // what the reader noticed (unreadable image, VAT numbers ambiguous, duplicate).
  const openItems = db.select({ title: reviewItems.title, detail: reviewItems.detail, dedupeKey: reviewItems.dedupeKey })
    .from(reviewItems)
    .where(and(
      eq(reviewItems.companyId, company.id), eq(reviewItems.entityType, 'document'),
      eq(reviewItems.entityId, documentId), eq(reviewItems.status, 'open'),
    )).all()
    .filter((i) => i.dedupeKey !== `document:${documentId}:awaiting_confirmation`)
    .map((i) => (i.detail ? `${i.title}: ${i.detail}` : i.title));
  const supplierOptions = db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers)
    .where(eq(suppliers.companyId, company.id)).orderBy(suppliers.name).all();
  const customerOptions = db.select({ id: customers.id, name: customers.name }).from(customers)
    .where(eq(customers.companyId, company.id)).orderBy(customers.name).all();

  return {
    document, supplier, extractions, matches, matchedTransaction, audit, duplicateOf, company,
    review, supplierOptions, customerOptions, openItems,
  };
}

/** Raw VAT period rows, for the screen that edits their dates. */
export function vatPeriodRows() {
  const db = getDb();
  const company = requireCompany();
  return db.select().from(vatPeriods)
    .where(eq(vatPeriods.companyId, company.id))
    .orderBy(desc(vatPeriods.startDate)).all();
}

/** Every manual adjustment, newest first (README §31). */
export function adjustmentList() {
  const company = requireCompany();
  return listAdjustments(getDb(), { companyId: company.id });
}

/** Invoices with their party name resolved, for the invoice listing. */
export function invoiceList(direction: 'sales' | 'purchase') {
  const db = getDb();
  const company = requireCompany();
  return db.select({
    invoice: invoices,
    supplierName: suppliers.name,
    customerName: customers.name,
  })
    .from(invoices)
    .leftJoin(suppliers, eq(invoices.supplierId, suppliers.id))
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(
      eq(invoices.companyId, company.id),
      eq(invoices.direction, direction),
    ))
    .orderBy(desc(invoices.invoiceDate)).all();
}

/** Aged debtors or creditors as at a date (README §26). */
export function aged(direction: 'sales' | 'purchase', asOf: IsoDate = today()) {
  const company = requireCompany();
  return agedAnalysis(getDb(), { companyId: company.id, direction, asOf });
}

/** A reconciliation as it stands right now, recomputed on every view. */
export function reconciliation(
  bankAccountId: string, periodStart: IsoDate, periodEnd: IsoDate,
) {
  const company = requireCompany();
  return reconcileBankAccount(getDb(), {
    companyId: company.id, bankAccountId, periodStart, periodEnd,
  });
}

/** Past reconciliations, for the record of what was signed off and when. */
export function pastReconciliations() {
  const company = requireCompany();
  return reconciliationHistory(getDb(), company.id);
}

/** Global search across every entity type (README §36). */
export function searchEverything(query: string, limit?: number) {
  const company = requireCompany();
  return search(getDb(), { companyId: company.id, query, limit });
}

/** One invoice with its lines, payments and party, for the invoice screen. */
export function invoiceDetail(invoiceId: string) {
  const db = getDb();
  const company = requireCompany();

  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, company.id))).get();
  if (!invoice) return null;

  const lines = db.select({
    line: invoiceLines,
    accountCode: accounts.code,
    accountName: accounts.name,
    treatmentName: vatTreatments.name,
    treatmentCode: vatTreatments.code,
  })
    .from(invoiceLines)
    .leftJoin(accounts, eq(invoiceLines.accountId, accounts.id))
    .leftJoin(vatTreatments, eq(invoiceLines.vatTreatmentId, vatTreatments.id))
    .where(eq(invoiceLines.invoiceId, invoiceId))
    .orderBy(invoiceLines.lineNumber).all();

  const allocations = db.select({ allocation: paymentAllocations, payment: payments })
    .from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(eq(paymentAllocations.invoiceId, invoiceId))
    .orderBy(payments.paymentDate).all();

  const party = invoice.supplierId
    ? db.select().from(suppliers).where(eq(suppliers.id, invoice.supplierId)).get()
    : invoice.customerId
      ? db.select().from(customers).where(eq(customers.id, invoice.customerId)).get()
      : undefined;

  return { invoice, lines, allocations, party, company };
}

/** One supplier with everything recorded against them (README §17). */
export function supplierDetail(supplierId: string) {
  const db = getDb();
  const company = requireCompany();

  const supplier = db.select().from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.companyId, company.id))).get();
  if (!supplier) return null;

  const transactions = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.companyId, company.id),
      eq(bankTransactions.supplierId, supplierId),
    ))
    .orderBy(desc(bankTransactions.transactionDate)).all();

  const supplierInvoices = db.select().from(invoices)
    .where(and(eq(invoices.companyId, company.id), eq(invoices.supplierId, supplierId)))
    .orderBy(desc(invoices.invoiceDate)).all();

  const supplierDocuments = db.select().from(documents)
    .where(and(eq(documents.companyId, company.id), eq(documents.supplierId, supplierId)))
    .orderBy(desc(documents.documentDate)).all();

  return { supplier, transactions, invoices: supplierInvoices, documents: supplierDocuments };
}

/** Statutory VAT treatment suggestion for one transaction (issue #200). */
export function statutoryVatSuggestion(transactionId: string) {
  return suggestVatTreatment(getDb(), { companyId: requireCompany().id, bankTransactionId: transactionId });
}

/** One provision, its source, the rules that cite it, and the source file re-checked (issue #200). */
export function provisionDetail(provisionId: string) {
  const db = getDb();
  const company = requireCompany();
  const row = db.select({ provision: irishActProvisions, source: irishKnowledgeSources })
    .from(irishActProvisions)
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(eq(irishActProvisions.id, provisionId)).get();
  if (!row) return null;
  const rulesCiting = db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.provisionId, provisionId), eq(irishTaxRules.companyId, company.id)))
    .all();
  return { ...row, rulesCiting, file: verifyStatuteFile(row.source.localPath, row.source.sha256,
    row.provision.sourceStart, row.provision.sourceEnd) };
}

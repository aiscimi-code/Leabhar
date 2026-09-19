import { and, eq, gte, lte, sql, ne, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, suppliers, documents, invoices, invoiceLines, vatEntries,
  journalLines, journalEntries, accounts, companies, fixedAssets,
} from '@/db/schema';
import { accountBalance } from '../accounting/ledger';
import { systemAccountId } from '../config/setup';
import { upsertReviewItem } from '../extraction/service';
import { normaliseDescription } from '../banking/fingerprint';
import { daysBetween, asIsoDate, today, type IsoDate } from '../dates';

/**
 * Anomaly detection (README §19, §44).
 *
 * Every check here is deterministic and arithmetic. None of it involves a
 * model, because an anomaly report a user cannot verify is worse than no
 * anomaly report: they either trust it blindly or ignore it entirely.
 *
 * Each finding says what is unusual, why that matters, and what would resolve
 * it. "Unusual" is never presented as "wrong" — a supplier genuinely can bill
 * ten times their usual amount — so the wording asks rather than asserts.
 */

export interface Anomaly {
  code: string;
  severity: 'warning' | 'info';
  title: string;
  detail: string;
  entityType: 'bank_transaction' | 'invoice' | 'document' | 'vat_entry' | 'account' | 'fixed_asset';
  entityId: string;
  /** What the user can do about it. */
  suggestion: string;
  dedupeKey: string;
}

export interface AnomalyScan {
  anomalies: Anomaly[];
  checked: {
    transactions: number;
    invoices: number;
    documents: number;
    vatEntries: number;
  };
  summary: string;
}

export function scanForAnomalies(
  db: AppDatabase,
  params: { companyId: string; from?: IsoDate; to?: IsoDate },
): AnomalyScan {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);

  const conditions = [eq(bankTransactions.companyId, params.companyId)];
  if (params.from) conditions.push(gte(bankTransactions.transactionDate, params.from));
  if (params.to) conditions.push(lte(bankTransactions.transactionDate, params.to));

  const transactions = db.select().from(bankTransactions).where(and(...conditions)).all();
  const invoiceRows = db.select().from(invoices)
    .where(eq(invoices.companyId, params.companyId)).all();
  const invoiceLineRows = db.select().from(invoiceLines)
    .where(eq(invoiceLines.companyId, params.companyId)).all();
  const documentRows = db.select().from(documents)
    .where(and(eq(documents.companyId, params.companyId), eq(documents.archived, false))).all();
  const vatRows = db.select().from(vatEntries)
    .where(eq(vatEntries.companyId, params.companyId)).all();

  const anomalies: Anomaly[] = [
    ...unusualSupplierAmounts(db, params.companyId, transactions),
    ...documentAmountMismatches(db, documentRows),
    ...roundNumberLargePayments(transactions),
    ...vatArithmeticFailures(vatRows),
    ...impossibleRecovery(vatRows),
    ...duplicateInvoiceNumbers(invoiceRows),
    ...nearDuplicatePurchaseInvoices(invoiceRows),
    ...hospitalityRateMismatches(invoiceRows, invoiceLineRows),
    ...possibleNonTradingPurchases(invoiceRows, invoiceLineRows),
    ...suspenseBalance(db, params.companyId),
    ...directorDebitBalance(db, params.companyId),
    ...unusedCapitalPurchases(db, params.companyId, transactions),
    ...staleUnpaidInvoices(invoiceRows),
  ];

  return {
    anomalies,
    checked: {
      transactions: transactions.length,
      invoices: invoiceRows.length,
      documents: documentRows.length,
      vatEntries: vatRows.length,
    },
    summary: anomalies.length === 0
      ? 'Nothing unusual found. These are arithmetic checks over your own data, not a '
        + 'judgement about whether the figures are right.'
      : `${anomalies.length} thing${anomalies.length === 1 ? '' : 's'} worth a look. None of `
        + 'them is necessarily wrong — each is something that is unusual enough to be '
        + 'worth confirming.',
  };
}

/**
 * A payment far outside a supplier's usual range.
 *
 * Uses the median rather than the mean, and requires at least four prior
 * payments. A mean is dragged around by the very outlier being looked for, and
 * with two or three data points almost anything looks anomalous — which trains
 * the user to dismiss the queue.
 */
function unusualSupplierAmounts(
  db: AppDatabase, companyId: string,
  transactions: Array<typeof bankTransactions.$inferSelect>,
): Anomaly[] {
  const bySupplier = new Map<string, Array<typeof bankTransactions.$inferSelect>>();
  for (const transaction of transactions) {
    if (!transaction.supplierId || transaction.amountMinor >= 0) continue;
    const group = bySupplier.get(transaction.supplierId) ?? [];
    group.push(transaction);
    bySupplier.set(transaction.supplierId, group);
  }

  const anomalies: Anomaly[] = [];

  for (const [supplierId, group] of bySupplier) {
    if (group.length < 5) continue;
    const supplier = db.select({ name: suppliers.name }).from(suppliers)
      .where(eq(suppliers.id, supplierId)).get();

    const amounts = group.map((t) => Math.abs(t.amountMinor)).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)]!;
    if (median === 0) continue;

    for (const transaction of group) {
      const amount = Math.abs(transaction.amountMinor);
      const ratio = amount / median;
      if (ratio < 4 && ratio > 0.25) continue;
      // Ignore small absolute differences: 4x a EUR 2 charge is not news.
      if (Math.abs(amount - median) < 5_000) continue;

      anomalies.push({
        code: 'unusual_supplier_amount',
        severity: 'warning',
        title: `${supplier?.name ?? 'This supplier'} charged an unusual amount`,
        detail: `${(amount / 100).toFixed(2)} against a usual ${(median / 100).toFixed(2)} `
          + `across ${group.length} payments — about ${ratio >= 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)} `
          + `times ${ratio >= 1 ? 'higher' : 'lower'} than normal.`,
        entityType: 'bank_transaction',
        entityId: transaction.id,
        suggestion: 'Check it against the invoice. An annual charge, a price rise or a '
          + 'one-off purchase would all explain it; a duplicated payment or a misread amount '
          + 'would not.',
        dedupeKey: `anomaly:unusual_amount:${transaction.id}`,
      });
    }
  }

  return anomalies;
}

/** A document whose total disagrees with the transaction it is matched to. */
function documentAmountMismatches(
  db: AppDatabase, documentRows: Array<typeof documents.$inferSelect>,
): Anomaly[] {
  const anomalies: Anomaly[] = [];

  for (const document of documentRows) {
    if (!document.matchedTransactionId || document.grossMinor === null) continue;
    const transaction = db.select().from(bankTransactions)
      .where(eq(bankTransactions.id, document.matchedTransactionId)).get();
    if (!transaction) continue;

    const difference = Math.abs(document.grossMinor) - Math.abs(transaction.amountMinor);
    if (difference === 0) continue;
    if (Math.abs(difference) < 100) continue;

    const sameCurrency = (document.currency ?? transaction.currency) === transaction.currency;

    anomalies.push({
      code: 'document_amount_mismatch',
      severity: 'warning',
      title: `"${document.originalFilename}" does not agree with the payment it is attached to`,
      detail: `The document says ${(Math.abs(document.grossMinor) / 100).toFixed(2)} and the `
        + `bank says ${(Math.abs(transaction.amountMinor) / 100).toFixed(2)}, a difference of `
        + `${(Math.abs(difference) / 100).toFixed(2)}.`,
      entityType: 'document',
      entityId: document.id,
      suggestion: sameCurrency
        ? 'Either the document is attached to the wrong payment, or the amount was read '
          + 'wrongly. Check the document and correct whichever is wrong.'
        : 'The currencies differ, so this may be an exchange difference rather than an error. '
          + 'Record the rate used rather than leaving the difference unexplained.',
      dedupeKey: `anomaly:doc_mismatch:${document.id}`,
    });
  }

  return anomalies;
}

/**
 * Large round-number payments.
 *
 * Informational only. Round numbers are perfectly normal for transfers and
 * salaries, but an exactly-round supplier payment is worth a glance because it
 * is also what a mistyped amount looks like.
 */
function roundNumberLargePayments(
  transactions: Array<typeof bankTransactions.$inferSelect>,
): Anomaly[] {
  return transactions
    .filter((t) => t.amountMinor < 0
      && Math.abs(t.amountMinor) >= 500_000
      && Math.abs(t.amountMinor) % 100_000 === 0
      && t.supplierId !== null)
    .map((t) => ({
      code: 'round_number_payment',
      severity: 'info' as const,
      title: 'Large round-number payment',
      detail: `${(Math.abs(t.amountMinor) / 100).toFixed(2)} is an exactly round amount.`,
      entityType: 'bank_transaction' as const,
      entityId: t.id,
      suggestion: 'Round amounts are normal for transfers and salaries. For a supplier '
        + 'payment it is worth confirming against the invoice, because a mistyped amount '
        + 'often looks like this too.',
      dedupeKey: `anomaly:round:${t.id}`,
    }));
}

/** VAT entries whose own arithmetic does not hold. */
function vatArithmeticFailures(
  vatRows: Array<typeof vatEntries.$inferSelect>,
): Anomaly[] {
  return vatRows
    .filter((entry) => {
      // A reverse-charge entry's gross equals its net by construction.
      if (entry.grossMinor === entry.netMinor) return false;
      return entry.netMinor + entry.vatMinor !== entry.grossMinor;
    })
    .map((entry) => ({
      code: 'vat_arithmetic',
      severity: 'warning' as const,
      title: 'A VAT entry does not add up',
      detail: `Net ${(entry.netMinor / 100).toFixed(2)} plus VAT `
        + `${(entry.vatMinor / 100).toFixed(2)} is `
        + `${((entry.netMinor + entry.vatMinor) / 100).toFixed(2)}, but the gross is recorded `
        + `as ${(entry.grossMinor / 100).toFixed(2)}.`,
      entityType: 'vat_entry' as const,
      entityId: entry.id,
      suggestion: 'Reclassify the transaction this came from. A VAT entry that does not add '
        + 'up will carry into your VAT return.',
      dedupeKey: `anomaly:vat_arithmetic:${entry.id}`,
    }));
}

/** More VAT being reclaimed than was ever charged. */
function impossibleRecovery(vatRows: Array<typeof vatEntries.$inferSelect>): Anomaly[] {
  return vatRows
    .filter((entry) => Math.abs(entry.recoverableVatMinor) > Math.abs(entry.vatMinor))
    .map((entry) => ({
      code: 'impossible_recovery',
      severity: 'warning' as const,
      title: 'More VAT is being reclaimed than was charged',
      detail: `Reclaiming ${(entry.recoverableVatMinor / 100).toFixed(2)} against VAT of `
        + `${(entry.vatMinor / 100).toFixed(2)}.`,
      entityType: 'vat_entry' as const,
      entityId: entry.id,
      suggestion: 'This cannot be right. Reclassify the transaction and check the VAT '
        + 'treatment’s recoverable percentage.',
      dedupeKey: `anomaly:recovery:${entry.id}`,
    }));
}

/** The same supplier invoice number appearing twice. */
function duplicateInvoiceNumbers(
  invoiceRows: Array<typeof invoices.$inferSelect>,
): Anomaly[] {
  const seen = new Map<string, Array<typeof invoices.$inferSelect>>();

  for (const invoice of invoiceRows) {
    if (!invoice.invoiceNumber || invoice.status === 'void') continue;
    const key = `${invoice.direction}|${invoice.supplierId ?? invoice.customerId ?? ''}`
      + `|${normaliseDescription(invoice.invoiceNumber)}`;
    const group = seen.get(key) ?? [];
    group.push(invoice);
    seen.set(key, group);
  }

  const anomalies: Anomaly[] = [];
  for (const group of seen.values()) {
    if (group.length < 2) continue;
    for (const invoice of group) {
      anomalies.push({
        code: 'duplicate_invoice_number',
        severity: 'warning',
        title: `Invoice number ${invoice.invoiceNumber} appears ${group.length} times`,
        detail: 'The same party and the same invoice number on more than one invoice.',
        entityType: 'invoice',
        entityId: invoice.id,
        suggestion: 'Check whether the same invoice has been entered twice. A duplicated '
          + 'purchase invoice would claim the cost and the VAT twice over.',
        dedupeKey: `anomaly:dup_invoice:${invoice.id}`,
      });
    }
  }
  return anomalies;
}

/**
 * Two purchase invoices for the same supplier and the same net amount, dated
 * close together but under different invoice numbers (issue #145 defect 2).
 *
 * `duplicateInvoiceNumbers` above catches the same invoice number appearing
 * twice; it cannot catch the same commercial document entered twice under
 * two different numbers, which is exactly the PI-019/PI-027 case the test
 * pack was built to catch. A short window (5 days) is deliberate: a genuine
 * recurring subscription at a flat monthly fee is the same supplier and the
 * same net amount too, but its invoices are a month apart, not days.
 */
function nearDuplicatePurchaseInvoices(
  invoiceRows: Array<typeof invoices.$inferSelect>,
): Anomaly[] {
  const WINDOW_DAYS = 5;
  const groups = new Map<string, Array<typeof invoices.$inferSelect>>();

  for (const invoice of invoiceRows) {
    if (invoice.direction !== 'purchase' || invoice.isCreditNote) continue;
    if (invoice.status === 'void' || !invoice.supplierId) continue;
    const key = `${invoice.supplierId}|${invoice.netMinor}|${invoice.currency}`;
    const group = groups.get(key) ?? [];
    group.push(invoice);
    groups.set(key, group);
  }

  const anomalies: Anomaly[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const invoice of group) {
      const near = group.filter((other) => other.id !== invoice.id
        && Math.abs(daysBetween(asIsoDate(invoice.invoiceDate), asIsoDate(other.invoiceDate))) <= WINDOW_DAYS);
      if (near.length === 0) continue;

      anomalies.push({
        code: 'near_duplicate_purchase_invoice',
        severity: 'warning',
        title: 'Two purchase invoices for the same amount, days apart',
        detail: `${(invoice.netMinor / 100).toFixed(2)} ${invoice.currency} from the same supplier as `
          + `invoice${near.length > 1 ? 's' : ''} ${near.map((n) => n.invoiceNumber ?? n.id).join(', ')}, `
          + `dated within ${WINDOW_DAYS} days of each other.`,
        entityType: 'invoice',
        entityId: invoice.id,
        suggestion: 'Check whether this is the same commercial document entered twice under a '
          + 'different invoice number. A duplicated purchase invoice would claim the cost and '
          + 'the VAT twice over.',
        dedupeKey: `anomaly:near_dup_invoice:${invoice.id}`,
      });
    }
  }
  return anomalies;
}

/**
 * A purchase line whose own description suggests a reduced-rate hospitality
 * supply, but which was posted at the standard rate (issue #145 defect 4).
 *
 * `lookupTransactionRules` already knows the restaurant/catering reduced
 * rate (`vatcaRevisedCuration.ts`'s `vat.rate_restaurant_catering_reduced_current`);
 * this mirrors its keyword test rather than importing it, because the two
 * ask different questions — the lookup proposes a treatment for a
 * transaction that has not been posted yet, this flags an invoice that
 * already has been. Neither determines the correct rate: an invoice that
 * bundles a room hire with the meal, for instance, may genuinely be 23% on
 * part of the bill. It only says the description and the rate disagree
 * often enough to be worth a look.
 */
const HOSPITALITY_KEYWORD_RE = /\b(restaurant|catering|takeaway|take-away|take away|hot food)\b/i;
const STANDARD_RATE_BASIS_POINTS = 2300;

function hospitalityRateMismatches(
  invoiceRows: Array<typeof invoices.$inferSelect>,
  invoiceLineRows: Array<typeof invoiceLines.$inferSelect>,
): Anomaly[] {
  const invoicesById = new Map(invoiceRows.map((i) => [i.id, i]));
  const anomalies: Anomaly[] = [];

  for (const line of invoiceLineRows) {
    const invoice = invoicesById.get(line.invoiceId);
    if (!invoice || invoice.direction !== 'purchase' || invoice.status === 'void') continue;
    if (!HOSPITALITY_KEYWORD_RE.test(line.description)) continue;
    if (line.rateBasisPoints !== STANDARD_RATE_BASIS_POINTS) continue;

    anomalies.push({
      code: 'hospitality_rate_mismatch',
      severity: 'info',
      title: `"${line.description}" was posted at the standard rate`,
      detail: 'The description suggests a restaurant, catering or takeaway supply, which is '
        + 'often reduced-rated, but this line was posted at the 23% standard rate.',
      entityType: 'invoice',
      entityId: invoice.id,
      suggestion: 'Confirm the correct VAT treatment for this line — a reduced hospitality rate '
        + 'may apply, subject to when the supply took place. Note that the section 60 '
        + 'entertainment deduction exclusion is a separate question from the rate charged: even '
        + 'a correctly-rated meal can still be non-deductible.',
      dedupeKey: `anomaly:hospitality_rate:${line.id}`,
    });
  }
  return anomalies;
}

/**
 * A purchase line whose own description reads as a donation or charitable
 * payment (issue #145 defect 5).
 *
 * A donation is not a supply the business received in the course of trade,
 * so posting it as an ordinary zero-rated or standard-rated purchase
 * conflates a non-trading appropriation with turnover. This never changes
 * what was posted — it only asks a human to confirm the classification and,
 * usually, that the VAT (if any) was not treated as deductible.
 */
const DONATION_KEYWORD_RE = /\b(donation|donated|charity|charitable)\b/i;

function possibleNonTradingPurchases(
  invoiceRows: Array<typeof invoices.$inferSelect>,
  invoiceLineRows: Array<typeof invoiceLines.$inferSelect>,
): Anomaly[] {
  const invoicesById = new Map(invoiceRows.map((i) => [i.id, i]));
  const anomalies: Anomaly[] = [];

  for (const line of invoiceLineRows) {
    const invoice = invoicesById.get(line.invoiceId);
    if (!invoice || invoice.direction !== 'purchase' || invoice.status === 'void') continue;
    if (!DONATION_KEYWORD_RE.test(line.description)) continue;

    anomalies.push({
      code: 'possible_donation',
      severity: 'info',
      title: `"${line.description}" reads as a donation, not a purchase`,
      detail: `${(line.grossMinor / 100).toFixed(2)} was posted as an ordinary purchase line, `
        + 'but its description suggests a donation or charitable payment.',
      entityType: 'invoice',
      entityId: invoice.id,
      suggestion: 'A donation is not a trading supply. Confirm whether this should be '
        + 'reclassified as a non-deductible appropriation rather than a purchase, and that any '
        + 'VAT on it was not treated as recoverable.',
      dedupeKey: `anomaly:donation:${line.id}`,
    });
  }
  return anomalies;
}

/** Anything left sitting in suspense. */
function suspenseBalance(db: AppDatabase, companyId: string): Anomaly[] {
  const accountId = systemAccountId(db, companyId, 'suspense');
  const balance = accountBalance(db, { companyId, accountId });
  if (balance === 0) return [];

  return [{
    code: 'suspense_balance',
    severity: 'warning',
    title: 'The suspense account has a balance',
    detail: `${(Math.abs(balance) / 100).toFixed(2)} is sitting in suspense, which means it `
      + 'has not been allocated to a real account.',
    entityType: 'account',
    entityId: accountId,
    suggestion: 'Find what the amount relates to and reclassify it. A suspense balance at '
      + 'period end is an unresolved question, not a result.',
    dedupeKey: `anomaly:suspense:${companyId}`,
  }];
}

/**
 * A director's current account in debit.
 *
 * Flagged, never computed. For a close company a loan to a participator can
 * give rise to an income tax charge and a benefit-in-kind issue, but whether
 * those rules apply depends on facts this application does not hold, and §48
 * forbids inventing Revenue requirements.
 */
function directorDebitBalance(db: AppDatabase, companyId: string): Anomaly[] {
  const accountId = systemAccountId(db, companyId, 'directors_current_account');
  const balance = accountBalance(db, { companyId, accountId });
  if (balance >= 0) return [];

  return [{
    code: 'director_owes_company',
    severity: 'warning',
    title: 'A director owes the company money',
    detail: `The director’s current account is ${(Math.abs(balance) / 100).toFixed(2)} in `
      + 'debit, meaning money has been taken out that was not salary, a dividend, or '
      + 'reimbursement of an expense.',
    entityType: 'account',
    entityId: accountId,
    suggestion: 'For a close company, a loan to a participator can trigger an income tax '
      + 'charge and a benefit-in-kind issue on any interest-free element. This application '
      + 'does not calculate either — raise it with your accountant before the year end, '
      + 'when there is still time to do something about it.',
    dedupeKey: `anomaly:director_debit:${companyId}`,
  }];
}

/** Large purchases expensed rather than capitalised. */
function unusedCapitalPurchases(
  db: AppDatabase, companyId: string,
  transactions: Array<typeof bankTransactions.$inferSelect>,
): Anomaly[] {
  const assetRows = db.select({ invoiceId: fixedAssets.invoiceId, documentId: fixedAssets.documentId })
    .from(fixedAssets).where(eq(fixedAssets.companyId, companyId)).all();
  const linked = new Set([...assetRows.map((a) => a.invoiceId), ...assetRows.map((a) => a.documentId)]);

  return transactions
    .filter((t) => {
      if (t.amountMinor > -100_000) return false;
      if (!t.accountId) return false;
      if (linked.has(t.id)) return false;
      const account = db.select({ type: accounts.type, subtype: accounts.subtype })
        .from(accounts).where(eq(accounts.id, t.accountId)).get();
      return account?.type === 'expense' && account.subtype === 'operating_expense';
    })
    .map((t) => ({
      code: 'possible_capital_purchase',
      severity: 'info' as const,
      title: 'A large purchase was charged straight to expenses',
      detail: `${(Math.abs(t.amountMinor) / 100).toFixed(2)} on "${t.description}" went to an `
        + 'operating expense account rather than to the asset register.',
      entityType: 'bank_transaction' as const,
      entityId: t.id,
      suggestion: 'If this is equipment the company will use for several years, it probably '
        + 'belongs on the balance sheet with depreciation and capital allowances, not in this '
        + 'year’s expenses. This application flags it rather than deciding.',
      dedupeKey: `anomaly:capital:${t.id}`,
    }));
}

/** Sales invoices long overdue. */
function staleUnpaidInvoices(
  invoiceRows: Array<typeof invoices.$inferSelect>,
): Anomaly[] {
  const now = today();

  return invoiceRows
    .filter((invoice) => {
      if (invoice.direction !== 'sales') return false;
      if (invoice.outstandingMinor === 0 || invoice.status === 'void') return false;
      const due = invoice.dueDate ?? invoice.invoiceDate;
      return daysBetween(asIsoDate(due), now) > 90;
    })
    .map((invoice) => {
      const due = invoice.dueDate ?? invoice.invoiceDate;
      const days = daysBetween(asIsoDate(due), now);
      return {
        code: 'long_overdue_invoice',
        severity: 'info' as const,
        title: `Invoice ${invoice.invoiceNumber ?? ''} is ${days} days overdue`.trim(),
        detail: `${(invoice.outstandingMinor / 100).toFixed(2)} has been outstanding since `
          + `${due}.`,
        entityType: 'invoice' as const,
        entityId: invoice.id,
        suggestion: 'Chase it, or if it will not be paid, write it off deliberately. An '
          + 'uncollectable debt left on the balance sheet overstates your assets, and on the '
          + 'cash receipts basis it also leaves VAT deferred that will never fall due.',
        dedupeKey: `anomaly:overdue:${invoice.id}`,
      };
    });
}

/** Push the findings into the review queue (README §20). */
export function syncAnomaliesToReviewQueue(
  db: AppDatabase, params: { companyId: string; scan: AnomalyScan },
): number {
  db.transaction((tx) => {
    for (const anomaly of params.scan.anomalies) {
      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: anomalyKind(anomaly.code),
        severity: anomaly.severity,
        title: anomaly.title,
        detail: `${anomaly.detail} ${anomaly.suggestion}`,
        entityType: anomaly.entityType,
        entityId: anomaly.entityId,
        dedupeKey: anomaly.dedupeKey,
        context: { code: anomaly.code, suggestion: anomaly.suggestion },
      });
    }
  });
  return params.scan.anomalies.length;
}

function anomalyKind(code: string): 'suspected_duplicate' | 'currency_discrepancy'
  | 'invoice_total_mismatch' | 'negative_vat' | 'capital_purchase_review'
  | 'uncertain_vat_treatment' | 'other' {
  switch (code) {
    case 'duplicate_invoice_number':
    case 'near_duplicate_purchase_invoice': return 'suspected_duplicate';
    case 'document_amount_mismatch': return 'invoice_total_mismatch';
    case 'vat_arithmetic':
    case 'impossible_recovery': return 'negative_vat';
    case 'possible_capital_purchase': return 'capital_purchase_review';
    case 'hospitality_rate_mismatch': return 'uncertain_vat_treatment';
    default: return 'other';
  }
}

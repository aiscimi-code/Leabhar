import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, accounts, vatTreatments, companies, bankAccounts,
  auditEvents, journalEntries, vatEntries, suppliers, customers, companyOfficers, documents, payments,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, nowIso, type IsoDate } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { postJournalEntry, reverseJournalEntry } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { createVatEntries, resolveTreatment, calculateVat, assertVatPeriodWritable, findVatPeriod } from '../vat/engine';
import { AccountingError } from '../accounting/errors';
import { upsertReviewItem } from '../extraction/service';

export class ClassificationError extends AccountingError {}

export interface ClassifyInput {
  companyId: string;
  bankTransactionId: string;
  accountId: string;
  vatTreatmentId: string;
  taxRateId?: string;
  supplierId?: string | null;
  customerId?: string | null;
  /** When the document states VAT explicitly, pass it rather than recomputing. */
  statedVatMinor?: number;
  /**
   * Declare this line's VAT in the VAT period covering this date, when the
   * transaction's own period is locked or filed (issue #226). Flagged for review.
   */
  vatDeclarationDate?: IsoDate | null;
  /** Required when the bank account is not in the company's base currency. */
  fxRate?: { numerator: number; denominator: number; source: string; date?: string };
  notes?: string | null;
  source?: 'ai' | 'rule' | 'user' | 'import' | 'system' | 'derived';
  confidence?: number;
  provenanceStatus?: 'ai_suggestion' | 'user_confirmed' | 'system_rule' | 'manually_entered';
  appliedRuleId?: string | null;
  actor?: string;
  requestId?: string;
}

export interface ClassifyResult {
  bankTransactionId: string;
  journalEntryId: string;
  entryNumber: number;
  vatEntryIds: string[];
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  posted: boolean;
}

/**
 * Classify a bank transaction and post the accounting entries it implies.
 *
 * README §4 is emphatic that a bank transaction is evidence of money movement,
 * not the accounting entry itself. This function is where the one becomes the
 * other. The imported row is never mutated in its evidential fields — only its
 * classification columns and status change — and the accounting consequence
 * lives in a journal entry and its VAT entries.
 *
 * The amount on the statement is always VAT-inclusive as far as the bank is
 * concerned: it is what left or entered the account. Under a reverse charge
 * that same figure is the NET, because the supplier charged no VAT. The VAT
 * engine handles that distinction; this function's job is to post the result.
 */
export function classifyTransaction(db: AppDatabase, input: ClassifyInput): ClassifyResult {
  const transaction = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.id, input.bankTransactionId),
      eq(bankTransactions.companyId, input.companyId),
    )).get();
  if (!transaction) {
    throw new ClassificationError(`Bank transaction ${input.bankTransactionId} not found.`);
  }

  if (transaction.journalEntryId) {
    throw new ClassificationError(
      'This transaction has already been posted. Reclassify it instead, which reverses '
        + 'the original entry and posts a new one, leaving both in the audit trail.',
      { bankTransactionId: transaction.id, journalEntryId: transaction.journalEntryId },
    );
  }

  // A bank line with a confirmed invoice behind it is posted from the invoice
  // (its lines carry the VAT) and settled by a payment — never classified as
  // if the bank amount itself were the evidence (issue #203).
  const confirmedDocument = db.select({ id: documents.id, name: documents.originalFilename }).from(documents)
    .where(and(
      eq(documents.companyId, input.companyId),
      eq(documents.matchedTransactionId, transaction.id),
      eq(documents.reviewStatus, 'confirmed'),
    )).get();
  if (confirmedDocument) {
    throw new ClassificationError(
      `This payment is matched to the confirmed document "${confirmedDocument.name}". Post that document as `
        + 'an invoice and settle this bank line against it, so the VAT comes from the invoice lines.',
      { bankTransactionId: transaction.id, documentId: confirmedDocument.id },
    );
  }

  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get()!;
  const account = db.select().from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, input.companyId)))
    .get();
  if (!account) throw new ClassificationError(`Account ${input.accountId} not found.`);

  const bankAccount = db.select().from(bankAccounts)
    .where(eq(bankAccounts.id, transaction.bankAccountId)).get()!;

  const transactionDate = asIsoDate(transaction.transactionDate);
  const baseCurrency = company.baseCurrency;
  const currency = transaction.currency;

  // When the statement itself reported the settled base-currency amount, the
  // bank's actual rate is already stored on the transaction. Derive it from the
  // two amounts rather than requiring the user to supply one — the bank's rate
  // is the correct one, and today's ECB rate would give the wrong figure.
  const statementRate = transaction.baseAmountMinor !== null
    && transaction.fxRateSource === 'bank_statement'
    && transaction.fxRateNumerator !== null
    && transaction.fxRateDenominator !== null
    ? {
        numerator: transaction.fxRateNumerator,
        denominator: transaction.fxRateDenominator,
        source: 'bank_statement' as const,
      }
    : undefined;

  if (currency !== baseCurrency && !input.fxRate && !statementRate) {
    throw new ClassificationError(
      `This transaction is in ${currency} but the company's base currency is `
        + `${baseCurrency}, and no exchange rate was supplied. A missing rate is an `
        + 'exception, never an assumed 1.0.',
      { bankTransactionId: transaction.id, currency },
    );
  }

  // A manual rate from the user takes precedence over the statement rate, so a
  // user correction overrides the bank's figure exactly as it overrides a
  // scored suggestion elsewhere.
  const resolvedFxRate = input.fxRate ?? statementRate;

  const resolved = resolveTreatment(db, {
    companyId: input.companyId,
    treatmentId: input.vatTreatmentId,
    onDate: transactionDate,
    rateOverrideId: input.taxRateId,
  });

  // Money out is negative on the statement. The magnitude is what we post.
  const isMoneyOut = transaction.amountMinor < 0;
  const direction = isMoneyOut ? 'purchases' : 'sales';
  const statementAmount = Math.abs(transaction.amountMinor);

  // The invoice is the only proof of input VAT (issue #203). A payment with no
  // confirmed invoice behind it claims none: the whole amount is the cost, no
  // VAT entry is created, and the missing invoice is flagged. VAT is never
  // derived by splitting a bank amount on the purchase side. (Under a reverse
  // charge the net also comes from the invoice, so nothing is self-assessed
  // until the invoice is confirmed and posted — flagged the same way.)
  const withoutInvoice = isMoneyOut && resolved.treatment.appliesRate;
  const calculation = withoutInvoice
    ? {
        netMinor: asMinor(statementAmount), vatMinor: asMinor(0), grossMinor: asMinor(statementAmount),
        recoverableVatMinor: asMinor(0), rateBasisPoints: 0,
      }
    : calculateVat({
        treatment: resolved.treatment,
        rateBasisPoints: resolved.rateBasisPoints,
        direction,
        grossMinor: statementAmount,
        statedVatMinor: input.statedVatMinor,
      });

  const toBase = (amount: number): number =>
    resolvedFxRate ? multiplyRational(asMinor(amount), resolvedFxRate.numerator, resolvedFxRate.denominator) : amount;

  const bankLedgerAccountId = bankAccount.accountId
    ?? systemAccountId(db, input.companyId, 'bank_control');
  const vatOnPurchasesId = systemAccountId(db, input.companyId, 'vat_on_purchases');
  const vatOnSalesId = systemAccountId(db, input.companyId, 'vat_on_sales');

  const fxRate = resolvedFxRate;
  const lineCurrency = currency;

  const lines: Parameters<typeof postJournalEntry>[1]['lines'] = [];
  const narrative = `${transaction.description}`.slice(0, 200);

  if (isMoneyOut) {
    // Expense (or asset) is debited at net; VAT recoverable is debited; bank credited.
    lines.push({
      accountId: input.accountId,
      debitMinor: calculation.netMinor + (calculation.vatMinor - calculation.recoverableVatMinor),
      currency: lineCurrency,
      fxRate,
      supplierId: input.supplierId ?? transaction.supplierId,
      memo: narrative,
    });

    if (calculation.recoverableVatMinor > 0) {
      lines.push({
        accountId: vatOnPurchasesId,
        debitMinor: calculation.recoverableVatMinor,
        currency: lineCurrency,
        fxRate,
        memo: `Input VAT — ${resolved.treatment.name}`,
      });
    }

    if (resolved.treatment.isReverseCharge && calculation.vatMinor > 0) {
      // Self-accounted output VAT: a liability created by the same invoice.
      lines.push({
        accountId: vatOnSalesId,
        creditMinor: calculation.vatMinor,
        currency: lineCurrency,
        fxRate,
        memo: `Output VAT (reverse charge) — ${resolved.treatment.name}`,
      });
    }

    lines.push({
      accountId: bankLedgerAccountId,
      creditMinor: statementAmount,
      currency: lineCurrency,
      fxRate,
      memo: narrative,
    });
  } else {
    // Money in: bank debited with the full receipt, income credited at net,
    // VAT on sales credited as a liability.
    lines.push({
      accountId: bankLedgerAccountId,
      debitMinor: statementAmount,
      currency: lineCurrency,
      fxRate,
      memo: narrative,
    });
    lines.push({
      accountId: input.accountId,
      creditMinor: calculation.netMinor,
      currency: lineCurrency,
      fxRate,
      customerId: input.customerId ?? transaction.customerId,
      memo: narrative,
    });
    if (calculation.vatMinor > 0) {
      lines.push({
        accountId: vatOnSalesId,
        creditMinor: calculation.vatMinor,
        currency: lineCurrency,
        fxRate,
        memo: `Output VAT — ${resolved.treatment.name}`,
      });
    }
  }

  const createsVat = !withoutInvoice && (calculation.vatMinor !== 0 || resolved.treatment.appliesRate);
  if (createsVat) {
    // A locked or filed VAT return is never changed (issue #226).
    assertVatPeriodWritable(db, input.companyId, input.vatDeclarationDate ?? transactionDate,
      `The VAT on "${transaction.description}"`);
  }

  const journal = postJournalEntry(db, {
    companyId: input.companyId,
    entryDate: transactionDate,
    narrative,
    sourceType: 'bank_transaction',
    sourceId: transaction.id,
    baseCurrency,
    createdBy: input.actor ?? 'user',
    createdVia: input.source === 'rule' ? 'rule' : input.source === 'ai' ? 'ai' : 'user',
    requestId: input.requestId,
    lines,
  });

  const vatResult = createsVat
    ? createVatEntries(db, {
        companyId: input.companyId,
        journalEntryId: journal.id,
        sourceType: 'bank_transaction',
        sourceId: transaction.id,
        declarationDate: input.vatDeclarationDate ?? undefined,
        direction,
        treatmentId: input.vatTreatmentId,
        rateOverrideId: input.taxRateId,
        taxPointDate: transactionDate,
        grossMinor: statementAmount,
        statedVatMinor: input.statedVatMinor,
        currency,
        baseCurrency,
        fxRate: resolvedFxRate
          ? { numerator: resolvedFxRate.numerator, denominator: resolvedFxRate.denominator }
          : undefined,
        counterpartyVatNumber: counterpartyVatNumber(db, input),
        counterpartyCountry: counterpartyCountry(db, input),
        source: input.source ?? 'user',
        confidence: input.confidence,
        provenanceStatus: input.provenanceStatus ?? 'manually_entered',
      })
    : { entries: [], calculation, isReverseCharge: false };

  db.transaction((tx) => {
    tx.update(bankTransactions).set({
      accountId: input.accountId,
      vatTreatmentId: input.vatTreatmentId,
      supplierId: input.supplierId ?? transaction.supplierId,
      customerId: input.customerId ?? transaction.customerId,
      journalEntryId: journal.id,
      status: 'posted',
      baseAmountMinor: toBase(transaction.amountMinor),
      baseCurrency,
      fxRateNumerator: resolvedFxRate?.numerator ?? null,
      fxRateDenominator: resolvedFxRate?.denominator ?? null,
      fxRateSource: resolvedFxRate?.source ?? null,
      appliedRuleId: input.appliedRuleId ?? null,
      source: input.source ?? 'user',
      confidence: input.confidence ?? null,
      provenanceStatus: input.provenanceStatus ?? 'manually_entered',
      notes: input.notes ?? transaction.notes,
      updatedAt: nowIso(),
    }).where(eq(bankTransactions.id, transaction.id)).run();

    if (withoutInvoice) {
      upsertReviewItem(tx, {
        companyId: input.companyId,
        kind: 'missing_document',
        severity: 'warning',
        title: `No invoice for "${transaction.description}": no input VAT claimed`,
        detail: resolved.treatment.isReverseCharge
          ? `Posted under "${resolved.treatment.name}", but without the supplier's invoice there is no net `
            + 'to self-assess on, so no reverse-charge VAT has been accounted for. Upload and confirm the '
            + 'invoice, then post it and settle this payment against it.'
          : `Posted under "${resolved.treatment.name}" with the full ${(statementAmount / 100).toFixed(2)} as `
            + 'cost. Input VAT can only be reclaimed on the supplier\'s invoice. Upload and confirm it, then '
            + 'post it and settle this payment against it.',
        entityType: 'bank_transaction',
        entityId: transaction.id,
        dedupeKey: `bank_transaction:${transaction.id}:no_invoice`,
      });
    } else if (!isMoneyOut && resolved.treatment.appliesRate) {
      upsertReviewItem(tx, {
        companyId: input.companyId,
        kind: 'missing_document',
        severity: 'info',
        title: `No sales invoice or record for "${transaction.description}"`,
        detail: 'Output VAT has been accounted for on this receipt so the liability is not understated, but '
          + 'it rests on the bank amount. Attach the sales invoice or the day\'s sales record (till Z-report) '
          + 'as evidence.',
        entityType: 'bank_transaction',
        entityId: transaction.id,
        dedupeKey: `bank_transaction:${transaction.id}:no_sales_evidence`,
      });
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: nowIso(),
      entityType: 'bank_transaction',
      entityId: transaction.id,
      action: 'classified',
      previousValue: JSON.stringify({
        accountId: transaction.accountId, vatTreatmentId: transaction.vatTreatmentId,
        status: transaction.status,
      }),
      newValue: JSON.stringify({
        accountId: input.accountId, vatTreatmentId: input.vatTreatmentId,
        journalEntryId: journal.id, status: 'posted',
        netMinor: calculation.netMinor, vatMinor: calculation.vatMinor,
      }),
      source: input.source ?? 'user',
      actor: input.actor ?? 'user',
      reason: input.appliedRuleId ? `Applied rule ${input.appliedRuleId}` : null,
      requestId: input.requestId ?? null,
    }).run();
  });

  return {
    bankTransactionId: transaction.id,
    journalEntryId: journal.id,
    entryNumber: journal.entryNumber,
    vatEntryIds: vatResult.entries.map((e) => e.id),
    netMinor: calculation.netMinor,
    vatMinor: calculation.vatMinor,
    grossMinor: calculation.grossMinor,
    posted: true,
  };
}

export interface BankTransactionJournalLine {
  accountId: string;
  debitMinor?: number;
  creditMinor?: number;
  currency?: string;
  memo?: string;
  supplierId?: string | null;
  customerId?: string | null;
}

export interface BankTransactionJournalInput {
  companyId: string;
  bankTransactionId: string;
  lines: BankTransactionJournalLine[];
  narrative?: string;
  /**
   * A statement line's own P&L split — Stripe's gross-less-fees, a loan's
   * capital/interest — is one statement amount posted to more than one
   * account (issue #158). This is deliberately a distinct command from
   * `classifyTransaction`: it never becomes classify's default, since a
   * rule matching a Stripe payout would otherwise post two P&L lines
   * silently. Also, optionally, records this transaction's own VAT position
   * — e.g. output VAT on a Stripe payout's *gross* card sales, which the
   * settled net that hit the bank does not by itself report to VAT3.
   */
  vat?: {
    /** 'purchases' is refused: input VAT comes only from a confirmed invoice (issue #221). */
    direction: 'sales' | 'purchases';
    treatmentId: string;
    netMinor?: number;
    grossMinor?: number;
    statedVatMinor?: number;
    taxRateId?: string;
  };
  notes?: string | null;
  actor?: string;
  requestId?: string;
}

export interface BankTransactionJournalResult {
  bankTransactionId: string;
  journalEntryId: string;
  entryNumber: number;
  vatEntryIds: string[];
}

/**
 * Post an arbitrary multi-line journal for one statement line, linking it in
 * the same call — `bank_transactions.journalEntryId`/`status` change with the
 * journal that explains them, rather than a caller posting the entry and then
 * updating the row itself as a separate step (issue #158).
 */
export function postBankTransactionJournal(
  db: AppDatabase, input: BankTransactionJournalInput,
): BankTransactionJournalResult {
  const transaction = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.id, input.bankTransactionId),
      eq(bankTransactions.companyId, input.companyId),
    )).get();
  if (!transaction) {
    throw new ClassificationError(`Bank transaction ${input.bankTransactionId} not found.`);
  }
  if (transaction.journalEntryId) {
    throw new ClassificationError(
      'This transaction has already been posted. Reclassify it, or reverse the existing '
        + 'entry, rather than posting a second one over the same statement line.',
      { bankTransactionId: transaction.id, journalEntryId: transaction.journalEntryId },
    );
  }
  if (input.lines.length < 2) {
    throw new ClassificationError('A split journal needs at least two lines.');
  }
  // The invoice is the only proof of input VAT (issue #221). A split journal
  // may record this line's own output VAT (a Stripe payout's gross card
  // sales), but never input VAT: that comes from a confirmed invoice, posted
  // as a purchase invoice and settled against this line.
  const noInputVat = 'Input VAT can only be claimed on a confirmed supplier invoice. Confirm the invoice, '
    + 'post it as a purchase invoice, and settle this bank line against it.';
  if (input.vat?.direction === 'purchases') {
    throw new ClassificationError(noInputVat, { bankTransactionId: transaction.id });
  }
  const vatOnPurchasesId = systemAccountId(db, input.companyId, 'vat_on_purchases');
  if (input.lines.some((line) => line.accountId === vatOnPurchasesId && (line.debitMinor ?? 0) > 0)) {
    throw new ClassificationError(noInputVat, { bankTransactionId: transaction.id });
  }

  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get()!;
  const baseCurrency = company.baseCurrency;
  const entryDate = asIsoDate(transaction.transactionDate);
  const narrative = (input.narrative ?? transaction.description).slice(0, 200);
  if (input.vat) {
    assertVatPeriodWritable(db, input.companyId, entryDate, `The VAT on "${transaction.description}"`);
  }

  const journal = postJournalEntry(db, {
    companyId: input.companyId,
    entryDate,
    narrative,
    sourceType: 'bank_transaction',
    sourceId: transaction.id,
    baseCurrency,
    createdBy: input.actor ?? 'user',
    createdVia: 'user',
    requestId: input.requestId,
    lines: input.lines.map((line) => ({
      accountId: line.accountId,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      currency: line.currency ?? transaction.currency,
      supplierId: line.supplierId ?? transaction.supplierId,
      customerId: line.customerId ?? transaction.customerId,
      memo: line.memo ?? narrative,
    })),
  });

  const vatEntryIds: string[] = [];
  if (input.vat) {
    const vatResult = createVatEntries(db, {
      companyId: input.companyId,
      journalEntryId: journal.id,
      sourceType: 'bank_transaction',
      sourceId: transaction.id,
      direction: input.vat.direction,
      treatmentId: input.vat.treatmentId,
      rateOverrideId: input.vat.taxRateId,
      taxPointDate: entryDate,
      netMinor: input.vat.netMinor,
      grossMinor: input.vat.grossMinor,
      statedVatMinor: input.vat.statedVatMinor,
      currency: transaction.currency,
      baseCurrency,
      source: 'user',
      provenanceStatus: 'manually_entered',
    });
    vatEntryIds.push(...vatResult.entries.map((e) => e.id));
  }

  db.transaction((tx) => {
    tx.update(bankTransactions).set({
      journalEntryId: journal.id,
      status: 'posted',
      source: 'user',
      provenanceStatus: 'manually_entered',
      notes: input.notes ?? transaction.notes,
      updatedAt: nowIso(),
    }).where(eq(bankTransactions.id, transaction.id)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: nowIso(),
      entityType: 'bank_transaction',
      entityId: transaction.id,
      action: 'classified',
      previousValue: JSON.stringify({ status: transaction.status }),
      newValue: JSON.stringify({
        journalEntryId: journal.id, status: 'posted', lines: input.lines.length,
      }),
      source: 'user',
      actor: input.actor ?? 'user',
      requestId: input.requestId ?? null,
    }).run();
  });

  return {
    bankTransactionId: transaction.id,
    journalEntryId: journal.id,
    entryNumber: journal.entryNumber,
    vatEntryIds,
  };
}

function counterpartyVatNumber(db: AppDatabase, input: ClassifyInput): string | null {
  if (input.supplierId) {
    return db.select({ v: suppliers.vatNumber }).from(suppliers)
      .where(eq(suppliers.id, input.supplierId)).get()?.v ?? null;
  }
  if (input.customerId) {
    return db.select({ v: customers.vatNumber }).from(customers)
      .where(eq(customers.id, input.customerId)).get()?.v ?? null;
  }
  return null;
}

function counterpartyCountry(db: AppDatabase, input: ClassifyInput): string | null {
  if (input.supplierId) {
    return db.select({ c: suppliers.countryCode }).from(suppliers)
      .where(eq(suppliers.id, input.supplierId)).get()?.c ?? null;
  }
  if (input.customerId) {
    return db.select({ c: customers.countryCode }).from(customers)
      .where(eq(customers.id, input.customerId)).get()?.c ?? null;
  }
  return null;
}

/**
 * Reclassify a posted transaction.
 *
 * Never edits the original entry. The old journal is reversed, its VAT entries
 * are voided by a compensating pair, and a new classification is posted — so
 * the books show what was originally decided, that it was changed, and why.
 */
export function reclassifyTransaction(
  db: AppDatabase,
  input: ClassifyInput & { reason: string; reversalDate?: IsoDate },
): ClassifyResult {
  const transaction = db.select().from(bankTransactions)
    .where(and(
      eq(bankTransactions.id, input.bankTransactionId),
      eq(bankTransactions.companyId, input.companyId),
    )).get();
  if (!transaction) {
    throw new ClassificationError(`Bank transaction ${input.bankTransactionId} not found.`);
  }
  if (!transaction.journalEntryId) {
    return classifyTransaction(db, input);
  }

  // A payment posted this bank line: it is corrected by reversing the
  // settlement, never by reclassifying the bank line (issue #220).
  const livePayment = db.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.bankTransactionId, transaction.id), isNull(payments.reversedAt))).get();
  if (livePayment) {
    throw new ClassificationError(
      'This bank line was posted by settling invoices. Reverse the settlement instead of reclassifying it.',
      { bankTransactionId: transaction.id, paymentId: livePayment.id },
    );
  }

  const transactionDate = asIsoDate(transaction.transactionDate);
  const reversalDate = input.reversalDate ?? transactionDate;
  const currentJournalId = transaction.journalEntryId;
  // Only the entries of the classification being replaced are reversed.
  const superseded = db.select().from(vatEntries)
    .where(and(
      eq(vatEntries.companyId, input.companyId),
      eq(vatEntries.sourceType, 'bank_transaction'),
      eq(vatEntries.sourceId, transaction.id),
      eq(vatEntries.journalEntryId, currentJournalId),
    )).all();

  // ---- Refuse before writing anything (issue #226) ----
  // The superseded VAT is reversed by negative entries dated at the reversal
  // date, never detached from the return it was declared in.
  const reversalPeriod = superseded.length > 0
    ? assertVatPeriodWritable(db, input.companyId, reversalDate, `Reversing the VAT on "${transaction.description}"`)
    : findVatPeriod(db, input.companyId, reversalDate);
  // The new classification's VAT: at the transaction date if its period is
  // open, otherwise declared at the reversal date the person chose.
  const ownPeriod = findVatPeriod(db, input.companyId, transactionDate);
  const ownPeriodClosed = ownPeriod?.status === 'locked' || ownPeriod?.status === 'submitted';
  const vatDeclarationDate = input.vatDeclarationDate
    ?? (ownPeriodClosed && input.reversalDate ? input.reversalDate : undefined);
  const newTreatment = resolveTreatment(db, {
    companyId: input.companyId, treatmentId: input.vatTreatmentId, onDate: transactionDate, rateOverrideId: input.taxRateId,
  }).treatment;
  const newCreatesVat = transaction.amountMinor >= 0 && newTreatment.appliesRate;
  if (newCreatesVat) {
    assertVatPeriodWritable(db, input.companyId, vatDeclarationDate ?? transactionDate,
      `The VAT on "${transaction.description}" under its new treatment`);
  }

  const reversal = reverseJournalEntry(db, {
    companyId: input.companyId,
    entryId: currentJournalId,
    reversalDate,
    reason: input.reason,
    createdBy: input.actor ?? 'user',
    requestId: input.requestId,
  });

  db.transaction((tx) => {
    const timestamp = nowIso();
    for (const entry of superseded) {
      tx.insert(vatEntries).values({
        ...entry,
        id: ids.vatEntry(),
        journalEntryId: reversal.id,
        netMinor: -entry.netMinor,
        vatMinor: -entry.vatMinor,
        grossMinor: -entry.grossMinor,
        baseNetMinor: -entry.baseNetMinor,
        baseVatMinor: -entry.baseVatMinor,
        baseGrossMinor: -entry.baseGrossMinor,
        recoverableVatMinor: -entry.recoverableVatMinor,
        baseRecoverableVatMinor: -entry.baseRecoverableVatMinor,
        taxPointDate: reversalDate,
        vatPeriodId: reversalPeriod?.id ?? null,
        pairedEntryId: null,
        notes: `Reversal on reclassification: ${input.reason}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run();
    }

    tx.update(bankTransactions)
      .set({ journalEntryId: null, status: 'classified' })
      .where(eq(bankTransactions.id, transaction.id)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: nowIso(),
      entityType: 'bank_transaction',
      entityId: transaction.id,
      action: 'vat_changed',
      previousValue: JSON.stringify({
        accountId: transaction.accountId, vatTreatmentId: transaction.vatTreatmentId,
      }),
      newValue: JSON.stringify({
        accountId: input.accountId, vatTreatmentId: input.vatTreatmentId,
      }),
      source: input.source ?? 'user',
      actor: input.actor ?? 'user',
      reason: input.reason,
      requestId: input.requestId ?? null,
    }).run();
  });

  return classifyTransaction(db, { ...input, vatDeclarationDate });
}

/**
 * Record a company expense paid personally by a director (README §28), when
 * there is no invoice for it.
 *
 * There is no bank transaction, because no company money moved. The expense is
 * debited and the director's current account is credited, creating a balance
 * the company owes them.
 *
 * The invoice is the only proof of input VAT (issue #221), so this claims
 * none: the whole amount is the cost, no VAT entry is written, and the missing
 * invoice is flagged. (Under a reverse charge the net also comes from the
 * invoice, so nothing is self-assessed until it is posted — flagged the same
 * way.) When there is an invoice, confirm it, post it as a purchase invoice
 * (`postDocumentAsInvoice`) and settle it as paid by the director
 * (`settleInvoiceByDirector`); the VAT then comes from the invoice's lines.
 */
export function recordDirectorPaidExpense(
  db: AppDatabase,
  params: {
    companyId: string;
    officerId: string;
    date: IsoDate;
    description: string;
    accountId: string;
    vatTreatmentId: string;
    grossMinor: number;
    currency?: string;
    actor?: string;
  },
): { journalEntryId: string; vatEntryIds: string[] } {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const currency = (params.currency ?? company.baseCurrency).toUpperCase();
  const amount = asMinor(params.grossMinor);
  if (amount <= 0) throw new ClassificationError('A director-paid expense needs a positive amount.');

  const officer = db.select().from(companyOfficers)
    .where(and(
      eq(companyOfficers.id, params.officerId),
      eq(companyOfficers.companyId, params.companyId),
    )).get();
  if (!officer) throw new ClassificationError(`Officer ${params.officerId} not found.`);

  const resolved = resolveTreatment(db, {
    companyId: params.companyId,
    treatmentId: params.vatTreatmentId,
    onDate: params.date,
  });

  const directorsAccount = officer.currentAccountId
    ?? systemAccountId(db, params.companyId, 'directors_current_account');

  const journal = postJournalEntry(db, {
    companyId: params.companyId,
    entryDate: params.date,
    narrative: `${params.description} (paid personally by ${officer.name})`,
    sourceType: 'manual_adjustment',
    entryType: 'standard',
    baseCurrency: company.baseCurrency,
    createdBy: params.actor ?? 'user',
    createdVia: 'user',
    lines: [
      { accountId: params.accountId, debitMinor: amount, currency, memo: params.description },
      {
        accountId: directorsAccount, creditMinor: amount, currency, officerId: officer.id,
        memo: `Paid personally by ${officer.name}`,
      },
    ],
  });

  if (resolved.treatment.appliesRate) {
    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'missing_document',
      severity: 'warning',
      title: `No invoice for "${params.description}" (paid by ${officer.name}): no input VAT claimed`,
      detail: resolved.treatment.isReverseCharge
        ? `Recorded under "${resolved.treatment.name}", but without the supplier's invoice there is no net `
          + 'to self-assess on, so no reverse-charge VAT has been accounted for. Upload and confirm the '
          + 'invoice, post it, and record it as paid by the director; then reverse this entry.'
        : `Recorded with the full ${(amount / 100).toFixed(2)} as cost. Input VAT can only be reclaimed on `
          + 'the supplier\'s invoice. Upload and confirm it, post it, and record it as paid by the director; '
          + 'then reverse this entry.',
      entityType: 'journal_entry',
      entityId: journal.id,
      dedupeKey: `journal_entry:${journal.id}:no_invoice`,
    });
  }

  return { journalEntryId: journal.id, vatEntryIds: [] };
}

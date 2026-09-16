import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, accounts, vatTreatments, companies, bankAccounts,
  auditEvents, journalEntries, vatEntries, suppliers, customers, companyOfficers,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, nowIso, type IsoDate } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { postJournalEntry, reverseJournalEntry } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { createVatEntries, resolveTreatment, calculateVat } from '../vat/engine';
import { AccountingError } from '../accounting/errors';

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

  if (currency !== baseCurrency && !input.fxRate) {
    throw new ClassificationError(
      `This transaction is in ${currency} but the company's base currency is `
        + `${baseCurrency}, and no exchange rate was supplied. A missing rate is an `
        + 'exception, never an assumed 1.0.',
      { bankTransactionId: transaction.id, currency },
    );
  }

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

  const calculation = calculateVat({
    treatment: resolved.treatment,
    rateBasisPoints: resolved.rateBasisPoints,
    direction,
    grossMinor: statementAmount,
    statedVatMinor: input.statedVatMinor,
  });

  const toBase = (amount: number): number =>
    input.fxRate ? multiplyRational(asMinor(amount), input.fxRate.numerator, input.fxRate.denominator) : amount;

  const bankLedgerAccountId = bankAccount.accountId
    ?? systemAccountId(db, input.companyId, 'bank_control');
  const vatOnPurchasesId = systemAccountId(db, input.companyId, 'vat_on_purchases');
  const vatOnSalesId = systemAccountId(db, input.companyId, 'vat_on_sales');

  const fxRate = input.fxRate;
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

  const vatResult = calculation.vatMinor !== 0 || resolved.treatment.appliesRate
    ? createVatEntries(db, {
        companyId: input.companyId,
        journalEntryId: journal.id,
        sourceType: 'bank_transaction',
        sourceId: transaction.id,
        direction,
        treatmentId: input.vatTreatmentId,
        rateOverrideId: input.taxRateId,
        taxPointDate: transactionDate,
        grossMinor: statementAmount,
        statedVatMinor: input.statedVatMinor,
        currency,
        baseCurrency,
        fxRate: input.fxRate
          ? { numerator: input.fxRate.numerator, denominator: input.fxRate.denominator }
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
      fxRateNumerator: input.fxRate?.numerator ?? null,
      fxRateDenominator: input.fxRate?.denominator ?? null,
      fxRateSource: input.fxRate?.source ?? null,
      appliedRuleId: input.appliedRuleId ?? null,
      source: input.source ?? 'user',
      confidence: input.confidence ?? null,
      provenanceStatus: input.provenanceStatus ?? 'manually_entered',
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

  const reversalDate = input.reversalDate ?? asIsoDate(transaction.transactionDate);

  reverseJournalEntry(db, {
    companyId: input.companyId,
    entryId: transaction.journalEntryId,
    reversalDate,
    reason: input.reason,
    createdBy: input.actor ?? 'user',
    requestId: input.requestId,
  });

  db.transaction((tx) => {
    // VAT entries from the reversed classification no longer apply. They are
    // detached from their period rather than deleted, so the original decision
    // remains visible in the audit trail.
    tx.update(vatEntries)
      .set({ vatPeriodId: null, notes: `Superseded: ${input.reason}` })
      .where(and(
        eq(vatEntries.companyId, input.companyId),
        eq(vatEntries.sourceType, 'bank_transaction'),
        eq(vatEntries.sourceId, transaction.id),
      )).run();

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

  return classifyTransaction(db, input);
}

/**
 * Record a company expense paid personally by a director (README §28).
 *
 * There is no bank transaction, because no company money moved. The expense is
 * debited and the director's current account is credited, creating a balance
 * the company owes them.
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
    documentId?: string | null;
    actor?: string;
  },
): { journalEntryId: string; vatEntryIds: string[] } {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const currency = (params.currency ?? company.baseCurrency).toUpperCase();

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
  const calculation = calculateVat({
    treatment: resolved.treatment,
    rateBasisPoints: resolved.rateBasisPoints,
    direction: 'purchases',
    grossMinor: params.grossMinor,
  });

  const directorsAccount = officer.currentAccountId
    ?? systemAccountId(db, params.companyId, 'directors_current_account');
  const vatOnPurchasesId = systemAccountId(db, params.companyId, 'vat_on_purchases');

  const lines: Parameters<typeof postJournalEntry>[1]['lines'] = [
    {
      accountId: params.accountId,
      debitMinor: calculation.netMinor + (calculation.vatMinor - calculation.recoverableVatMinor),
      currency,
      memo: params.description,
    },
  ];
  if (calculation.recoverableVatMinor > 0) {
    lines.push({
      accountId: vatOnPurchasesId,
      debitMinor: calculation.recoverableVatMinor,
      currency,
      memo: `Input VAT — ${resolved.treatment.name}`,
    });
  }
  // A director can pay a reverse-charge supplier personally just as easily as
  // the company can — a domain renewal on a personal card, say. The VAT is
  // still self-accounted, so the output leg belongs here too. Without it the
  // entry does not balance.
  if (resolved.treatment.isReverseCharge && calculation.vatMinor > 0) {
    lines.push({
      accountId: systemAccountId(db, params.companyId, 'vat_on_sales'),
      creditMinor: calculation.vatMinor,
      currency,
      memo: `Output VAT (reverse charge) — ${resolved.treatment.name}`,
    });
  }

  lines.push({
    accountId: directorsAccount,
    // What the director actually paid out of pocket. Under a reverse charge
    // that is the net, because the supplier charged no VAT.
    creditMinor: calculation.grossMinor,
    currency,
    officerId: officer.id,
    memo: `Paid personally by ${officer.name}`,
  });

  const journal = postJournalEntry(db, {
    companyId: params.companyId,
    entryDate: params.date,
    narrative: `${params.description} (paid personally by ${officer.name})`,
    sourceType: 'manual_adjustment',
    entryType: 'standard',
    baseCurrency: company.baseCurrency,
    createdBy: params.actor ?? 'user',
    createdVia: 'user',
    lines,
  });

  const vatResult = createVatEntries(db, {
    companyId: params.companyId,
    journalEntryId: journal.id,
    sourceType: 'manual_adjustment',
    sourceId: journal.id,
    direction: 'purchases',
    treatmentId: params.vatTreatmentId,
    taxPointDate: params.date,
    grossMinor: params.grossMinor,
    currency,
    baseCurrency: company.baseCurrency,
    provenanceStatus: 'manually_entered',
    source: 'user',
  });

  return { journalEntryId: journal.id, vatEntryIds: vatResult.entries.map((e) => e.id) };
}

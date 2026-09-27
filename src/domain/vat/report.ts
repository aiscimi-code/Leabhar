import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  vatEntries, vatPeriods, vatTreatments, bankTransactions, invoices,
  documents, suppliers, customers, journalEntries, payments, paymentAllocations,
  rules,
} from '@/db/schema';
import type { Vat3Box } from '../config/vatTreatments';

/**
 * VAT reporting (README §23, §25).
 *
 * Every figure produced here carries the entry ids that make it up, so the
 * drill-down chain README §53 demands — VAT report to VAT entry to transaction
 * to invoice to source document — is structural rather than a feature that has
 * to be remembered for each new report.
 */

export interface BoxFigure {
  box: string;
  label: string;
  amountMinor: number;
  entryIds: string[];
  entryCount: number;
}

export interface Vat3Return {
  vatPeriodId: string;
  periodName: string;
  startDate: string;
  endDate: string;
  filingDeadline: string | null;
  status: string;
  currency: string;

  T1: BoxFigure;
  T2: BoxFigure;
  T3: BoxFigure;
  T4: BoxFigure;
  E1: BoxFigure;
  E2: BoxFigure;
  ES1: BoxFigure;
  ES2: BoxFigure;
  PA1: BoxFigure;

  /** Positive means payable to Revenue, negative means repayable. */
  netPositionMinor: number;

  /** Supporting analysis, not part of the VAT3 itself. */
  salesNetMinor: number;
  purchasesNetMinor: number;
  reverseChargeVatMinor: number;
  nonRecoverableVatMinor: number;
  entryCount: number;
}

const BOX_LABELS: Record<string, string> = {
  T1: 'VAT on sales',
  T2: 'VAT on purchases',
  T3: 'Net payable',
  T4: 'Net repayable',
  E1: 'Goods dispatched to other EU member states',
  E2: 'Goods acquired from other EU member states',
  ES1: 'Services supplied to other EU member states',
  ES2: 'Services received from other EU member states',
  PA1: 'Goods imported under postponed accounting',
};

/**
 * Build the VAT3 figures for a period.
 *
 * T2 sums the RECOVERABLE VAT, not the VAT charged. Where a treatment
 * restricts recovery — non-deductible VAT on entertainment, or a partial
 * exemption percentage — the difference is real cost and must not be claimed.
 * Summing `vatMinor` here instead of `recoverableVatMinor` would overstate the
 * reclaim, which is the kind of error that is invisible until an audit.
 */
export function buildVat3Return(
  db: AppDatabase,
  params: { companyId: string; vatPeriodId: string; baseCurrency?: string },
): Vat3Return {
  const period = db.select().from(vatPeriods)
    .where(and(
      eq(vatPeriods.id, params.vatPeriodId),
      eq(vatPeriods.companyId, params.companyId),
    )).get();
  if (!period) throw new Error(`VAT period ${params.vatPeriodId} not found.`);

  const entries = db.select().from(vatEntries)
    .where(and(
      eq(vatEntries.companyId, params.companyId),
      eq(vatEntries.vatPeriodId, params.vatPeriodId),
    )).all();

  const box = (name: string): BoxFigure => ({
    box: name, label: BOX_LABELS[name] ?? name,
    amountMinor: 0, entryIds: [], entryCount: 0,
  });

  const figures: Record<string, BoxFigure> = {
    T1: box('T1'), T2: box('T2'), T3: box('T3'), T4: box('T4'),
    E1: box('E1'), E2: box('E2'), ES1: box('ES1'), ES2: box('ES2'), PA1: box('PA1'),
  };

  let salesNetMinor = 0;
  let purchasesNetMinor = 0;
  let reverseChargeVatMinor = 0;
  let nonRecoverableVatMinor = 0;

  for (const entry of entries) {
    // ---- VAT boxes ----
    if (entry.vatBox && figures[entry.vatBox]) {
      const target = figures[entry.vatBox]!;
      // T2 is what can be reclaimed; T1 is what is owed.
      const amount = entry.vatBox === 'T2'
        ? entry.baseRecoverableVatMinor
        : entry.baseVatMinor;
      target.amountMinor += amount;
      target.entryIds.push(entry.id);
      target.entryCount += 1;
    }

    // ---- Statistical net boxes ----
    if (entry.netBox && figures[entry.netBox]) {
      const target = figures[entry.netBox]!;
      target.amountMinor += entry.baseNetMinor;
      target.entryIds.push(entry.id);
      target.entryCount += 1;
    }

    if (entry.direction === 'sales') salesNetMinor += entry.baseNetMinor;
    else purchasesNetMinor += entry.baseNetMinor;

    if (entry.isReverseChargeLeg && entry.direction === 'sales') {
      reverseChargeVatMinor += entry.baseVatMinor;
    }
    if (entry.direction === 'purchases') {
      nonRecoverableVatMinor += entry.baseVatMinor - entry.baseRecoverableVatMinor;
    }
  }

  // T3 and T4 are derived: one of them is the net position, the other is zero.
  const net = figures['T1']!.amountMinor - figures['T2']!.amountMinor;
  if (net >= 0) {
    figures['T3']!.amountMinor = net;
    figures['T4']!.amountMinor = 0;
  } else {
    figures['T3']!.amountMinor = 0;
    figures['T4']!.amountMinor = -net;
  }
  // T3/T4 draw on everything behind T1 and T2, so drilling into them works too.
  const derivedIds = [...figures['T1']!.entryIds, ...figures['T2']!.entryIds];
  figures['T3']!.entryIds = derivedIds;
  figures['T4']!.entryIds = derivedIds;
  figures['T3']!.entryCount = derivedIds.length;
  figures['T4']!.entryCount = derivedIds.length;

  return {
    vatPeriodId: period.id,
    periodName: period.name,
    startDate: period.startDate,
    endDate: period.endDate,
    filingDeadline: period.filingDeadline,
    status: period.status,
    currency: params.baseCurrency ?? 'EUR',
    T1: figures['T1']!, T2: figures['T2']!, T3: figures['T3']!, T4: figures['T4']!,
    E1: figures['E1']!, E2: figures['E2']!, ES1: figures['ES1']!, ES2: figures['ES2']!,
    PA1: figures['PA1']!,
    netPositionMinor: net,
    salesNetMinor,
    purchasesNetMinor,
    reverseChargeVatMinor,
    nonRecoverableVatMinor,
    entryCount: entries.length,
  };
}

export interface VatDrillRow {
  entryId: string;
  direction: string;
  taxPointDate: string;
  treatmentCode: string;
  treatmentName: string;
  /** Where the treatment's rate and scope came from (README §48). */
  treatmentSourceNote: string | null;
  treatmentSourceDate: string | null;
  rateBasisPoints: number;
  netMinor: number;
  vatMinor: number;
  recoverableVatMinor: number;
  currency: string;
  baseNetMinor: number;
  baseVatMinor: number;
  baseRecoverableVatMinor: number;
  isReverseChargeLeg: boolean;
  sourceType: string;
  sourceId: string | null;
  /** Populated so the UI can go straight to the evidence. */
  counterpartyName: string | null;
  documentId: string | null;
  bankTransactionId: string | null;
  invoiceId: string | null;
  /**
   * The journal entry behind the VAT entry — the transaction leg of the
   * chain. A VAT entry always arises from a posting; this is its identity.
   */
  journalEntryId: string | null;
  journalEntryNumber: number | null;
  journalNarrative: string | null;
  /** The rule that classified the bank line behind this entry, if one did. */
  ruleId: string | null;
  ruleName: string | null;
  notes: string | null;
}

/**
 * Drill from a VAT3 box to the entries behind it (README §23, §43).
 *
 * This is the first hop of the chain in README §53. Each row carries enough
 * identity for the UI to make the next hop, to the invoice and then the
 * original PDF, without a second round of lookups.
 */
export function drillIntoBox(
  db: AppDatabase,
  params: { companyId: string; vatPeriodId: string; box: Vat3Box | string },
): VatDrillRow[] {
  const report = buildVat3Return(db, {
    companyId: params.companyId, vatPeriodId: params.vatPeriodId,
  });
  const figure = (report as unknown as Record<string, BoxFigure>)[params.box];
  if (!figure || figure.entryIds.length === 0) return [];

  return drillIntoEntries(db, params.companyId, figure.entryIds);
}

export function drillIntoEntries(
  db: AppDatabase, companyId: string, entryIds: string[],
): VatDrillRow[] {
  if (entryIds.length === 0) return [];

  const rows = db.select({
    entry: vatEntries,
    treatmentCode: vatTreatments.code,
    treatmentName: vatTreatments.name,
    treatmentSourceNote: vatTreatments.sourceNote,
    treatmentSourceDate: vatTreatments.sourceDate,
    journalEntryNumber: journalEntries.entryNumber,
    journalNarrative: journalEntries.narrative,
  })
    .from(vatEntries)
    .innerJoin(vatTreatments, eq(vatEntries.vatTreatmentId, vatTreatments.id))
    .leftJoin(journalEntries, eq(vatEntries.journalEntryId, journalEntries.id))
    .where(and(
      eq(vatEntries.companyId, companyId),
      inArray(vatEntries.id, entryIds),
    ))
    .orderBy(vatEntries.taxPointDate)
    .all();

  return rows.map(({
    entry, treatmentCode, treatmentName, treatmentSourceNote, treatmentSourceDate,
    journalEntryNumber, journalNarrative,
  }) => {
    const links = resolveSourceLinks(db, companyId, entry.sourceType, entry.sourceId);
    return {
      entryId: entry.id,
      direction: entry.direction,
      taxPointDate: entry.taxPointDate,
      treatmentCode,
      treatmentName,
      treatmentSourceNote,
      treatmentSourceDate,
      rateBasisPoints: entry.rateBasisPoints,
      netMinor: entry.netMinor,
      vatMinor: entry.vatMinor,
      recoverableVatMinor: entry.recoverableVatMinor,
      currency: entry.currency,
      baseNetMinor: entry.baseNetMinor,
      baseVatMinor: entry.baseVatMinor,
      baseRecoverableVatMinor: entry.baseRecoverableVatMinor,
      isReverseChargeLeg: entry.isReverseChargeLeg,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      journalEntryId: entry.journalEntryId,
      journalEntryNumber: journalEntryNumber ?? null,
      journalNarrative: journalNarrative ?? null,
      notes: entry.notes,
      ...links,
    };
  });
}

interface SourceLinks {
  counterpartyName: string | null;
  documentId: string | null;
  bankTransactionId: string | null;
  invoiceId: string | null;
  ruleId: string | null;
  ruleName: string | null;
}

const EMPTY_LINKS: SourceLinks = {
  counterpartyName: null, documentId: null, bankTransactionId: null,
  invoiceId: null, ruleId: null, ruleName: null,
};

/** The rule that classified a bank line, so the drill names its own reasoning. */
function ruleBehind(
  db: AppDatabase, ruleId: string | null,
): Pick<SourceLinks, 'ruleId' | 'ruleName'> {
  if (!ruleId) return { ruleId: null, ruleName: null };
  const rule = db.select({ name: rules.name }).from(rules)
    .where(eq(rules.id, ruleId)).get();
  return rule ? { ruleId, ruleName: rule.name } : { ruleId, ruleName: null };
}

/** Counterparty, matched document and applied rule for one bank line. */
function bankTransactionLinks(
  db: AppDatabase, bankTransactionId: string,
): { counterpartyName: string | null; documentId: string | null;
     bankTransactionId: string; invoiceId: null;
     ruleId: string | null; ruleName: string | null } {
  const tx = db.select({
    description: bankTransactions.description,
    counterpartyName: bankTransactions.counterpartyName,
    appliedRuleId: bankTransactions.appliedRuleId,
  }).from(bankTransactions).where(eq(bankTransactions.id, bankTransactionId)).get();

  const document = db.select({ id: documents.id }).from(documents)
    .where(eq(documents.matchedTransactionId, bankTransactionId)).get();

  return {
    counterpartyName: tx?.counterpartyName ?? tx?.description ?? null,
    documentId: document?.id ?? null,
    bankTransactionId,
    invoiceId: null,
    ...ruleBehind(db, tx?.appliedRuleId ?? null),
  };
}

/**
 * The bank line that settled an invoice, if one has been recorded. Payment
 * allocations name the payment, the payment names the bank line; a reversed
 * payment settles nothing.
 */
function settlingBankTransactionId(
  db: AppDatabase, invoiceId: string,
): string | null {
  const rows = db.select({ bankTransactionId: payments.bankTransactionId })
    .from(paymentAllocations)
    .innerJoin(payments, eq(paymentAllocations.paymentId, payments.id))
    .where(and(
      eq(paymentAllocations.invoiceId, invoiceId),
      isNull(payments.reversedAt),
      isNotNull(payments.bankTransactionId),
    ))
    .orderBy(payments.paymentDate)
    .all();
  return rows[0]?.bankTransactionId ?? null;
}

/**
 * Resolve a VAT entry's source to the evidence behind it: the full chain
 * README §53 asks for — transaction, invoice, bank line, rule, document.
 * A leg that does not exist yet is left null rather than guessed; the UI shows
 * an honest gap instead of a fabricated link.
 */
function resolveSourceLinks(
  db: AppDatabase, companyId: string, sourceType: string, sourceId: string | null,
): SourceLinks {
  if (!sourceId) return EMPTY_LINKS;

  if (sourceType === 'bank_transaction') {
    return bankTransactionLinks(db, sourceId);
  }

  if (sourceType === 'sales_invoice' || sourceType === 'purchase_invoice') {
    const invoice = db.select().from(invoices).where(eq(invoices.id, sourceId)).get();
    if (!invoice) return EMPTY_LINKS;

    let counterpartyName: string | null = null;
    if (invoice.supplierId) {
      counterpartyName = db.select({ name: suppliers.name }).from(suppliers)
        .where(eq(suppliers.id, invoice.supplierId)).get()?.name ?? null;
    } else if (invoice.customerId) {
      counterpartyName = db.select({ name: customers.name }).from(customers)
        .where(eq(customers.id, invoice.customerId)).get()?.name ?? null;
    }

    const bankTransactionId = settlingBankTransactionId(db, invoice.id);
    const bank = bankTransactionId ? bankTransactionLinks(db, bankTransactionId) : null;

    return {
      counterpartyName: counterpartyName ?? bank?.counterpartyName ?? null,
      // The invoice's own document is its evidence; a document matched to the
      // bank line that paid it is not, so a missing one stays a gap.
      documentId: invoice.documentId ?? null,
      bankTransactionId,
      invoiceId: invoice.id,
      ruleId: bank?.ruleId ?? null,
      ruleName: bank?.ruleName ?? null,
    };
  }

  if (sourceType === 'payment') {
    // The cash receipts basis (README §9): output VAT arises from the payment,
    // so the payment is the source. Its bank line is the evidence leg.
    const payment = db.select().from(payments).where(eq(payments.id, sourceId)).get();
    if (!payment) return EMPTY_LINKS;

    const bankTransactionId = payment.bankTransactionId;
    const bank = bankTransactionId ? bankTransactionLinks(db, bankTransactionId) : null;

    // A payment settling several invoices cannot name one invoice without
    // guessing, so the invoice leg is linked only when it is unambiguous.
    const settledInvoices = db.select({ invoiceId: paymentAllocations.invoiceId })
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, payment.id)).all()
      .map((row) => row.invoiceId);
    const invoiceId = settledInvoices.length === 1 ? settledInvoices[0]! : null;
    const invoice = invoiceId
      ? db.select().from(invoices).where(eq(invoices.id, invoiceId)).get()
      : null;

    let counterpartyName = bank?.counterpartyName ?? null;
    if (invoice?.supplierId) {
      counterpartyName = db.select({ name: suppliers.name }).from(suppliers)
        .where(eq(suppliers.id, invoice.supplierId)).get()?.name ?? counterpartyName;
    } else if (invoice?.customerId) {
      counterpartyName = db.select({ name: customers.name }).from(customers)
        .where(eq(customers.id, invoice.customerId)).get()?.name ?? counterpartyName;
    }

    return {
      counterpartyName,
      // When the payment settles one invoice, that invoice's document is the
      // evidence (or the gap); otherwise the bank line's own document.
      documentId: invoice ? invoice.documentId ?? null : bank?.documentId ?? null,
      bankTransactionId,
      invoiceId,
      ruleId: bank?.ruleId ?? null,
      ruleName: bank?.ruleName ?? null,
    };
  }

  return EMPTY_LINKS;
}

/** Totals across every period, for the dashboard. */
export function vatPositionSummary(
  db: AppDatabase, companyId: string,
): Array<{ periodId: string; name: string; startDate: string; endDate: string;
          status: string; netPositionMinor: number; entryCount: number }> {
  const periods = db.select().from(vatPeriods)
    .where(eq(vatPeriods.companyId, companyId))
    .orderBy(vatPeriods.startDate).all();

  return periods.map((period) => {
    const report = buildVat3Return(db, { companyId, vatPeriodId: period.id });
    return {
      periodId: period.id,
      name: period.name,
      startDate: period.startDate,
      endDate: period.endDate,
      status: period.status,
      netPositionMinor: report.netPositionMinor,
      entryCount: report.entryCount,
    };
  });
}

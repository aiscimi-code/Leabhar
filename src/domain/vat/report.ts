import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  vatEntries, vatPeriods, vatTreatments, bankTransactions, invoices,
  documents, suppliers, customers,
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
  })
    .from(vatEntries)
    .innerJoin(vatTreatments, eq(vatEntries.vatTreatmentId, vatTreatments.id))
    .where(and(
      eq(vatEntries.companyId, companyId),
      inArray(vatEntries.id, entryIds),
    ))
    .orderBy(vatEntries.taxPointDate)
    .all();

  return rows.map(({ entry, treatmentCode, treatmentName }) => {
    const links = resolveSourceLinks(db, companyId, entry.sourceType, entry.sourceId);
    return {
      entryId: entry.id,
      direction: entry.direction,
      taxPointDate: entry.taxPointDate,
      treatmentCode,
      treatmentName,
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
      notes: entry.notes,
      ...links,
    };
  });
}

/** Resolve a VAT entry's source to the evidence behind it. */
function resolveSourceLinks(
  db: AppDatabase, companyId: string, sourceType: string, sourceId: string | null,
): { counterpartyName: string | null; documentId: string | null;
     bankTransactionId: string | null; invoiceId: string | null } {
  const empty = {
    counterpartyName: null, documentId: null, bankTransactionId: null, invoiceId: null,
  };
  if (!sourceId) return empty;

  if (sourceType === 'bank_transaction') {
    const tx = db.select({
      id: bankTransactions.id,
      description: bankTransactions.description,
      counterpartyName: bankTransactions.counterpartyName,
      supplierId: bankTransactions.supplierId,
    }).from(bankTransactions).where(eq(bankTransactions.id, sourceId)).get();
    if (!tx) return empty;

    const document = db.select({ id: documents.id }).from(documents)
      .where(eq(documents.matchedTransactionId, tx.id)).get();

    return {
      counterpartyName: tx.counterpartyName ?? tx.description,
      documentId: document?.id ?? null,
      bankTransactionId: tx.id,
      invoiceId: null,
    };
  }

  if (sourceType === 'sales_invoice' || sourceType === 'purchase_invoice') {
    const invoice = db.select().from(invoices).where(eq(invoices.id, sourceId)).get();
    if (!invoice) return empty;

    let counterpartyName: string | null = null;
    if (invoice.supplierId) {
      counterpartyName = db.select({ name: suppliers.name }).from(suppliers)
        .where(eq(suppliers.id, invoice.supplierId)).get()?.name ?? null;
    } else if (invoice.customerId) {
      counterpartyName = db.select({ name: customers.name }).from(customers)
        .where(eq(customers.id, invoice.customerId)).get()?.name ?? null;
    }

    return {
      counterpartyName,
      documentId: invoice.documentId,
      bankTransactionId: null,
      invoiceId: invoice.id,
    };
  }

  return empty;
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

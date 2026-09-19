import { and, eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  invoices, invoiceLines, companies, auditEvents, suppliers, customers,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asMinor, multiplyRational } from '../money';
import { nowIso, type IsoDate } from '../dates';
import { postJournalEntry } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import {
  resolveTreatment, calculateVat, createVatEntries, determineTaxPoint, vatDiscrepancy,
} from '../vat/engine';
import { AccountingError } from '../accounting/errors';
import { upsertReviewItem } from '../extraction/service';

export class InvoicingError extends AccountingError {}

/**
 * Invoices (README §26, §27).
 *
 * README §26 is explicit that payment-on-issue must not be assumed, so the
 * model is three-legged: Invoice -> Payment -> BankTransaction, each leg
 * optional and each meaning something different.
 *
 * The cash receipts basis is what makes this more than bookkeeping ceremony.
 * On that basis the VAT on a sales invoice is not owed until the customer pays,
 * so the invoice credits a *deferred* VAT liability and each payment transfers
 * its share to VAT payable, creating a VAT entry dated at the payment. A
 * part-payment therefore produces a VAT entry for the proportion settled, which
 * may fall in a different period from the invoice. A design that put VAT on the
 * invoice row could not express that at all.
 */

export interface InvoiceLineInput {
  description: string;
  /** Quantity in thousandths, so 1.5 is 1500. */
  quantityMilli?: number;
  unitPriceMinor?: number;
  /** Supply the line net directly instead of quantity x unit price. */
  netMinor?: number;
  accountId: string;
  vatTreatmentId: string;
  taxRateId?: string;
  /** Where the document states VAT explicitly, use it rather than recomputing. */
  statedVatMinor?: number;
  fixedAssetId?: string | null;
}

export interface CreateInvoiceInput {
  companyId: string;
  direction: 'sales' | 'purchase';
  invoiceDate: IsoDate;
  dueDate?: IsoDate | null;
  /** The VAT tax point, where it differs from the invoice date. */
  supplyDate?: IsoDate | null;
  supplierId?: string | null;
  customerId?: string | null;
  invoiceNumber?: string | null;
  reference?: string | null;
  currency?: string;
  fxRate?: { numerator: number; denominator: number; source: string; date?: string };
  lines: InvoiceLineInput[];
  documentId?: string | null;
  isCreditNote?: boolean;
  creditNoteOfId?: string | null;
  notes?: string | null;
  actor?: string;
  requestId?: string;
}

export interface CreatedInvoice {
  invoiceId: string;
  journalEntryId: string;
  internalNumber: number | null;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  vatEntryIds: string[];
  /** True when output VAT was deferred pending payment. */
  vatDeferred: boolean;
}

/**
 * Create and post an invoice.
 *
 * A sales invoice debits debtors and credits income; a purchase invoice debits
 * the expense and credits creditors. VAT is computed per line, because one
 * invoice can legitimately carry several treatments and rates — common on an EU
 * supplier invoice mixing goods and services.
 */
export function createInvoice(db: AppDatabase, input: CreateInvoiceInput): CreatedInvoice {
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  if (!company) throw new InvoicingError(`Company ${input.companyId} not found.`);
  if (input.lines.length === 0) {
    throw new InvoicingError('An invoice needs at least one line.');
  }

  const isSales = input.direction === 'sales';
  if (isSales && !input.customerId) {
    throw new InvoicingError('A sales invoice needs a customer.');
  }
  if (!isSales && !input.supplierId) {
    throw new InvoicingError('A purchase invoice needs a supplier.');
  }

  const currency = (input.currency ?? company.baseCurrency).toUpperCase();
  const baseCurrency = company.baseCurrency;
  if (currency !== baseCurrency && !input.fxRate) {
    throw new InvoicingError(
      `This invoice is in ${currency} but the company's base currency is ${baseCurrency}, `
        + 'and no exchange rate was supplied. A missing rate is an exception, never an '
        + 'assumed 1.0.',
    );
  }

  const toBase = (amount: number): number =>
    input.fxRate
      ? multiplyRational(asMinor(amount), input.fxRate.numerator, input.fxRate.denominator)
      : amount;

  const sign = input.isCreditNote ? -1 : 1;
  const taxPointBase = input.supplyDate ?? input.invoiceDate;

  // A purchase invoice's input VAT is only ever as trustworthy as the
  // supplier's own VAT status (issue #145 defects 1 and 3): a non-Irish
  // supplier's country is resolved once per invoice, not per line, since
  // one invoice has one supplier.
  const supplierCountryCode = !isSales ? counterpartyCountry(db, input) : null;

  // ---- Compute each line ----
  const computed = input.lines.map((line, index) => {
    const resolved = resolveTreatment(db, {
      companyId: input.companyId,
      treatmentId: line.vatTreatmentId,
      onDate: taxPointBase,
      rateOverrideId: line.taxRateId,
    });

    const lineNet = line.netMinor !== undefined
      ? line.netMinor
      : multiplyRational(asMinor(line.unitPriceMinor ?? 0), line.quantityMilli ?? 1000, 1000);

    // Issue #145 defect 1: a purchase line's input VAT is held back from
    // recovery — flagged for review instead — rather than trusted outright,
    // when either the stated figure disagrees with what the treatment's own
    // rate implies, or the treatment is a domestic (non-reverse-charge) one
    // applied to a supplier who is not established in the State. Neither
    // check fires for a genuine reverse-charge line: that VAT is always
    // self-assessed (see calculateVat), so a stated figure on the document
    // is worth flagging for a human, but never changes what is recoverable.
    let vatReviewReason: string | null = null;
    let recoverableOverrideMinor: number | undefined;
    if (!isSales && resolved.treatment.appliesRate) {
      if (resolved.treatment.isReverseCharge) {
        if (line.statedVatMinor !== undefined && line.statedVatMinor !== 0) {
          vatReviewReason = 'This is a reverse-charge supply, so VAT is self-assessed at the '
            + 'treatment\'s own rate — but the document itself also states a VAT amount. A '
            + 'supplier who is not established in the State is not entitled to charge Irish '
            + 'VAT; the stated figure was not used and this invoice is worth checking.';
        }
      } else {
        const discrepancy = line.statedVatMinor === undefined
          ? null
          : vatDiscrepancy(lineNet, line.statedVatMinor, resolved.rateBasisPoints);
        const foreignSupplier = !!supplierCountryCode && supplierCountryCode.toUpperCase() !== 'IE';

        if (discrepancy && Math.abs(discrepancy.differenceMinor) > 1) {
          recoverableOverrideMinor = 0;
          vatReviewReason = `The invoice states VAT of ${(discrepancy.statedMinor / 100).toFixed(2)}, `
            + `but the treatment's own rate implies ${(discrepancy.expectedMinor / 100).toFixed(2)} — `
            + 'a difference too large to be per-line rounding. The VAT has been costed as stated '
            + 'but held back from input VAT recovery pending review.';
        } else if (foreignSupplier) {
          recoverableOverrideMinor = 0;
          vatReviewReason = `The supplier is established in ${supplierCountryCode}, not the State, `
            + `but this line was posted under a domestic treatment ("${resolved.treatment.name}") `
            + 'that trusts VAT stated on the document. A non-Irish supplier is not entitled to '
            + 'charge Irish VAT, so it has been held back from recovery pending review — confirm '
            + 'whether a reverse-charge treatment applies instead.';
        }
      }
    }

    const calculation = calculateVat({
      treatment: resolved.treatment,
      rateBasisPoints: resolved.rateBasisPoints,
      direction: isSales ? 'sales' : 'purchases',
      netMinor: lineNet * sign,
      statedVatMinor: line.statedVatMinor === undefined ? undefined : line.statedVatMinor * sign,
      recoverableOverrideMinor,
    });

    return { line, index, resolved, calculation, recoverableOverrideMinor, vatReviewReason };
  });

  const netMinor = computed.reduce((s, c) => s + c.calculation.netMinor, 0);
  const vatMinor = computed.reduce((s, c) => s + c.calculation.vatMinor, 0);
  const grossMinor = computed.reduce((s, c) => s + c.calculation.grossMinor, 0);

  // ---- Deferral decision ----
  // Output VAT on the cash receipts basis is not owed until payment, so it is
  // held in a separate liability until then. Purchases are unaffected: input
  // VAT is reclaimed by reference to the supplier's invoice date under either
  // basis, which is the asymmetry people get wrong.
  const vatDeferred = isSales && company.vatAccountingBasis === 'cash_receipts' && vatMinor !== 0;

  const debtors = systemAccountId(db, input.companyId, 'debtors');
  const creditors = systemAccountId(db, input.companyId, 'creditors');
  const vatOnSales = systemAccountId(db, input.companyId, 'vat_on_sales');
  const vatOnSalesDeferred = systemAccountId(db, input.companyId, 'vat_on_sales_deferred');
  const vatOnPurchases = systemAccountId(db, input.companyId, 'vat_on_purchases');

  const journalLines: Parameters<typeof postJournalEntry>[1]['lines'] = [];
  const fxRate = input.fxRate;
  const counterparty = isSales
    ? { customerId: input.customerId }
    : { supplierId: input.supplierId };

  const narrative = buildNarrative(db, input, isSales);

  if (isSales) {
    journalLines.push({
      accountId: debtors,
      ...(grossMinor >= 0 ? { debitMinor: grossMinor } : { creditMinor: -grossMinor }),
      currency, fxRate, ...counterparty, memo: narrative,
    });
    for (const { line, calculation } of computed) {
      if (calculation.netMinor === 0) continue;
      journalLines.push({
        accountId: line.accountId,
        ...(calculation.netMinor >= 0
          ? { creditMinor: calculation.netMinor }
          : { debitMinor: -calculation.netMinor }),
        currency, fxRate, ...counterparty, memo: line.description,
      });
    }
    if (vatMinor !== 0) {
      journalLines.push({
        accountId: vatDeferred ? vatOnSalesDeferred : vatOnSales,
        ...(vatMinor >= 0 ? { creditMinor: vatMinor } : { debitMinor: -vatMinor }),
        currency, fxRate,
        memo: vatDeferred
          ? 'Output VAT, not due until the customer pays (cash receipts basis)'
          : 'Output VAT',
      });
    }
  } else {
    for (const { line, calculation } of computed) {
      // Irrecoverable VAT forms part of the cost rather than being reclaimed.
      const cost = calculation.netMinor + (calculation.vatMinor - calculation.recoverableVatMinor);
      if (cost !== 0) {
        journalLines.push({
          accountId: line.accountId,
          ...(cost >= 0 ? { debitMinor: cost } : { creditMinor: -cost }),
          currency, fxRate, ...counterparty, memo: line.description,
        });
      }
    }
    const recoverable = computed.reduce((s, c) => s + c.calculation.recoverableVatMinor, 0);
    if (recoverable !== 0) {
      journalLines.push({
        accountId: vatOnPurchases,
        ...(recoverable >= 0 ? { debitMinor: recoverable } : { creditMinor: -recoverable }),
        currency, fxRate, memo: 'Input VAT',
      });
    }
    // Reverse charge: the same invoice creates an output VAT liability too.
    const reverseChargeVat = computed
      .filter((c) => c.resolved.treatment.isReverseCharge)
      .reduce((s, c) => s + c.calculation.vatMinor, 0);
    if (reverseChargeVat !== 0) {
      journalLines.push({
        accountId: vatOnSales,
        ...(reverseChargeVat >= 0
          ? { creditMinor: reverseChargeVat }
          : { debitMinor: -reverseChargeVat }),
        currency, fxRate, memo: 'Output VAT (reverse charge)',
      });
    }
    journalLines.push({
      accountId: creditors,
      ...(grossMinor >= 0 ? { creditMinor: grossMinor } : { debitMinor: -grossMinor }),
      currency, fxRate, ...counterparty, memo: narrative,
    });
  }

  const invoiceId = ids.invoice();

  const journal = postJournalEntry(db, {
    companyId: input.companyId,
    entryDate: input.invoiceDate,
    narrative,
    sourceType: isSales ? 'sales_invoice' : 'purchase_invoice',
    sourceId: invoiceId,
    baseCurrency,
    createdBy: input.actor ?? 'user',
    createdVia: 'user',
    requestId: input.requestId,
    lines: journalLines,
  });

  // ---- VAT entries ----
  const vatEntryIds: string[] = [];
  if (!vatDeferred) {
    for (const { line, calculation, resolved, recoverableOverrideMinor } of computed) {
      if (calculation.vatMinor === 0 && !resolved.treatment.appliesRate) continue;
      const taxPoint = determineTaxPoint({
        basis: company.vatAccountingBasis,
        direction: isSales ? 'sales' : 'purchases',
        invoiceDate: input.invoiceDate,
        supplyDate: input.supplyDate,
        // On the invoice basis a sale's tax point is the invoice date, so no
        // payment date is needed. Deferred sales never reach here.
        paymentDate: input.invoiceDate,
      });

      const created = createVatEntries(db, {
        companyId: input.companyId,
        journalEntryId: journal.id,
        sourceType: isSales ? 'sales_invoice' : 'purchase_invoice',
        sourceId: invoiceId,
        direction: isSales ? 'sales' : 'purchases',
        treatmentId: line.vatTreatmentId,
        rateOverrideId: line.taxRateId,
        taxPointDate: taxPoint.taxPointDate,
        netMinor: calculation.netMinor,
        statedVatMinor: calculation.vatMinor,
        recoverableOverrideMinor: recoverableOverrideMinor === undefined
          ? undefined : recoverableOverrideMinor * sign,
        currency,
        baseCurrency,
        fxRate: input.fxRate
          ? { numerator: input.fxRate.numerator, denominator: input.fxRate.denominator }
          : undefined,
        counterpartyVatNumber: counterpartyVatNumber(db, input),
        counterpartyCountry: counterpartyCountry(db, input),
        source: 'user',
        provenanceStatus: 'manually_entered',
      });
      vatEntryIds.push(...created.entries.map((e) => e.id));
    }
  }

  // ---- Persist ----
  const internalNumber = isSales ? nextInvoiceNumber(db, input.companyId) : null;
  const timestamp = nowIso();

  db.transaction((tx) => {
    tx.insert(invoices).values({
      id: invoiceId,
      companyId: input.companyId,
      direction: input.direction,
      invoiceNumber: input.invoiceNumber ?? (internalNumber ? `INV-${internalNumber}` : null),
      internalNumber,
      reference: input.reference ?? null,
      supplierId: input.supplierId ?? null,
      customerId: input.customerId ?? null,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate ?? null,
      supplyDate: input.supplyDate ?? null,
      currency,
      netMinor, vatMinor, grossMinor,
      baseCurrency,
      baseNetMinor: toBase(netMinor),
      baseVatMinor: toBase(vatMinor),
      baseGrossMinor: toBase(grossMinor),
      fxRateNumerator: input.fxRate?.numerator ?? null,
      fxRateDenominator: input.fxRate?.denominator ?? null,
      fxRateSource: input.fxRate?.source ?? null,
      fxRateDate: input.fxRate?.date ?? null,
      paidMinor: 0,
      outstandingMinor: grossMinor,
      documentId: input.documentId ?? null,
      journalEntryId: journal.id,
      isCreditNote: input.isCreditNote ?? false,
      creditNoteOfId: input.creditNoteOfId ?? null,
      status: 'issued',
      notes: input.notes ?? null,
      source: 'user',
      provenanceStatus: 'manually_entered',
    }).run();

    for (const { line, index, calculation, resolved } of computed) {
      tx.insert(invoiceLines).values({
        id: ids.invoiceLine(),
        companyId: input.companyId,
        invoiceId,
        lineNumber: index + 1,
        description: line.description,
        quantityMilli: line.quantityMilli ?? 1000,
        unitPriceMinor: line.unitPriceMinor ?? 0,
        accountId: line.accountId,
        vatTreatmentId: line.vatTreatmentId,
        taxRateId: resolved.rate?.id ?? null,
        rateBasisPoints: calculation.rateBasisPoints,
        netMinor: calculation.netMinor,
        vatMinor: calculation.vatMinor,
        grossMinor: calculation.grossMinor,
        currency,
        fixedAssetId: line.fixedAssetId ?? null,
        source: 'user',
        provenanceStatus: 'manually_entered',
      }).run();
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'created',
      newValue: JSON.stringify({
        direction: input.direction, invoiceDate: input.invoiceDate,
        netMinor, vatMinor, grossMinor, currency, vatDeferred,
      }),
      source: 'user',
      actor: input.actor ?? 'user',
      reason: vatDeferred
        ? 'Output VAT deferred until payment under the cash receipts basis'
        : null,
      requestId: input.requestId ?? null,
    }).run();

    // Issue #145 defects 1 and 3: an untrustworthy VAT figure is never
    // silently repaired (AGENTS.md invariant #7) — it becomes a review item
    // alongside the posted invoice, whether or not recovery was held back.
    for (const { index, vatReviewReason } of computed) {
      if (!vatReviewReason) continue;
      const lineNumber = index + 1;
      upsertReviewItem(tx, {
        companyId: input.companyId,
        kind: 'uncertain_vat_treatment',
        severity: 'warning',
        title: `Invoice ${input.invoiceNumber ?? invoiceId}, line ${lineNumber}: VAT needs review`,
        detail: vatReviewReason,
        entityType: 'invoice',
        entityId: invoiceId,
        dedupeKey: `invoice:${invoiceId}:line:${lineNumber}:vat-review`,
        context: { lineNumber, invoiceId },
      });
    }
  });

  return {
    invoiceId,
    journalEntryId: journal.id,
    internalNumber,
    netMinor, vatMinor, grossMinor,
    vatEntryIds,
    vatDeferred,
  };
}

function buildNarrative(db: AppDatabase, input: CreateInvoiceInput, isSales: boolean): string {
  const party = isSales
    ? db.select({ name: customers.name }).from(customers)
        .where(eq(customers.id, input.customerId!)).get()?.name
    : db.select({ name: suppliers.name }).from(suppliers)
        .where(eq(suppliers.id, input.supplierId!)).get()?.name;

  const kind = input.isCreditNote ? 'Credit note' : isSales ? 'Sales invoice' : 'Purchase invoice';
  const number = input.invoiceNumber ? ` ${input.invoiceNumber}` : '';
  return `${kind}${number} — ${party ?? 'unknown party'}`.slice(0, 200);
}

function nextInvoiceNumber(db: AppDatabase, companyId: string): number {
  const last = db.select({ n: invoices.internalNumber }).from(invoices)
    .where(and(eq(invoices.companyId, companyId), eq(invoices.direction, 'sales')))
    .orderBy(desc(invoices.internalNumber)).limit(1).get();
  return (last?.n ?? 0) + 1;
}

function counterpartyVatNumber(db: AppDatabase, input: CreateInvoiceInput): string | null {
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

function counterpartyCountry(db: AppDatabase, input: CreateInvoiceInput): string | null {
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

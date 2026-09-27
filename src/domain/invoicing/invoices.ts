import { and, eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  invoices, invoiceLines, companies, auditEvents, suppliers, customers, vatEntries, documents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asMinor, multiplyRational } from '../money';
import { nowIso, addDays, type IsoDate } from '../dates';
import { customerExposure } from '../parties/customerAccount';
import { postJournalEntry, reverseJournalEntry, atomically } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import {
  resolveTreatment, calculateVat, createVatEntries, determineTaxPoint, vatDiscrepancy, findVatPeriod,
  assertVatPeriodWritable,
} from '../vat/engine';
import { AccountingError } from '../accounting/errors';
import { upsertReviewItem } from '../extraction/service';

export class InvoicingError extends AccountingError {}

/**
 * A supplier record whose own name says the supplier is not actually known
 * (issue #147 finding 3) — a placeholder such as "Unknown Supplier" used to
 * let a payment post while the real counterparty is still being tracked
 * down. The name is the only signal available here; VAT recovery on such an
 * invoice is held back until the supplier is identified, same as an invoice
 * whose stated VAT cannot be trusted (issue #145 defect 1).
 */
const UNIDENTIFIED_SUPPLIER_RE = /\bunknown\b|\bunidentified\b/i;

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
  /**
   * A trade discount (issue #393), as a percentage in basis points (1000 =
   * 10%) or a fixed amount in minor units — not both. It comes off the line
   * net before VAT: an unconditional discount given at the time of supply
   * reduces the consideration. A prompt-payment discount is not this.
   */
  discountBasisPoints?: number;
  discountMinor?: number;
  accountId: string;
  vatTreatmentId: string;
  taxRateId?: string;
  /** Where the document states VAT explicitly, use it rather than recomputing. */
  statedVatMinor?: number;
  fixedAssetId?: string | null;
  /** The confirmed document line this invoice line is posted from (issue #203). */
  documentLineId?: string | null;
  /** The statutory rules behind the chosen VAT treatment, for the trace. */
  vatRuleKeys?: string[];
  /**
   * Hold this purchase line's VAT back from recovery, with the reason: the
   * VAT is costed and a review item raised (issue #209: an invoice missing a
   * particular its deduction depends on).
   */
  holdRecoveryReason?: string;
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
  /**
   * A historic invoice migrated from a previous system whose VAT was already
   * declared there, in a filed period (issue #234): recorded for its balance
   * and ageing, information only for VAT. No VAT entries, no VAT journal
   * lines — the whole gross goes to the line accounts — and the reason is
   * audited.
   */
  vatAlreadyDeclared?: { reason: string } | null;
  isCreditNote?: boolean;
  creditNoteOfId?: string | null;
  /** An additional charge against an earlier invoice of the same party (issue #403). */
  isDebitNote?: boolean;
  debitNoteOfId?: string | null;
  /** The recurring template and occurrence this invoice is raised for (issue #394). */
  recurring?: { templateId: string; date: IsoDate } | null;
  /**
   * Declare this invoice's VAT in the VAT period covering this date instead of
   * the one covering its tax point — only for a late document whose own
   * period's return is locked or filed (issue #226). Flagged for review.
   */
  vatDeclarationDate?: IsoDate | null;
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
  /** The due date recorded, stated or derived from the customer's terms (issue #392). */
  dueDate: IsoDate | null;
  /** Things a person should know that did not stop the invoice, e.g. a credit limit exceeded. */
  warnings: string[];
}

/**
 * Create and post an invoice.
 *
 * A sales invoice debits debtors and credits income; a purchase invoice debits
 * the expense and credits creditors. VAT is computed per line, because one
 * invoice can legitimately carry several treatments and rates — common on an EU
 * supplier invoice mixing goods and services.
 */
export function createInvoice(
  db: AppDatabase, input: Parameters<typeof createInvoiceSteps>[1],
): ReturnType<typeof createInvoiceSteps> {
  return atomically(db, () => createInvoiceSteps(db, input));
}

function createInvoiceSteps(db: AppDatabase, input: CreateInvoiceInput): CreatedInvoice {
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

  if (input.isDebitNote) {
    if (input.isCreditNote) throw new InvoicingError('A document is a credit note or a debit note, not both.');
    if (!input.debitNoteOfId) throw new InvoicingError('A debit note names the invoice it adjusts.');
    const original = db.select().from(invoices)
      .where(and(eq(invoices.id, input.debitNoteOfId), eq(invoices.companyId, input.companyId))).get();
    if (!original) throw new InvoicingError(`Invoice ${input.debitNoteOfId} not found.`);
    if (original.isCreditNote || original.direction !== input.direction
      || (original.customerId ?? null) !== (input.customerId ?? null)
      || (original.supplierId ?? null) !== (input.supplierId ?? null)) {
      throw new InvoicingError('A debit note adjusts an invoice of the same party and direction, not a credit note.');
    }
  } else if (input.debitNoteOfId) {
    throw new InvoicingError('Only a debit note names an invoice it adjusts.');
  }

  const sign = input.isCreditNote ? -1 : 1;
  const taxPointBase = input.supplyDate ?? input.invoiceDate;

  // A purchase invoice's input VAT is only ever as trustworthy as the
  // supplier's own VAT status (issue #145 defects 1 and 3): a non-Irish
  // supplier's country is resolved once per invoice, not per line, since
  // one invoice has one supplier.
  const supplierCountryCode = !isSales ? counterpartyCountry(db, input) : null;
  const supplierDisplayName = !isSales && input.supplierId
    ? db.select({ name: suppliers.name }).from(suppliers)
        .where(eq(suppliers.id, input.supplierId)).get()?.name ?? null
    : null;
  const unidentifiedSupplier = !!supplierDisplayName && UNIDENTIFIED_SUPPLIER_RE.test(supplierDisplayName);

  // Input VAT comes only from a confirmed supplier invoice (issue #234). A
  // purchase posted without one — typed in, imported from a ledger CSV —
  // holds its VAT back from recovery and is flagged, until the invoice is
  // uploaded, confirmed and posted from its document.
  const historic = input.vatAlreadyDeclared ?? null;
  if (historic && !historic.reason.trim()) {
    throw new InvoicingError('Say why this invoice\'s VAT was already declared elsewhere (e.g. "migrated from the previous system; VAT in returns to Dec 2024").');
  }
  const evidenced = !input.documentId ? false
    : db.select({ s: documents.reviewStatus }).from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.companyId, input.companyId))).get()?.s === 'confirmed';
  const noEvidenceReason = !isSales && !historic && !evidenced
    ? 'Posted without a confirmed supplier invoice, so its input VAT is held back from recovery. Upload the '
      + 'invoice, confirm it and post it from the document to recover the VAT.'
    : undefined;

  // ---- Compute each line ----
  const computed = input.lines.map((line, index) => {
    const resolved = resolveTreatment(db, {
      companyId: input.companyId,
      treatmentId: line.vatTreatmentId,
      onDate: taxPointBase,
      rateOverrideId: line.taxRateId,
    });

    const undiscountedNet = line.netMinor !== undefined
      ? line.netMinor
      : multiplyRational(asMinor(line.unitPriceMinor ?? 0), line.quantityMilli ?? 1000, 1000);
    const discount = lineDiscount(undiscountedNet, line, index + 1);
    const lineNet = undiscountedNet - discount.minor;

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
      if (line.holdRecoveryReason || noEvidenceReason) {
        recoverableOverrideMinor = 0;
        vatReviewReason = line.holdRecoveryReason ?? noEvidenceReason!;
      } else if (unidentifiedSupplier) {
        // Not knowing who was actually paid undermines even a reverse-charge
        // self-assessment, so this takes priority over — and applies
        // regardless of — the treatment-specific checks below.
        recoverableOverrideMinor = 0;
        vatReviewReason = `The supplier is recorded as "${supplierDisplayName}", which does not identify `
          + 'who was actually paid. The VAT has been costed as stated but held back from recovery until '
          + 'the supplier is identified.';
      } else if (resolved.treatment.isReverseCharge) {
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

    return {
      line, index, lineId: ids.invoiceLine(), resolved, calculation, recoverableOverrideMinor, vatReviewReason,
      undiscountedNet, discount,
    };
  });

  const netMinor = computed.reduce((s, c) => s + c.calculation.netMinor, 0);
  const vatMinor = computed.reduce((s, c) => s + c.calculation.vatMinor, 0);
  const grossMinor = computed.reduce((s, c) => s + c.calculation.grossMinor, 0);

  // ---- Deferral decision ----
  // Output VAT on the cash receipts basis is not owed until payment, so it is
  // held in a separate liability until then. Purchases are unaffected: input
  // VAT is reclaimed by reference to the supplier's invoice date under either
  // basis, which is the asymmetry people get wrong.
  const vatDeferred = !historic && isSales && company.vatAccountingBasis === 'cash_receipts' && vatMinor !== 0;

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
      // A historic invoice's VAT was declared in the previous system: its
      // whole gross is the migrated balance, with no VAT line here.
      const amount = historic ? calculation.grossMinor : calculation.netMinor;
      if (amount === 0) continue;
      journalLines.push({
        accountId: line.accountId,
        ...(amount >= 0
          ? { creditMinor: amount }
          : { debitMinor: -amount }),
        currency, fxRate, ...counterparty, memo: line.description,
      });
    }
    if (vatMinor !== 0 && !historic) {
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
      const cost = historic
        ? calculation.grossMinor
        : calculation.netMinor + (calculation.vatMinor - calculation.recoverableVatMinor);
      if (cost !== 0) {
        journalLines.push({
          accountId: line.accountId,
          ...(cost >= 0 ? { debitMinor: cost } : { creditMinor: -cost }),
          currency, fxRate, ...counterparty, memo: line.description,
        });
      }
    }
    const recoverable = historic ? 0 : computed.reduce((s, c) => s + c.calculation.recoverableVatMinor, 0);
    if (recoverable !== 0) {
      journalLines.push({
        accountId: vatOnPurchases,
        ...(recoverable >= 0 ? { debitMinor: recoverable } : { creditMinor: -recoverable }),
        currency, fxRate, memo: 'Input VAT',
      });
    }
    // Reverse charge: the same invoice creates an output VAT liability too.
    const reverseChargeVat = historic ? 0 : computed
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

  // A locked or filed VAT return is never changed (issue #226): checked before
  // anything is written, so a refusal leaves no half-posted invoice.
  const vatTaxPoint = determineTaxPoint({
    basis: company.vatAccountingBasis,
    direction: isSales ? 'sales' : 'purchases',
    invoiceDate: input.invoiceDate,
    supplyDate: input.supplyDate,
    paymentDate: input.invoiceDate,
  }).taxPointDate;
  const createsVatNow = !vatDeferred && !historic
    && computed.some((c) => c.calculation.vatMinor !== 0 || c.resolved.treatment.appliesRate);
  if (createsVatNow) {
    assertVatPeriodWritable(db, input.companyId, input.vatDeclarationDate ?? vatTaxPoint,
      `The VAT on ${input.invoiceNumber ? `invoice ${input.invoiceNumber}` : 'this invoice'}`);
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
  if (!vatDeferred && !historic) {
    for (const { line, lineId, calculation, resolved, recoverableOverrideMinor } of computed) {
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
        invoiceLineId: lineId,
        declarationDate: input.vatDeclarationDate ?? undefined,
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

  // ---- Due date and credit limit (issue #392) ----
  // A sales invoice with no due date takes one from its customer's terms; a
  // stated one always wins. Terms of 0 days mean none recorded, not "on receipt".
  const customer = isSales
    ? db.select().from(customers).where(and(eq(customers.id, input.customerId!), eq(customers.companyId, input.companyId))).get()
    : undefined;
  let dueDate: IsoDate | null = input.dueDate ?? null;
  let dueDateSource: 'stated' | 'customer_terms' | 'supplier_terms' | null = dueDate ? 'stated' : null;
  if (!dueDate && customer && customer.defaultPaymentTermsDays > 0) {
    dueDate = addDays(input.invoiceDate, customer.defaultPaymentTermsDays);
    dueDateSource = 'customer_terms';
  }
  // A bill with no due date of its own follows its supplier's terms (issue #410).
  if (!dueDate && !isSales && input.supplierId) {
    const days = db.select({ d: suppliers.defaultPaymentTermsDays }).from(suppliers)
      .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.companyId, input.companyId))).get()?.d ?? 0;
    if (days > 0) {
      dueDate = addDays(input.invoiceDate, days);
      dueDateSource = 'supplier_terms';
    }
  }
  // Over the credit limit is flagged, never refused: it is credit control.
  const warnings: string[] = [];
  let overLimit: { outstanding: number; limit: number } | null = null;
  if (customer && !input.isCreditNote && customer.creditLimitMinor !== null) {
    const outstanding = customerExposure(db, { companyId: input.companyId, customerId: customer.id }).outstandingBaseMinor
      + toBase(grossMinor);
    if (outstanding > customer.creditLimitMinor) {
      overLimit = { outstanding, limit: customer.creditLimitMinor };
      warnings.push(`${customer.name} now owes ${(outstanding / 100).toFixed(2)} ${baseCurrency}, over the `
        + `credit limit of ${(customer.creditLimitMinor / 100).toFixed(2)}. The invoice is posted and flagged.`);
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
      dueDate,
      dueDateSource,
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
      isDebitNote: input.isDebitNote ?? false,
      debitNoteOfId: input.debitNoteOfId ?? null,
      recurringInvoiceId: input.recurring?.templateId ?? null,
      recurringDate: input.recurring?.date ?? null,
      status: 'issued',
      notes: input.notes ?? null,
      source: 'user',
      provenanceStatus: 'manually_entered',
    }).run();

    for (const { line, index, lineId, calculation, resolved, undiscountedNet, discount } of computed) {
      tx.insert(invoiceLines).values({
        id: lineId,
        companyId: input.companyId,
        invoiceId,
        lineNumber: index + 1,
        description: line.description,
        quantityMilli: line.quantityMilli ?? 1000,
        unitPriceMinor: line.unitPriceMinor ?? 0,
        undiscountedNetMinor: discount.minor !== 0 ? undiscountedNet * sign : null,
        discountBasisPoints: discount.basisPoints,
        discountMinor: discount.minor * sign,
        accountId: line.accountId,
        vatTreatmentId: line.vatTreatmentId,
        taxRateId: resolved.rate?.id ?? null,
        rateBasisPoints: calculation.rateBasisPoints,
        netMinor: calculation.netMinor,
        vatMinor: calculation.vatMinor,
        grossMinor: calculation.grossMinor,
        currency,
        fixedAssetId: line.fixedAssetId ?? null,
        documentLineId: line.documentLineId ?? null,
        vatRuleKeys: line.vatRuleKeys ?? [],
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
      reason: historic
        ? `Migrated; VAT already declared elsewhere, recorded for information only: ${historic.reason.trim()}`
        : vatDeferred
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

    if (overLimit && customer) {
      upsertReviewItem(tx, {
        companyId: input.companyId,
        kind: 'other',
        severity: 'warning',
        title: `${customer.name} is over its credit limit`,
        detail: warnings[0]!,
        entityType: 'customer',
        entityId: customer.id,
        dedupeKey: `customer:${customer.id}:over_credit_limit`,
        context: { invoiceId, outstandingMinor: overLimit.outstanding, creditLimitMinor: overLimit.limit },
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
    dueDate,
    warnings,
  };
}

/**
 * The discount on a line (issue #393), in minor units, rounded half away from
 * zero when given as a percentage. Refused when it is not positive, is both a
 * percentage and an amount, or is more than the line.
 */
export function lineDiscount(
  undiscountedNetMinor: number,
  line: Pick<InvoiceLineInput, 'discountBasisPoints' | 'discountMinor'>,
  lineNumber: number,
): { minor: number; basisPoints: number | null } {
  const { discountBasisPoints: bp, discountMinor: amount } = line;
  if (bp === undefined && amount === undefined) return { minor: 0, basisPoints: null };
  if (bp !== undefined && amount !== undefined) {
    throw new InvoicingError(`Line ${lineNumber}: give the discount as a percentage or an amount, not both.`);
  }
  if (bp !== undefined) {
    if (!Number.isInteger(bp) || bp <= 0 || bp > 10_000) {
      throw new InvoicingError(`Line ${lineNumber}: a discount percentage is more than 0% and at most 100%, in basis points.`);
    }
    return { minor: multiplyRational(asMinor(undiscountedNetMinor), bp, 10_000), basisPoints: bp };
  }
  if (!Number.isInteger(amount) || amount! <= 0) {
    throw new InvoicingError(`Line ${lineNumber}: a discount amount is a positive amount in minor units.`);
  }
  if (amount! > undiscountedNetMinor) {
    throw new InvoicingError(`Line ${lineNumber}: the discount (${amount}) is more than the line (${undiscountedNetMinor}).`);
  }
  return { minor: amount!, basisPoints: null };
}

export interface VoidInvoiceInput {
  companyId: string;
  invoiceId: string;
  voidDate: IsoDate;
  /** Mandatory. Recorded in the audit trail and on the invoice itself. */
  reason: string;
  actor?: string;
  requestId?: string;
}

export interface VoidedInvoice {
  invoiceId: string;
  reversalJournalEntryId: string | null;
  reversedVatEntryIds: string[];
}

/**
 * Void an invoice entered in error.
 *
 * Posted journals are immutable (AGENTS.md invariant #2), so this never
 * edits or deletes the original posting. It reverses the invoice's journal
 * entry — debits and credits swapped, dated at `voidDate` rather than the
 * invoice date, so voiding something in a closed period does not reach back
 * into it — and, for each VAT entry the invoice created (both legs of a
 * reverse charge, where one applies), posts an equal-and-opposite entry at
 * the same rate and box, also dated at `voidDate`. The invoice row itself is
 * marked void rather than deleted, so what it originally said is still
 * there.
 *
 * A part-paid or paid invoice is refused rather than silently unwound: its
 * payment allocations would be left pointing at an invoice that no longer
 * owes anything, which is exactly the kind of problem AGENTS.md invariant #7
 * says becomes a review item, not something this function guesses how to
 * fix on its own. Unallocate the payment first.
 */
export function voidInvoice(
  db: AppDatabase, input: Parameters<typeof voidInvoiceSteps>[1],
): ReturnType<typeof voidInvoiceSteps> {
  return atomically(db, () => voidInvoiceSteps(db, input));
}

function voidInvoiceSteps(db: AppDatabase, input: VoidInvoiceInput): VoidedInvoice {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new InvoicingError('Voiding an invoice needs a reason.');
  }

  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, input.companyId)))
    .get();
  if (!invoice) throw new InvoicingError(`Invoice ${input.invoiceId} not found.`);
  if (invoice.status === 'void') {
    throw new InvoicingError(`Invoice ${invoice.invoiceNumber ?? invoice.id} is already void.`);
  }
  if (invoice.status === 'written_off') {
    throw new InvoicingError('This invoice was written off as a bad debt. Reverse the write-off before voiding it.');
  }
  if (invoice.paidMinor !== 0) {
    throw new InvoicingError(
      `Invoice ${invoice.invoiceNumber ?? invoice.id} has ${(invoice.paidMinor / 100).toFixed(2)} `
        + 'allocated against it. Unallocate the payment before voiding it — voiding would '
        + 'otherwise silently leave that allocation pointed at an invoice that owes nothing.',
    );
  }

  const sourceTypeForVat = invoice.direction === 'sales' ? 'sales_invoice' : 'purchase_invoice';
  const hasVatEntries = db.select({ id: vatEntries.id }).from(vatEntries)
    .where(and(
      eq(vatEntries.companyId, input.companyId),
      eq(vatEntries.sourceType, sourceTypeForVat),
      eq(vatEntries.sourceId, invoice.id),
    )).get();
  if (hasVatEntries) {
    // The reversing VAT lands in the period of the void date: never a locked or filed one (issue #226).
    assertVatPeriodWritable(db, input.companyId, input.voidDate,
      `Voiding invoice ${invoice.invoiceNumber ?? invoice.id} reverses its VAT, which`);
  }

  let reversalJournalEntryId: string | null = null;
  if (invoice.journalEntryId) {
    const reversal = reverseJournalEntry(db, {
      companyId: input.companyId,
      entryId: invoice.journalEntryId,
      reversalDate: input.voidDate,
      reason: input.reason,
      createdBy: input.actor ?? 'user',
      requestId: input.requestId,
    });
    reversalJournalEntryId = reversal.id;
  }

  const sourceType = invoice.direction === 'sales' ? 'sales_invoice' : 'purchase_invoice';
  const originalVatEntries = db.select().from(vatEntries)
    .where(and(
      eq(vatEntries.companyId, input.companyId),
      eq(vatEntries.sourceType, sourceType),
      eq(vatEntries.sourceId, invoice.id),
    )).all();
  const period = findVatPeriod(db, input.companyId, input.voidDate);

  const reversedVatEntryIds: string[] = [];

  db.transaction((tx) => {
    for (const entry of originalVatEntries) {
      const reversedId = ids.vatEntry();
      tx.insert(vatEntries).values({
        id: reversedId,
        companyId: input.companyId,
        journalEntryId: reversalJournalEntryId,
        sourceType: entry.sourceType,
        sourceId: invoice.id,
        direction: entry.direction,
        vatTreatmentId: entry.vatTreatmentId,
        taxRateId: entry.taxRateId,
        rateBasisPoints: entry.rateBasisPoints,
        netMinor: -entry.netMinor,
        vatMinor: -entry.vatMinor,
        grossMinor: -entry.grossMinor,
        currency: entry.currency,
        baseNetMinor: -entry.baseNetMinor,
        baseVatMinor: -entry.baseVatMinor,
        baseGrossMinor: -entry.baseGrossMinor,
        baseCurrency: entry.baseCurrency,
        recoverableVatMinor: -entry.recoverableVatMinor,
        baseRecoverableVatMinor: -entry.baseRecoverableVatMinor,
        taxPointDate: input.voidDate,
        vatPeriodId: period?.id ?? null,
        vatBox: entry.vatBox,
        netBox: entry.netBox,
        pairedEntryId: null,
        isReverseChargeLeg: entry.isReverseChargeLeg,
        counterpartyVatNumber: entry.counterpartyVatNumber,
        counterpartyCountry: entry.counterpartyCountry,
        notes: `Reversal of voided invoice ${invoice.invoiceNumber ?? invoice.id}: ${input.reason}`,
        source: 'user',
        provenanceStatus: 'manually_entered',
      }).run();
      reversedVatEntryIds.push(reversedId);
    }

    tx.update(invoices).set({
      status: 'void',
      voidedAt: nowIso(),
      voidReason: input.reason,
      outstandingMinor: 0,
    }).where(eq(invoices.id, invoice.id)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: nowIso(),
      entityType: 'invoice',
      entityId: invoice.id,
      action: 'voided',
      previousValue: JSON.stringify({ status: invoice.status }),
      newValue: JSON.stringify({ status: 'void', reversalJournalEntryId }),
      source: 'user',
      actor: input.actor ?? 'user',
      reason: input.reason,
      requestId: input.requestId ?? null,
    }).run();
  });

  return { invoiceId: invoice.id, reversalJournalEntryId, reversedVatEntryIds };
}

function buildNarrative(db: AppDatabase, input: CreateInvoiceInput, isSales: boolean): string {
  const party = isSales
    ? db.select({ name: customers.name }).from(customers)
        .where(eq(customers.id, input.customerId!)).get()?.name
    : db.select({ name: suppliers.name }).from(suppliers)
        .where(eq(suppliers.id, input.supplierId!)).get()?.name;

  const kind = input.isCreditNote ? 'Credit note' : input.isDebitNote ? 'Debit note' : isSales ? 'Sales invoice' : 'Purchase invoice';
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

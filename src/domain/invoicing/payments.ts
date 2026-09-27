import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  invoices, invoiceLines, payments, paymentAllocations, companies,
  bankTransactions, bankAccounts, auditEvents, companyOfficers, accounts, customers,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asMinor, multiplyRational } from '../money';
import { asIsoDate, nowIso, type IsoDate } from '../dates';
import { postJournalEntry, atomically } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { createVatEntries, assertVatPeriodWritable } from '../vat/engine';
import { upsertReviewItem } from '../extraction/service';
import { InvoicingError } from './invoices';

/**
 * Payments and allocations (README §26).
 *
 * The middle leg of Invoice -> Payment -> BankTransaction, and the point at
 * which the cash receipts basis stops being a setting and starts being
 * arithmetic.
 *
 * On that basis a sales invoice's output VAT sits in a deferred liability until
 * the customer pays. Each payment transfers its proportional share to VAT
 * payable and creates a VAT entry dated at the payment, so a part-payment can
 * legitimately put half an invoice's VAT in one period and half in the next.
 *
 * Proportions are computed cumulatively — the VAT released by this payment is
 * the VAT due on everything paid so far, less the VAT already released — rather
 * than by rounding each payment's share independently. Independent rounding
 * drifts, and the last payment on an invoice would leave a stray cent of VAT
 * permanently deferred.
 */

export interface PaymentAllocationInput {
  invoiceId: string;
  /**
   * In the payment's currency, always as a positive amount of cash — the
   * same whether the target is an invoice or a credit note. A credit note's
   * `outstandingMinor` is negative; this function negates the allocation
   * internally when settling one (issue #157), so a caller never has to
   * know that sign convention to zero a credit note out.
   */
  allocatedMinor: number;
}

/** Why a short-paid invoice's remainder is written off. Chosen, never free text (issue #389). */
export type PaymentWriteOffReason = 'bank_charges' | 'discount' | 'bad_debt';

export interface RecordPaymentInput {
  companyId: string;
  direction: 'received' | 'made';
  paymentDate: IsoDate;
  amountMinor: number;
  currency?: string;
  fxRate?: { numerator: number; denominator: number; source: string; date?: string };
  method?: typeof payments.$inferInsert['method'];
  /** Links the payment to the statement line that evidences it. */
  bankTransactionId?: string | null;
  bankAccountId?: string | null;
  /** Set when a director settled the invoice personally. */
  officerId?: string | null;
  /**
   * Whose money this is (issue #386). Defaults to the one customer or supplier
   * all the allocated invoices belong to; must agree with them when given.
   */
  customerId?: string | null;
  supplierId?: string | null;
  allocations: PaymentAllocationInput[];
  /**
   * Close one allocated invoice by writing off what this payment leaves unpaid
   * (issue #386). The reason is chosen, never free text, because each one has
   * a fixed treatment (issue #389):
   *
   * - `bank_charges` — deducted by the payer's or an intermediary bank. The
   *   customer paid the full consideration, so on the cash receipts basis all
   *   the invoice's deferred output VAT is released at the receipt date and
   *   the shortfall is posted to `accountId` (an income or expense account) as
   *   the business's own cost of being paid, with no VAT in it. Flagged, with
   *   a finding that the collected sources state no Revenue position on it.
   * - `discount` — refused: a reduction or discount needs a credit note
   *   (VATCA s.67(1)(b)), and on the cash receipts basis s.80(5) makes the
   *   VAT due anyway if none is issued.
   * - `bad_debt` — refused: money never received is a bad debt, not a
   *   shortfall of this payment. The bad-debt path clears the deferred VAT
   *   rather than releasing it (#404).
   */
  writeOff?: { invoiceId: string; accountId: string; reason: PaymentWriteOffReason } | null;
  /**
   * Declare the output VAT this receipt releases (cash receipts basis) in the
   * VAT period covering this date, when the receipt's own period is locked or
   * filed (issue #226). Flagged for review.
   */
  vatDeclarationDate?: IsoDate | null;
  reference?: string | null;
  notes?: string | null;
  actor?: string;
  requestId?: string;
}

export interface RecordedPayment {
  paymentId: string;
  journalEntryId: string;
  allocatedMinor: number;
  unallocatedMinor: number;
  /**
   * The output VAT this receipt released, in the base currency: the sum of the
   * base VAT on the VAT entries the payment creates, which is what the VAT3
   * shows. Never a sum across invoice currencies (issue #503).
   */
  vatReleasedBaseMinor: number;
  /** The same release per invoice currency: each invoice's VAT stays in its own currency (issue #503). */
  vatReleasedByCurrency: Array<{ currency: string; minor: number }>;
  vatEntryIds: string[];
  fxDifferenceMinor: number;
  /** The shortfall written off, when `writeOff` was given. */
  writtenOffMinor: number;
  invoiceStatuses: Array<{ invoiceId: string; status: string; outstandingMinor: number }>;
}

export function recordPayment(
  db: AppDatabase, input: Parameters<typeof recordPaymentSteps>[1],
): ReturnType<typeof recordPaymentSteps> {
  return atomically(db, () => recordPaymentSteps(db, input));
}

function recordPaymentSteps(db: AppDatabase, input: RecordPaymentInput): RecordedPayment {
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  if (!company) throw new InvoicingError(`Company ${input.companyId} not found.`);

  const currency = (input.currency ?? company.baseCurrency).toUpperCase();
  const baseCurrency = company.baseCurrency;
  if (currency !== baseCurrency && !input.fxRate) {
    throw new InvoicingError(
      `This payment is in ${currency} but the company's base currency is ${baseCurrency}, `
        + 'and no exchange rate was supplied. A missing rate is an exception, never an '
        + 'assumed 1.0.',
    );
  }
  if (input.amountMinor <= 0) {
    throw new InvoicingError(
      'A payment amount must be positive. Its direction says whether money came in or went out.',
    );
  }

  const isReceived = input.direction === 'received';
  // `toBase` converts a payment-currency amount to base. When the payment is in
  // base currency, no conversion is needed even if an fxRate is present (in the
  // cross-currency case the fxRate converts base to the invoice's currency, not
  // to base). When the payment is foreign, the fxRate is the payment-to-base
  // rate.
  const paymentFx = currency !== baseCurrency ? input.fxRate : undefined;
  const toBase = (amount: number): number =>
    paymentFx
      ? multiplyRational(asMinor(amount), paymentFx.numerator, paymentFx.denominator)
      : amount;

  // ---- Validate allocations ----
  const targets = input.allocations.map((allocation) => {
    const invoice = db.select().from(invoices)
      .where(and(
        eq(invoices.id, allocation.invoiceId),
        eq(invoices.companyId, input.companyId),
      )).get();
    if (!invoice) throw new InvoicingError(`Invoice ${allocation.invoiceId} not found.`);

    if (invoice.status === 'void') {
      throw new InvoicingError(
        `Invoice ${invoice.invoiceNumber ?? invoice.id} has been voided and cannot be paid.`,
      );
    }
    if (invoice.status === 'written_off') {
      throw new InvoicingError(
        `Invoice ${invoice.invoiceNumber ?? invoice.id} was written off as a bad debt. If it is being paid after all, `
          + 'reverse the write-off first (the debt is recovered), then record the payment.',
        { invoiceId: invoice.id },
      );
    }
    const expectedDirection = isReceived ? 'sales' : 'purchase';
    // A credit note reverses the cash flow of its own direction: a sales
    // credit note is settled by a refund going out ('made'), a purchase
    // credit note by a refund coming in ('received') — issue #157. Any other
    // mismatch is still refused.
    if (invoice.direction !== expectedDirection && !invoice.isCreditNote) {
      throw new InvoicingError(
        `A payment ${input.direction} cannot settle a ${invoice.direction} invoice.`,
        { invoiceId: invoice.id },
      );
    }
    // When the invoice and payment are in different currencies, the payment
    // amount is converted to the invoice's currency for allocation. The fxRate
    // supplied here converts one unit of the payment currency into units of the
    // invoice currency. This is scoped to the case where the payment is in the
    // base currency — a three-currency settlement (payment, invoice and base all
    // different) is not handled here.
    const crossCurrency = invoice.currency !== currency;
    if (crossCurrency && !input.fxRate) {
      throw new InvoicingError(
        `Invoice ${invoice.invoiceNumber ?? invoice.id} is in ${invoice.currency} but the `
          + `payment is in ${currency}. Settling across currencies needs a deliberate `
          + 'conversion rather than an implied one.',
        { invoiceId: invoice.id },
      );
    }
    if (crossCurrency && currency !== baseCurrency && invoice.currency !== baseCurrency) {
      throw new InvoicingError(
        `Settling a ${invoice.currency} invoice with a ${currency} payment when the base `
          + `currency is ${baseCurrency} involves three currencies and is not supported. `
          + 'Pay from a base-currency account, or record the payment in the invoice\'s currency.',
        { invoiceId: invoice.id },
      );
    }
    const allocatedMagnitude = crossCurrency && input.fxRate
      ? multiplyRational(asMinor(allocation.allocatedMinor), input.fxRate.numerator, input.fxRate.denominator)
      : allocation.allocatedMinor;
    // A credit note's outstandingMinor is negative (issue #157): the caller's
    // allocatedMinor is always a positive amount of cash, so settling one
    // moves the invoice's own outstanding balance the opposite way from
    // settling an ordinary invoice or bill.
    const invoiceAllocatedMinor = invoice.isCreditNote ? -allocatedMagnitude : allocatedMagnitude;
    const signedAllocatedMinor = invoice.isCreditNote
      ? -allocation.allocatedMinor : allocation.allocatedMinor;

    if (Math.abs(invoiceAllocatedMinor) > Math.abs(invoice.outstandingMinor)) {
      throw new InvoicingError(
        `Allocating ${allocatedMagnitude} to invoice `
          + `${invoice.invoiceNumber ?? invoice.id} exceeds the ${Math.abs(invoice.outstandingMinor)} `
          + 'still outstanding on it. Overpayments must be recorded deliberately, not '
          + 'absorbed into an allocation.',
        { invoiceId: invoice.id, outstandingMinor: invoice.outstandingMinor },
      );
    }
    // Cash this allocation accounts for. A credit note in the same direction as
    // the payment (a supplier's credit note deducted from what we pay them, or
    // our credit note deducted from what a customer pays us) reduces the cash:
    // the payment is net of it (issue #203). A credit note settled by a refund
    // in the opposite direction (issue #157) is cash in its own right.
    const offsetsCash = invoice.isCreditNote && invoice.direction === expectedDirection;
    const cashMinor = offsetsCash ? -allocation.allocatedMinor : allocation.allocatedMinor;
    return {
      invoice, allocatedMinor: allocation.allocatedMinor, invoiceAllocatedMinor,
      signedAllocatedMinor, crossCurrency, cashMinor,
    };
  });

  const allocatedTotal = targets.reduce((s, t) => s + t.cashMinor, 0);
  if (allocatedTotal > input.amountMinor) {
    throw new InvoicingError(
      `Allocations total ${allocatedTotal} but the payment is only ${input.amountMinor}. `
        + 'A payment cannot settle more than it is worth.',
      { allocatedTotal, amountMinor: input.amountMinor },
    );
  }
  if (allocatedTotal < 0) {
    throw new InvoicingError(
      'The credit notes allocated are worth more than the invoices they are netted against, so this '
        + 'would be a refund, not a payment. Record the refund in the direction the money moved.',
    );
  }

  const party = paymentParty(input, targets.map((t) => t.invoice));
  const writeOff = input.writeOff
    ? validateWriteOff(db, input, company, targets, input.amountMinor - allocatedTotal)
    : null;

  const debtors = systemAccountId(db, input.companyId, 'debtors');
  const creditors = systemAccountId(db, input.companyId, 'creditors');
  const vatOnSales = systemAccountId(db, input.companyId, 'vat_on_sales');
  const vatOnSalesDeferred = systemAccountId(db, input.companyId, 'vat_on_sales_deferred');
  const fxAccount = systemAccountId(db, input.companyId, 'fx_gain_loss');

  // ---- Where the money moved ----
  let moneyAccountId: string;
  if (input.officerId) {
    const officer = db.select().from(companyOfficers)
      .where(and(eq(companyOfficers.id, input.officerId), eq(companyOfficers.companyId, input.companyId))).get();
    if (!officer) throw new InvoicingError(`Officer ${input.officerId} not found.`);
    moneyAccountId = officer.currentAccountId
      ?? systemAccountId(db, input.companyId, 'directors_current_account');
  } else if (input.bankTransactionId) {
    const transaction = db.select().from(bankTransactions)
      .where(and(
        eq(bankTransactions.id, input.bankTransactionId),
        eq(bankTransactions.companyId, input.companyId),
      )).get();
    if (!transaction) {
      throw new InvoicingError(`Bank transaction ${input.bankTransactionId} not found.`);
    }
    if (transaction.journalEntryId) {
      throw new InvoicingError(
        'That bank transaction has already been posted on its own. Unpost it before linking '
          + 'it to a payment, otherwise the same money would be recorded twice.',
        { bankTransactionId: transaction.id },
      );
    }
    const account = db.select().from(bankAccounts)
      .where(eq(bankAccounts.id, transaction.bankAccountId)).get();
    moneyAccountId = account?.accountId ?? systemAccountId(db, input.companyId, 'bank_control');
  } else if (input.bankAccountId) {
    const account = db.select().from(bankAccounts)
      .where(eq(bankAccounts.id, input.bankAccountId)).get();
    moneyAccountId = account?.accountId ?? systemAccountId(db, input.companyId, 'bank_control');
  } else {
    moneyAccountId = systemAccountId(db, input.companyId, 'bank_control');
  }

  // ---- Journal ----
  const journalLines: Parameters<typeof postJournalEntry>[1]['lines'] = [];
  const narrative = `${isReceived ? 'Receipt' : 'Payment'} ${input.reference ?? ''}`.trim()
    || (isReceived ? 'Customer receipt' : 'Supplier payment');

  journalLines.push({
    accountId: moneyAccountId,
    ...(isReceived ? { debitMinor: input.amountMinor } : { creditMinor: input.amountMinor }),
    currency, fxRate: paymentFx,
    officerId: input.officerId ?? null,
    memo: narrative,
  });

  let fxDifferenceMinor = 0;
  const allocationDetails: Array<{
    invoiceId: string; allocatedMinor: number;
    baseAllocatedMinor: number; fxDifferenceMinor: number;
    allocationType: 'settlement' | 'write_off'; writeOffAccountId?: string; notes?: string;
  }> = [];

  for (const { invoice, invoiceAllocatedMinor, signedAllocatedMinor, crossCurrency } of targets) {
    // The receivable is relieved at the rate it was booked at, not today's.
    const invoiceFx = invoice.fxRateNumerator && invoice.fxRateDenominator
      ? {
          numerator: invoice.fxRateNumerator,
          denominator: invoice.fxRateDenominator,
          source: invoice.fxRateSource ?? 'invoice',
          date: invoice.fxRateDate ?? undefined,
        }
      : undefined;

    // The debtors/creditors line relieves the invoice in its own currency.
    // For a cross-currency settlement the allocated amount has been converted
    // to the invoice currency; for a same-currency payment it is unchanged.
    // Which control account carries it follows the invoice's own direction,
    // not the payment's — a credit note refund (issue #157) settles a sales
    // invoice's debtors with a payment made, or a purchase invoice's
    // creditors with a payment received. Debit/credit follows the sign of
    // invoiceAllocatedMinor, which is negative exactly when relieving a
    // credit note's negative outstanding.
    const isSalesInvoice = invoice.direction === 'sales';
    const settleControlAccount = isSalesInvoice ? debtors : creditors;
    const positiveSettlement = invoiceAllocatedMinor >= 0;
    journalLines.push({
      accountId: settleControlAccount,
      ...(positiveSettlement === isSalesInvoice
        ? { creditMinor: Math.abs(invoiceAllocatedMinor) }
        : { debitMinor: Math.abs(invoiceAllocatedMinor) }),
      currency: invoice.currency, fxRate: invoiceFx,
      supplierId: invoice.supplierId, customerId: invoice.customerId,
      memo: `Settles ${invoice.invoiceNumber ?? invoice.id}`,
    });

    const baseAtInvoiceRate = invoiceFx
      ? multiplyRational(asMinor(invoiceAllocatedMinor), invoiceFx.numerator, invoiceFx.denominator)
      : invoiceAllocatedMinor;
    const baseAtPaymentRate = toBase(signedAllocatedMinor);
    const difference = baseAtPaymentRate - baseAtInvoiceRate;
    fxDifferenceMinor += difference;

    allocationDetails.push({
      invoiceId: invoice.id,
      allocatedMinor: invoiceAllocatedMinor,
      baseAllocatedMinor: baseAtPaymentRate,
      fxDifferenceMinor: difference,
      allocationType: 'settlement',
    });
  }

  // A shortfall written off (issue #386): the rest of the invoice's control
  // balance goes to the account chosen, so the invoice closes. Base currency
  // only, so the amount needs no conversion.
  if (writeOff) {
    const isSalesInvoice = writeOff.invoice.direction === 'sales';
    const control = isSalesInvoice ? debtors : creditors;
    const memo = `Shortfall on ${writeOff.invoice.invoiceNumber ?? writeOff.invoice.id} written off: ${writeOff.reason}`;
    journalLines.push({
      accountId: isSalesInvoice ? writeOff.accountId : control,
      debitMinor: writeOff.amountMinor, currency: baseCurrency,
      ...(isSalesInvoice ? {} : { supplierId: writeOff.invoice.supplierId, customerId: writeOff.invoice.customerId }),
      memo,
    });
    journalLines.push({
      accountId: isSalesInvoice ? control : writeOff.accountId,
      creditMinor: writeOff.amountMinor, currency: baseCurrency,
      ...(isSalesInvoice ? { supplierId: writeOff.invoice.supplierId, customerId: writeOff.invoice.customerId } : {}),
      memo,
    });
    allocationDetails.push({
      invoiceId: writeOff.invoice.id,
      allocatedMinor: writeOff.amountMinor,
      baseAllocatedMinor: writeOff.amountMinor,
      fxDifferenceMinor: 0,
      allocationType: 'write_off',
      writeOffAccountId: writeOff.accountId,
      notes: writeOff.reason,
    });
  }

  // Settlement at a different rate from the invoice produces a real gain or
  // loss. It is posted separately so FX movement is never mistaken for trading
  // performance (README §22).
  if (fxDifferenceMinor !== 0) {
    const gain = isReceived ? fxDifferenceMinor > 0 : fxDifferenceMinor < 0;
    journalLines.push({
      accountId: fxAccount,
      ...(gain
        ? { creditMinor: Math.abs(fxDifferenceMinor) }
        : { debitMinor: Math.abs(fxDifferenceMinor) }),
      currency: baseCurrency,
      memo: 'Exchange difference on settlement',
    });
  }

  // Unallocated money is a payment on account: still a real movement, but it
  // has not settled anything yet.
  const unallocatedMinor = input.amountMinor - allocatedTotal;
  if (unallocatedMinor !== 0) {
    journalLines.push({
      accountId: isReceived ? debtors : creditors,
      ...(isReceived ? { creditMinor: unallocatedMinor } : { debitMinor: unallocatedMinor }),
      currency, fxRate: paymentFx,
      supplierId: party.supplierId, customerId: party.customerId,
      memo: 'On account, not yet allocated to an invoice',
    });
  }

  // ---- Cash-basis VAT release ----
  // Scoped to sales-direction targets explicitly, not just `isReceived`: a
  // purchase credit note settled by a receipt (issue #157) is also
  // `isReceived`, but the cash receipts basis defers output VAT on sales
  // only (AGENTS.md) — input VAT is never deferred, so this must never run
  // against a purchase-direction target regardless of payment direction.
  // Only an invoice whose VAT was deferred has anything to release. A sales
  // invoice with no VAT at all (an EU or export supply, say) is never deferred:
  // its entry — and the net it reports in ES1/E1 — was created on the invoice,
  // and releasing it again at payment would report the supply twice.
  const salesTargets = targets.filter((t) => t.invoice.direction === 'sales' && t.invoice.vatMinor !== 0)
    .map((t) => (
      // Bank charges deducted from the payment (issue #389): the customer
      // paid the full consideration - the charge is the supplier's own cost
      // of being paid - so the write-off counts as paid and the whole
      // invoice's deferred VAT is released at the receipt date, leaving none
      // stranded.
      writeOff && writeOff.invoice.id === t.invoice.id
        ? { ...t, invoiceAllocatedMinor: t.invoiceAllocatedMinor + writeOff.amountMinor }
        : t
    ));
  const vatReleases = isReceived && company.vatAccountingBasis === 'cash_receipts' && salesTargets.length > 0
    ? computeVatReleases(db, salesTargets)
    : [];

  // The release is reported per invoice currency, never as a sum across
  // currencies (issue #503). The base-currency figure — what the VAT3 shows —
  // is accumulated below from the VAT entries this payment creates.
  const byCurrency = new Map<string, number>();
  for (const release of vatReleases) {
    const invoice = targets.find((t) => t.invoice.id === release.invoiceId)!.invoice;
    byCurrency.set(invoice.currency, (byCurrency.get(invoice.currency) ?? 0) + release.vatMinor);
  }
  const vatReleasedByCurrency = [...byCurrency.entries()]
    .map(([currency, minor]) => ({ currency, minor }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  let vatReleasedBaseMinor = 0;

  // The release journal lines are posted per invoice, in the invoice's own
  // currency at the invoice's booking rate — exactly how the deferral was
  // booked and how the VAT entries below are written (issue #479). Posting
  // the aggregate in the payment's currency at the payment's rate leaves
  // the deferred-VAT control account with a residual that never nets to
  // zero on a cross-currency settlement, and makes the ledger disagree with
  // the VAT3 by construction.
  const releasedByInvoice = new Map<string, number>();
  for (const release of vatReleases) {
    releasedByInvoice.set(release.invoiceId, (releasedByInvoice.get(release.invoiceId) ?? 0) + release.vatMinor);
  }
  for (const [invoiceId, releasedMinor] of releasedByInvoice) {
    if (releasedMinor === 0) continue;
    const target = targets.find((t) => t.invoice.id === invoiceId)!;
    const invoice = target.invoice;
    const releaseFx = invoice.fxRateNumerator && invoice.fxRateDenominator
      ? {
          numerator: invoice.fxRateNumerator,
          denominator: invoice.fxRateDenominator,
          source: invoice.fxRateSource ?? 'invoice',
          date: invoice.fxRateDate ?? undefined,
        }
      : undefined;
    // A credit note's release is negative and releases the opposite way
    // round, mirroring how its deferral was booked.
    const releaseLines = releasedMinor >= 0
      ? { deferred: 'debitMinor' as const, due: 'creditMinor' as const }
      : { deferred: 'creditMinor' as const, due: 'debitMinor' as const };
    journalLines.push({
      accountId: vatOnSalesDeferred,
      [releaseLines.deferred]: Math.abs(releasedMinor),
      currency: invoice.currency, fxRate: releaseFx,
      memo: 'VAT now due following payment (cash receipts basis)',
    });
    journalLines.push({
      accountId: vatOnSales,
      [releaseLines.due]: Math.abs(releasedMinor),
      currency: invoice.currency, fxRate: releaseFx,
      memo: 'VAT now due following payment (cash receipts basis)',
    });
  }

  // A locked or filed VAT return is never changed (issue #226): checked before
  // the journal is posted, so a refusal leaves nothing half-written.
  if (vatReleases.some((r) => r.netMinor !== 0 || r.vatMinor !== 0)) {
    assertVatPeriodWritable(db, input.companyId, input.vatDeclarationDate ?? input.paymentDate,
      'The output VAT this receipt releases');
  }

  const paymentId = ids.payment();

  const journal = postJournalEntry(db, {
    companyId: input.companyId,
    entryDate: input.paymentDate,
    narrative,
    sourceType: 'payment',
    sourceId: paymentId,
    baseCurrency,
    createdBy: input.actor ?? 'user',
    createdVia: 'user',
    requestId: input.requestId,
    lines: journalLines,
  });

  // ---- VAT entries for the released portion ----
  const vatEntryIds: string[] = [];
  for (const release of vatReleases) {
    if (release.netMinor === 0 && release.vatMinor === 0) continue;
    // The release amounts are in the invoice's currency; the rate that
    // converts them to base is the invoice's booking rate, not the payment's.
    const target = targets.find((t) => t.invoice.id === release.invoiceId)!;
    const releaseCurrency = target.invoice.currency;
    const releaseFx = target.invoice.fxRateNumerator && target.invoice.fxRateDenominator
      ? {
          numerator: target.invoice.fxRateNumerator,
          denominator: target.invoice.fxRateDenominator,
        }
      : undefined;
    const created = createVatEntries(db, {
      companyId: input.companyId,
      journalEntryId: journal.id,
      sourceType: 'payment',
      sourceId: paymentId,
      direction: 'sales',
      treatmentId: release.vatTreatmentId,
      rateOverrideId: release.taxRateId ?? undefined,
      invoiceLineId: release.invoiceLineId,
      // The tax point is the payment date. This is the whole point of the basis.
      taxPointDate: input.paymentDate,
      declarationDate: input.vatDeclarationDate ?? undefined,
      netMinor: release.netMinor,
      statedVatMinor: release.vatMinor,
      currency: releaseCurrency,
      baseCurrency,
      fxRate: releaseFx,
      source: 'user',
      provenanceStatus: 'manually_entered',
      notes: `Released by payment on ${input.paymentDate} against invoice ${release.invoiceId}`,
    });
    vatEntryIds.push(...created.entries.map((e) => e.id));
    // The base-currency release: the sum of the base VAT on the VAT entries
    // this payment creates (its sales legs), each converted at its own
    // invoice's booking rate — what the VAT3 shows (issue #503).
    vatReleasedBaseMinor += created.entries
      .filter((e) => e.direction === 'sales')
      .reduce((s, e) => s + e.baseVatMinor, 0);
  }

  // ---- Persist ----
  const timestamp = nowIso();
  const invoiceStatuses: RecordedPayment['invoiceStatuses'] = [];

  db.transaction((tx) => {
    tx.insert(payments).values({
      id: paymentId,
      companyId: input.companyId,
      direction: input.direction,
      paymentDate: input.paymentDate,
      amountMinor: input.amountMinor,
      currency,
      baseAmountMinor: toBase(input.amountMinor),
      baseCurrency,
      fxRateNumerator: paymentFx?.numerator ?? null,
      fxRateDenominator: paymentFx?.denominator ?? null,
      method: input.method ?? (input.officerId ? 'director_personal' : 'bank_transfer'),
      bankTransactionId: input.bankTransactionId ?? null,
      supplierId: party.supplierId,
      customerId: party.customerId,
      officerId: input.officerId ?? null,
      journalEntryId: journal.id,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      source: 'user',
      provenanceStatus: 'manually_entered',
    }).run();

    const paidSoFar = new Map<string, number>();
    for (const detail of allocationDetails) {
      const target = targets.find((t) => t.invoice.id === detail.invoiceId)!;
      tx.insert(paymentAllocations).values({
        id: ids.allocation(),
        companyId: input.companyId,
        paymentId,
        invoiceId: detail.invoiceId,
        allocatedMinor: detail.allocatedMinor,
        baseAllocatedMinor: detail.baseAllocatedMinor,
        currency: target.invoice.currency,
        fxDifferenceMinor: detail.fxDifferenceMinor,
        allocationType: detail.allocationType,
        writeOffAccountId: detail.writeOffAccountId ?? null,
        notes: detail.notes ?? null,
      }).run();

      const invoice = target.invoice;
      const paidMinor = (paidSoFar.get(invoice.id) ?? invoice.paidMinor) + detail.allocatedMinor;
      paidSoFar.set(invoice.id, paidMinor);
      const outstandingMinor = invoice.grossMinor - paidMinor;
      const status = outstandingMinor === 0 ? 'paid'
        : paidMinor === 0 ? 'issued' : 'part_paid';

      tx.update(invoices).set({ paidMinor, outstandingMinor, status, updatedAt: timestamp })
        .where(eq(invoices.id, detail.invoiceId)).run();

      const earlier = invoiceStatuses.findIndex((s) => s.invoiceId === detail.invoiceId);
      if (earlier >= 0) invoiceStatuses.splice(earlier, 1);
      invoiceStatuses.push({ invoiceId: detail.invoiceId, status, outstandingMinor });
    }

    if (input.bankTransactionId) {
      tx.update(bankTransactions).set({
        journalEntryId: journal.id,
        status: 'posted',
        source: 'user',
        provenanceStatus: 'user_confirmed',
        updatedAt: timestamp,
      }).where(eq(bankTransactions.id, input.bankTransactionId)).run();
    }

    // Money held on account for a cash-basis trader (issue #389): whether it
    // was received "in respect of taxable supplies" decides if its VAT was
    // due the moment it arrived (s.80(1)). The books cannot tell, so it is
    // flagged the moment it is held, and the item says what to do.
    if (unallocatedMinor > 0 && isReceived && company.vatAccountingBasis === 'cash_receipts' && party.customerId) {
      const customerName = db.select({ n: customers.name }).from(customers)
        .where(eq(customers.id, party.customerId)).get()?.n ?? 'the customer';
      upsertReviewItem(tx, {
        companyId: input.companyId,
        kind: 'uncertain_vat_treatment',
        severity: 'warning',
        title: `${(unallocatedMinor / 100).toFixed(2)} received on account from ${customerName} on ${input.paymentDate}`,
        detail: `On the cash receipts basis, VAT on money received "in respect of taxable supplies" is due in the `
          + `period it arrived (VATCA s.80(1)), not the period it is applied to an invoice. If this pays for a `
          + `supply, apply it to the invoice and its output VAT is declared with the tax point of `
          + `${input.paymentDate}; if it is a genuine overpayment, refund it and no VAT is due. Decide which it is.`,
        entityType: 'payment', entityId: paymentId,
        dedupeKey: `payment:${paymentId}:on_account_vat`,
      });
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'payment',
      entityId: paymentId,
      action: 'created',
      newValue: JSON.stringify({
        direction: input.direction, paymentDate: input.paymentDate,
        amountMinor: input.amountMinor, currency,
        vatReleasedBaseMinor, baseCurrency, vatReleasedByCurrency,
        allocations: allocationDetails.length,
        fxDifferenceMinor,
        ...(writeOff ? { writtenOffMinor: writeOff.amountMinor, writeOffAccountId: writeOff.accountId } : {}),
      }),
      source: 'user',
      actor: input.actor ?? 'user',
      reason: writeOff
        ? `Shortfall written off: ${writeOff.reason}`
        : vatReleasedByCurrency.some((r) => r.minor !== 0)
          ? 'VAT became due on receipt under the cash receipts basis'
          : null,
      requestId: input.requestId ?? null,
    }).run();
  });

  return {
    paymentId,
    journalEntryId: journal.id,
    allocatedMinor: allocatedTotal,
    unallocatedMinor,
    vatReleasedBaseMinor,
    vatReleasedByCurrency,
    vatEntryIds,
    fxDifferenceMinor,
    writtenOffMinor: writeOff?.amountMinor ?? 0,
    invoiceStatuses,
  };
}

/** The one customer or supplier a payment's money belongs to, if there is one (issue #386). */
function paymentParty(
  input: RecordPaymentInput, allocated: Array<typeof invoices.$inferSelect>,
): { customerId: string | null; supplierId: string | null } {
  const customers = new Set(allocated.map((i) => i.customerId));
  const suppliers = new Set(allocated.map((i) => i.supplierId));
  const derived = {
    customerId: customers.size === 1 && suppliers.size === 1 && suppliers.has(null) ? [...customers][0]! : null,
    supplierId: suppliers.size === 1 && customers.size === 1 && customers.has(null) ? [...suppliers][0]! : null,
  };
  if (input.customerId || input.supplierId) {
    const mismatch = allocated.find((i) =>
      (input.customerId && i.customerId !== input.customerId)
      || (input.supplierId && i.supplierId !== input.supplierId));
    if (mismatch) {
      throw new InvoicingError(
        `Invoice ${mismatch.invoiceNumber ?? mismatch.id} belongs to another party than the one this payment is from.`,
        { invoiceId: mismatch.id },
      );
    }
    return { customerId: input.customerId ?? null, supplierId: input.supplierId ?? null };
  }
  return derived;
}

/**
 * A shortfall write-off is allowed only when it is plainly what it says:
 * one ordinary invoice in base currency, the payment fully applied, something
 * actually left unpaid, an income or expense account to take it, and one of
 * the three reasons, each with a fixed treatment (issues #386, #389).
 */
function validateWriteOff(
  db: AppDatabase,
  input: RecordPaymentInput,
  company: typeof companies.$inferSelect,
  targets: Array<{ invoice: typeof invoices.$inferSelect; invoiceAllocatedMinor: number }>,
  unallocatedMinor: number,
): { invoice: typeof invoices.$inferSelect; accountId: string; amountMinor: number; reason: PaymentWriteOffReason } {
  const spec = input.writeOff!;
  const reason = (spec.reason ?? '').trim();
  if (!reason) {
    throw new InvoicingError(
      'Say why the shortfall is written off: bank or transfer charges deducted from the payment, a discount, '
        + 'or a bad debt. Each has a different treatment.',
    );
  }
  if (reason !== 'bank_charges' && reason !== 'discount' && reason !== 'bad_debt') {
    throw new InvoicingError(
      `Unknown write-off reason "${reason}". Say bank_charges, discount or bad_debt (issue #389).`,
    );
  }
  if (reason === 'discount') {
    throw new InvoicingError(
      'A discount taken is a reduction of the price, so it needs a credit note (VATCA s.67(1)(b)) - the '
        + 'supplier cannot simply write the shortfall off. On the cash receipts basis s.80(5) makes the VAT on '
        + 'the discount due anyway if no credit note is issued. Issue the credit note first, then settle '
        + 'against it (issue #389).',
    );
  }
  if (reason === 'bad_debt') {
    throw new InvoicingError(
      'Money that was never received is a bad debt, not a shortfall of this payment. Record it on the bad-debt '
        + 'path (write the invoice off as a bad debt), which charges bad debts and, on the cash receipts basis, '
        + 'clears the deferred VAT rather than releasing it (issue #404, #389).',
    );
  }
  const target = targets.find((t) => t.invoice.id === spec.invoiceId);
  if (!target) throw new InvoicingError('The invoice whose shortfall is written off must be one this payment settles.');
  const invoice = target.invoice;
  if (invoice.isCreditNote) throw new InvoicingError('A credit note has no shortfall to write off.');
  const base = company.baseCurrency.toUpperCase();
  if (invoice.currency.toUpperCase() !== base || (input.currency ?? base).toUpperCase() !== base) {
    throw new InvoicingError(
      `Writing off a shortfall is supported in ${base} only for now. For a foreign-currency invoice, `
        + 'record the difference as a journal and leave the invoice part-paid, or ask for a credit note.',
    );
  }
  if (unallocatedMinor !== 0) {
    throw new InvoicingError(
      'Some of this payment is not applied to any invoice. Apply it before writing off a shortfall: '
        + 'an invoice cannot be both short-paid and have money left over.',
    );
  }
  const amountMinor = Math.abs(invoice.outstandingMinor) - Math.abs(target.invoiceAllocatedMinor);
  if (amountMinor <= 0) throw new InvoicingError('This payment settles the invoice in full; there is nothing to write off.');
  const account = db.select().from(accounts)
    .where(and(eq(accounts.id, spec.accountId), eq(accounts.companyId, input.companyId))).get();
  if (!account) throw new InvoicingError(`Account ${spec.accountId} not found.`);
  if (account.type !== 'income' && account.type !== 'expense') {
    throw new InvoicingError(
      `${account.code} ${account.name} is not an income or expense account. A shortfall written off is a cost `
        + '(bank charges, discount allowed) or a gain (discount received).',
    );
  }
  return { invoice, accountId: account.id, amountMinor, reason };
}

export interface VatRelease {
  invoiceId: string;
  /** The invoice line the release is proportional to, so the VAT entry traces back to it. */
  invoiceLineId: string;
  vatTreatmentId: string;
  taxRateId: string | null;
  netMinor: number;
  vatMinor: number;
}

/**
 * How much of each invoice line's VAT this payment makes due.
 *
 * Computed cumulatively: the VAT due on everything paid so far, less what has
 * already been released. Rounding each payment's share in isolation drifts, and
 * the final payment on an invoice would leave a stray cent deferred for ever.
 * This way the releases always sum to exactly the invoice's VAT once it is
 * fully paid, which is asserted in the tests.
 */
export function computeVatReleases(
  db: AppDatabase,
  targets: Array<{ invoice: typeof invoices.$inferSelect; invoiceAllocatedMinor: number }>,
): VatRelease[] {
  const releases: VatRelease[] = [];

  for (const { invoice, invoiceAllocatedMinor } of targets) {
    if (invoice.grossMinor === 0) continue;

    const lines = db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id))
      .orderBy(invoiceLines.lineNumber).all();

    const paidBefore = invoice.paidMinor;
    const paidAfter = paidBefore + invoiceAllocatedMinor;

    for (const line of lines) {
      if (!line.vatTreatmentId) continue;

      const share = (amount: number, paid: number): number =>
        amount === 0 ? 0 : multiplyRational(asMinor(amount), paid, invoice.grossMinor);

      const vatMinor = share(line.vatMinor, paidAfter) - share(line.vatMinor, paidBefore);
      const netMinor = share(line.netMinor, paidAfter) - share(line.netMinor, paidBefore);

      if (vatMinor === 0 && netMinor === 0) continue;

      releases.push({
        invoiceId: invoice.id,
        invoiceLineId: line.id,
        vatTreatmentId: line.vatTreatmentId,
        taxRateId: line.taxRateId,
        netMinor,
        vatMinor,
      });
    }
  }

  return releases;
}

/** Outstanding invoices, for the aged listings and the allocation picker. */
export function outstandingInvoices(
  db: AppDatabase,
  params: { companyId: string; direction: 'sales' | 'purchase'; asOf?: IsoDate },
): Array<typeof invoices.$inferSelect> {
  const rows = db.select().from(invoices)
    .where(and(
      eq(invoices.companyId, params.companyId),
      eq(invoices.direction, params.direction),
    ))
    .orderBy(invoices.invoiceDate).all();

  return rows.filter((invoice) =>
    invoice.outstandingMinor !== 0
    && invoice.status !== 'void'
    && (!params.asOf || invoice.invoiceDate <= params.asOf));
}

/** Age outstanding invoices into the buckets an accountant expects. */
export function agedAnalysis(
  db: AppDatabase,
  params: { companyId: string; direction: 'sales' | 'purchase'; asOf: IsoDate },
): {
  buckets: Array<{ label: string; amountMinor: number; count: number }>;
  totalMinor: number;
  rows: Array<{ invoice: typeof invoices.$inferSelect; daysOverdue: number; bucket: string }>;
} {
  const open = outstandingInvoices(db, params);
  const bucketLabels = ['Not yet due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'];
  const buckets = bucketLabels.map((label) => ({ label, amountMinor: 0, count: 0 }));

  const rows = open.map((invoice) => {
    const due = invoice.dueDate ?? invoice.invoiceDate;
    const daysOverdue = daysBetweenDates(due, params.asOf);
    const index = daysOverdue <= 0 ? 0
      : daysOverdue <= 30 ? 1
      : daysOverdue <= 60 ? 2
      : daysOverdue <= 90 ? 3
      : 4;
    buckets[index]!.amountMinor += invoice.outstandingMinor;
    buckets[index]!.count += 1;
    return { invoice, daysOverdue, bucket: bucketLabels[index]! };
  });

  return {
    buckets,
    totalMinor: buckets.reduce((s, b) => s + b.amountMinor, 0),
    rows,
  };
}

function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

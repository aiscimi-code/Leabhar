import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  invoices, invoiceLines, payments, paymentAllocations, companies,
  bankTransactions, bankAccounts, auditEvents, companyOfficers,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asMinor, multiplyRational } from '../money';
import { asIsoDate, nowIso, type IsoDate } from '../dates';
import { postJournalEntry } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { createVatEntries } from '../vat/engine';
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
  /** In the payment's currency. */
  allocatedMinor: number;
}

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
  allocations: PaymentAllocationInput[];
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
  vatReleasedMinor: number;
  vatEntryIds: string[];
  fxDifferenceMinor: number;
  invoiceStatuses: Array<{ invoiceId: string; status: string; outstandingMinor: number }>;
}

export function recordPayment(db: AppDatabase, input: RecordPaymentInput): RecordedPayment {
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
  const toBase = (amount: number): number =>
    input.fxRate
      ? multiplyRational(asMinor(amount), input.fxRate.numerator, input.fxRate.denominator)
      : amount;

  // ---- Validate allocations ----
  const allocatedTotal = input.allocations.reduce((s, a) => s + a.allocatedMinor, 0);
  if (allocatedTotal > input.amountMinor) {
    throw new InvoicingError(
      `Allocations total ${allocatedTotal} but the payment is only ${input.amountMinor}. `
        + 'A payment cannot settle more than it is worth.',
      { allocatedTotal, amountMinor: input.amountMinor },
    );
  }

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
    const expectedDirection = isReceived ? 'sales' : 'purchase';
    if (invoice.direction !== expectedDirection) {
      throw new InvoicingError(
        `A payment ${input.direction} cannot settle a ${invoice.direction} invoice.`,
        { invoiceId: invoice.id },
      );
    }
    if (allocation.allocatedMinor > invoice.outstandingMinor) {
      throw new InvoicingError(
        `Allocating ${allocation.allocatedMinor} to invoice `
          + `${invoice.invoiceNumber ?? invoice.id} exceeds the ${invoice.outstandingMinor} `
          + 'still outstanding on it. Overpayments must be recorded deliberately, not '
          + 'absorbed into an allocation.',
        { invoiceId: invoice.id, outstandingMinor: invoice.outstandingMinor },
      );
    }
    if (invoice.currency !== currency) {
      throw new InvoicingError(
        `Invoice ${invoice.invoiceNumber ?? invoice.id} is in ${invoice.currency} but the `
          + `payment is in ${currency}. Settling across currencies needs a deliberate `
          + 'conversion rather than an implied one.',
        { invoiceId: invoice.id },
      );
    }
    return { invoice, allocatedMinor: allocation.allocatedMinor };
  });

  const debtors = systemAccountId(db, input.companyId, 'debtors');
  const creditors = systemAccountId(db, input.companyId, 'creditors');
  const vatOnSales = systemAccountId(db, input.companyId, 'vat_on_sales');
  const vatOnSalesDeferred = systemAccountId(db, input.companyId, 'vat_on_sales_deferred');
  const fxAccount = systemAccountId(db, input.companyId, 'fx_gain_loss');

  // ---- Where the money moved ----
  let moneyAccountId: string;
  if (input.officerId) {
    const officer = db.select().from(companyOfficers)
      .where(eq(companyOfficers.id, input.officerId)).get();
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
  const paymentFx = input.fxRate;
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
  }> = [];

  for (const { invoice, allocatedMinor } of targets) {
    // The receivable is relieved at the rate it was booked at, not today's.
    const invoiceFx = invoice.fxRateNumerator && invoice.fxRateDenominator
      ? {
          numerator: invoice.fxRateNumerator,
          denominator: invoice.fxRateDenominator,
          source: invoice.fxRateSource ?? 'invoice',
          date: invoice.fxRateDate ?? undefined,
        }
      : undefined;

    journalLines.push({
      accountId: isReceived ? debtors : creditors,
      ...(isReceived ? { creditMinor: allocatedMinor } : { debitMinor: allocatedMinor }),
      currency, fxRate: invoiceFx,
      supplierId: invoice.supplierId, customerId: invoice.customerId,
      memo: `Settles ${invoice.invoiceNumber ?? invoice.id}`,
    });

    const baseAtInvoiceRate = invoiceFx
      ? multiplyRational(asMinor(allocatedMinor), invoiceFx.numerator, invoiceFx.denominator)
      : allocatedMinor;
    const baseAtPaymentRate = toBase(allocatedMinor);
    const difference = baseAtPaymentRate - baseAtInvoiceRate;
    fxDifferenceMinor += difference;

    allocationDetails.push({
      invoiceId: invoice.id,
      allocatedMinor,
      baseAllocatedMinor: baseAtPaymentRate,
      fxDifferenceMinor: difference,
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
      memo: 'On account, not yet allocated to an invoice',
    });
  }

  // ---- Cash-basis VAT release ----
  const vatReleases = isReceived && company.vatAccountingBasis === 'cash_receipts'
    ? computeVatReleases(db, targets)
    : [];

  const vatReleasedMinor = vatReleases.reduce((s, r) => s + r.vatMinor, 0);
  if (vatReleasedMinor !== 0) {
    journalLines.push({
      accountId: vatOnSalesDeferred,
      debitMinor: vatReleasedMinor,
      currency, fxRate: paymentFx,
      memo: 'VAT now due following payment (cash receipts basis)',
    });
    journalLines.push({
      accountId: vatOnSales,
      creditMinor: vatReleasedMinor,
      currency, fxRate: paymentFx,
      memo: 'VAT now due following payment (cash receipts basis)',
    });
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
    const created = createVatEntries(db, {
      companyId: input.companyId,
      journalEntryId: journal.id,
      sourceType: 'payment',
      sourceId: paymentId,
      direction: 'sales',
      treatmentId: release.vatTreatmentId,
      rateOverrideId: release.taxRateId ?? undefined,
      // The tax point is the payment date. This is the whole point of the basis.
      taxPointDate: input.paymentDate,
      netMinor: release.netMinor,
      statedVatMinor: release.vatMinor,
      currency,
      baseCurrency,
      fxRate: input.fxRate
        ? { numerator: input.fxRate.numerator, denominator: input.fxRate.denominator }
        : undefined,
      source: 'user',
      provenanceStatus: 'manually_entered',
      notes: `Released by payment on ${input.paymentDate} against invoice ${release.invoiceId}`,
    });
    vatEntryIds.push(...created.entries.map((e) => e.id));
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
      fxRateNumerator: input.fxRate?.numerator ?? null,
      fxRateDenominator: input.fxRate?.denominator ?? null,
      method: input.method ?? (input.officerId ? 'director_personal' : 'bank_transfer'),
      bankTransactionId: input.bankTransactionId ?? null,
      officerId: input.officerId ?? null,
      journalEntryId: journal.id,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      source: 'user',
      provenanceStatus: 'manually_entered',
    }).run();

    for (const detail of allocationDetails) {
      tx.insert(paymentAllocations).values({
        id: ids.allocation(),
        companyId: input.companyId,
        paymentId,
        invoiceId: detail.invoiceId,
        allocatedMinor: detail.allocatedMinor,
        baseAllocatedMinor: detail.baseAllocatedMinor,
        currency,
        fxDifferenceMinor: detail.fxDifferenceMinor,
      }).run();

      const invoice = targets.find((t) => t.invoice.id === detail.invoiceId)!.invoice;
      const paidMinor = invoice.paidMinor + detail.allocatedMinor;
      const outstandingMinor = invoice.grossMinor - paidMinor;
      const status = outstandingMinor === 0 ? 'paid'
        : paidMinor === 0 ? 'issued' : 'part_paid';

      tx.update(invoices).set({ paidMinor, outstandingMinor, status, updatedAt: timestamp })
        .where(eq(invoices.id, detail.invoiceId)).run();

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
        allocations: allocationDetails.length,
        vatReleasedMinor, fxDifferenceMinor,
      }),
      source: 'user',
      actor: input.actor ?? 'user',
      reason: vatReleasedMinor !== 0
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
    vatReleasedMinor,
    vatEntryIds,
    fxDifferenceMinor,
    invoiceStatuses,
  };
}

interface VatRelease {
  invoiceId: string;
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
function computeVatReleases(
  db: AppDatabase,
  targets: Array<{ invoice: typeof invoices.$inferSelect; allocatedMinor: number }>,
): VatRelease[] {
  const releases: VatRelease[] = [];

  for (const { invoice, allocatedMinor } of targets) {
    if (invoice.grossMinor === 0) continue;

    const lines = db.select().from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id))
      .orderBy(invoiceLines.lineNumber).all();

    const paidBefore = invoice.paidMinor;
    const paidAfter = paidBefore + allocatedMinor;

    for (const line of lines) {
      if (!line.vatTreatmentId) continue;

      const share = (amount: number, paid: number): number =>
        amount === 0 ? 0 : multiplyRational(asMinor(amount), paid, invoice.grossMinor);

      const vatMinor = share(line.vatMinor, paidAfter) - share(line.vatMinor, paidBefore);
      const netMinor = share(line.netMinor, paidAfter) - share(line.netMinor, paidBefore);

      if (vatMinor === 0 && netMinor === 0) continue;

      releases.push({
        invoiceId: invoice.id,
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

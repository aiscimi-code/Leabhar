import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { invoices, invoiceLines, companies, accounts, auditEvents, journalLines, vatTreatments } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, type IsoDate } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { postJournalEntry, reverseJournalEntry, atomically, withFxRoundingLine, type JournalLineInput } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { upsertReviewItem } from '../extraction/service';
import { InvoicingError } from './invoices';
import { invoiceVatDeferred } from '../vat/basis';
import { createAdjustment } from '../accounting/adjustments';

/**
 * Bad debts (issue #404).
 *
 * Writing off a sales invoice takes what is still outstanding out of debtors
 * and charges it to bad debts, dated when the debt is judged irrecoverable.
 *
 * What happens to the VAT in it depends on the basis:
 * - Cash receipts basis: the unpaid share of the invoice's output VAT was never
 *   due — it is still in deferred VAT — so it is cancelled against deferred
 *   VAT, and only the net goes to bad debts. No VAT return is touched.
 * - Invoice basis: the VAT was declared when the invoice was raised. Bad-debt
 *   relief (VATCA s.39(2), S.I. 639/2010 reg.10) has conditions a person must
 *   judge, so nothing is claimed by the write-off: the gross goes to bad
 *   debts, and a review item says relief may be available. The person claims
 *   it afterwards with `claimBadDebtRelief` (issue #620).
 *
 * A write-off is reversed, not edited: if the customer pays after all, the
 * reversing journal restores the debtor and the invoice is open again.
 */

type Invoice = typeof invoices.$inferSelect;

function load(db: AppDatabase, companyId: string, invoiceId: string): Invoice {
  const invoice = db.select().from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId))).get();
  if (!invoice) throw new InvoicingError(`Invoice ${invoiceId} not found.`);
  return invoice;
}

/**
 * The share of an invoice's output VAT that is still deferred: its VAT less
 * what receipts have released, computed per line the way the release is
 * (cumulatively on the amount paid), so the two sum to exactly the invoice's
 * VAT.
 */
function deferredVatRemaining(db: AppDatabase, invoice: Invoice): number {
  if (invoice.grossMinor === 0) return 0;
  const lines = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).all();
  return lines.reduce((sum, line) => sum + line.vatMinor
    - (line.vatMinor === 0 ? 0 : multiplyRational(asMinor(line.vatMinor), invoice.paidMinor, invoice.grossMinor)), 0);
}

export function writeOffBadDebt(
  db: AppDatabase,
  params: {
    companyId: string; invoiceId: string; date: IsoDate; reason: string; actor: string;
    /** An expense account to charge instead of the bad debts system account. */
    accountId?: string | null; requestId?: string;
  },
): { journalEntryId: string; writtenOffMinor: number; vatCancelledMinor: number } {
  return atomically(db, () => {
    const actor = params.actor.trim();
    const reason = params.reason.trim();
    if (!actor) throw new InvoicingError('Say who is writing this debt off.');
    if (!reason) throw new InvoicingError('Say why the debt is irrecoverable.');
    const invoice = load(db, params.companyId, params.invoiceId);
    const label = invoice.invoiceNumber ?? invoice.id;
    if (invoice.direction !== 'sales') throw new InvoicingError('Only a debt owed to the business (a sales invoice) is written off as a bad debt.');
    if (invoice.isCreditNote) throw new InvoicingError('A credit note is not a debt.');
    if (invoice.status === 'void') throw new InvoicingError(`Invoice ${label} has been voided.`);
    if (invoice.status === 'written_off') throw new InvoicingError(`Invoice ${label} has already been written off.`);
    if (invoice.outstandingMinor <= 0) throw new InvoicingError(`Invoice ${label} has nothing outstanding.`);
    if (params.date < invoice.invoiceDate) throw new InvoicingError('A debt cannot be written off before the invoice was raised.');

    const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
    let chargeId: string;
    if (params.accountId) {
      const account = db.select().from(accounts)
        .where(and(eq(accounts.id, params.accountId), eq(accounts.companyId, params.companyId))).get();
      if (!account || account.type !== 'expense') throw new InvoicingError('A bad debt is charged to an expense account.');
      chargeId = account.id;
    } else {
      try {
        chargeId = systemAccountId(db, params.companyId, 'bad_debts');
      } catch {
        throw new InvoicingError('This book has no bad debts account (its code 6230 is used for something else). Choose the expense account to charge.');
      }
    }

    const cashBasis = invoiceVatDeferred(db, invoice);
    const vatCancelled = cashBasis ? deferredVatRemaining(db, invoice) : 0;
    const amount = invoice.outstandingMinor;
    const fx = invoice.fxRateNumerator && invoice.fxRateDenominator
      ? { numerator: invoice.fxRateNumerator, denominator: invoice.fxRateDenominator, source: invoice.fxRateSource ?? 'invoice' }
      : undefined;
    const memo = `Bad debt written off: ${label} — ${reason}`;
    const lines: JournalLineInput[] = [
      { accountId: chargeId, debitMinor: amount - vatCancelled, currency: invoice.currency, fxRate: fx, memo },
      ...(vatCancelled !== 0 ? [{
        accountId: systemAccountId(db, params.companyId, 'vat_on_sales_deferred'), debitMinor: vatCancelled,
        currency: invoice.currency, fxRate: fx, memo: `Deferred VAT never due on ${label} (cash receipts basis)`,
      }] : []),
      {
        accountId: systemAccountId(db, params.companyId, 'debtors'), creditMinor: amount,
        currency: invoice.currency, fxRate: fx, customerId: invoice.customerId, memo,
      },
    ];
    const journal = postJournalEntry(db, {
      companyId: params.companyId, entryDate: params.date, narrative: memo.slice(0, 200),
      sourceType: 'sales_invoice', sourceId: invoice.id, entryType: 'adjustment',
      baseCurrency: company.baseCurrency, createdBy: actor, createdVia: 'user', requestId: params.requestId,
      // Each line converted on its own can leave base totals a cent apart (#639).
      lines: invoice.currency === company.baseCurrency
        ? lines
        : withFxRoundingLine(lines, company.baseCurrency, systemAccountId(db, params.companyId, 'rounding_difference')),
    });

    const timestamp = nowIso();
    db.update(invoices).set({
      status: 'written_off', outstandingMinor: 0, writtenOffMinor: amount,
      writtenOffJournalEntryId: journal.id, writtenOffAt: params.date, writeOffReason: reason, updatedAt: timestamp,
    }).where(eq(invoices.id, invoice.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'invoice', entityId: invoice.id, action: 'updated', field: 'status',
      previousValue: JSON.stringify(invoice.status), newValue: JSON.stringify('written_off'),
      source: 'user', actor, reason, requestId: params.requestId ?? null,
    }).run();

    upsertReviewItem(db, {
      companyId: params.companyId, kind: 'uncertain_vat_treatment', severity: 'warning',
      title: `Bad debt written off: ${label}`,
      detail: cashBasis
        ? `The unpaid share of its output VAT (${(vatCancelled / 100).toFixed(2)}) was never due on the cash receipts basis `
          + 'and has been cancelled from deferred VAT; no VAT return changes. If the customer pays later, reverse the write-off.'
        : `The ${(amount / 100).toFixed(2)} written off includes output VAT already declared. Bad-debt relief (VATCA s.39) may `
          + 'let it be reclaimed once the conditions in S.I. 639/2010 reg.10(3) are met; nothing has been claimed. Decide with '
          + 'your accountant, then claim the relief on this invoice.',
      entityType: 'invoice', entityId: invoice.id, dedupeKey: `invoice:${invoice.id}:bad_debt`,
    });
    return { journalEntryId: journal.id, writtenOffMinor: amount, vatCancelledMinor: vatCancelled };
  });
}

/** The debt recovered after all: reverse the write-off and reopen the invoice. */
export function reverseBadDebtWriteOff(
  db: AppDatabase,
  params: { companyId: string; invoiceId: string; date: IsoDate; reason: string; actor: string; requestId?: string },
): { reversalJournalEntryId: string; outstandingMinor: number } {
  return atomically(db, () => {
    const invoice = load(db, params.companyId, params.invoiceId);
    if (invoice.status !== 'written_off' || !invoice.writtenOffJournalEntryId) {
      throw new InvoicingError('This invoice has not been written off.');
    }
    if (!params.reason.trim()) throw new InvoicingError('Say why the write-off is being reversed.');
    // reg.10(10): relief was claimed, so the tax on what is recovered is due
    // again in the period it is recovered. Reversing the write-off restores
    // the whole debt, so the whole relief is charged back, before the
    // write-off is undone: a locked VAT period refuses the reversal outright.
    const reliefRepaid = invoice.badDebtReliefJournalEntryId
      ? repayBadDebtRelief(db, invoice, params) : null;
    const reversal = reverseJournalEntry(db, {
      companyId: params.companyId, entryId: invoice.writtenOffJournalEntryId, reversalDate: params.date,
      reason: params.reason, createdBy: params.actor, requestId: params.requestId,
    });
    const outstanding = invoice.grossMinor - invoice.paidMinor;
    const timestamp = nowIso();
    db.update(invoices).set({
      status: invoice.paidMinor === 0 ? 'issued' : 'part_paid', outstandingMinor: outstanding,
      writtenOffMinor: 0, writtenOffJournalEntryId: null, writtenOffAt: null, writeOffReason: null,
      badDebtReliefMinor: 0, badDebtReliefJournalEntryId: null, badDebtReliefClaimedAt: null, updatedAt: timestamp,
    }).where(eq(invoices.id, invoice.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'invoice', entityId: invoice.id, action: 'reversal_posted', field: 'status',
      previousValue: JSON.stringify('written_off'),
      newValue: JSON.stringify({ reversalJournalEntryId: reversal.id, ...(reliefRepaid ? { reliefRepaid } : {}) }),
      source: 'user', actor: params.actor, reason: params.reason, requestId: params.requestId ?? null,
    }).run();
    return {
      reversalJournalEntryId: reversal.id, outstandingMinor: outstanding,
      ...(reliefRepaid ? { reliefRepaidJournalEntryId: reliefRepaid.journalEntryId, reliefRepaidMinor: reliefRepaid.vatMinor } : {}),
    };
  });
}

/**
 * The facts S.I. 639/2010 reg.10 and VATCA s.39(3) turn on. A person states
 * each one; none can be read from the books.
 */
export interface BadDebtReliefFacts {
  /** reg.10(3)(a): all reasonable steps have been taken to recover the debt. */
  reasonableStepsTaken: boolean;
  /**
   * reg.10(3)(b): the debt is allowable as a deduction under TCA 1997
   * s.81(2)(i), where the business is chargeable under Case I or II of
   * Schedule D (true also where it is not so chargeable).
   */
  allowableUnderTcaS81: boolean;
  /** reg.10(3)(c): the records reg.27(1)(m) requires for a debt written off are kept. */
  recordsKept: boolean;
  /**
   * reg.10(3)(d): the debtor was connected with the business (VATCA s.97(3))
   * at any time from the supply to the write-off.
   */
  debtorConnected: boolean;
  /** s.39(3): the supply is a letting of immovable goods that is a taxable supply under s.95. */
  taxableLettingUnderS95: boolean;
  /** The supply is goods under a hire-purchase agreement (s.19(1)(c)): reg.10(5), not covered here. */
  hirePurchase: boolean;
}

export type BadDebtReliefResult =
  | { posted: true; journalEntryId: string; reliefMinor: number; working: string }
  | { posted: false; reason: string };

const euro = (minor: number): string => `€${(minor / 100).toFixed(2)}`;

/** Why the stated facts give no relief, or null when they meet every condition. */
function reliefRefused(facts: BadDebtReliefFacts): string | null {
  if (facts.taxableLettingUnderS95) {
    return 'Relief under s.39(2) does not apply to a letting of immovable goods that is a taxable supply under s.95 '
      + '(VATCA s.39(3)).';
  }
  const unmet = [
    !facts.reasonableStepsTaken && 'all reasonable steps have not been taken to recover the debt (reg.10(3)(a))',
    !facts.allowableUnderTcaS81 && 'the debt is not allowable as a deduction under TCA 1997 s.81(2)(i) (reg.10(3)(b))',
    !facts.recordsKept && 'the records Regulation 27(1)(m) requires for the debt are not kept (reg.10(3)(c))',
    facts.debtorConnected && 'the debtor was connected with the business, within VATCA s.97(3), between the supply and '
      + 'the write-off (reg.10(3)(d))',
  ].filter((x): x is string => typeof x === 'string');
  return unmet.length
    ? `No bad-debt relief can be claimed (S.I. 639/2010 reg.10(3)): ${unmet.join('; ')}.`
    : null;
}

/**
 * Claim bad-debt relief on a sales invoice written off on the invoice basis
 * (issue #620): VATCA s.39(2), S.I. 639/2010 reg.10.
 *
 * The relief is A x B / (100 + B) (reg.10(4)): A the amount outstanding when
 * it was written off, B the rate applied to the supply. It is claimed "as if
 * that amount were tax deductible" for the period the claim is made in
 * (reg.10(9)), so it posts to T2 in the period of `date`, through
 * `createAdjustment`: a locked or filed period is refused before anything is
 * written. The other side reduces the bad-debt charge the write-off made.
 *
 * Not covered, and refused rather than guessed: goods under a hire-purchase
 * agreement (reg.10(5)-(7)), an invoice with lines at more than one rate (the
 * regulation gives no apportionment of A between them; reg.10(8) needs a
 * method agreed with Revenue), and an invoice in another currency.
 */
export function claimBadDebtRelief(
  db: AppDatabase,
  params: {
    companyId: string; invoiceId: string; date: IsoDate; actor: string; facts: BadDebtReliefFacts; requestId?: string;
  },
): BadDebtReliefResult {
  return atomically(db, () => {
    const actor = params.actor.trim();
    if (!actor) throw new InvoicingError('Say who is claiming the relief: the conditions are a person\'s statement.');
    const invoice = load(db, params.companyId, params.invoiceId);
    const label = invoice.invoiceNumber ?? invoice.id;
    if (invoice.direction !== 'sales' || invoice.isCreditNote) throw new InvoicingError('Bad-debt relief is claimed on a sales invoice.');
    if (invoice.status !== 'written_off' || !invoice.writtenOffJournalEntryId || !invoice.writtenOffAt) {
      throw new InvoicingError(`Invoice ${label} has not been written off. The debt must be written off in the accounts `
        + 'before relief is claimed (S.I. 639/2010 reg.10(3)(c)).');
    }
    if (invoice.badDebtReliefJournalEntryId) throw new InvoicingError(`Relief has already been claimed on invoice ${label}.`);
    if (params.date < invoice.writtenOffAt) {
      throw new InvoicingError(`Relief is claimed after the debt is written off, on ${invoice.writtenOffAt} (reg.10(3)(c)).`);
    }
    if (invoiceVatDeferred(db, invoice)) {
      throw new InvoicingError('On the cash receipts basis the unpaid VAT was never accounted for: the write-off cancelled '
        + 'it, so there is no tax to relieve (reg.10(3): relief is for tax already accounted for).');
    }
    if (params.facts.hirePurchase) {
      throw new InvoicingError('Relief on goods supplied under a hire-purchase agreement is calculated under S.I. 639/2010 '
        + 'reg.10(5), which this does not do. Claim it with your accountant.');
    }
    const refused = reliefRefused(params.facts);
    if (refused) return { posted: false, reason: refused };

    const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
    if (invoice.currency !== company.baseCurrency) {
      throw new InvoicingError(`Invoice ${label} is in ${invoice.currency}. Relief on an invoice in another currency is not `
        + 'calculated here: claim it with your accountant.');
    }
    const lines = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).all();
    const rates = [...new Set(lines.map((l) => l.rateBasisPoints))];
    if (rates.length !== 1) {
      throw new InvoicingError(`Invoice ${label} has lines at more than one rate. S.I. 639/2010 reg.10(4) takes the rate `
        + 'applied to the supply, and gives no way to share the amount outstanding between rates; another method needs '
        + 'Revenue\'s prior agreement (reg.10(8)). Claim it with your accountant.');
    }
    const treatment = lines[0]!.vatTreatmentId
      ? db.select().from(vatTreatments).where(eq(vatTreatments.id, lines[0]!.vatTreatmentId)).get()
      : undefined;
    const rate = rates[0]!;
    if (!treatment || treatment.jurisdiction !== 'IE' || treatment.isReverseCharge || !treatment.appliesRate || rate === 0) {
      return { posted: false, reason: `No Irish VAT was charged on invoice ${label}, so there is no tax to relieve.` };
    }

    const outstanding = asMinor(invoice.writtenOffMinor);
    // reg.10(4): A x B / (100 + B), B as a percentage; in basis points A x bp / (10000 + bp).
    const relief = multiplyRational(outstanding, rate, 10_000 + rate);
    const working = `${euro(outstanding)} outstanding x ${rate / 100} / (100 + ${rate / 100}) = ${euro(relief)} `
      + '(S.I. 639/2010 reg.10(4))';

    // The account the write-off charged: relief reduces that charge.
    const charged = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, invoice.writtenOffJournalEntryId)).all()
      .find((l) => l.baseDebitMinor > 0)!;
    const created = createAdjustment(db, {
      companyId: params.companyId, date: params.date,
      description: `Bad-debt relief (VATCA s.39(2), S.I. 639/2010 reg.10): ${label}`.slice(0, 200),
      reason: `${working}. Conditions in reg.10(3) stated by ${actor}.`,
      lines: [
        { accountId: systemAccountId(db, params.companyId, 'vat_control'), debitMinor: relief },
        { accountId: charged.accountId, creditMinor: relief },
      ],
      vat: { treatmentId: treatment.id, direction: 'purchases', netMinor: outstanding - relief, statedVatMinor: relief, taxPointDate: params.date },
      actor, requestId: params.requestId,
    });

    const timestamp = nowIso();
    db.update(invoices).set({
      badDebtReliefMinor: relief, badDebtReliefJournalEntryId: created.journalEntryId, badDebtReliefClaimedAt: params.date,
      updatedAt: timestamp,
    }).where(eq(invoices.id, invoice.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: timestamp,
      entityType: 'invoice', entityId: invoice.id, action: 'updated', field: 'bad_debt_relief_minor',
      previousValue: JSON.stringify(0), newValue: JSON.stringify({ reliefMinor: relief, facts: params.facts }),
      source: 'user', actor, reason: working, requestId: params.requestId ?? null,
    }).run();
    upsertReviewItem(db, {
      companyId: params.companyId, kind: 'uncertain_vat_treatment', severity: 'info',
      title: `Bad-debt relief claimed: ${label}`,
      detail: `${working}, claimed in T2 for the period of ${params.date} (reg.10(9)). ${actor} stated the conditions in `
        + 'reg.10(3) are met: check them against the records. If the debt is recovered, reverse the write-off: the tax on '
        + 'it is due again (reg.10(10)).',
      entityType: 'invoice', entityId: invoice.id, dedupeKey: `invoice:${invoice.id}:bad_debt`,
    });
    return { posted: true, journalEntryId: created.journalEntryId, reliefMinor: relief, working };
  });
}

/**
 * reg.10(10): a debt relieved and then recovered. What is recovered is treated
 * as inclusive of tax, and the tax on it is due for the period it is
 * recovered in. The whole debt is restored, so the tax is the relief claimed.
 */
function repayBadDebtRelief(
  db: AppDatabase, invoice: Invoice, params: { companyId: string; date: IsoDate; actor: string; reason: string; requestId?: string },
): { journalEntryId: string; vatMinor: number } {
  const claim = db.select().from(journalLines)
    .where(eq(journalLines.journalEntryId, invoice.badDebtReliefJournalEntryId!)).all();
  const vatLine = claim.find((l) => l.baseDebitMinor > 0)!;
  const chargeLine = claim.find((l) => l.baseCreditMinor > 0)!;
  const lines = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).all();
  const relief = invoice.badDebtReliefMinor;
  const label = invoice.invoiceNumber ?? invoice.id;
  const created = createAdjustment(db, {
    companyId: params.companyId, date: params.date,
    description: `Bad debt recovered, relief repaid (S.I. 639/2010 reg.10(10)): ${label}`.slice(0, 200),
    reason: `Tax on the ${euro(invoice.writtenOffMinor)} recovered, treated as inclusive of tax: ${euro(relief)}, the `
      + `relief claimed on ${invoice.badDebtReliefClaimedAt}. ${params.reason.trim()}`,
    lines: [
      { accountId: chargeLine.accountId, debitMinor: relief },
      { accountId: vatLine.accountId, creditMinor: relief },
    ],
    vat: {
      treatmentId: lines[0]!.vatTreatmentId!, direction: 'sales', netMinor: invoice.writtenOffMinor - relief,
      statedVatMinor: relief, taxPointDate: params.date,
    },
    actor: params.actor.trim() || 'user', requestId: params.requestId,
  });
  return { journalEntryId: created.journalEntryId, vatMinor: relief };
}

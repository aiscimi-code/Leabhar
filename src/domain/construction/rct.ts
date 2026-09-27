import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  auditEvents, companies, invoices, payments, rctContracts, rctPayments, rctReturns, rctSubcontractors, suppliers,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, nowIso } from '../dates';
import { atomically, assertAccountingPeriodOpen, postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { systemAccountId } from '../config/setup';
import { rctPrincipalOn } from '../config/companyStatus';
import { recordPayment } from '../invoicing/payments';
import { settleBankTransaction } from '../consolidation/settle';
import { upsertReviewItem } from '../extraction/service';
import { markBankLinePosted, resolvePayment } from '../payroll/runs';
import { farmFigure as ruleFigure } from '../farmTax/reliefs';
import { ConstructionError, requireConstructionDate, requireProject, requireSite } from './projects';

/**
 * Relevant contracts tax for a principal (EPIC 26, issues #548, #549; TCA
 * ss.530B-530L, from the Notes for Guidance on Part 18).
 *
 * Revenue decides every figure: the rate is its determination (s.530E), and
 * the tax on each payment is the sum its deduction authorisation specifies
 * (s.530D). These books record them as issued, settle the subcontractor's
 * invoice with the net payment and an RCT deduction (Dr creditors, Cr RCT
 * payable), return the period (s.530K) and pay it (s.530L). A payment to a
 * subcontractor outside this path is flagged with its penalty exposure
 * (s.530F(2)); nothing is posted as though it were authorised.
 */

export type RctSubcontractor = typeof rctSubcontractors.$inferSelect;
export type RctContract = typeof rctContracts.$inferSelect;
export type RctPayment = typeof rctPayments.$inferSelect;

const eur = (m: number) => (m / 100).toFixed(2);
const RATES = [0, 2000, 3500];

/** The book's company, refused unless it is a confirmed principal on the date (s.530A; #208). */
function requirePrincipal(db: AppDatabase, companyId: string, date: string) {
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new ConstructionError(`Company ${companyId} not found.`);
  if (rctPrincipalOn(company, date) !== true) {
    throw new ConstructionError(`The business is not recorded as an RCT principal on ${date}: confirm its principal status first (s.530A).`);
  }
  return company;
}

/** A supplier's particulars as a subcontractor (issue #548; s.530B(1)(b), (1A)). */
export function registerSubcontractor(db: AppDatabase, p: {
  companyId: string; supplierId: string; taxReference: string; identityEvidence: string; identityCheckedBy: string;
  identityCheckedOn: string; notEmployeeDeclared: boolean;
}): RctSubcontractor {
  const supplier = db.select().from(suppliers).where(and(eq(suppliers.id, p.supplierId), eq(suppliers.companyId, p.companyId))).get();
  if (!supplier) throw new ConstructionError(`Supplier ${p.supplierId} not found.`);
  if (!p.taxReference.trim()) throw new ConstructionError('Record the subcontractor\'s tax reference from their identity evidence.');
  if (!p.identityEvidence.trim() || !p.identityCheckedBy.trim()) {
    throw new ConstructionError('Record the documentary evidence of identity seen, and who checked it (s.530B(1A)).');
  }
  if (!p.notEmployeeDeclared) {
    throw new ConstructionError('A contract notification declares the subcontractor is not an employee (s.530B(1)(b)): confirm it first.');
  }
  if (db.select({ id: rctSubcontractors.id }).from(rctSubcontractors).where(eq(rctSubcontractors.supplierId, supplier.id)).get()) {
    throw new ConstructionError(`${supplier.name} is already registered as a subcontractor.`);
  }
  const id = ids.rctSubcontractor();
  db.insert(rctSubcontractors).values({
    id, companyId: p.companyId, supplierId: supplier.id, taxReference: p.taxReference.trim(), identityEvidence: p.identityEvidence.trim(),
    identityCheckedBy: p.identityCheckedBy.trim(), identityCheckedOn: requireConstructionDate(p.identityCheckedOn, 'The date identity was checked'),
    notEmployeeDeclared: true,
  }).run();
  return db.select().from(rctSubcontractors).where(eq(rctSubcontractors.id, id)).get()!;
}

function requireSubcontractor(db: AppDatabase, companyId: string, id: string): RctSubcontractor {
  const s = db.select().from(rctSubcontractors).where(and(eq(rctSubcontractors.id, id), eq(rctSubcontractors.companyId, companyId))).get();
  if (!s) throw new ConstructionError(`Subcontractor ${id} not found.`);
  return s;
}

/** A relevant contract, and its notification to Revenue (issue #548; s.530B). */
export function recordRctContract(db: AppDatabase, p: {
  companyId: string; subcontractorId: string; projectId?: string | null; siteId?: string | null; description: string;
  estimatedValueMinor: number; startsOn: string; endsOn?: string | null; labourOnly: boolean; notifiedOn?: string | null;
  revenueContractId?: string | null; recordedBy: string;
}): RctContract {
  const startsOn = requireConstructionDate(p.startsOn, 'The start date');
  requirePrincipal(db, p.companyId, startsOn);
  const sub = requireSubcontractor(db, p.companyId, p.subcontractorId);
  if (!p.description.trim()) throw new ConstructionError('Describe the work under the contract.');
  if (!Number.isInteger(p.estimatedValueMinor) || p.estimatedValueMinor <= 0) throw new ConstructionError('The estimated value is a positive number of cent.');
  const endsOn = p.endsOn ? requireConstructionDate(p.endsOn, 'The end date') : null;
  if (endsOn && endsOn < startsOn) throw new ConstructionError('A contract ends on or after it starts.');
  const projectId = p.projectId ? requireProject(db, p.companyId, p.projectId).id : null;
  const siteId = p.siteId ? requireSite(db, p.companyId, p.siteId).id : null;
  if (!siteId) throw new ConstructionError('Name the site the work is carried out at: the notification gives the location (s.530B(1)(a)).');
  const notifiedOn = p.notifiedOn ? requireConstructionDate(p.notifiedOn, 'The notification date') : null;
  if (notifiedOn && notifiedOn < sub.identityCheckedOn) {
    throw new ConstructionError('The subcontractor\'s identity is checked before the contract is notified (s.530B(1A)).');
  }
  if (notifiedOn && !p.revenueContractId?.trim()) throw new ConstructionError('Record the contract ID Revenue gave the notification.');
  const id = ids.rctContract();
  db.insert(rctContracts).values({
    id, companyId: p.companyId, subcontractorId: sub.id, projectId, siteId, description: p.description.trim(),
    estimatedValueMinor: p.estimatedValueMinor, startsOn, endsOn, labourOnly: p.labourOnly, notifiedOn,
    revenueContractId: p.revenueContractId?.trim() || null, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(rctContracts).where(eq(rctContracts.id, id)).get()!;
}

/** Record that the contract was notified on ROS, with Revenue's contract ID. */
export function recordContractNotification(db: AppDatabase, p: { companyId: string; contractId: string; notifiedOn: string; revenueContractId: string }) {
  const c = requireContract(db, p.companyId, p.contractId);
  if (c.notifiedOn) throw new ConstructionError(`The contract was notified on ${c.notifiedOn}.`);
  if (!p.revenueContractId.trim()) throw new ConstructionError('Record the contract ID Revenue gave the notification.');
  db.update(rctContracts).set({ notifiedOn: requireConstructionDate(p.notifiedOn, 'The notification date'), revenueContractId: p.revenueContractId.trim(), updatedAt: nowIso() })
    .where(eq(rctContracts.id, c.id)).run();
  return requireContract(db, p.companyId, c.id);
}

function requireContract(db: AppDatabase, companyId: string, id: string): RctContract {
  const c = db.select().from(rctContracts).where(and(eq(rctContracts.id, id), eq(rctContracts.companyId, companyId))).get();
  if (!c) throw new ConstructionError(`Contract ${id} not found.`);
  return c;
}

/**
 * The payment notification (s.530C), made immediately before a payment, for
 * its gross amount, against the subcontractor's invoice it will settle.
 */
export function notifyRctPayment(db: AppDatabase, p: {
  companyId: string; contractId: string; invoiceId: string; grossMinor: number; notifiedOn: string; recordedBy: string;
}): RctPayment {
  const contract = requireContract(db, p.companyId, p.contractId);
  const notifiedOn = requireConstructionDate(p.notifiedOn, 'The notification date');
  requirePrincipal(db, p.companyId, notifiedOn);
  if (!contract.notifiedOn || contract.notifiedOn > notifiedOn) {
    throw new ConstructionError('The contract is notified to Revenue before any payment under it (s.530B).');
  }
  const sub = requireSubcontractor(db, p.companyId, contract.subcontractorId);
  const invoice = db.select().from(invoices).where(and(eq(invoices.id, p.invoiceId), eq(invoices.companyId, p.companyId))).get();
  if (!invoice) throw new ConstructionError(`Invoice ${p.invoiceId} not found.`);
  if (invoice.direction !== 'purchase' || invoice.supplierId !== sub.supplierId) {
    throw new ConstructionError('The payment settles the subcontractor\'s own purchase invoice.');
  }
  if (!Number.isInteger(p.grossMinor) || p.grossMinor <= 0 || p.grossMinor > invoice.outstandingMinor) {
    throw new ConstructionError(`The gross payment is positive and no more than the ${eur(invoice.outstandingMinor)} outstanding on the invoice.`);
  }
  const id = ids.rctPayment();
  db.insert(rctPayments).values({
    id, companyId: p.companyId, contractId: contract.id, invoiceId: invoice.id, grossMinor: p.grossMinor, notifiedOn, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(rctPayments).where(eq(rctPayments.id, id)).get()!;
}

function requireRctPayment(db: AppDatabase, companyId: string, id: string): RctPayment {
  const r = db.select().from(rctPayments).where(and(eq(rctPayments.id, id), eq(rctPayments.companyId, companyId))).get();
  if (!r) throw new ConstructionError(`RCT payment ${id} not found.`);
  return r;
}

/**
 * Revenue's deduction authorisation for a notified payment (s.530D): its
 * number, the rate (0%, 20% or 35%, s.530E) and the tax it specifies, as
 * issued. A sum that is not the rate on the gross is recorded as issued and
 * flagged: the authorisation is Revenue's figure.
 */
export function recordDeductionAuthorisation(db: AppDatabase, p: {
  companyId: string; rctPaymentId: string; number: string; rateBasisPoints: number; rctMinor: number;
}): { payment: RctPayment; warnings: string[] } {
  const r = requireRctPayment(db, p.companyId, p.rctPaymentId);
  if (r.deductionAuthorisationNumber) throw new ConstructionError(`The deduction authorisation ${r.deductionAuthorisationNumber} is recorded already.`);
  if (!p.number.trim()) throw new ConstructionError('Record the deduction authorisation number.');
  if (!RATES.includes(p.rateBasisPoints)) throw new ConstructionError('The rate is 0%, 20% or 35% (s.530E).');
  if (!Number.isInteger(p.rctMinor) || p.rctMinor < 0 || p.rctMinor > r.grossMinor) throw new ConstructionError('The tax is a whole number of cent, no more than the payment.');
  const warnings: string[] = [];
  const expected = Math.round((r.grossMinor * p.rateBasisPoints) / 10_000);
  if (p.rctMinor !== expected) {
    warnings.push(`The authorisation specifies ${eur(p.rctMinor)}, not ${p.rateBasisPoints / 100}% of ${eur(r.grossMinor)} (${eur(expected)}). `
      + 'It is recorded as issued: check it against the authorisation on ROS.');
  }
  db.update(rctPayments).set({ deductionAuthorisationNumber: p.number.trim(), rateBasisPoints: p.rateBasisPoints, rctMinor: p.rctMinor, updatedAt: nowIso() })
    .where(eq(rctPayments.id, r.id)).run();
  return { payment: requireRctPayment(db, p.companyId, r.id), warnings };
}

/**
 * Pay the subcontractor under the deduction authorisation (s.530F(1)): the
 * gross less the tax leaves the bank, and the invoice is settled for the
 * gross, the tax to RCT payable, in one payment.
 */
export function payRctPayment(db: AppDatabase, p: {
  companyId: string; rctPaymentId: string; bankTransactionId?: string | null; bankAccountId?: string | null; date?: string | null;
  paidBy: string;
}): RctPayment {
  return atomically(db, () => {
    const r = requireRctPayment(db, p.companyId, p.rctPaymentId);
    if (r.paymentId) throw new ConstructionError(`This payment was made on ${r.paidOn}.`);
    if (r.rctMinor === null || r.rateBasisPoints === null) {
      throw new ConstructionError('Record the deduction authorisation first: a payment is made only in accordance with one (s.530F).');
    }
    const net = r.grossMinor - r.rctMinor;
    const where = resolvePayment(db, { companyId: p.companyId, amountMinor: net, bankTransactionId: p.bankTransactionId, bankAccountId: p.bankAccountId, date: p.date });
    if (where.date < r.notifiedOn) throw new ConstructionError('The payment follows its notification (s.530C).');
    assertAccountingPeriodOpen(db, p.companyId, where.date);
    const allocations = [{ invoiceId: r.invoiceId!, amountMinor: net }];
    const rctDeduction = r.rctMinor > 0 ? { invoiceId: r.invoiceId!, amountMinor: r.rctMinor } : null;
    const recorded = where.transaction
      ? settleBankTransaction(db, { companyId: p.companyId, bankTransactionId: where.transaction.id, allocations, rctDeduction, actor: p.paidBy })
      : recordPayment(db, {
        companyId: p.companyId, direction: 'made', paymentDate: where.date, amountMinor: net, bankAccountId: p.bankAccountId ?? null,
        allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, allocatedMinor: a.amountMinor })), rctDeduction,
        reference: `RCT payment ${r.deductionAuthorisationNumber}`, actor: p.paidBy,
      });
    db.update(rctPayments).set({ paymentId: recorded.paymentId, paidOn: where.date, returnPeriod: where.date.slice(0, 7), updatedAt: nowIso() })
      .where(eq(rctPayments.id, r.id)).run();
    return requireRctPayment(db, p.companyId, r.id);
  });
}

/** Whether a recorded payment still stands (not reversed). */
function standing(db: AppDatabase, paymentId: string | null): boolean {
  if (!paymentId) return false;
  return !db.select({ r: payments.reversedAt }).from(payments).where(eq(payments.id, paymentId)).get()?.r;
}

export interface RctPeriod {
  period: string;
  payments: Array<RctPayment & { supplierName: string; netMinor: number }>;
  grossMinor: number;
  liabilityMinor: number;
  return: typeof rctReturns.$inferSelect | null;
}

/** A return period's relevant payments and the tax on them (s.530F(5), s.530K). */
export function rctPeriod(db: AppDatabase, p: { companyId: string; period: string }): RctPeriod {
  if (!/^\d{4}-\d{2}$/.test(p.period)) throw new ConstructionError('A return period is a month, YYYY-MM.');
  const rows = db.select({ r: rctPayments, name: suppliers.name }).from(rctPayments)
    .innerJoin(rctContracts, eq(rctPayments.contractId, rctContracts.id))
    .innerJoin(rctSubcontractors, eq(rctContracts.subcontractorId, rctSubcontractors.id))
    .innerJoin(suppliers, eq(rctSubcontractors.supplierId, suppliers.id))
    .where(and(eq(rctPayments.companyId, p.companyId), eq(rctPayments.returnPeriod, p.period))).orderBy(asc(rctPayments.paidOn)).all()
    .filter(({ r }) => standing(db, r.paymentId))
    .map(({ r, name }) => ({ ...r, supplierName: name, netMinor: r.grossMinor - (r.rctMinor ?? 0) }));
  return {
    period: p.period, payments: rows,
    grossMinor: rows.reduce((s, r) => s + r.grossMinor, 0),
    liabilityMinor: rows.reduce((s, r) => s + (r.rctMinor ?? 0), 0),
    return: db.select().from(rctReturns).where(and(eq(rctReturns.companyId, p.companyId), eq(rctReturns.period, p.period))).get() ?? null,
  };
}

/**
 * Record the period's return (s.530K): Revenue's deduction summary is deemed
 * the return unless the principal amends it. A summary that differs from the
 * books, not amended, is a review item: one of them is missing a payment.
 */
export function fileRctReturn(db: AppDatabase, p: {
  companyId: string; period: string; summaryLiabilityMinor: number; amended?: boolean; filedOn: string; filedBy: string;
}) {
  const period = rctPeriod(db, p);
  if (period.return) throw new ConstructionError(`The ${p.period} return is recorded already.`);
  if (!Number.isInteger(p.summaryLiabilityMinor) || p.summaryLiabilityMinor < 0) throw new ConstructionError('The liability is a whole number of cent.');
  const filedOn = requireConstructionDate(p.filedOn, 'The filing date');
  const id = ids.rctReturn();
  db.insert(rctReturns).values({
    id, companyId: p.companyId, period: p.period, booksLiabilityMinor: period.liabilityMinor, summaryLiabilityMinor: p.summaryLiabilityMinor,
    amended: !!p.amended, filedOn, filedBy: p.filedBy,
  }).run();
  if (p.summaryLiabilityMinor !== period.liabilityMinor) {
    upsertReviewItem(db, {
      companyId: p.companyId, kind: 'reconciliation_difference', severity: 'warning',
      title: `RCT ${p.period}: the ${p.amended ? 'amended return' : 'deduction summary'} is ${eur(p.summaryLiabilityMinor)}, the books ${eur(period.liabilityMinor)}`,
      detail: 'Every payment on the deduction summary should be a payment made here under its authorisation, and each one here '
        + 'should be on the summary. Find the payment one side is missing before paying the return (s.530K(2)).',
      entityType: 'rct_return', entityId: id, dedupeKey: `rct_return:${p.companyId}:${p.period}`,
      context: { period: p.period, books: period.liabilityMinor, summary: p.summaryLiabilityMinor },
    });
  }
  return db.select().from(rctReturns).where(eq(rctReturns.id, id)).get()!;
}

/** Pay a return's liability to the Collector-General (s.530L): Dr RCT payable / Cr bank, to the cent. */
export function payRctReturn(db: AppDatabase, p: {
  companyId: string; period: string; bankTransactionId?: string | null; bankAccountId?: string | null; date?: string | null; paidBy: string;
}) {
  return atomically(db, () => {
    const ret = db.select().from(rctReturns).where(and(eq(rctReturns.companyId, p.companyId), eq(rctReturns.period, p.period))).get();
    if (!ret) throw new ConstructionError(`Record the ${p.period} return first.`);
    if (ret.paymentJournalEntryId) throw new ConstructionError(`The ${p.period} return was paid on ${ret.paidOn}.`);
    const where = resolvePayment(db, { companyId: p.companyId, amountMinor: ret.summaryLiabilityMinor, bankTransactionId: p.bankTransactionId, bankAccountId: p.bankAccountId, date: p.date });
    assertAccountingPeriodOpen(db, p.companyId, where.date);
    const company = db.select().from(companies).where(eq(companies.id, p.companyId)).get()!;
    const journal = postJournalEntry(db, {
      companyId: p.companyId, entryDate: where.date, narrative: `RCT for ${p.period} paid to the Collector-General`,
      sourceType: 'rct_payment', sourceId: ret.id, baseCurrency: company.baseCurrency, createdBy: p.paidBy, createdVia: 'user',
      lines: [
        { accountId: systemAccountId(db, p.companyId, 'rct_payable'), debitMinor: ret.summaryLiabilityMinor, memo: `RCT ${p.period}` },
        { accountId: where.moneyAccountId, creditMinor: ret.summaryLiabilityMinor, memo: `RCT ${p.period}` },
      ],
    });
    if (where.transaction) markBankLinePosted(db, where.transaction.id, journal.id);
    db.update(rctReturns).set({ paymentJournalEntryId: journal.id, paidOn: where.date, bankTransactionId: where.transaction?.id ?? null, updatedAt: nowIso() })
      .where(eq(rctReturns.id, ret.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: p.companyId, occurredAt: nowIso(), entityType: 'rct_return', entityId: ret.id, action: 'reconciled',
      newValue: JSON.stringify({ paid: ret.summaryLiabilityMinor, journalEntryId: journal.id }), source: 'user', actor: p.paidBy, requestId: null,
    }).run();
    return db.select().from(rctReturns).where(eq(rctReturns.id, ret.id)).get()!;
  });
}

export interface RctReconciliation {
  asOf: string;
  ledgerMinor: number;
  deductedMinor: number;
  paidMinor: number;
  differenceMinor: number;
  /** Payments to subcontractors outside the RCT path, with the penalty exposure (s.530F(2)). */
  unauthorised: Array<{ paymentId: string; date: string; supplierName: string; amountMinor: number; penaltyRateBasisPoints: number; exposureMinor: number }>;
}

/** The penalty rate for a payment made otherwise than by authorisation, by the subcontractor's last determination (s.530F(2)). */
function penaltyRate(db: AppDatabase, companyId: string, lastRate: number | null, date: string): number {
  const key = lastRate === null ? 'rct.penalty_no_determination'
    : lastRate === 3500 ? 'rct.penalty_higher_rate_sub'
      : lastRate === 2000 ? 'rct.penalty_standard_rate_sub' : 'rct.penalty_zero_rate_sub';
  return ruleFigure(db, companyId, key, date);
}

/**
 * Reconcile RCT (issue #549): the RCT payable account against the tax
 * deducted less returns paid, and every payment to a registered
 * subcontractor made outside the RCT path, flagged with its s.530F(2)
 * exposure. Differences are review items; nothing is adjusted.
 */
export function reconcileRct(db: AppDatabase, p: { companyId: string; asOf: string }): RctReconciliation {
  const asOf = requireConstructionDate(p.asOf, 'The date');
  // A liability's natural balance: what is owed to the Collector-General.
  const ledgerMinor = accountBalance(db, { companyId: p.companyId, accountId: systemAccountId(db, p.companyId, 'rct_payable'), asOf: asIsoDate(asOf) });
  const rows = db.select().from(rctPayments).where(eq(rctPayments.companyId, p.companyId)).all()
    .filter((r) => r.paidOn && r.paidOn <= asOf && standing(db, r.paymentId));
  const deductedMinor = rows.reduce((s, r) => s + (r.rctMinor ?? 0), 0);
  const paidMinor = db.select().from(rctReturns).where(eq(rctReturns.companyId, p.companyId)).all()
    .filter((r) => r.paidOn && r.paidOn <= asOf).reduce((s, r) => s + r.summaryLiabilityMinor, 0);
  const differenceMinor = ledgerMinor - (deductedMinor - paidMinor);
  if (differenceMinor !== 0) {
    upsertReviewItem(db, {
      companyId: p.companyId, kind: 'reconciliation_difference', severity: 'warning',
      title: `RCT payable holds ${eur(ledgerMinor)}; deductions less returns paid come to ${eur(deductedMinor - paidMinor)}`,
      detail: 'An entry reached the RCT payable account outside an RCT payment or return, or a return was paid for a different amount '
        + 'than its payments deducted. Find it before the next return.',
      entityType: 'account', entityId: systemAccountId(db, p.companyId, 'rct_payable'), dedupeKey: `rct_reconciliation:${p.companyId}:${asOf}`,
      context: { ledgerMinor, deductedMinor, paidMinor },
    });
  }
  // Payments to registered subcontractors made outside the RCT path.
  const subs = db.select({ s: rctSubcontractors, name: suppliers.name }).from(rctSubcontractors)
    .innerJoin(suppliers, eq(rctSubcontractors.supplierId, suppliers.id)).where(eq(rctSubcontractors.companyId, p.companyId)).all();
  const viaRct = new Set(rows.map((r) => r.paymentId));
  const unauthorised: RctReconciliation['unauthorised'] = [];
  const company = db.select().from(companies).where(eq(companies.id, p.companyId)).get()!;
  if (subs.length) {
    const made = db.select().from(payments).where(and(
      eq(payments.companyId, p.companyId), eq(payments.direction, 'made'), isNull(payments.reversedAt),
      inArray(payments.supplierId, subs.map((x) => x.s.supplierId)),
    )).orderBy(desc(payments.paymentDate)).all().filter((x) => x.paymentDate <= asOf && !viaRct.has(x.id));
    for (const pay of made) {
      if (rctPrincipalOn(company, pay.paymentDate) !== true) continue;
      const sub = subs.find((x) => x.s.supplierId === pay.supplierId)!;
      const last = db.select({ rate: rctPayments.rateBasisPoints, d: rctPayments.notifiedOn }).from(rctPayments)
        .innerJoin(rctContracts, eq(rctPayments.contractId, rctContracts.id))
        .where(and(eq(rctContracts.subcontractorId, sub.s.id))).orderBy(desc(rctPayments.notifiedOn)).all()
        .find((x) => x.rate !== null && x.d <= pay.paymentDate);
      const rate = penaltyRate(db, p.companyId, last?.rate ?? null, pay.paymentDate);
      const item = {
        paymentId: pay.id, date: pay.paymentDate, supplierName: sub.name, amountMinor: pay.baseAmountMinor, penaltyRateBasisPoints: rate,
        exposureMinor: Math.round((pay.baseAmountMinor * rate) / 10_000),
      };
      unauthorised.push(item);
      upsertReviewItem(db, {
        companyId: p.companyId, kind: 'other', severity: 'error',
        title: `A payment of ${eur(item.amountMinor)} to ${sub.name} on ${pay.paymentDate} has no deduction authorisation`,
        detail: `${sub.name} is a subcontractor under a relevant contract. A payment made otherwise than by a deduction authorisation `
          + `exposes the principal to a penalty of ${rate / 100}% of it (${eur(item.exposureMinor)}, s.530F(2)) and needs an unreported `
          + 'payment notification (s.530F(3)). If it was not a relevant payment, record why.',
        entityType: 'payment', entityId: pay.id, dedupeKey: `rct_unauthorised:${pay.id}`, context: item,
      });
    }
  }
  return { asOf, ledgerMinor, deductedMinor, paidMinor, differenceMinor, unauthorised };
}

export function listSubcontractors(db: AppDatabase, companyId: string) {
  return db.select({ s: rctSubcontractors, name: suppliers.name }).from(rctSubcontractors)
    .innerJoin(suppliers, eq(rctSubcontractors.supplierId, suppliers.id)).where(eq(rctSubcontractors.companyId, companyId))
    .orderBy(asc(suppliers.name)).all().map(({ s, name }) => ({ ...s, supplierName: name }));
}

export function listRctContracts(db: AppDatabase, companyId: string): RctContract[] {
  return db.select().from(rctContracts).where(eq(rctContracts.companyId, companyId)).orderBy(desc(rctContracts.startsOn)).all();
}

export function listRctPayments(db: AppDatabase, companyId: string): RctPayment[] {
  return db.select().from(rctPayments).where(eq(rctPayments.companyId, companyId)).orderBy(desc(rctPayments.notifiedOn)).all();
}

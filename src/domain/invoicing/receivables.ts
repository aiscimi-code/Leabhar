import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  invoices, payments, paymentAllocations, customers, companies, reminderLetters, invoiceReminders, auditEvents,
  journalEntries,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, daysBetween, asIsoDate, type IsoDate } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { InvoicingError } from './invoices';
import { paymentsOnAccount } from './onAccount';
import { customerExposure } from '../parties/customerAccount';

/**
 * Receivables (issue #405): what is overdue, a customer's statement of
 * account, payment reminder letters, and the receivables summary.
 *
 * Overdue is computed on the day asked, never stored: an invoice is overdue
 * when its due date (or, with none, its invoice date) is before `asOf` and
 * something is still outstanding.
 */

type Invoice = typeof invoices.$inferSelect;

const toBase = (invoice: Invoice, minor: number): number =>
  invoice.fxRateNumerator && invoice.fxRateDenominator
    ? multiplyRational(asMinor(minor), invoice.fxRateNumerator, invoice.fxRateDenominator)
    : minor;

export interface OverdueInvoice {
  invoiceId: string; number: string | null; customerId: string | null; customerName: string | null;
  invoiceDate: string; dueDate: string; daysOverdue: number;
  outstandingMinor: number; currency: string; outstandingBaseMinor: number;
  lastReminderLevel: number | null; lastReminderOn: string | null;
}

export function overdueInvoices(
  db: AppDatabase, params: { companyId: string; asOf: IsoDate; customerId?: string | null },
): OverdueInvoice[] {
  const rows = db.select({ invoice: invoices, customerName: customers.name }).from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(
      eq(invoices.companyId, params.companyId), eq(invoices.direction, 'sales'), eq(invoices.isCreditNote, false),
      ne(invoices.status, 'void'), ne(invoices.status, 'written_off'), ne(invoices.outstandingMinor, 0),
      params.customerId ? eq(invoices.customerId, params.customerId) : undefined,
    )).all();
  const out: OverdueInvoice[] = [];
  for (const { invoice, customerName } of rows) {
    const due = invoice.dueDate ?? invoice.invoiceDate;
    if (due >= params.asOf || invoice.outstandingMinor <= 0) continue;
    const last = db.select({ level: reminderLetters.level, asOf: reminderLetters.asOf }).from(invoiceReminders)
      .innerJoin(reminderLetters, eq(invoiceReminders.letterId, reminderLetters.id))
      .where(eq(invoiceReminders.invoiceId, invoice.id)).orderBy(desc(reminderLetters.asOf), desc(reminderLetters.level)).get();
    out.push({
      invoiceId: invoice.id, number: invoice.invoiceNumber, customerId: invoice.customerId, customerName,
      invoiceDate: invoice.invoiceDate, dueDate: due, daysOverdue: daysBetween(asIsoDate(due), params.asOf),
      outstandingMinor: invoice.outstandingMinor, currency: invoice.currency,
      outstandingBaseMinor: toBase(invoice, invoice.outstandingMinor),
      lastReminderLevel: last?.level ?? null, lastReminderOn: last?.asOf ?? null,
    });
  }
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export interface StatementEntry {
  date: string;
  kind: 'invoice' | 'debit_note' | 'credit_note' | 'payment' | 'refund' | 'payment_reversed' | 'write_off';
  reference: string;
  /** Positive: the balance grows (the customer owes more, or we owe the supplier more). Base currency. */
  amountMinor: number;
  balanceMinor: number;
}

export interface CustomerStatement {
  customerId: string; customerName: string; address: string | null; currency: string;
  from: IsoDate; to: IsoDate;
  openingBalanceMinor: number; entries: StatementEntry[]; closingBalanceMinor: number;
  /** Outstanding at `to` by how long past due. */
  ageing: Array<{ label: string; amountMinor: number }>;
}

/**
 * A customer's statement of account, in base currency: every invoice, debit
 * note, credit note, payment, refund, reversed payment and write-off in date
 * order with a running balance. Voided documents are left out entirely.
 * The closing balance is what the customer owes less what they have on
 * account — the customer's share of debtors.
 */
export function customerStatement(
  db: AppDatabase, params: { companyId: string; customerId: string; from: IsoDate; to: IsoDate },
): CustomerStatement {
  if (params.to < params.from) throw new InvoicingError('The statement ends before it starts.');
  const customer = db.select().from(customers)
    .where(and(eq(customers.id, params.customerId), eq(customers.companyId, params.companyId))).get();
  if (!customer) throw new InvoicingError(`Customer ${params.customerId} not found.`);
  const base = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, params.companyId)).get()!.c;

  const { openingBalanceMinor, entries, closingBalanceMinor, ageing } = accountHistory(db, {
    companyId: params.companyId, side: 'customer', partyId: customer.id, from: params.from, to: params.to,
  });

  return {
    customerId: customer.id, customerName: customer.legalName ?? customer.name, address: customer.addressLines,
    currency: base, from: params.from, to: params.to,
    openingBalanceMinor, entries, closingBalanceMinor, ageing,
  };
}

/**
 * A party's account in base currency (issues #405, #413): every invoice,
 * debit note, credit note, payment, refund, shortfall written off, bad debt
 * written off and reversed payment, in date order with a running balance. Voided
 * documents are left out. Positive means the balance grows — the customer owes
 * us more, or we owe the supplier more — so the closing balance is the party's
 * share of the control account.
 */
export function accountHistory(
  db: AppDatabase,
  params: { companyId: string; side: 'customer' | 'supplier'; partyId: string; from: IsoDate; to: IsoDate },
): Pick<CustomerStatement, 'openingBalanceMinor' | 'entries' | 'closingBalanceMinor' | 'ageing'> {
  const isCustomer = params.side === 'customer';
  const docs = db.select().from(invoices).where(and(
    eq(invoices.companyId, params.companyId),
    isCustomer ? eq(invoices.customerId, params.partyId) : eq(invoices.supplierId, params.partyId),
    eq(invoices.direction, isCustomer ? 'sales' : 'purchase'), ne(invoices.status, 'void'),
  )).all();
  const raw: Array<Omit<StatementEntry, 'balanceMinor'>> = [];
  for (const doc of docs) {
    const gross = toBase(doc, Math.abs(doc.grossMinor));
    raw.push({
      date: doc.invoiceDate,
      kind: doc.isCreditNote ? 'credit_note' : doc.isDebitNote ? 'debit_note' : 'invoice',
      reference: doc.invoiceNumber ?? doc.id,
      amountMinor: doc.isCreditNote ? -gross : gross,
    });
    if (doc.status === 'written_off' && doc.writtenOffAt) {
      raw.push({ date: doc.writtenOffAt, kind: 'write_off', reference: `${doc.invoiceNumber ?? doc.id} written off`, amountMinor: -toBase(doc, doc.writtenOffMinor) });
    }
  }

  // Payments: the party's own, and — for older payments that record no
  // party — the part allocated to this party's documents. Money that settles
  // the account is the direction that reduces it: received from a customer,
  // made to a supplier.
  const docIds = docs.map((d) => d.id);
  const candidateIds = new Set(db.select({ id: payments.id }).from(payments).where(and(
    eq(payments.companyId, params.companyId),
    isCustomer ? eq(payments.customerId, params.partyId) : eq(payments.supplierId, params.partyId),
  )).all().map((r) => r.id));
  if (docIds.length > 0) {
    for (const r of db.select({ id: paymentAllocations.paymentId }).from(paymentAllocations)
      .where(inArray(paymentAllocations.invoiceId, docIds)).all()) candidateIds.add(r.id);
  }
  for (const id of candidateIds) {
    const payment = db.select().from(payments).where(eq(payments.id, id)).get()!;
    if (payment.method === 'offset') continue; // a credit note applied: the credit note is already a line
    const allocations = db.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, payment.id)).all();
    const ownParty = isCustomer ? payment.customerId === params.partyId : payment.supplierId === params.partyId;
    const amount = ownParty ? payment.baseAmountMinor
      : allocations.filter((a) => docIds.includes(a.invoiceId) && a.allocationType !== 'write_off')
        .reduce((s, a) => s + a.baseAllocatedMinor, 0);
    // A shortfall written off with the payment (issue #386) takes the rest of
    // the invoice out of the control account too.
    const writtenOff = allocations.filter((a) => docIds.includes(a.invoiceId) && a.allocationType === 'write_off')
      .reduce((s, a) => s + a.baseAllocatedMinor, 0);
    const settles = payment.direction === (isCustomer ? 'received' : 'made');
    raw.push({
      date: payment.paymentDate, kind: settles ? 'payment' : 'refund',
      reference: payment.reference ?? (settles ? (isCustomer ? 'Payment received' : 'Payment made') : 'Refund'),
      amountMinor: settles ? -amount : amount,
    });
    if (writtenOff > 0) {
      raw.push({ date: payment.paymentDate, kind: 'write_off', reference: 'Shortfall written off', amountMinor: -writtenOff });
    }
    if (payment.reversedAt) {
      // Dated by the reversing journal, which is what moved the balance, not
      // by when the reversal was recorded.
      const reversalDate = payment.reversalJournalEntryId
        ? db.select({ d: journalEntries.entryDate }).from(journalEntries)
          .where(eq(journalEntries.id, payment.reversalJournalEntryId)).get()?.d
        : undefined;
      raw.push({
        date: reversalDate ?? payment.reversedAt.slice(0, 10), kind: 'payment_reversed',
        reference: `${settles ? 'Payment' : 'Refund'} reversed${payment.reversalReason ? `: ${payment.reversalReason}` : ''}`,
        amountMinor: (settles ? amount : -amount) + writtenOff,
      });
    }
  }

  raw.sort((a, b) => a.date.localeCompare(b.date) || b.amountMinor - a.amountMinor);
  const openingBalanceMinor = raw.filter((e) => e.date < params.from).reduce((s, e) => s + e.amountMinor, 0);
  let balance = openingBalanceMinor;
  const entries: StatementEntry[] = raw.filter((e) => e.date >= params.from && e.date <= params.to)
    .map((e) => { balance += e.amountMinor; return { ...e, balanceMinor: balance }; });

  const labels = ['Not yet due', '1–30 days', '31–60 days', '61–90 days', 'Over 90 days'];
  const ageing = labels.map((label) => ({ label, amountMinor: 0 }));
  for (const doc of docs) {
    if (doc.invoiceDate > params.to || doc.outstandingMinor === 0 || doc.status === 'written_off') continue;
    const days = daysBetween(asIsoDate(doc.dueDate ?? doc.invoiceDate), params.to);
    const index = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
    ageing[index]!.amountMinor += toBase(doc, doc.outstandingMinor);
  }
  return { openingBalanceMinor, entries, closingBalanceMinor: balance, ageing };
}

export const REMINDER_LEVELS: Record<number, { title: string; body: string }> = {
  1: {
    title: 'Payment reminder',
    body: 'Our records show the invoices below as unpaid past their due date. If you have already paid, thank you, '
      + 'and please ignore this letter; otherwise we would be grateful for payment at your earliest convenience.',
  },
  2: {
    title: 'Second payment reminder',
    body: 'We wrote to you about the invoices below, which remain unpaid. Please arrange payment within 7 days, '
      + 'or contact us if there is a query about any of them.',
  },
  3: {
    title: 'Final notice',
    body: 'Despite earlier reminders, the invoices below remain unpaid. Unless payment is received within 7 days, '
      + 'we will have to consider further action to recover the debt.',
  },
};

/**
 * Record a reminder letter for a customer's overdue invoices as at `asOf`.
 * Refused when nothing is overdue. The letter's content is recorded so it can
 * be produced again exactly.
 */
export function produceReminderLetter(
  db: AppDatabase,
  params: { companyId: string; customerId: string; asOf: IsoDate; level: number; actor: string },
): { letterId: string; invoices: number; totalMinor: number } {
  if (![1, 2, 3].includes(params.level)) throw new InvoicingError('A reminder is level 1, 2 or 3 (final notice).');
  if (!params.actor.trim()) throw new InvoicingError('Say who is producing this reminder.');
  const overdue = overdueInvoices(db, { companyId: params.companyId, asOf: params.asOf, customerId: params.customerId });
  if (overdue.length === 0) throw new InvoicingError('Nothing of this customer\'s is overdue at that date.');
  const letterId = ids.reminderLetter();
  db.transaction(() => {
    db.insert(reminderLetters).values({
      id: letterId, companyId: params.companyId, customerId: params.customerId, level: params.level,
      asOf: params.asOf, producedBy: params.actor,
    }).run();
    for (const o of overdue) {
      db.insert(invoiceReminders).values({
        id: ids.invoiceReminder(), companyId: params.companyId, letterId, invoiceId: o.invoiceId,
        outstandingMinor: o.outstandingMinor, daysOverdue: o.daysOverdue,
      }).run();
    }
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'customer', entityId: params.customerId, action: 'created', field: 'reminder_letter',
      newValue: JSON.stringify({ letterId, level: params.level, asOf: params.asOf, invoices: overdue.length }),
      source: 'user', actor: params.actor,
    }).run();
  });
  return { letterId, invoices: overdue.length, totalMinor: overdue.reduce((s, o) => s + o.outstandingBaseMinor, 0) };
}

export interface ReminderLetter {
  letterId: string; level: number; title: string; body: string; asOf: string;
  customer: { name: string; address: string | null };
  supplier: { name: string; address: string | null; vatNumber: string | null };
  lines: Array<{ number: string | null; invoiceDate: string; dueDate: string; daysOverdue: number; outstandingMinor: number; currency: string }>;
}

/** A recorded reminder letter, as it was produced. */
export function reminderLetter(db: AppDatabase, params: { companyId: string; letterId: string }): ReminderLetter {
  const letter = db.select().from(reminderLetters)
    .where(and(eq(reminderLetters.id, params.letterId), eq(reminderLetters.companyId, params.companyId))).get();
  if (!letter) throw new InvoicingError(`Reminder ${params.letterId} not found.`);
  const customer = db.select().from(customers).where(eq(customers.id, letter.customerId)).get()!;
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const lines = db.select({ reminder: invoiceReminders, invoice: invoices }).from(invoiceReminders)
    .innerJoin(invoices, eq(invoiceReminders.invoiceId, invoices.id))
    .where(eq(invoiceReminders.letterId, letter.id)).all()
    .map(({ reminder, invoice }) => ({
      number: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, dueDate: invoice.dueDate ?? invoice.invoiceDate,
      daysOverdue: reminder.daysOverdue, outstandingMinor: reminder.outstandingMinor, currency: invoice.currency,
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return {
    letterId: letter.id, level: letter.level, asOf: letter.asOf, ...REMINDER_LEVELS[letter.level]!,
    customer: { name: customer.legalName ?? customer.name, address: customer.addressLines },
    supplier: { name: company.legalName, address: company.principalBusinessAddress ?? company.registeredOffice, vatNumber: company.vatNumber },
    lines,
  };
}

export interface ReceivablesSummary {
  asOf: string;
  owedMinor: number;
  overdueMinor: number;
  overdueCount: number;
  onAccountMinor: number;
  topDebtors: Array<{ customerId: string; name: string; owedMinor: number; overdueMinor: number }>;
  overLimit: Array<{ customerId: string; name: string; owedMinor: number; creditLimitMinor: number }>;
  /** Overdue invoices with no reminder in the last 14 days. */
  needingReminder: number;
}

/** The receivables position on one page (base currency). */
export function receivablesSummary(db: AppDatabase, params: { companyId: string; asOf: IsoDate }): ReceivablesSummary {
  const open = db.select().from(invoices).where(and(
    eq(invoices.companyId, params.companyId), eq(invoices.direction, 'sales'),
    ne(invoices.status, 'void'), ne(invoices.status, 'written_off'), ne(invoices.outstandingMinor, 0),
  )).all();
  const overdue = overdueInvoices(db, params);
  const byCustomer = new Map<string, { owed: number; overdue: number }>();
  for (const inv of open) {
    if (!inv.customerId) continue;
    const e = byCustomer.get(inv.customerId) ?? { owed: 0, overdue: 0 };
    e.owed += toBase(inv, inv.outstandingMinor);
    byCustomer.set(inv.customerId, e);
  }
  for (const o of overdue) if (o.customerId) byCustomer.get(o.customerId)!.overdue += o.outstandingBaseMinor;
  const names = new Map(db.select({ id: customers.id, name: customers.name }).from(customers)
    .where(eq(customers.companyId, params.companyId)).all().map((c) => [c.id, c.name]));
  const topDebtors = [...byCustomer.entries()]
    .map(([customerId, v]) => ({ customerId, name: names.get(customerId) ?? customerId, owedMinor: v.owed, overdueMinor: v.overdue }))
    .filter((d) => d.owedMinor > 0).sort((a, b) => b.owedMinor - a.owedMinor).slice(0, 10);
  const overLimit = db.select().from(customers).where(and(eq(customers.companyId, params.companyId), isNotNull(customers.creditLimitMinor))).all()
    .filter((c) => c.creditLimitMinor !== null)
    .map((c) => ({ customerId: c.id, name: c.name, owedMinor: customerExposure(db, { companyId: params.companyId, customerId: c.id }).outstandingBaseMinor, creditLimitMinor: c.creditLimitMinor! }))
    .filter((c) => c.owedMinor > c.creditLimitMinor);
  const fortnightAgo = asIsoDate(new Date(Date.parse(`${params.asOf}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10));
  return {
    asOf: params.asOf,
    owedMinor: open.reduce((s, inv) => s + toBase(inv, inv.outstandingMinor), 0),
    overdueMinor: overdue.reduce((s, o) => s + o.outstandingBaseMinor, 0),
    overdueCount: overdue.length,
    onAccountMinor: paymentsOnAccount(db, { companyId: params.companyId }).filter((p) => p.direction === 'received')
      .reduce((s, p) => s + p.onAccountMinor, 0),
    topDebtors, overLimit,
    needingReminder: overdue.filter((o) => !o.lastReminderOn || o.lastReminderOn < fortnightAgo).length,
  };
}

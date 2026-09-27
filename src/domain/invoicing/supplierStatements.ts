import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { invoices, suppliers, companies, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, type IsoDate } from '../dates';
import { upsertReviewItem } from '../extraction/service';
import { InvoicingError } from './invoices';
import { accountHistory, type StatementEntry } from './receivables';

/**
 * Supplier statements (issue #413): our account with a supplier, and checking
 * the supplier's own statement against it.
 *
 * The statement mirrors the customer's (#405) from the other side: bills and
 * debit notes increase what we owe, credit notes, payments made and shortfalls
 * written off reduce it, refunds received and reversed payments put it back.
 * Its closing balance is the supplier's share of creditors.
 *
 * Reconciling a supplier's statement compares their balance with ours and,
 * when their invoice numbers are given, lists the invoices they show that we
 * do not hold (likely missing documents) and the open ones we hold that they
 * do not show. A difference is flagged for a person; nothing is adjusted.
 */

export interface SupplierStatement {
  supplierId: string; supplierName: string; address: string | null; currency: string;
  from: IsoDate; to: IsoDate;
  openingBalanceMinor: number; entries: StatementEntry[]; closingBalanceMinor: number;
  ageing: Array<{ label: string; amountMinor: number }>;
}

function requireSupplier(db: AppDatabase, companyId: string, supplierId: string) {
  const supplier = db.select().from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.companyId, companyId))).get();
  if (!supplier) throw new InvoicingError(`Supplier ${supplierId} not found.`);
  return supplier;
}

export function supplierStatement(
  db: AppDatabase, params: { companyId: string; supplierId: string; from: IsoDate; to: IsoDate },
): SupplierStatement {
  if (params.to < params.from) throw new InvoicingError('The statement ends before it starts.');
  const supplier = requireSupplier(db, params.companyId, params.supplierId);
  const currency = db.select({ c: companies.baseCurrency }).from(companies).where(eq(companies.id, params.companyId)).get()!.c;
  const history = accountHistory(db, {
    companyId: params.companyId, side: 'supplier', partyId: supplier.id, from: params.from, to: params.to,
  });
  return {
    supplierId: supplier.id, supplierName: supplier.legalName ?? supplier.name, address: supplier.viesAddress,
    currency, from: params.from, to: params.to, ...history,
  };
}

/** Invoice numbers compare without case, spaces or punctuation: "INV-0042" and "inv 0042" are the same. */
const normalise = (number: string) => number.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface SupplierStatementReconciliation {
  supplierId: string; supplierName: string; asOf: IsoDate; currency: string;
  theirBalanceMinor: number; ourBalanceMinor: number;
  /** Their balance less ours: positive when they say we owe more than our books show. */
  differenceMinor: number;
  /** Invoice numbers on their statement that match nothing we hold. */
  theirsNotHeld: string[];
  /** Our bills with something outstanding that their statement does not show. */
  oursNotOnTheirs: Array<{ invoiceId: string; number: string | null; invoiceDate: string; outstandingMinor: number }>;
  invoiceNumbersChecked: boolean;
}

/**
 * Check a supplier's statement against our books as of its date. The
 * difference, when there is one, becomes a review item; nothing is posted.
 */
export function reconcileSupplierStatement(
  db: AppDatabase,
  params: {
    companyId: string; supplierId: string; asOf: IsoDate; statementBalanceMinor: number;
    invoiceNumbers?: string[] | null; actor: string;
  },
): SupplierStatementReconciliation {
  if (!Number.isInteger(params.statementBalanceMinor)) {
    throw new InvoicingError('The statement balance is an amount in minor units.');
  }
  if (!params.actor.trim()) throw new InvoicingError('Say who is checking the statement.');
  const statement = supplierStatement(db, {
    companyId: params.companyId, supplierId: params.supplierId, from: params.asOf, to: params.asOf,
  });
  const ourBalanceMinor = statement.closingBalanceMinor;
  const differenceMinor = params.statementBalanceMinor - ourBalanceMinor;

  const bills = db.select().from(invoices).where(and(
    eq(invoices.companyId, params.companyId), eq(invoices.supplierId, params.supplierId),
    eq(invoices.direction, 'purchase'), ne(invoices.status, 'void'),
  )).all().filter((b) => b.invoiceDate <= params.asOf);

  const given = (params.invoiceNumbers ?? []).map((n) => n.trim()).filter(Boolean);
  const invoiceNumbersChecked = given.length > 0;
  const held = new Set(bills.map((b) => b.invoiceNumber).filter((n): n is string => !!n).map(normalise));
  const theirs = new Set(given.map(normalise));
  const theirsNotHeld = invoiceNumbersChecked ? given.filter((n) => !held.has(normalise(n))) : [];
  const oursNotOnTheirs = invoiceNumbersChecked
    ? bills.filter((b) => !b.isCreditNote && b.outstandingMinor > 0 && !(b.invoiceNumber && theirs.has(normalise(b.invoiceNumber))))
      .map((b) => ({ invoiceId: b.id, number: b.invoiceNumber, invoiceDate: b.invoiceDate, outstandingMinor: b.outstandingMinor }))
    : [];

  const money = (m: number) => (m / 100).toFixed(2);
  db.transaction(() => {
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'supplier', entityId: statement.supplierId, action: 'reconciled',
      newValue: JSON.stringify({
        asOf: params.asOf, theirBalanceMinor: params.statementBalanceMinor, ourBalanceMinor, differenceMinor,
        theirsNotHeld, oursNotOnTheirs: oursNotOnTheirs.map((o) => o.number ?? o.invoiceId),
      }),
      source: 'user', actor: params.actor,
    }).run();
    if (differenceMinor !== 0 || theirsNotHeld.length > 0) {
      upsertReviewItem(db, {
        companyId: params.companyId, kind: 'reconciliation_difference', severity: 'warning',
        title: `${statement.supplierName}'s statement at ${params.asOf} differs from our books`,
        detail: `Their statement shows ${money(params.statementBalanceMinor)}; our books show ${money(ourBalanceMinor)} `
          + `(difference ${money(differenceMinor)}).`
          + (theirsNotHeld.length ? ` Invoices on their statement we do not hold: ${theirsNotHeld.join(', ')} — ask for them.` : '')
          + (oursNotOnTheirs.length ? ` Our open bills they do not show: ${oursNotOnTheirs.map((o) => o.number ?? o.invoiceId).join(', ')}.` : '')
          + ' Nothing has been adjusted.',
        entityType: 'supplier', entityId: statement.supplierId,
        dedupeKey: `supplier:${statement.supplierId}:statement:${params.asOf}`,
      });
    }
  });

  return {
    supplierId: statement.supplierId, supplierName: statement.supplierName, asOf: params.asOf, currency: statement.currency,
    theirBalanceMinor: params.statementBalanceMinor, ourBalanceMinor, differenceMinor,
    theirsNotHeld, oursNotOnTheirs, invoiceNumbersChecked,
  };
}

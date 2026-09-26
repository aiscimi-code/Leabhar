import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { vatEntries, vatPeriods, journalLines, accounts, bankTransactions, documents } from '@/db/schema';
import { buildVat3Return } from './report';

/**
 * Reconcile a VAT return (issue #210, absorbing #187):
 *
 * 1. Each box equals the sum of the entries behind it, recomputed here
 *    independently of the report.
 * 2. The ledger agrees: across the journals behind the period's entries, the
 *    VAT accounts moved by T1 - T2 (VAT on sales and the VAT control account
 *    credited, recoverable VAT on purchases debited).
 * 3. What is not in the return because nobody has confirmed it yet is listed,
 *    with its value: unclassified bank lines and unconfirmed documents dated
 *    in the period.
 */

export interface VatReconciliation {
  vatPeriodId: string;
  boxes: Array<{ box: string; reported: number; fromEntries: number; agrees: boolean }>;
  ledger: { vatAccountsMovementMinor: number; netPositionMinor: number; agrees: boolean; journalCount: number };
  excluded: {
    unclassifiedBankLines: Array<{ id: string; date: string; description: string; amountMinor: number }>;
    unconfirmedDocuments: Array<{ id: string; filename: string; date: string | null; grossMinor: number | null }>;
  };
  agrees: boolean;
}

export function reconcileVatReturn(db: AppDatabase, params: { companyId: string; vatPeriodId: string }): VatReconciliation {
  const period = db.select().from(vatPeriods)
    .where(and(eq(vatPeriods.id, params.vatPeriodId), eq(vatPeriods.companyId, params.companyId))).get();
  if (!period) throw new Error(`VAT period ${params.vatPeriodId} not found.`);
  const report = buildVat3Return(db, params);
  const entries = db.select().from(vatEntries)
    .where(and(eq(vatEntries.companyId, params.companyId), eq(vatEntries.vatPeriodId, params.vatPeriodId))).all();

  // 1. Boxes from the entries, independently.
  const sums: Record<string, number> = {};
  for (const e of entries) {
    if (e.vatBox) sums[e.vatBox] = (sums[e.vatBox] ?? 0) + (e.vatBox === 'T2' ? e.baseRecoverableVatMinor : e.baseVatMinor);
    if (e.netBox) sums[e.netBox] = (sums[e.netBox] ?? 0) + e.baseNetMinor;
  }
  const net = (sums['T1'] ?? 0) - (sums['T2'] ?? 0);
  sums['T3'] = Math.max(net, 0);
  sums['T4'] = Math.max(-net, 0);
  const r = report as unknown as Record<string, { amountMinor: number }>;
  const boxes = ['T1', 'T2', 'T3', 'T4', 'E1', 'E2', 'ES1', 'ES2', 'PA1'].map((box) => {
    const reported = r[box]!.amountMinor;
    const fromEntries = sums[box] ?? 0;
    return { box, reported, fromEntries, agrees: reported === fromEntries };
  });

  // 2. The VAT accounts across the journals behind the entries.
  const journalIds = [...new Set(entries.map((e) => e.journalEntryId).filter((j): j is string => !!j))];
  const vatAccountIds = db.select({ id: accounts.id, key: accounts.systemKey }).from(accounts)
    .where(and(eq(accounts.companyId, params.companyId), inArray(accounts.systemKey, ['vat_on_sales', 'vat_on_purchases', 'vat_control'])))
    .all();
  let movement = 0;
  if (journalIds.length && vatAccountIds.length) {
    const byId = new Map(vatAccountIds.map((a) => [a.id, a.key]));
    for (const l of db.select().from(journalLines)
      .where(and(inArray(journalLines.journalEntryId, journalIds), inArray(journalLines.accountId, [...byId.keys()]))).all()) {
      // Credit balances on the liability side, debit on the recoverable side: net movement is credits less debits.
      movement += l.baseCreditMinor - l.baseDebitMinor;
    }
  }
  const ledger = { vatAccountsMovementMinor: movement, netPositionMinor: report.netPositionMinor, agrees: movement === report.netPositionMinor, journalCount: journalIds.length };

  // 3. What the return cannot yet include.
  const unclassifiedBankLines = db.select().from(bankTransactions)
    .where(and(eq(bankTransactions.companyId, params.companyId), eq(bankTransactions.status, 'unclassified'),
      gte(bankTransactions.transactionDate, period.startDate), lte(bankTransactions.transactionDate, period.endDate)))
    .all().map((t) => ({ id: t.id, date: t.transactionDate, description: t.description, amountMinor: t.amountMinor }));
  const unconfirmedDocuments = db.select().from(documents)
    .where(and(eq(documents.companyId, params.companyId), ne(documents.reviewStatus, 'confirmed'),
      gte(documents.documentDate, period.startDate), lte(documents.documentDate, period.endDate)))
    .all().filter((d) => d.reviewStatus !== 'rejected')
    .map((d) => ({ id: d.id, filename: d.originalFilename, date: d.documentDate, grossMinor: d.grossMinor }));

  return {
    vatPeriodId: period.id, boxes, ledger, excluded: { unclassifiedBankLines, unconfirmedDocuments },
    agrees: boxes.every((b) => b.agrees) && ledger.agrees,
  };
}

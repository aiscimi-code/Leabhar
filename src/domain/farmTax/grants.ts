import { and, asc, eq, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, fixedAssets, grantReceipts, grants, journalEntries, journalLines, GRANT_KINDS } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate } from '../dates';
import { upsertReviewItem } from '../extraction/service';

/**
 * Farm grants and DAFM payments (EPIC 25, issue #543). The register says what
 * each grant is and what it funds; its receipts are posted lines linked to
 * it, so the amounts are always the ledger's. A capital grant reduces the
 * expenditure its asset's allowances are computed on (TCA s.317(2); s.658(13)
 * for farm buildings), in `capitalAllowances`.
 */

export class GrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrantError';
  }
}

export type Grant = typeof grants.$inferSelect;
export type GrantKind = (typeof GRANT_KINDS)[number];

const eur = (m: number) => (m / 100).toFixed(2);

export function recordGrant(db: AppDatabase, p: {
  companyId: string; scheme: string; payer: string; reference?: string | null; kind: GrantKind; awardedMinor: number;
  awardedOn: string; fixedAssetId?: string | null; notes?: string | null; recordedBy: string;
}): Grant {
  if (!p.scheme.trim() || !p.payer.trim()) throw new GrantError('Name the scheme and who pays it (DAFM, or another body).');
  if (!GRANT_KINDS.includes(p.kind)) throw new GrantError('A grant is revenue (income of the year) or capital (towards an asset).');
  if (!Number.isInteger(p.awardedMinor) || p.awardedMinor <= 0) throw new GrantError('The amount awarded is a positive number of cent.');
  if (!isIsoDate(p.awardedOn)) throw new GrantError('The award date is a YYYY-MM-DD date.');
  if (p.kind === 'capital') {
    if (!p.fixedAssetId) throw new GrantError('A capital grant names the asset it funds: register the asset first.');
    const asset = db.select().from(fixedAssets).where(and(eq(fixedAssets.id, p.fixedAssetId), eq(fixedAssets.companyId, p.companyId))).get();
    if (!asset) throw new GrantError(`Fixed asset ${p.fixedAssetId} not found.`);
  } else if (p.fixedAssetId) {
    throw new GrantError('A revenue grant is income of the year; only a capital grant funds an asset.');
  }
  const id = ids.grant();
  db.insert(grants).values({
    id, companyId: p.companyId, scheme: p.scheme.trim(), payer: p.payer.trim(), reference: p.reference?.trim() || null, kind: p.kind,
    awardedMinor: p.awardedMinor, awardedOn: asIsoDate(p.awardedOn), fixedAssetId: p.fixedAssetId ?? null, notes: p.notes?.trim() || null,
    recordedBy: p.recordedBy,
  }).run();
  return db.select().from(grants).where(eq(grants.id, id)).get()!;
}

function requireGrant(db: AppDatabase, companyId: string, grantId: string): Grant {
  const g = db.select().from(grants).where(and(eq(grants.id, grantId), eq(grants.companyId, companyId))).get();
  if (!g) throw new GrantError(`Grant ${grantId} not found.`);
  return g;
}

/** The amount a posted line brought in: its credit less its debit, in base currency. */
function receivedBy(line: { baseCreditMinor: number; baseDebitMinor: number }): number {
  return line.baseCreditMinor - line.baseDebitMinor;
}

/**
 * Link a posted line to the grant it received (issue #543): the credit line
 * of the receipt (to grant income, or to the asset or deferred income for a
 * capital grant). One line belongs to one grant.
 */
export function linkGrantReceipt(db: AppDatabase, p: { companyId: string; grantId: string; journalLineId: string; recordedBy: string }) {
  const grant = requireGrant(db, p.companyId, p.grantId);
  const row = db.select({ line: journalLines, entry: journalEntries, account: accounts }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.id, p.journalLineId), eq(journalLines.companyId, p.companyId))).get();
  if (!row) throw new GrantError(`Journal line ${p.journalLineId} not found.`);
  if (!row.entry.isPosted) throw new GrantError('Only a posted line is a receipt.');
  if (row.entry.reversedByEntryId) throw new GrantError('That entry has been reversed: link the entry that replaced it.');
  if (receivedBy(row.line) <= 0) throw new GrantError('A receipt is the credit line the grant was posted to, not a debit.');
  if (grant.kind === 'revenue' && row.account.type !== 'income') {
    throw new GrantError(`${row.account.code} ${row.account.name} is not an income account: a revenue grant is income of the year.`);
  }
  if (grant.kind === 'capital' && row.account.type === 'income') {
    throw new GrantError('A capital grant is not income of the year: link the line posted to the asset or to deferred grant income.');
  }
  const taken = db.select().from(grantReceipts).where(eq(grantReceipts.journalLineId, row.line.id)).get();
  if (taken) throw new GrantError('That line is already the receipt of a grant.');
  const id = ids.grantReceipt();
  db.insert(grantReceipts).values({ id, companyId: p.companyId, grantId: grant.id, journalLineId: row.line.id, recordedBy: p.recordedBy }).run();
  return db.select().from(grantReceipts).where(eq(grantReceipts.id, id)).get()!;
}

/** Receipts of a grant up to a date, from the lines linked to it. */
function receiptsOf(db: AppDatabase, grantId: string, asOf?: string) {
  const where = [eq(grantReceipts.grantId, grantId), eq(journalEntries.isPosted, true)];
  if (asOf) where.push(lte(journalEntries.entryDate, asOf));
  return db.select({ receiptId: grantReceipts.id, journalLineId: journalLines.id, date: journalEntries.entryDate,
    reversedBy: journalEntries.reversedByEntryId, credit: journalLines.baseCreditMinor, debit: journalLines.baseDebitMinor })
    .from(grantReceipts)
    .innerJoin(journalLines, eq(grantReceipts.journalLineId, journalLines.id))
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .where(and(...where)).orderBy(asc(journalEntries.entryDate)).all()
    .filter((r) => !r.reversedBy)
    .map((r) => ({ ...r, amountMinor: r.credit - r.debit }));
}

/** Capital grants received towards an asset by a date: what s.317(2) takes off its expenditure. */
export function capitalGrantsReceivedFor(db: AppDatabase, assetId: string, asOf: string): { receivedMinor: number; awardedMinor: number } {
  let receivedMinor = 0;
  let awardedMinor = 0;
  for (const g of db.select().from(grants).where(and(eq(grants.fixedAssetId, assetId), eq(grants.kind, 'capital'))).all()) {
    if (g.awardedOn > asOf) continue;
    awardedMinor += g.awardedMinor;
    receivedMinor += receiptsOf(db, g.id, asOf).reduce((s, r) => s + r.amountMinor, 0);
  }
  return { receivedMinor, awardedMinor };
}

export interface GrantReconciliation {
  asOf: string;
  grants: Array<Grant & { receivedMinor: number; outstandingMinor: number; receipts: Array<{ date: string; amountMinor: number }> }>;
  /** Credits to grant income accounts that no grant claims. */
  unlinked: Array<{ journalLineId: string; date: string; accountCode: string; amountMinor: number; narrative: string }>;
}

/** Scheme income accounts: the farm chart's "Scheme and support income" and anything named for grants. */
function grantIncomeAccounts(db: AppDatabase, companyId: string) {
  return db.select().from(accounts).where(and(eq(accounts.companyId, companyId), eq(accounts.type, 'income'))).all()
    .filter((a) => /grant|scheme|subsid/i.test(a.name));
}

/**
 * Reconcile the grants register (issue #543): awarded against received per
 * grant, and every credit to a grant or scheme income account that no grant
 * claims. An unclaimed receipt is a review item, never assigned to a grant;
 * `raiseReviewItems: false` reads the same figures without raising them.
 */
export function reconcileGrants(db: AppDatabase, p: { companyId: string; asOf: string; raiseReviewItems?: boolean }): GrantReconciliation {
  if (!isIsoDate(p.asOf)) throw new GrantError('The date is a YYYY-MM-DD date.');
  const list = db.select().from(grants).where(and(eq(grants.companyId, p.companyId), lte(grants.awardedOn, p.asOf)))
    .orderBy(asc(grants.awardedOn)).all().map((g) => {
      const receipts = receiptsOf(db, g.id, p.asOf);
      const receivedMinor = receipts.reduce((s, r) => s + r.amountMinor, 0);
      return { ...g, receivedMinor, outstandingMinor: g.awardedMinor - receivedMinor, receipts: receipts.map((r) => ({ date: r.date, amountMinor: r.amountMinor })) };
    });
  const linked = new Set(db.select({ id: grantReceipts.journalLineId }).from(grantReceipts).where(eq(grantReceipts.companyId, p.companyId)).all().map((r) => r.id));
  const unlinked: GrantReconciliation['unlinked'] = [];
  for (const account of grantIncomeAccounts(db, p.companyId)) {
    const lines = db.select({ line: journalLines, entry: journalEntries }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(and(eq(journalLines.accountId, account.id), eq(journalEntries.isPosted, true), lte(journalEntries.entryDate, p.asOf))).all();
    for (const { line, entry } of lines) {
      const amount = receivedBy(line);
      if (amount <= 0 || linked.has(line.id) || entry.reversedByEntryId || entry.reversalOfId) continue;
      unlinked.push({ journalLineId: line.id, date: entry.entryDate, accountCode: account.code, amountMinor: amount, narrative: entry.narrative });
    }
  }
  for (const u of p.raiseReviewItems === false ? [] : unlinked) {
    upsertReviewItem(db, {
      companyId: p.companyId, kind: 'reconciliation_difference', severity: 'info',
      title: `Grant income of ${eur(u.amountMinor)} on ${u.date} is not linked to a grant`,
      detail: `${u.narrative}: a credit to ${u.accountCode}. Link it to the grant it was paid under, so the register shows what was received.`,
      entityType: 'journal_line', entityId: u.journalLineId, dedupeKey: `grant_unlinked:${u.journalLineId}`, context: u,
    });
  }
  return { asOf: p.asOf, grants: list, unlinked };
}

export function listGrants(db: AppDatabase, companyId: string): Grant[] {
  return db.select().from(grants).where(eq(grants.companyId, companyId)).orderBy(asc(grants.awardedOn)).all();
}

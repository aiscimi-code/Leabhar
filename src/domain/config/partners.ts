import { and, eq, like } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, partners, partnerShares, accounts, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, isIsoDate } from '../dates';
import { multiplyRational } from '../money';

/**
 * The partners of a partnership and their profit shares (issue #212).
 *
 * Each partner has a capital and a current account of their own. A share is
 * effective-dated: a change closes the old row on its date and adds a new
 * one, so the allocation for any earlier period is what was in force then.
 */

export class PartnerError extends Error {}

export type Partner = typeof partners.$inferSelect;

export function requirePartnership(db: AppDatabase, companyId: string) {
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new PartnerError(`Company ${companyId} not found.`);
  if (company.entityType !== 'partnership') {
    throw new PartnerError('Partners belong to a partnership; these books are for a '
      + `${company.entityType === 'sole_trader' ? 'sole trader' : 'company'}.`);
  }
  return company;
}

const checkShare = (bp: number) => {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) throw new PartnerError('A share is between 0% and 100%, in basis points.');
};

export function nextCode(db: AppDatabase, companyId: string, prefix: string): string {
  const used = new Set(db.select({ code: accounts.code }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), like(accounts.code, `${prefix}%`))).all().map((a) => a.code));
  for (let n = 1; n < 50; n++) {
    const code = `${prefix}${String(n).padStart(2, '0')}`;
    if (!used.has(code)) return code;
  }
  throw new PartnerError('No free account code for another partner.');
}

export function addPartner(db: AppDatabase, params: {
  companyId: string; name: string; shareBasisPoints: number; joinedOn: string; recordedBy: string;
  isPrecedentPartner?: boolean; taxReference?: string | null;
}): Partner {
  requirePartnership(db, params.companyId);
  if (!params.recordedBy.trim()) throw new PartnerError('Say who is recording this partner.');
  if (!params.name.trim()) throw new PartnerError('A partner needs a name.');
  if (!isIsoDate(params.joinedOn)) throw new PartnerError('The date the partner joined is a YYYY-MM-DD date.');
  checkShare(params.shareBasisPoints);
  if (params.isPrecedentPartner) {
    const existing = db.select().from(partners)
      .where(and(eq(partners.companyId, params.companyId), eq(partners.isPrecedentPartner, true))).get();
    if (existing && !existing.leftOn) {
      throw new PartnerError(`${existing.name} is already the precedent partner; a partnership has one.`);
    }
  }
  return db.transaction((tx) => {
    const account = (code: string, name: string) => {
      const id = ids.account();
      tx.insert(accounts).values({
        id, companyId: params.companyId, code, name, type: 'equity', subtype: 'equity', vatApplicable: false,
        isSystem: false, systemKey: null, reportSection: 'equity', reportOrder: 900, description: null,
        effectiveFrom: params.joinedOn,
      }).run();
      return id;
    };
    const capitalAccountId = account(nextCode(tx as unknown as AppDatabase, params.companyId, '301'), `Capital — ${params.name}`);
    const currentAccountId = account(nextCode(tx as unknown as AppDatabase, params.companyId, '305'), `Current account — ${params.name}`);
    const id = ids.partner();
    tx.insert(partners).values({
      id, companyId: params.companyId, name: params.name.trim(), taxReference: params.taxReference ?? null,
      isPrecedentPartner: params.isPrecedentPartner ?? false, joinedOn: params.joinedOn,
      capitalAccountId, currentAccountId, recordedBy: params.recordedBy,
    }).run();
    tx.insert(partnerShares).values({
      id: ids.partnerShare(), companyId: params.companyId, partnerId: id, shareBasisPoints: params.shareBasisPoints,
      effectiveFrom: params.joinedOn, recordedBy: params.recordedBy,
    }).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(), entityType: 'partner', entityId: id,
      action: 'created', newValue: JSON.stringify({ name: params.name, shareBasisPoints: params.shareBasisPoints, joinedOn: params.joinedOn }),
      source: 'user', actor: params.recordedBy,
    }).run();
    return tx.select().from(partners).where(eq(partners.id, id)).get()!;
  });
}

/** A new profit share from a date: the share in force is closed on that date, never edited. */
export function setPartnerShare(db: AppDatabase, params: {
  companyId: string; partnerId: string; shareBasisPoints: number; effectiveFrom: string; recordedBy: string; basis?: string;
}): void {
  requirePartnership(db, params.companyId);
  checkShare(params.shareBasisPoints);
  if (!params.recordedBy.trim()) throw new PartnerError('Say who is recording this change.');
  if (!isIsoDate(params.effectiveFrom)) throw new PartnerError('The date the share changes is a YYYY-MM-DD date.');
  const current = db.select().from(partnerShares)
    .where(and(eq(partnerShares.companyId, params.companyId), eq(partnerShares.partnerId, params.partnerId))).all()
    .find((s) => s.effectiveTo === null);
  if (!current) throw new PartnerError('That partner has no share in force.');
  if (params.effectiveFrom <= current.effectiveFrom) {
    throw new PartnerError(`The new share must start after ${current.effectiveFrom}, when the current one did.`);
  }
  db.transaction((tx) => {
    tx.update(partnerShares).set({ effectiveTo: params.effectiveFrom }).where(eq(partnerShares.id, current.id)).run();
    tx.insert(partnerShares).values({
      id: ids.partnerShare(), companyId: params.companyId, partnerId: params.partnerId,
      shareBasisPoints: params.shareBasisPoints, effectiveFrom: params.effectiveFrom, recordedBy: params.recordedBy,
      basis: params.basis ?? null,
    }).run();
  });
}

export interface PartnerShareOn { partner: Partner; shareBasisPoints: number }

/** The shares in force on a date. */
export function partnerSharesOn(db: AppDatabase, companyId: string, date: string): PartnerShareOn[] {
  const byId = new Map(db.select().from(partners).where(eq(partners.companyId, companyId)).all().map((p) => [p.id, p]));
  return db.select().from(partnerShares).where(eq(partnerShares.companyId, companyId)).all()
    .filter((s) => s.effectiveFrom <= date && (s.effectiveTo === null || s.effectiveTo > date))
    .map((s) => ({ partner: byId.get(s.partnerId)!, shareBasisPoints: s.shareBasisPoints }))
    .filter((s) => !s.partner.leftOn || s.partner.leftOn > date);
}

/**
 * The periods within [from, to] over which the shares were constant, with
 * the shares in force: the allocation of a year's profit is made period by
 * period, by days, when the shares changed during it.
 */
export function shareSegments(db: AppDatabase, companyId: string, from: string, to: string) {
  const changes = new Set<string>([from]);
  for (const s of db.select().from(partnerShares).where(eq(partnerShares.companyId, companyId)).all()) {
    if (s.effectiveFrom > from && s.effectiveFrom <= to) changes.add(s.effectiveFrom);
    if (s.effectiveTo && s.effectiveTo > from && s.effectiveTo <= to) changes.add(s.effectiveTo);
  }
  const starts = [...changes].sort();
  return starts.map((start, i) => {
    const end = i + 1 < starts.length
      ? new Date(Date.parse(starts[i + 1]!) - 86_400_000).toISOString().slice(0, 10) : to;
    return { from: start, to: end, shares: partnerSharesOn(db, companyId, start) };
  });
}

/** The stretches of [from, to] over which the partners' shares do not add up to 100%. */
export function shareGaps(
  db: AppDatabase, companyId: string, from: string, to: string,
): Array<{ from: string; to: string; totalBasisPoints: number }> {
  return shareSegments(db, companyId, from, to)
    .map((seg) => ({ seg, total: seg.shares.reduce((s, x) => s + x.shareBasisPoints, 0) }))
    .filter((s) => s.total !== 10_000)
    .map((s) => ({ from: s.seg.from, to: s.seg.to, totalBasisPoints: s.total }));
}

/** What is wrong with the partnership's record for a period. */
export function partnershipFindings(db: AppDatabase, companyId: string, from: string, to: string): string[] {
  const findings = shareGaps(db, companyId, from, to).map((gap) =>
    `From ${gap.from} to ${gap.to} the partners' shares add up to ${gap.totalBasisPoints / 100}%, not 100%. `
    + 'Record each partner\'s share so the profit can be allocated.');
  const all = db.select().from(partners).where(eq(partners.companyId, companyId)).all();
  if (!all.some((p) => p.isPrecedentPartner && (!p.leftOn || p.leftOn > to))) {
    findings.push('No precedent partner is recorded. The precedent partner makes the partnership return (Form 1 (Firms), TCA s.1007).');
  }
  return findings;
}

export interface PartnerAllocation {
  partner: Partner;
  amountMinor: number;
  /** The partner's share of the period, weighted by days through share changes. */
  weightedShareBasisPoints: number;
}

/**
 * Allocate an amount over [from, to] between the partners by the shares in
 * force, day by day through a change (s.1008) — the one allocation the
 * year-end close and the income tax computation both use, so the books and
 * the tax return cannot disagree. Rounding can leave the parts a cent off the
 * whole; that residue goes to the precedent partner, or the partner who
 * joined first, so the parts always add up to the amount exactly.
 *
 * Shares that do not add up to 100% are allocated as recorded and the gap is
 * reported by `shareGaps`; the allocation never guesses a missing share.
 */
export function allocateByShares(
  db: AppDatabase, companyId: string, params: { from: string; to: string; amountMinor: number },
): PartnerAllocation[] {
  const totalDays = Math.round((Date.parse(params.to) - Date.parse(params.from)) / 86_400_000) + 1;
  const partnersById = new Map(db.select().from(partners)
    .where(eq(partners.companyId, companyId)).all()
    .sort((a, b) => a.joinedOn.localeCompare(b.joinedOn) || a.name.localeCompare(b.name))
    .map((p) => [p.id, p]));
  const parts = new Map<string, { amountMinor: number; shareDays: number }>();
  for (const seg of shareSegments(db, companyId, params.from, params.to)) {
    const segDays = Math.round((Date.parse(seg.to) - Date.parse(seg.from)) / 86_400_000) + 1;
    const segAmount = multiplyRational(params.amountMinor, segDays, totalDays);
    for (const s of seg.shares) {
      const cur = parts.get(s.partner.id) ?? { amountMinor: 0, shareDays: 0 };
      cur.amountMinor += multiplyRational(segAmount, s.shareBasisPoints, 10_000);
      cur.shareDays += s.shareBasisPoints * segDays;
      parts.set(s.partner.id, cur);
    }
  }
  const rows: PartnerAllocation[] = [...partnersById.values()]
    .filter((p) => parts.has(p.id))
    .map((p) => {
      const part = parts.get(p.id)!;
      return { partner: p, amountMinor: part.amountMinor, weightedShareBasisPoints: Math.round(part.shareDays / totalDays) };
    });
  const residue = params.amountMinor - rows.reduce((s, r) => s + r.amountMinor, 0);
  if (rows.length > 0 && residue !== 0) {
    const taker = rows.find((r) => r.partner.isPrecedentPartner && !r.partner.leftOn) ?? rows[0]!;
    taker.amountMinor += residue;
  }
  return rows;
}

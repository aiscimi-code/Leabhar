import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, isIsoDate } from '../dates';

/**
 * Facts about the company itself that VAT turns on and that no transaction
 * shows (issue #208): whether it is a principal for Relevant Contracts Tax
 * (the s.16(3) reverse charge), and Revenue's authorisation to use the
 * moneys-received basis (s.80). A person records each, from a date, with what
 * it rests on. Each change is audited with the value it replaced.
 */

type CompanyRow = typeof companies.$inferSelect;

function load(db: AppDatabase, companyId: string): CompanyRow {
  const row = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!row) throw new Error(`Company ${companyId} not found.`);
  return row;
}

function requirePerson(who: string): string {
  const name = who?.trim();
  if (!name) throw new Error('Say who is confirming this: it is a person\'s decision, not the system\'s.');
  return name;
}

function requireDate(value: string | null | undefined, what: string): string {
  if (!value || !isIsoDate(value)) throw new Error(`${what} must be a date (YYYY-MM-DD).`);
  return value;
}

function audit(db: AppDatabase, companyId: string, field: string, previous: unknown, next: unknown, actor: string, at: string) {
  db.insert(auditEvents).values({
    id: ids.audit(), companyId, occurredAt: at, entityType: 'company', entityId: companyId,
    action: 'user_confirmed', field, previousValue: previous == null ? null : JSON.stringify(previous),
    newValue: JSON.stringify(next), source: 'user', actor,
  }).run();
}

export function confirmRctPrincipal(db: AppDatabase, params: {
  companyId: string;
  status: 'principal' | 'not_principal';
  /** The date from which the status holds. Required for a principal. */
  from?: string | null;
  /** What it rests on, e.g. "main contractor on building contracts; registered for RCT on ROS". */
  basis: string;
  confirmedBy: string;
}): void {
  const who = requirePerson(params.confirmedBy);
  const basis = params.basis?.trim();
  if (!basis) {
    throw new Error('Say what the status rests on: a principal under TCA 1997 s.530A is, for example, a main '
      + 'contractor or a developer who pays subcontractors for construction operations.');
  }
  const from = params.status === 'principal' ? requireDate(params.from, 'The date the company became a principal') : null;
  const before = load(db, params.companyId);
  const at = nowIso();
  db.transaction((tx) => {
    tx.update(companies).set({
      rctPrincipal: params.status, rctPrincipalFrom: from, rctPrincipalBasis: basis,
      rctPrincipalConfirmedBy: who, rctPrincipalConfirmedAt: at, updatedAt: at,
    }).where(eq(companies.id, params.companyId)).run();
    audit(tx as unknown as AppDatabase, params.companyId, 'rct_principal',
      before.rctPrincipal ? { status: before.rctPrincipal, from: before.rctPrincipalFrom, basis: before.rctPrincipalBasis } : null,
      { status: params.status, from, basis }, who, at);
  });
}

export function recordCashBasisAuthorisation(db: AppDatabase, params: {
  companyId: string;
  eligibility: 'turnover_threshold' | 'supplies_to_unregistered';
  authorisedFrom: string;
  /** Revenue's reference, or where the authorisation is filed. */
  reference: string;
  confirmedBy: string;
}): void {
  const who = requirePerson(params.confirmedBy);
  const from = requireDate(params.authorisedFrom, 'The date the authorisation has effect from');
  const reference = params.reference?.trim();
  if (!reference) throw new Error('Record Revenue\'s reference for the authorisation, or where it is filed.');
  const before = load(db, params.companyId);
  const at = nowIso();
  db.transaction((tx) => {
    tx.update(companies).set({
      cashBasisEligibility: params.eligibility, cashBasisAuthorisedFrom: from,
      cashBasisAuthorisationReference: reference, cashBasisConfirmedBy: who, cashBasisConfirmedAt: at, updatedAt: at,
    }).where(eq(companies.id, params.companyId)).run();
    audit(tx as unknown as AppDatabase, params.companyId, 'cash_basis_authorisation',
      before.cashBasisAuthorisedFrom
        ? { eligibility: before.cashBasisEligibility, from: before.cashBasisAuthorisedFrom, reference: before.cashBasisAuthorisationReference }
        : null,
      { eligibility: params.eligibility, from, reference }, who, at);
  });
}

/** Whether the company was a confirmed RCT principal on a date; null when nothing is recorded for that date. */
export function rctPrincipalOn(company: Pick<CompanyRow, 'rctPrincipal' | 'rctPrincipalFrom'>, onDate: string): boolean | null {
  if (company.rctPrincipal === 'not_principal') return false;
  if (company.rctPrincipal === 'principal') return company.rctPrincipalFrom && company.rctPrincipalFrom <= onDate ? true : null;
  return null;
}

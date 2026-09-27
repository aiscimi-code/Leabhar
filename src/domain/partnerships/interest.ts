import { and, eq, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, auditEvents, journalEntries, journalLines, partners } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, isIsoDate, asIsoDate, addDays, type IsoDate } from '../dates';
import { postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { requirePartnership, type Partner } from '../config/partners';

/**
 * Interest charged on a loan from a partner (issue #464).
 *
 * The books side is mechanical: the interest accrues to the partner's loan
 * account (a liability the firm owes them back, like the principal) and is
 * debited to loan interest (6710). The amount is computed from the ledger,
 * never typed in: the rate, the period and the loan it relates to are entered
 * by a person, and the interest is simple interest on the loan account's
 * day-end balance over the period, at an annual rate over a 365-day year,
 * rounded once at the end. Days on which the account stands at nothing or in
 * debit accrue nothing: the firm owes no interest on money it does not owe.
 *
 * The tax side is a fact the books cannot know — whether the "loan" is a
 * genuine loan used wholly and exclusively for the trade (a trading expense,
 * s.81) or interest on the partner's capital (an appropriation of profit, not
 * an expense of earning it) — so the tax computation raises a pending
 * `journal_line` decision for the interest line and adds it back until a
 * person decides (see src/domain/corporationTax/computation.ts). Interest the
 * partner receives is their own income, not part of their profit share; the
 * income tax computation says so in a finding.
 */

export class PartnerLoanInterestError extends Error {}

export interface PartnerLoanInterestResult {
  partner: Partner;
  journalEntryId: string;
  entryNumber: number;
  /** The interest accrued over the period, in minor units. */
  amountMinor: number;
  /** The loan account balance after the interest is accrued. */
  balanceMinor: number;
}

/**
 * Record the interest accrued on a partner's loan account over a period, at
 * the annual rate the loan carries. The journal is dated the last day of the
 * period, and nothing is written unless the whole path completes.
 */
export function recordPartnerLoanInterest(db: AppDatabase, params: {
  companyId: string;
  partnerId: string;
  /** The annual interest rate, in basis points: 500 = 5%. */
  rateBasisPoints: number;
  /** The first day interest accrues (inclusive). */
  from: string;
  /** The last day interest accrues (inclusive); the journal is dated this day. */
  to: string;
  recordedBy: string;
  narrative?: string;
  requestId?: string;
  /** Post even though the date falls in a locked period. */
  overrideLock?: { reason: string };
}): PartnerLoanInterestResult {
  const company = requirePartnership(db, params.companyId);
  if (!params.recordedBy.trim()) throw new PartnerLoanInterestError('Say who is recording this interest.');
  if (!isIsoDate(params.from) || !isIsoDate(params.to)) {
    throw new PartnerLoanInterestError('The interest period is a pair of YYYY-MM-DD dates.');
  }
  const from = asIsoDate(params.from);
  const to = asIsoDate(params.to);
  if (from > to) {
    throw new PartnerLoanInterestError('The interest period ends after the day it starts.');
  }
  if (!Number.isInteger(params.rateBasisPoints) || params.rateBasisPoints <= 0) {
    throw new PartnerLoanInterestError('The interest rate is a positive annual rate in basis points (500 = 5%).');
  }
  const partner = db.select().from(partners)
    .where(and(eq(partners.id, params.partnerId), eq(partners.companyId, params.companyId))).get();
  if (!partner) throw new PartnerLoanInterestError(`Partner ${params.partnerId} not found.`);
  if (!partner.loanAccountId) {
    throw new PartnerLoanInterestError(
      `${partner.name} has no loan account, so there is no loan for interest to accrue on. Record the loan first.`,
    );
  }
  const loanAccountId = partner.loanAccountId;

  // Simple interest on the day-end balance: each day contributes its balance,
  // rounded once at the end so the figure cannot drift from the rate.
  let balanceDays = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const balance = accountBalance(db, {
      companyId: params.companyId, accountId: loanAccountId, asOf: day,
    });
    if (balance > 0) balanceDays += balance;
  }
  const amountMinor = Math.round((balanceDays * params.rateBasisPoints) / (10_000 * 365));
  if (amountMinor <= 0) {
    throw new PartnerLoanInterestError(
      `No interest accrues on ${partner.name}'s loan over ${from} to ${to}: the loan account carries no balance in that period.`,
    );
  }

  // The cost of the financing, reported below operating profit like every
  // other borrowing (account 6710).
  const interestAccount = db.select().from(accounts)
    .where(and(eq(accounts.companyId, params.companyId), eq(accounts.code, '6710'))).get();
  if (!interestAccount) {
    throw new PartnerLoanInterestError(
      'Account 6710 "Loan interest" is not in this book, so the interest has nowhere to be charged.',
    );
  }

  return db.transaction((tx) => {
    const txDb = tx as unknown as AppDatabase;
    const journal = postJournalEntry(txDb, {
      companyId: params.companyId,
      entryDate: to,
      narrative: params.narrative?.trim()
        ?? `Interest on partner loan — ${partner.name}`,
      sourceType: 'partner_loan_interest',
      sourceId: partner.id,
      baseCurrency: company.baseCurrency,
      createdBy: params.recordedBy,
      createdVia: 'user',
      requestId: params.requestId,
      overrideLock: params.overrideLock,
      lines: [
        {
          accountId: interestAccount.id, debitMinor: amountMinor,
          memo: `Interest on ${partner.name}'s loan at ${(params.rateBasisPoints / 100).toFixed(2)}%`,
        },
        {
          accountId: loanAccountId, creditMinor: amountMinor,
          memo: `Interest accrued on ${partner.name}'s loan, ${from} to ${to}`,
        },
      ],
    });

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'partner', entityId: partner.id,
      action: 'loan_interest_accrued',
      newValue: JSON.stringify({
        amountMinor, rateBasisPoints: params.rateBasisPoints, from, to,
        journalEntryId: journal.id, loanAccountId,
      }),
      source: 'user', actor: params.recordedBy, requestId: params.requestId ?? null,
    }).run();

    return {
      partner: tx.select().from(partners).where(eq(partners.id, partner.id)).get()!,
      journalEntryId: journal.id,
      entryNumber: journal.entryNumber,
      amountMinor,
      balanceMinor: accountBalance(txDb, {
        companyId: params.companyId, accountId: loanAccountId, asOf: to,
      }),
    };
  });
}

/**
 * The interest credited to each partner's loan account over a period — for the
 * tax computations' findings, which must say what the books hold rather than
 * re-derive it. Interest is identified by its journal entry's source, never by
 * balance movement, which would mix in advances and repayments.
 */
export function partnerLoanInterestForPeriod(
  db: AppDatabase, params: { companyId: string; from: IsoDate; to: IsoDate },
): Array<{ partner: Partner; amountMinor: number }> {
  const rows = db.select({ line: journalLines, partner: partners })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(partners, eq(partners.loanAccountId, journalLines.accountId))
    .where(and(
      eq(journalLines.companyId, params.companyId),
      eq(journalEntries.sourceType, 'partner_loan_interest'),
      gte(journalEntries.entryDate, params.from),
      lte(journalEntries.entryDate, params.to),
    ))
    .all();
  const byPartner = new Map<string, { partner: Partner; amountMinor: number }>();
  for (const { line, partner } of rows) {
    const bucket = byPartner.get(partner.id) ?? { partner, amountMinor: 0 };
    bucket.amountMinor += line.baseCreditMinor - line.baseDebitMinor;
    byPartner.set(partner.id, bucket);
  }
  return [...byPartner.values()].filter((b) => b.amountMinor !== 0);
}

import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, auditEvents, partners } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, isIsoDate, asIsoDate, type IsoDate } from '../dates';
import { asMinor } from '../money';
import { postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { systemAccountId } from '../config/setup';
import { requirePartnership, nextCode, type Partner } from '../config/partners';

/**
 * Loans between a partner and the partnership (issue #314).
 *
 * A loan is not capital: money a partner lends the firm is a liability it
 * owes them back, so it never touches their capital or current account. Each
 * partner's loans sit in their own account (created on the first loan, under
 * the 228x loans heading), which is what the balance sheet and the partner
 * allocation statement read. The advance or repayment itself is an ordinary
 * posted journal against a money account, so it is immutable like every
 * entry and can only be corrected by a reversing entry.
 *
 * Only the principal is recorded. Interest on a partner loan is a separate
 * question (whether it is charged at all, and what the firm may deduct when
 * computing its profits) and is deliberately not guessed here.
 */

export class PartnerLoanError extends Error {}

export type LoanDirection = 'advanced' | 'repaid';

export interface PartnerLoanResult {
  partner: Partner;
  journalEntryId: string;
  entryNumber: number;
  /** The partner's loan account balance after this loan. */
  balanceMinor: number;
}

/** The partner's loan account, creating it on first use. */
function loanAccount(db: AppDatabase, companyId: string, partner: Partner, date: IsoDate): string {
  if (partner.loanAccountId) {
    const existing = db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.id, partner.loanAccountId), eq(accounts.companyId, companyId))).get();
    if (existing) return existing.id;
  }
  const id = ids.account();
  db.insert(accounts).values({
    id, companyId, code: nextCode(db, companyId, '228'),
    name: `Loan — ${partner.name}`, type: 'liability', subtype: 'non_current_liability',
    vatApplicable: false, isSystem: false, systemKey: null,
    reportSection: 'long_term_liabilities', reportOrder: 905, description: null,
    effectiveFrom: date,
  }).run();
  db.update(partners).set({ loanAccountId: id }).where(eq(partners.id, partner.id)).run();
  return id;
}

export function partnerLoanBalance(db: AppDatabase, companyId: string, partnerId: string, asOf: IsoDate): number | null {
  const partner = db.select().from(partners)
    .where(and(eq(partners.id, partnerId), eq(partners.companyId, companyId))).get();
  if (!partner?.loanAccountId) return null;
  return accountBalance(db, { companyId, accountId: partner.loanAccountId, asOf });
}

/**
 * Record money lent by a partner to the partnership, or the firm repaying it.
 * A repayment never exceeds the outstanding balance: money owed back to a
 * partner beyond their loan is a current-account matter, and posting it here
 * would quietly turn the loan into something it is not.
 */
export function recordPartnerLoan(db: AppDatabase, params: {
  companyId: string;
  partnerId: string;
  direction: LoanDirection;
  amountMinor: number;
  date: string;
  recordedBy: string;
  /** Where the money moved. Defaults to the bank control account. */
  moneyAccountId?: string;
  narrative?: string;
  requestId?: string;
  /** Post even though the date falls in a locked period. */
  overrideLock?: { reason: string };
}): PartnerLoanResult {
  const company = requirePartnership(db, params.companyId);
  if (!params.recordedBy.trim()) throw new PartnerLoanError('Say who is recording this loan.');
  if (!isIsoDate(params.date)) throw new PartnerLoanError('The date of the loan is a YYYY-MM-DD date.');
  const date = asIsoDate(params.date);
  const amount = asMinor(params.amountMinor);
  if (amount <= 0) throw new PartnerLoanError('A loan amount is a positive amount of money.');
  const partner = db.select().from(partners)
    .where(and(eq(partners.id, params.partnerId), eq(partners.companyId, params.companyId))).get();
  if (!partner) throw new PartnerLoanError(`Partner ${params.partnerId} not found.`);

  const moneyAccount = params.moneyAccountId
    ?? systemAccountId(db, params.companyId, 'bank_control');

  return db.transaction((tx) => {
    const txDb = tx as unknown as AppDatabase;
    const loanAccountId = loanAccount(txDb, params.companyId, partner, date);
    const outstanding = accountBalance(txDb, {
      companyId: params.companyId, accountId: loanAccountId, asOf: date,
    });
    if (params.direction === 'repaid' && amount > outstanding) {
      throw new PartnerLoanError(
        `${partner.name}'s loan account stands at ${(outstanding / 100).toFixed(2)} at ${params.date}, `
        + `so ${(amount / 100).toFixed(2)} cannot be repaid. A repayment never exceeds what the firm owes on the loan; `
        + 'record the rest against their current account, or record the loan first.');
    }

    const journal = postJournalEntry(txDb, {
      companyId: params.companyId,
      entryDate: date,
      narrative: params.narrative?.trim()
        ?? `Loan ${params.direction} by ${partner.name}`,
      sourceType: 'partner_loan',
      sourceId: partner.id,
      baseCurrency: company.baseCurrency,
      createdBy: params.recordedBy,
      createdVia: 'user',
      requestId: params.requestId,
      overrideLock: params.overrideLock,
      lines: params.direction === 'advanced'
        ? [
          { accountId: moneyAccount, debitMinor: amount, memo: `Loan advanced by ${partner.name}` },
          { accountId: loanAccountId, creditMinor: amount, memo: `Loan from ${partner.name}` },
        ]
        : [
          { accountId: loanAccountId, debitMinor: amount, memo: `Loan repaid to ${partner.name}` },
          { accountId: moneyAccount, creditMinor: amount, memo: `Loan repaid to ${partner.name}` },
        ],
    });

    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'partner', entityId: partner.id,
      action: params.direction === 'advanced' ? 'loan_advanced' : 'loan_repaid',
      newValue: JSON.stringify({
        amountMinor: amount, date, journalEntryId: journal.id,
        moneyAccountId: params.moneyAccountId ?? moneyAccount, direction: params.direction,
      }),
      source: 'user', actor: params.recordedBy, requestId: params.requestId ?? null,
    }).run();

    return {
      partner: tx.select().from(partners).where(eq(partners.id, partner.id)).get()!,
      journalEntryId: journal.id,
      entryNumber: journal.entryNumber,
      balanceMinor: accountBalance(txDb, {
        companyId: params.companyId, accountId: loanAccountId, asOf: date,
      }),
    };
  });
}

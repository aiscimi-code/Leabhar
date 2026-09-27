import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accounts, auditEvents, bankAccounts, bankTransactions, companies, companyOfficers,
  documents, expenseClaimLines, expenseClaims, users, companyMembers, journalEntries,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, nowIso, today, type IsoDate } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { AccountingError } from '../accounting/errors';
import {
  postJournalEntry, reverseJournalEntry, atomically, assertAccountingPeriodOpen,
} from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { upsertReviewItem } from '../extraction/service';
import { resolveExpenseRate, calculateRateAmount } from './rates';

/**
 * Expense claims (issue #306): the money a director or a member of staff spent
 * personally on the business's behalf and wants back.
 *
 * The claim is the evidence; the approval is the accounting event. Approving a
 * claim posts the journal (Dr the expense accounts, Cr the claimant), and the
 * company owes them the money until it is reimbursed — from a bank line, so
 * the payment has bank evidence like every other movement.
 *
 * A claim claims no input VAT. The supplier's invoice is the only proof of
 * input VAT (issue #234): a purchase with an invoice behind it is confirmed,
 * posted as an invoice and settled, never claimed. Mileage and subsistence
 * allowances have no VAT in them at all, which is why they belong here rather
 * than on the invoice path.
 *
 * A claim is never edited after it is submitted. It is approved, rejected with
 * a reason, or reversed — and a reversal is a reversing journal, not a change.
 *
 * The claimant may approve their own claim (issue #425): no statute or Revenue
 * rule requires a second approver, and a one-director company has only one.
 * Self-approval is allowed in every book, never refused — but it is always
 * flagged: the audit event marks the approval self-approved, and a review
 * item asks someone to check the receipts and the business use. It is a
 * prompt, not a refusal.
 */

export class ExpenseClaimError extends AccountingError {}

export interface ClaimLineInput {
  lineType: 'mileage' | 'travel' | 'subsistence' | 'receipt';
  date: IsoDate;
  description: string;
  /** The expense account the business share is debited to. */
  accountId: string;
  /** Required unless the amount is rate-calculated (`rateId` + `units`). */
  amountMinor?: number;
  /** Units (km, absences, nights) for a rate-calculated line. */
  units?: number;
  rateId?: string;
  /**
   * Business share of the line, in basis points. 10000 = wholly business. The
   * private share is the claimant's own cost: it is not posted and not owed.
   */
  businessUseBasisPoints?: number;
  /** The receipt behind the line, when there is one. */
  documentId?: string | null;
  notes?: string | null;
}

export interface CreateExpenseClaimInput {
  companyId: string;
  /** Who is owed the money. */
  claimant: { officerId: string } | { userId: string };
  title: string;
  lines: ClaimLineInput[];
  notes?: string | null;
  actor?: string;
  requestId?: string;
}

export interface CreateExpenseClaimResult {
  claimId: string;
  totalMinor: number;
  businessMinor: number;
  privateMinor: number;
  payableAccountId: string;
}

/**
 * A claim's claimant: their name for the narrative and the account the
 * company owes them on — an officer's own current account, or the staff
 * expenses payable account for everyone else.
 */
function claimantAccount(
  db: AppDatabase, input: CreateExpenseClaimInput,
): { name: string; officerId: string | null; userId: string | null; payableAccountId: string; entityType: string; entityId: string } {
  if ('officerId' in input.claimant) {
    const officer = db.select().from(companyOfficers)
      .where(and(
        eq(companyOfficers.id, input.claimant.officerId),
        eq(companyOfficers.companyId, input.companyId),
      )).get();
    if (!officer) throw new ExpenseClaimError(`Officer ${input.claimant.officerId} not found.`);
    return {
      name: officer.name,
      officerId: officer.id,
      userId: null,
      payableAccountId: officer.currentAccountId
        ?? systemAccountId(db, input.companyId, 'directors_current_account'),
      entityType: 'company_officer',
      entityId: officer.id,
    };
  }

  const user = db.select().from(users).where(eq(users.id, input.claimant.userId)).get();
  if (!user) throw new ExpenseClaimError(`User ${input.claimant.userId} not found.`);
  const member = db.select({ id: companyMembers.id }).from(companyMembers)
    .where(and(eq(companyMembers.userId, user.id), eq(companyMembers.companyId, input.companyId))).get();
  if (!member) throw new ExpenseClaimError(`${user.displayName} is not a member of this company.`);
  return {
    name: user.displayName,
    officerId: null,
    userId: user.id,
    payableAccountId: systemAccountId(db, input.companyId, 'staff_expenses_payable'),
    entityType: 'user',
    entityId: user.id,
  };
}

/**
 * Create and submit a claim. The lines are validated and priced here, so a
 * claim is never stored with an amount that cannot be re-derived from its rate
 * and units (invariant #8: every derived value carries its source).
 */
export function createExpenseClaim(
  db: AppDatabase, input: CreateExpenseClaimInput,
): CreateExpenseClaimResult {
  return atomically(db, () => createExpenseClaimSteps(db, input));
}

function createExpenseClaimSteps(
  db: AppDatabase, input: CreateExpenseClaimInput,
): CreateExpenseClaimResult {
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  if (!company) throw new ExpenseClaimError(`Company ${input.companyId} not found.`);

  if (!input.title.trim()) throw new ExpenseClaimError('A claim needs a title.');
  if (input.lines.length === 0) throw new ExpenseClaimError('A claim needs at least one line.');

  const claimant = claimantAccount(db, input);
  const timestamp = nowIso();
  const claimId = ids.expenseClaim();

  let totalMinor = 0;
  let privateMinor = 0;
  const pricedLines: Array<{
    values: typeof expenseClaimLines.$inferInsert;
    businessMinor: number;
    privatePartMinor: number;
  }> = [];

  for (const [index, line] of input.lines.entries()) {
    const date = asIsoDate(line.date);
    const account = db.select().from(accounts)
      .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, input.companyId))).get();
    if (!account) throw new ExpenseClaimError(`Account ${line.accountId} not found.`);

    const businessBp = line.businessUseBasisPoints ?? 10_000;
    if (!Number.isInteger(businessBp) || businessBp < 0 || businessBp > 10_000) {
      throw new ExpenseClaimError(
        'The business-use share must be between 0% and 100%.',
        { line: index + 1 },
      );
    }

    // ---- Price the line ----
    let amountMinor: number;
    let rate: ReturnType<typeof resolveExpenseRate> | null = null;
    if (line.lineType === 'mileage' || line.lineType === 'subsistence') {
      if (!line.rateId || line.units === undefined) {
        throw new ExpenseClaimError(
          `A ${line.lineType} line needs the rate that was in force and the distance or nights `
          + 'claimed — the amount is never typed in for an allowance.',
          { line: index + 1 },
        );
      }
      if (!Number.isInteger(line.units) || line.units <= 0) {
        throw new ExpenseClaimError('The distance or nights claimed must be a positive whole number.', { line: index + 1 });
      }
      rate = resolveExpenseRate(db, { companyId: input.companyId, rateId: line.rateId, onDate: date });
      amountMinor = calculateRateAmount(line.units, rate);
    } else {
      if (line.amountMinor === undefined) {
        throw new ExpenseClaimError('A travel or receipt line needs the amount spent.', { line: index + 1 });
      }
      amountMinor = asMinor(line.amountMinor);
      if (amountMinor <= 0) throw new ExpenseClaimError('A claim line amount must be positive.', { line: index + 1 });
    }

    if (line.documentId) {
      const document = db.select({ id: documents.id }).from(documents)
        .where(and(eq(documents.id, line.documentId), eq(documents.companyId, input.companyId))).get();
      if (!document) throw new ExpenseClaimError(`Document ${line.documentId} not found.`);
    }

    const businessMinor = multiplyRational(amountMinor, businessBp, 10_000);
    const privatePartMinor = amountMinor - businessMinor;
    totalMinor += amountMinor;
    privateMinor += privatePartMinor;

    pricedLines.push({
      businessMinor,
      privatePartMinor,
      values: {
        id: ids.expenseClaimLine(),
        companyId: input.companyId,
        claimId,
        lineNumber: index + 1,
        lineType: line.lineType,
        date,
        description: line.description.trim(),
        accountId: line.accountId,
        amountMinor,
        units: line.units ?? null,
        rateId: rate?.id ?? null,
        rateCode: rate?.code ?? null,
        rateName: rate?.name ?? null,
        rateAmountMinor: rate?.amountMinor ?? null,
        ratePerUnits: rate?.perUnits ?? null,
        businessUseBasisPoints: businessBp,
        privateUseAccountId: null,
        documentId: line.documentId ?? null,
        notes: line.notes ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
  }

  db.transaction((tx) => {
    tx.insert(expenseClaims).values({
      id: claimId,
      companyId: input.companyId,
      claimantType: claimant.officerId ? 'officer' : 'employee',
      officerId: claimant.officerId,
      userId: claimant.userId,
      title: input.title.trim(),
      status: 'submitted',
      currency: company.baseCurrency,
      totalMinor,
      businessMinor: totalMinor - privateMinor,
      privateMinor,
      payableAccountId: claimant.payableAccountId,
      notes: input.notes ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
    for (const line of pricedLines) tx.insert(expenseClaimLines).values(line.values).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'expense_claim',
      entityId: claimId,
      action: 'created',
      newValue: JSON.stringify({
        claimant: claimant.name, title: input.title, totalMinor,
        businessMinor: totalMinor - privateMinor, privateMinor, lines: input.lines.length,
      }),
      source: 'user',
      actor: input.actor ?? 'user',
      requestId: input.requestId ?? null,
    }).run();
  });

  return {
    claimId,
    totalMinor,
    businessMinor: totalMinor - privateMinor,
    privateMinor,
    payableAccountId: claimant.payableAccountId,
  };
}

/**
 * Approve a submitted claim: the accounting decision. Posts the journal — each
 * line's business share to its expense account and the business total credited
 * to the claimant — and checks every line's accounting period before writing
 * anything. A private share is the claimant's own cost, paid with their own
 * money: the company neither bears it nor owes it, so it is not posted at all
 * (the same rule as a director-paid expense).
 */
export function approveExpenseClaim(
  db: AppDatabase, input: {
    companyId: string; claimId: string; actor?: string; requestId?: string;
    /**
     * The approving user's id, where the surface knows it (the web app does).
     * A user's own claim is then recognised by identity, not by name (issue #425).
     */
    approverUserId?: string;
  },
): { journalEntryId: string; entryNumber: number } {
  return atomically(db, () => approveExpenseClaimSteps(db, input));
}

function approveExpenseClaimSteps(
  db: AppDatabase, input: { companyId: string; claimId: string; actor?: string; requestId?: string; approverUserId?: string },
): { journalEntryId: string; entryNumber: number } {
  const claim = loadClaim(db, input.companyId, input.claimId);
  if (claim.status !== 'submitted') {
    throw new ExpenseClaimError(
      `This claim is ${claim.status}, not awaiting approval. Only a submitted claim can be approved.`,
      { claimId: claim.id, status: claim.status },
    );
  }
  const lines = db.select().from(expenseClaimLines)
    .where(eq(expenseClaimLines.claimId, claim.id)).orderBy(asc(expenseClaimLines.lineNumber)).all();
  if (lines.length === 0) throw new ExpenseClaimError('This claim has no lines to approve.');
  if (claim.totalMinor - claim.privateMinor <= 0) {
    throw new ExpenseClaimError(
      'None of this claim is business use, so there is nothing for the company to record. Reject it instead.',
      { claimId: claim.id },
    );
  }

  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get()!;
  const claimant = claimantName(db, claim);
  const actor = input.actor ?? 'user';
  // Self-approval (issue #425): the approver is the claimant. A user's claim
  // approved by a known user is compared by identity — two people can share a
  // display name, and the actor may be a username. An officer is not a user
  // account, and the CLI knows only a name, so those fall back to the recorded
  // names. Allowed, but flagged below.
  const selfApproved = claim.userId && input.approverUserId
    ? claim.userId === input.approverUserId
    : actor.trim().length > 0 && actor.trim().toLowerCase() === claimant.trim().toLowerCase();

  // ---- Refuse before writing anything (AGENTS.md: a posting path either
  // completes or writes nothing) ----
  for (const line of lines) {
    assertAccountingPeriodOpen(db, input.companyId, asIsoDate(line.date));
  }

  const journalLines: Parameters<typeof postJournalEntry>[1]['lines'] = [];
  let businessTotal = 0;
  let privateTotal = 0;

  for (const line of lines) {
    const businessMinor = multiplyRational(line.amountMinor, line.businessUseBasisPoints, 10_000);
    const privateMinor = line.amountMinor - businessMinor;
    businessTotal += businessMinor;
    privateTotal += privateMinor;

    if (businessMinor > 0) {
      journalLines.push({
        accountId: line.accountId,
        debitMinor: businessMinor,
        currency: company.baseCurrency,
        memo: `${line.description} (expense claim by ${claimant})`,
      });
    }
  }

  journalLines.push({
    accountId: claim.payableAccountId,
    creditMinor: businessTotal,
    currency: company.baseCurrency,
    officerId: claim.officerId,
    memo: `Expense claim "${claim.title}" owed to ${claimant}`,
  });

  const journal = postJournalEntry(db, {
    companyId: input.companyId,
    entryDate: latestLineDate(lines),
    narrative: `Expense claim "${claim.title}" (${claimant})`,
    sourceType: 'expense_claim',
    sourceId: claim.id,
    baseCurrency: company.baseCurrency,
    createdBy: input.actor ?? 'user',
    createdVia: 'user',
    requestId: input.requestId,
    lines: journalLines,
  });

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(expenseClaims).set({
      status: 'approved',
      journalEntryId: journal.id,
      approvedBy: input.actor ?? 'user',
      approvedOn: timestamp,
      updatedAt: timestamp,
    }).where(eq(expenseClaims.id, claim.id)).run();

    // A receipt line with no document behind it claims no input VAT and has no
    // evidence: flagged, not silently accepted.
    for (const line of lines) {
      if (line.lineType === 'receipt' && !line.documentId) {
        upsertReviewItem(tx, {
          companyId: input.companyId,
          kind: 'missing_document',
          severity: 'info',
          title: `No receipt attached to "${line.description}" on claim "${claim.title}"`,
          detail: 'The line was approved without a document behind it, so there is no evidence for '
            + 'the amount and no input VAT can ever be reclaimed on it. If there is a receipt, '
            + 'upload it and link it to the claim line.',
          entityType: 'expense_claim',
          entityId: claim.id,
          dedupeKey: `expense_claim:${claim.id}:line:${line.id}:no_receipt`,
        });
      }
    }

    // The claimant approved their own claim (issue #425). Allowed, because a
    // one-director company has no second approver — but flagged, so the
    // receipts and the business use get a second look.
    if (selfApproved) {
      upsertReviewItem(tx, {
        companyId: input.companyId,
        kind: 'other',
        severity: 'warning',
        title: `${claimant} approved their own claim "${claim.title}"`,
        detail: `${claimant} approved their own claim of ${(businessTotal / 100).toFixed(2)} `
          + `${company.baseCurrency}. No statute or Revenue rule requires a second approver, so the `
          + 'approval stands, but check the receipts and that each cost was incurred wholly and '
          + 'exclusively for the business. '
          + (claim.officerId
            ? 'A director\'s self-approved reimbursement is where a benefit-in-kind question most '
              + 'often arises: check the private-use share was recorded correctly.'
            : 'Another approver or the accountant can clear this item once the receipts are checked.'),
        entityType: 'expense_claim',
        entityId: claim.id,
        dedupeKey: `expense_claim:${claim.id}:self_approved`,
      });
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'expense_claim',
      entityId: claim.id,
      action: 'user_confirmed',
      previousValue: JSON.stringify({ status: 'submitted' }),
      newValue: JSON.stringify({
        status: 'approved', journalEntryId: journal.id,
        businessMinor: businessTotal, privateMinor: privateTotal,
        ...(selfApproved ? { selfApproved: true } : {}),
      }),
      source: 'user',
      actor: input.actor ?? 'user',
      requestId: input.requestId ?? null,
    }).run();
  });

  return { journalEntryId: journal.id, entryNumber: journal.entryNumber };
}

/** Reject a submitted claim, with the reason the claimant will see. */
export function rejectExpenseClaim(
  db: AppDatabase, input: {
    companyId: string; claimId: string; reason: string; actor?: string; requestId?: string;
  },
): void {
  atomically(db, () => rejectExpenseClaimSteps(db, input));
}

function rejectExpenseClaimSteps(
  db: AppDatabase, input: { companyId: string; claimId: string; reason: string; actor?: string; requestId?: string },
): void {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new ExpenseClaimError('Rejecting a claim needs a reason — it is all the claimant will see.');
  }
  const claim = loadClaim(db, input.companyId, input.claimId);
  if (claim.status !== 'submitted') {
    throw new ExpenseClaimError(
      `This claim is ${claim.status}. Only a submitted claim can be rejected.`,
      { claimId: claim.id, status: claim.status },
    );
  }
  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(expenseClaims).set({
      status: 'rejected',
      rejectedBy: input.actor ?? 'user',
      rejectedOn: timestamp,
      rejectionReason: input.reason.trim(),
      updatedAt: timestamp,
    }).where(eq(expenseClaims.id, claim.id)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'expense_claim',
      entityId: claim.id,
      action: 'user_rejected',
      previousValue: JSON.stringify({ status: 'submitted' }),
      newValue: JSON.stringify({ status: 'rejected', reason: input.reason.trim() }),
      source: 'user',
      actor: input.actor ?? 'user',
      reason: input.reason.trim(),
      requestId: input.requestId ?? null,
    }).run();
  });
}

/**
 * Reimburse an approved claim: the money leaves the bank. The business share
 * (what is actually owed — the private share was never the company's) pays
 * down the claimant's account.
 *
 * The payment is evidenced by a bank line wherever there is one: passing
 * `bankTransactionId` posts against that account's ledger and marks the line
 * posted, exactly as classifying it would. Without one, `bankAccountId` (or
 * the bank control account) carries the credit and the date is the person's to
 * give — a reimbursement recorded by hand, like a manual payment.
 */
export function reimburseExpenseClaim(
  db: AppDatabase, input: {
    companyId: string; claimId: string;
    bankTransactionId?: string | null;
    bankAccountId?: string | null;
    date?: IsoDate | null;
    actor?: string; requestId?: string;
  },
): { journalEntryId: string; entryNumber: number; amountMinor: number } {
  return atomically(db, () => reimburseExpenseClaimSteps(db, input));
}

function reimburseExpenseClaimSteps(
  db: AppDatabase, input: {
    companyId: string; claimId: string;
    bankTransactionId?: string | null;
    bankAccountId?: string | null;
    date?: IsoDate | null;
    actor?: string; requestId?: string;
  },
): { journalEntryId: string; entryNumber: number; amountMinor: number } {
  const claim = loadClaim(db, input.companyId, input.claimId);
  if (claim.status !== 'approved') {
    throw new ExpenseClaimError(
      `This claim is ${claim.status}. Approve it before reimbursing it.`,
      { claimId: claim.id, status: claim.status },
    );
  }
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get()!;
  const claimant = claimantName(db, claim);
  const owedMinor = claim.totalMinor - claim.privateMinor;
  if (owedMinor <= 0) {
    throw new ExpenseClaimError(
      'Nothing is owed on this claim: its private share covers the whole amount, so there is '
      + 'nothing to reimburse.',
      { claimId: claim.id },
    );
  }

  let moneyAccountId: string;
  let paymentDate: IsoDate;
  let transaction: typeof bankTransactions.$inferSelect | undefined;

  if (input.bankTransactionId) {
    transaction = db.select().from(bankTransactions)
      .where(and(
        eq(bankTransactions.id, input.bankTransactionId),
        eq(bankTransactions.companyId, input.companyId),
      )).get();
    if (!transaction) throw new ExpenseClaimError(`Bank transaction ${input.bankTransactionId} not found.`);
    if (transaction.status === 'rolled_back') {
      throw new ExpenseClaimError(
        'This line\'s statement import was undone, so it is not part of the books. Reimburse from a line on the corrected statement.');
    }
    if (transaction.journalEntryId) {
      throw new ExpenseClaimError(
        'That bank transaction has already been posted on its own, so the same money would be '
        + 'recorded twice. Reimburse from an unposted line.',
        { bankTransactionId: transaction.id, journalEntryId: transaction.journalEntryId },
      );
    }
    if (transaction.amountMinor >= 0) {
      throw new ExpenseClaimError(
        'That bank line is money coming in, but a reimbursement is money out. Choose the line the payment left on.');
    }
    if (Math.abs(transaction.amountMinor) !== owedMinor) {
      throw new ExpenseClaimError(
        `The bank line is ${(Math.abs(transaction.amountMinor) / 100).toFixed(2)} ${transaction.currency} but `
        + `${(owedMinor / 100).toFixed(2)} ${company.baseCurrency} is owed on this claim. The payment must match `
        + 'the claim exactly — record the difference deliberately, not by absorbing it.',
        { bankTransactionId: transaction.id, owedMinor },
      );
    }
    const bankAccount = db.select().from(bankAccounts)
      .where(eq(bankAccounts.id, transaction.bankAccountId)).get();
    moneyAccountId = bankAccount?.accountId ?? systemAccountId(db, input.companyId, 'bank_control');
    paymentDate = asIsoDate(transaction.transactionDate);
  } else {
    if (!input.date) {
      throw new ExpenseClaimError(
        'A reimbursement recorded without a bank line needs the date the money was paid.',
        { claimId: claim.id },
      );
    }
    paymentDate = asIsoDate(input.date);
    if (input.bankAccountId) {
      const bankAccount = db.select().from(bankAccounts)
        .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId))).get();
      if (!bankAccount) throw new ExpenseClaimError(`Bank account ${input.bankAccountId} not found.`);
      moneyAccountId = bankAccount.accountId ?? systemAccountId(db, input.companyId, 'bank_control');
    } else {
      moneyAccountId = systemAccountId(db, input.companyId, 'bank_control');
    }
  }

  // Refuse before writing anything: the reimbursement must land in an open period.
  assertAccountingPeriodOpen(db, input.companyId, paymentDate);

  const journal = postJournalEntry(db, {
    companyId: input.companyId,
    entryDate: paymentDate,
    narrative: `Reimbursement of expense claim "${claim.title}" (${claimant})`,
    sourceType: 'expense_claim',
    sourceId: claim.id,
    baseCurrency: company.baseCurrency,
    createdBy: input.actor ?? 'user',
    createdVia: 'user',
    requestId: input.requestId,
    lines: [
      {
        accountId: claim.payableAccountId,
        debitMinor: owedMinor,
        currency: company.baseCurrency,
        officerId: claim.officerId,
        memo: `Reimbursed expense claim "${claim.title}"`,
      },
      {
        accountId: moneyAccountId,
        creditMinor: owedMinor,
        currency: company.baseCurrency,
        memo: `Expense reimbursement to ${claimant}`,
      },
    ],
  });

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(expenseClaims).set({
      status: 'reimbursed',
      reimbursementJournalEntryId: journal.id,
      reimbursementDate: paymentDate,
      reimbursedBy: input.actor ?? 'user',
      bankTransactionId: transaction?.id ?? null,
      updatedAt: timestamp,
    }).where(eq(expenseClaims.id, claim.id)).run();

    if (transaction) {
      tx.update(bankTransactions).set({
        journalEntryId: journal.id,
        status: 'posted',
        source: 'user',
        provenanceStatus: 'user_confirmed',
        updatedAt: timestamp,
      }).where(eq(bankTransactions.id, transaction.id)).run();
    }

    // Travel and subsistence payments to a director or employee are reportable
    // to Revenue in real time under the Enhanced Reporting Requirements
    // (Finance Act 2022). The submission itself is EPIC 21 (#316); until it
    // exists the payment is flagged rather than silently treated as filed.
    const reportable = db.select({ id: expenseClaimLines.id }).from(expenseClaimLines)
      .where(and(
        eq(expenseClaimLines.claimId, claim.id),
        inArray(expenseClaimLines.lineType, ['mileage', 'subsistence', 'travel']),
      )).get();
    if (reportable) {
      upsertReviewItem(tx, {
        companyId: input.companyId,
        kind: 'other',
        severity: 'warning',
        title: `Reimbursement of "${claim.title}" is reportable to Revenue (ERR)`,
        detail: 'Travel, mileage and subsistence payments to an employee or director must be reported '
          + 'to Revenue in real time under the Enhanced Reporting Requirements (Finance Act 2022). '
          + 'Leabhar cannot submit it yet (epic #316), so nothing has been filed: keep this claim '
          + 'and its receipts until the submission is built.',
        entityType: 'expense_claim',
        entityId: claim.id,
        dedupeKey: `expense_claim:${claim.id}:err_reportable`,
      });
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'expense_claim',
      entityId: claim.id,
      action: 'reconciled',
      previousValue: JSON.stringify({ status: 'approved' }),
      newValue: JSON.stringify({
        status: 'reimbursed', journalEntryId: journal.id,
        amountMinor: owedMinor, paymentDate,
        bankTransactionId: transaction?.id ?? null,
      }),
      source: 'user',
      actor: input.actor ?? 'user',
      requestId: input.requestId ?? null,
    }).run();
  });

  return { journalEntryId: journal.id, entryNumber: journal.entryNumber, amountMinor: owedMinor };
}

/**
 * Reverse an approved claim that was wrong: the approval journal is reversed
 * (a posted entry is never edited) and the claim is closed as reversed. A
 * reimbursed claim cannot be reversed here — the money has left, so the
 * correction is a new claim, not an undo.
 */
export function reverseExpenseClaim(
  db: AppDatabase, input: {
    companyId: string; claimId: string; reason: string;
    reversalDate?: IsoDate | null; actor?: string; requestId?: string;
  },
): { reversalJournalEntryId: string } {
  return atomically(db, () => reverseExpenseClaimSteps(db, input));
}

function reverseExpenseClaimSteps(
  db: AppDatabase, input: {
    companyId: string; claimId: string; reason: string;
    reversalDate?: IsoDate | null; actor?: string; requestId?: string;
  },
): { reversalJournalEntryId: string } {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new ExpenseClaimError('Reversing a claim needs a reason — it is the only record of what was wrong.');
  }
  const claim = loadClaim(db, input.companyId, input.claimId);
  if (claim.status === 'reimbursed') {
    throw new ExpenseClaimError(
      'This claim has been reimbursed: the money has left the bank, so it cannot be undone. '
      + 'Post the correction as a new claim instead.',
      { claimId: claim.id },
    );
  }
  if (claim.status !== 'approved') {
    throw new ExpenseClaimError(
      `This claim is ${claim.status}. Only an approved claim can be reversed.`,
      { claimId: claim.id, status: claim.status },
    );
  }

  // By default the reversal is dated with the approval journal, never before it.
  const approval = db.select({ date: journalEntries.entryDate }).from(journalEntries)
    .where(eq(journalEntries.id, claim.journalEntryId!)).get();
  const reversalDate = input.reversalDate ?? asIsoDate(approval?.date ?? today());

  const reversal = reverseJournalEntry(db, {
    companyId: input.companyId,
    entryId: claim.journalEntryId!,
    reversalDate,
    reason: input.reason,
    createdBy: input.actor ?? 'user',
    requestId: input.requestId,
  });

  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.update(expenseClaims).set({
      status: 'reversed',
      reversalJournalEntryId: reversal.id,
      reversalReason: input.reason.trim(),
      updatedAt: timestamp,
    }).where(eq(expenseClaims.id, claim.id)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: timestamp,
      entityType: 'expense_claim',
      entityId: claim.id,
      action: 'reversal_posted',
      previousValue: JSON.stringify({ status: 'approved', journalEntryId: claim.journalEntryId }),
      newValue: JSON.stringify({ status: 'reversed', reversalJournalEntryId: reversal.id }),
      source: 'user',
      actor: input.actor ?? 'user',
      reason: input.reason.trim(),
      requestId: input.requestId ?? null,
    }).run();
  });

  return { reversalJournalEntryId: reversal.id };
}

function loadClaim(
  db: AppDatabase, companyId: string, claimId: string,
): typeof expenseClaims.$inferSelect {
  const claim = db.select().from(expenseClaims)
    .where(and(eq(expenseClaims.id, claimId), eq(expenseClaims.companyId, companyId))).get();
  if (!claim) throw new ExpenseClaimError(`Expense claim ${claimId} not found.`);
  return claim;
}

function claimantName(db: AppDatabase, claim: typeof expenseClaims.$inferSelect): string {
  if (claim.officerId) {
    const officer = db.select().from(companyOfficers)
      .where(eq(companyOfficers.id, claim.officerId)).get();
    return officer?.name ?? 'officer';
  }
  if (claim.userId) {
    const user = db.select().from(users).where(eq(users.id, claim.userId)).get();
    return user?.displayName ?? 'claimant';
  }
  return 'claimant';
}

function latestLineDate(lines: Array<typeof expenseClaimLines.$inferSelect>): IsoDate {
  const latest = lines.reduce((max, line) => (line.date > max ? line.date : max), lines[0]!.date);
  return asIsoDate(latest);
}

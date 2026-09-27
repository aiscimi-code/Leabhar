import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { seedTestBook, insertTestBankTransaction } from '@/db/testing';
import {
  companyOfficers, expenseClaims, expenseClaimLines, expenseRates, journalLines, reviewItems, users, companyMembers, journalEntries, auditEvents,
} from '@/db/schema';
import type { AppDatabase } from '@/db';
import { ids } from '@/lib/ids';
import { accountBalance } from '../accounting/ledger';
import { asIsoDate } from '../dates';
import {
  createExpenseClaim, approveExpenseClaim, rejectExpenseClaim, reimburseExpenseClaim,
  reverseExpenseClaim, ExpenseClaimError,
} from './claims';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let bankAccountId: string;
let officerId: string;
let userId: string;

beforeEach(() => {
  const book = seedTestBook();
  db = book.db;
  companyId = book.companyId;
  acc = book.accountsByKey;
  byCode = book.accountsByCode;
  bankAccountId = book.bankAccountId;

  officerId = ids.officer();
  db.insert(companyOfficers).values({
    id: officerId, companyId, name: 'Mary Byrne', role: 'director',
  }).run();

  userId = ids.user();
  db.insert(users).values({
    id: userId, username: `colleague-${userId}`, displayName: 'John O’Sullivan',
    passwordHash: 'x', passwordSalt: 'y',
  }).run();
  db.insert(companyMembers).values({ id: ids.member(), companyId, userId }).run();
});

function mileageRate(code = 'car_upto_1200cc_band1'): string {
  return db.select().from(expenseRates)
    .where(and(eq(expenseRates.companyId, companyId), eq(expenseRates.code, code))).get()!.id;
}

const travelAccount = () => byCode['6110']!;

describe('createExpenseClaim', () => {
  it('prices a mileage line from the rate in force and snapshots it on the line', () => {
    const claim = createExpenseClaim(db, {
      companyId,
      claimant: { officerId },
      title: 'Site visits, May',
      lines: [{
        lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'Cork site visit',
        accountId: travelAccount(), rateId: mileageRate(), units: 1500,
      }],
    });

    expect(claim.totalMinor).toBe(62_700); // 1,500 km at 41.80 cent
    expect(claim.businessMinor).toBe(62_700);
    expect(claim.privateMinor).toBe(0);
    expect(claim.payableAccountId).toBe(acc['directors_current_account']);

    const line = db.select().from(expenseClaimLines)
      .where(eq(expenseClaimLines.claimId, claim.claimId)).get()!;
    expect(line.rateCode).toBe('car_upto_1200cc_band1');
    expect(line.rateAmountMinor).toBe(4180);
    expect(line.ratePerUnits).toBe(100);
    expect(line.units).toBe(1500);
    expect(line.amountMinor).toBe(62_700);
  });

  it('prices a subsistence allowance per occasion, not per night spent', () => {
    const claim = createExpenseClaim(db, {
      companyId,
      claimant: { officerId },
      title: 'Conference, Galway',
      lines: [{
        lineType: 'subsistence', date: asIsoDate('2025-05-20'), description: 'Full-day absence',
        accountId: travelAccount(), rateId: mileageRate('day_10_hours_or_more'), units: 1,
      }],
    });
    expect(claim.totalMinor).toBe(4_617);
  });

  it('splits a partly-private line and charges the private share to the claimant', () => {
    const claim = createExpenseClaim(db, {
      companyId,
      claimant: { officerId },
      title: 'Phone and broadband',
      lines: [{
        lineType: 'receipt', date: asIsoDate('2025-05-02'), description: 'Broadband', amountMinor: 50_00,
        accountId: byCode['6030']!, businessUseBasisPoints: 8_000,
      }],
    });
    expect(claim.totalMinor).toBe(50_00);
    expect(claim.businessMinor).toBe(40_00);
    expect(claim.privateMinor).toBe(10_00);
  });

  it('owes a staff claimant on the staff expenses payable account', () => {
    const claim = createExpenseClaim(db, {
      companyId,
      claimant: { userId },
      title: 'Train tickets',
      lines: [{
        lineType: 'travel', date: asIsoDate('2025-05-05'), description: 'Dublin–Cork return', amountMinor: 9_999,
        accountId: travelAccount(),
      }],
    });
    expect(claim.payableAccountId).toBe(acc['staff_expenses_payable']);
    const row = db.select().from(expenseClaims).where(eq(expenseClaims.id, claim.claimId)).get()!;
    expect(row.claimantType).toBe('employee');
    expect(row.userId).toBe(userId);
  });

  it('refuses a user who is not a member of this company', () => {
    const outsider = ids.user();
    db.insert(users).values({ id: outsider, username: `outsider-${outsider}`, displayName: 'Stranger', passwordHash: 'x', passwordSalt: 'y' }).run();
    expect(() => createExpenseClaim(db, {
      companyId, claimant: { userId: outsider }, title: 'Not ours',
      lines: [{ lineType: 'travel', date: asIsoDate('2025-05-05'), description: 'Taxi', amountMinor: 1_000, accountId: travelAccount() }],
    })).toThrow(/not a member/);
  });

  it('refuses an allowance line without a rate and units, and an amount that is not money', () => {
    expect(() => createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'No rate',
      lines: [{ lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'x', accountId: travelAccount(), amountMinor: 100 }],
    })).toThrow(ExpenseClaimError);

    expect(() => createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Bad units',
      lines: [{
        lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'x', accountId: travelAccount(),
        rateId: mileageRate(), units: 0,
      }],
    })).toThrow(ExpenseClaimError);
  });
});

describe('approveExpenseClaim', () => {
  it('posts the business share to the expense and owes the claimant only that', () => {
    const claim = createExpenseClaim(db, {
      companyId,
      claimant: { officerId },
      title: 'Site visits, May',
      lines: [
        {
          lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'Cork site visit',
          accountId: travelAccount(), rateId: mileageRate(), units: 1500,
        },
        {
          lineType: 'receipt', date: asIsoDate('2025-05-15'), description: 'Broadband', amountMinor: 50_00,
          accountId: byCode['6030']!, businessUseBasisPoints: 8_000,
        },
      ],
    });

    const approval = approveExpenseClaim(db, { companyId, claimId: claim.claimId });

    expect(accountBalance(db, { companyId, accountId: travelAccount() })).toBe(62_700);
    expect(accountBalance(db, { companyId, accountId: byCode['6030']! })).toBe(40_00);
    // The private share (10.00) is the claimant's own cost: not posted, not
    // owed. The company owes 667.00 — a credit balance on a credit-normal
    // liability.
    expect(accountBalance(db, { companyId, accountId: acc['directors_current_account']! })).toBe(66_700);

    const row = db.select().from(expenseClaims).where(eq(expenseClaims.id, claim.claimId)).get()!;
    expect(row.status).toBe('approved');
    expect(row.journalEntryId).toBe(approval.journalEntryId!);
    expect(row.approvedBy).toBe('user');

    // The director's current account lines name the director (§28).
    const officerLines = db.select().from(journalLines)
      .where(and(eq(journalLines.journalEntryId, approval.journalEntryId), eq(journalLines.officerId, officerId)))
      .all();
    expect(officerLines.length).toBe(1); // the credit for what is owed
  });

  it('flags a receipt line with no document, because there is no evidence for it', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Parking',
      lines: [{
        lineType: 'receipt', date: asIsoDate('2025-05-14'), description: 'Parking meter', amountMinor: 4_50,
        accountId: travelAccount(),
      }],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId });

    const items = db.select().from(reviewItems)
      .where(eq(reviewItems.entityId, claim.claimId)).all();
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe('missing_document');
  });

  it('refuses a claim whose line falls outside every accounting period, writing nothing', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Old mileage',
      lines: [{
        lineType: 'mileage', date: asIsoDate('2024-05-14'), description: 'Before the books began',
        accountId: travelAccount(), rateId: mileageRate(), units: 10,
      }],
    });
    expect(() => approveExpenseClaim(db, { companyId, claimId: claim.claimId }))
      .toThrow(/No accounting period covers 2024-05-14/);
    const row = db.select().from(expenseClaims).where(eq(expenseClaims.id, claim.claimId)).get()!;
    expect(row.status).toBe('submitted');
    expect(row.journalEntryId).toBeNull();
  });

  it('approves only a submitted claim', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Once',
      lines: [{
        lineType: 'travel', date: asIsoDate('2025-05-14'), description: 'Taxi', amountMinor: 20_00,
        accountId: travelAccount(),
      }],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId });
    expect(() => approveExpenseClaim(db, { companyId, claimId: claim.claimId }))
      .toThrow(ExpenseClaimError);
  });

  it('allows a claimant to approve their own claim, and marks and flags it (#425)', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Site visit',
      lines: [{
        lineType: 'travel', date: asIsoDate('2025-05-14'), description: 'Taxi', amountMinor: 20_00,
        accountId: travelAccount(),
      }],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId, actor: 'Mary Byrne' });

    // The claim is approved exactly as any other: posted and owed.
    expect(accountBalance(db, { companyId, accountId: travelAccount() })).toBe(20_00);
    const row = db.select().from(expenseClaims).where(eq(expenseClaims.id, claim.claimId)).get()!;
    expect(row.status).toBe('approved');
    expect(row.approvedBy).toBe('Mary Byrne');

    // The audit event marks the approval self-approved.
    const event = JSON.parse(db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'expense_claim'), eq(auditEvents.entityId, claim.claimId),
        eq(auditEvents.action, 'user_confirmed'),
      )).get()!.newValue as string);
    expect(event.selfApproved).toBe(true);

    // One review item asks for the receipts to be checked.
    const items = db.select().from(reviewItems)
      .where(eq(reviewItems.dedupeKey, `expense_claim:${claim.claimId}:self_approved`)).all();
    expect(items.length).toBe(1);
    expect(items[0]!.kind).toBe('other');
    expect(items[0]!.severity).toBe('warning');
    expect(items[0]!.title).toContain('approved their own claim');
    expect(items[0]!.detail).toContain('wholly and exclusively');
    expect(items[0]!.detail).toContain('benefit-in-kind');
  });

  it('flags a staff claimant the same way as an officer (#425)', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { userId }, title: 'Train tickets',
      lines: [{
        lineType: 'travel', date: asIsoDate('2025-05-05'), description: 'Dublin–Cork return', amountMinor: 9_999,
        accountId: travelAccount(),
      }],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId, actor: 'John O’Sullivan' });

    const items = db.select().from(reviewItems)
      .where(eq(reviewItems.dedupeKey, `expense_claim:${claim.claimId}:self_approved`)).all();
    expect(items.length).toBe(1);
    expect(items[0]!.title).toContain('John O’Sullivan');
    expect(items[0]!.detail).not.toContain('benefit-in-kind');
  });

  it('raises no self-approval flag when someone else approves (#425)', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Site visit',
      lines: [{
        lineType: 'travel', date: asIsoDate('2025-05-14'), description: 'Taxi', amountMinor: 20_00,
        accountId: travelAccount(),
      }],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId, actor: 'Accountant' });

    const items = db.select().from(reviewItems)
      .where(eq(reviewItems.dedupeKey, `expense_claim:${claim.claimId}:self_approved`)).all();
    expect(items.length).toBe(0);
    const event = JSON.parse(db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'expense_claim'), eq(auditEvents.entityId, claim.claimId),
        eq(auditEvents.action, 'user_confirmed'),
      )).get()!.newValue as string);
    expect(event.selfApproved).toBeUndefined();
  });
});

describe('rejectExpenseClaim', () => {
  it('needs a reason and records it', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { userId }, title: 'Conference',
      lines: [{
        lineType: 'travel', date: asIsoDate('2025-05-14'), description: 'Flight', amountMinor: 200_00,
        accountId: travelAccount(),
      }],
    });
    expect(() => rejectExpenseClaim(db, { companyId, claimId: claim.claimId, reason: 'x' }))
      .toThrow(ExpenseClaimError);

    rejectExpenseClaim(db, { companyId, claimId: claim.claimId, reason: 'Already claimed in April.' });
    const row = db.select().from(expenseClaims).where(eq(expenseClaims.id, claim.claimId)).get()!;
    expect(row.status).toBe('rejected');
    expect(row.rejectionReason).toBe('Already claimed in April.');
  });
});

describe('a partly-private claim', () => {
  it('owes only the business share, and leaves nothing on the payable account once reimbursed', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { userId }, title: 'Phone',
      lines: [{
        lineType: 'receipt', date: asIsoDate('2025-05-02'), description: 'Mobile bill', amountMinor: 50_00,
        accountId: byCode['6030']!, businessUseBasisPoints: 6_000,
      }],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId });
    expect(accountBalance(db, { companyId, accountId: byCode['6030']! })).toBe(30_00);
    expect(accountBalance(db, { companyId, accountId: acc['staff_expenses_payable']! })).toBe(30_00);
    const paid = reimburseExpenseClaim(db, { companyId, claimId: claim.claimId, bankAccountId, date: asIsoDate('2025-06-02') });
    expect(paid.amountMinor).toBe(30_00);
    expect(accountBalance(db, { companyId, accountId: acc['staff_expenses_payable']! })).toBe(0);
  });

  it('refuses to approve a claim with no business share', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Private',
      lines: [{
        lineType: 'receipt', date: asIsoDate('2025-05-02'), description: 'Holiday', amountMinor: 50_00,
        accountId: byCode['6030']!, businessUseBasisPoints: 0,
      }],
    });
    expect(() => approveExpenseClaim(db, { companyId, claimId: claim.claimId })).toThrow(/nothing for the company/);
  });
});

describe('reimburseExpenseClaim', () => {
  const approvedClaim = () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Site visits, May',
      lines: [
        {
          lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'Cork site visit',
          accountId: travelAccount(), rateId: mileageRate(), units: 1500,
        },
        {
          lineType: 'receipt', date: asIsoDate('2025-05-15'), description: 'Broadband', amountMinor: 50_00,
          accountId: byCode['6030']!, businessUseBasisPoints: 8_000,
        },
      ],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId });
    return claim;
  };

  it('pays the claimant from a matching bank line and marks the line posted', () => {
    const claim = approvedClaim();
    const txId = insertTestBankTransaction(db, {
      companyId, bankAccountId, amountMinor: -66_700, transactionDate: '2025-06-02',
      description: 'EXPENSE REIMBURSEMENT M BYRNE',
    });

    const result = reimburseExpenseClaim(db, {
      companyId, claimId: claim.claimId, bankTransactionId: txId,
    });

    expect(result.amountMinor).toBe(66_700);
    expect(accountBalance(db, { companyId, accountId: acc['directors_current_account']! })).toBe(0);

    const row = db.select().from(expenseClaims).where(eq(expenseClaims.id, claim.claimId)).get()!;
    expect(row.status).toBe('reimbursed');
    expect(row.bankTransactionId).toBe(txId);
    const line = db.select().from(expenseClaims).where(eq(expenseClaims.id, claim.claimId)).get()!;
    expect(line.reimbursementJournalEntryId).toBe(result.journalEntryId);
  });

  it('refuses a bank line that does not match what is owed exactly', () => {
    const claim = approvedClaim();
    const txId = insertTestBankTransaction(db, {
      companyId, bankAccountId, amountMinor: -1_100_00, transactionDate: '2025-06-02',
      description: 'EXPENSE REIMBURSEMENT M BYRNE',
    });
    expect(() => reimburseExpenseClaim(db, { companyId, claimId: claim.claimId, bankTransactionId: txId }))
      .toThrow(/must match the claim exactly/);
  });

  it('flags mileage and subsistence payments as reportable to Revenue (ERR) until submission exists', () => {
    const claim = approvedClaim();
    const txId = insertTestBankTransaction(db, {
      companyId, bankAccountId, amountMinor: -66_700, transactionDate: '2025-06-02',
      description: 'EXPENSE REIMBURSEMENT M BYRNE',
    });
    reimburseExpenseClaim(db, { companyId, claimId: claim.claimId, bankTransactionId: txId });

    const item = db.select().from(reviewItems)
      .where(eq(reviewItems.dedupeKey, `expense_claim:${claim.claimId}:err_reportable`)).get();
    expect(item?.severity).toBe('warning');
    expect(item?.detail).toContain('Enhanced Reporting Requirements');
  });

  it('reimburses without a bank line when the person gives the date and account', () => {
    const claim = approvedClaim();
    const result = reimburseExpenseClaim(db, {
      companyId, claimId: claim.claimId, bankAccountId, date: asIsoDate('2025-06-02'),
    });
    expect(result.amountMinor).toBe(66_700);
    expect(() => reimburseExpenseClaim(db, { companyId, claimId: claim.claimId, bankAccountId, date: asIsoDate('2025-06-03') }))
      .toThrow(ExpenseClaimError);
  });

  it('refuses to reimburse a claim that is not approved', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Parking',
      lines: [{
        lineType: 'travel', date: asIsoDate('2025-05-14'), description: 'Taxi', amountMinor: 20_00,
        accountId: travelAccount(),
      }],
    });
    expect(() => reimburseExpenseClaim(db, { companyId, claimId: claim.claimId, bankAccountId, date: asIsoDate('2025-06-02') }))
      .toThrow(ExpenseClaimError);
  });
});

describe('reverseExpenseClaim', () => {
  it('reverses the approval journal and closes the claim, rather than editing it', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Wrong mileage',
      lines: [{
        lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'Cork site visit',
        accountId: travelAccount(), rateId: mileageRate(), units: 100,
      }],
    });
    const approval = approveExpenseClaim(db, { companyId, claimId: claim.claimId });
    const before = accountBalance(db, { companyId, accountId: travelAccount() });

    const reversal = reverseExpenseClaim(db, {
      companyId, claimId: claim.claimId, reason: 'Wrong distance claimed',
    });

    expect(accountBalance(db, { companyId, accountId: travelAccount() })).toBe(before - 4180);
    const row = db.select().from(expenseClaims).where(eq(expenseClaims.id, claim.claimId)).get()!;
    expect(row.status).toBe('reversed');
    expect(row.reversalJournalEntryId).toBe(reversal.reversalJournalEntryId);
    expect(row.journalEntryId).toBe(approval.journalEntryId!); // the original is untouched
  });

  it('dates the reversal with the approval journal, never before it', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Two trips',
      lines: [
        { lineType: 'travel', date: asIsoDate('2025-05-02'), description: 'Taxi', amountMinor: 20_00, accountId: travelAccount() },
        { lineType: 'travel', date: asIsoDate('2025-05-20'), description: 'Train', amountMinor: 30_00, accountId: travelAccount() },
      ],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId });
    const reversal = reverseExpenseClaim(db, { companyId, claimId: claim.claimId, reason: 'Claimed twice' });
    const entry = db.select().from(journalEntries).where(eq(journalEntries.id, reversal.reversalJournalEntryId)).get()!;
    expect(entry.entryDate).toBe('2025-05-20');
  });

  it('refuses to reverse a reimbursed claim: the money has left', () => {
    const claim = createExpenseClaim(db, {
      companyId, claimant: { officerId }, title: 'Parking',
      lines: [{
        lineType: 'travel', date: asIsoDate('2025-05-14'), description: 'Taxi', amountMinor: 20_00,
        accountId: travelAccount(),
      }],
    });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId });
    reimburseExpenseClaim(db, { companyId, claimId: claim.claimId, bankAccountId, date: asIsoDate('2025-06-02') });
    expect(() => reverseExpenseClaim(db, { companyId, claimId: claim.claimId, reason: 'Wrong amount' }))
      .toThrow(/cannot be undone/);
  });
});

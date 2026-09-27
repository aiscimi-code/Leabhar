import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { addPartner, PartnerError } from '../config/partners';
import { postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { recordPartnerLoan, partnerLoanBalance, PartnerLoanError } from './loans';
import { accounts, partners, journalEntries, auditEvents } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bank: string;
let aoife: { id: string; capitalAccountId: string | null; currentAccountId: string | null };

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Byrne & Walsh', entityType: 'partnership', tradeCommencedOn: '2024-01-01',
    vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
  });
  companyId = created.companyId;
  bank = created.accountsByKey['bank_control']!;
  aoife = addPartner(db, {
    companyId, name: 'Aoife', shareBasisPoints: 5_000, joinedOn: '2024-01-01',
    recordedBy: 'Aoife', isPrecedentPartner: true,
  });
  addPartner(db, { companyId, name: 'Brian', shareBasisPoints: 5_000, joinedOn: '2024-01-01', recordedBy: 'Aoife' });
});

describe('recordPartnerLoan', () => {
  it('moves the money through one of the company\'s own asset accounts only', () => {
    const expense = db.select().from(accounts).where(eq(accounts.companyId, companyId)).all().find((a) => a.type === 'expense')!;
    expect(() => recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced', amountMinor: 1_000,
      date: makeDate(2025, 3, 31), recordedBy: 'Aoife', moneyAccountId: expense.id,
    })).toThrow(/asset account/);
    expect(() => recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced', amountMinor: 1_000,
      date: makeDate(2025, 3, 31), recordedBy: 'Aoife', moneyAccountId: 'acct_elsewhere',
    })).toThrow(/not found/);
  });


  it('records an advance against the bank and the partner\'s own loan account', () => {
    const result = recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced',
      amountMinor: 500_000, date: makeDate(2025, 3, 31), recordedBy: 'Aoife',
    });

    expect(result.entryNumber).toBe(1);
    expect(result.balanceMinor).toBe(500_000);

    // A liability account of the partner's own, under the 228x loans heading.
    const row = db.select().from(partners).where(eq(partners.id, aoife.id)).get()!;
    expect(row.loanAccountId).not.toBeNull();
    const loan = db.select().from(accounts).where(eq(accounts.id, row.loanAccountId!)).get()!;
    expect(loan.code).toBe('22801');
    expect(loan.type).toBe('liability');

    // The bank received the money; the loan account owes it back.
    expect(accountBalance(db, { companyId, accountId: bank, asOf: makeDate(2025, 3, 31) })).toBe(500_000);
    expect(accountBalance(db, { companyId, accountId: loan.id, asOf: makeDate(2025, 3, 31) })).toBe(500_000);
  });

  it('keeps a loan out of the partner\'s capital and current accounts', () => {
    recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced',
      amountMinor: 500_000, date: makeDate(2025, 3, 31), recordedBy: 'Aoife',
    });
    expect(accountBalance(db, { companyId, accountId: aoife.capitalAccountId!, asOf: makeDate(2025, 12, 31) })).toBe(0);
    expect(accountBalance(db, { companyId, accountId: aoife.currentAccountId!, asOf: makeDate(2025, 12, 31) })).toBe(0);
  });

  it('repays a loan, and refuses a repayment beyond what the firm owes', () => {
    recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced',
      amountMinor: 500_000, date: makeDate(2025, 1, 15), recordedBy: 'Aoife',
    });
    const repaid = recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'repaid',
      amountMinor: 200_000, date: makeDate(2025, 6, 30), recordedBy: 'Aoife',
    });
    expect(repaid.balanceMinor).toBe(300_000);
    expect(accountBalance(db, { companyId, accountId: bank, asOf: makeDate(2025, 6, 30) })).toBe(300_000);

    expect(() => recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'repaid',
      amountMinor: 400_000, date: makeDate(2025, 7, 31), recordedBy: 'Aoife',
    })).toThrow(/cannot be repaid/);
    // Nothing was posted by the refused repayment.
    expect(partnerLoanBalance(db, companyId, aoife.id, makeDate(2025, 12, 31))).toBe(300_000);
  });

  it('refuses a non-integer amount, a non-positive amount, and a bad date', () => {
    expect(() => recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced',
      amountMinor: 500.5, date: makeDate(2025, 3, 31), recordedBy: 'Aoife',
    })).toThrow(/whole minor units/);
    expect(() => recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced',
      amountMinor: 0, date: makeDate(2025, 3, 31), recordedBy: 'Aoife',
    })).toThrow(/positive amount/);
    expect(() => recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced',
      amountMinor: 100, date: '31-03-2025', recordedBy: 'Aoife',
    })).toThrow(/YYYY-MM-DD/);
  });

  it('refuses loans for anything but a partnership, and a partner who is not there', () => {
    const { db: companyDb } = createTestDatabase();
    const co = createCompany(companyDb, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    expect(() => recordPartnerLoan(companyDb, {
      companyId: co.companyId, partnerId: 'ptr_none', direction: 'advanced',
      amountMinor: 100, date: makeDate(2025, 1, 1), recordedBy: 'Me',
    })).toThrow(PartnerError);
    expect(() => recordPartnerLoan(db, {
      companyId, partnerId: 'ptr_none', direction: 'advanced',
      amountMinor: 100, date: makeDate(2025, 1, 1), recordedBy: 'Me',
    })).toThrow(PartnerLoanError);
  });

  it('posts the loan as a partner_loan entry, dated and source-identified like every posted entry', () => {
    const { journalEntryId } = recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced',
      amountMinor: 500_000, date: makeDate(2025, 3, 31), recordedBy: 'Aoife',
    });
    const entry = db.select().from(journalEntries).where(eq(journalEntries.id, journalEntryId)).get()!;
    expect(entry.sourceType).toBe('partner_loan');
    expect(entry.sourceId).toBe(aoife.id);
    expect(entry.isPosted).toBe(true);
    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.entityId, aoife.id)).all()
      .find((a) => a.action === 'loan_advanced');
    expect(audit?.newValue).toContain('"amountMinor":500000');
  });
});

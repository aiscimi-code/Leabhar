import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { addPartner } from '../config/partners';
import { recordPartnerLoan, partnerLoanBalance } from './loans';
import { postJournalEntry } from '../accounting/journal';
import {
  recordPartnerLoanInterest, partnerLoanInterestForPeriod, PartnerLoanInterestError,
} from './interest';
import { computeBase } from '../corporationTax/computation';
import { recordCtDecision } from '../corporationTax/subjects';
import { computeIncomeTax } from '../incomeTax/computation';
import { trialBalance, accountBalance } from '../accounting/ledger';
import { journalEntries, journalLines, auditEvents, accounts } from '@/db/schema';
import { asIsoDate, makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let aoife: { id: string; loanAccountId: string | null };

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Byrne & Walsh', entityType: 'partnership', tradeCommencedOn: '2024-01-01',
    seedYears: [2025],
  });
  companyId = created.companyId;
  aoife = addPartner(db, {
    companyId, name: 'Aoife', shareBasisPoints: 5_000, joinedOn: '2024-01-01',
    recordedBy: 'Aoife', isPrecedentPartner: true,
  });
  addPartner(db, {
    companyId, name: 'Brian', shareBasisPoints: 5_000, joinedOn: '2024-01-01', recordedBy: 'Aoife',
  });
});

const loanInterestAccount = () => db.select().from(accounts)
  .where(and(eq(accounts.companyId, companyId), eq(accounts.code, '6710'))).get()!;

describe('recordPartnerLoanInterest (#464)', () => {
  it('accrues simple interest on the day-end balance over the period', () => {
    recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced', amountMinor: 10_000_000,
      date: '2025-01-01', recordedBy: 'Aoife',
    });

    // 100,000.00 at 5% for the whole of 2025 (365 days) is 5,000.00.
    const result = recordPartnerLoanInterest(db, {
      companyId, partnerId: aoife.id, rateBasisPoints: 500,
      from: '2025-01-01', to: '2025-12-31', recordedBy: 'Aoife',
    });

    expect(result.amountMinor).toBe(5_000_00);
    expect(accountBalance(db, { companyId, accountId: loanInterestAccount().id })).toBe(5_000_00);
    // The interest is owed back on the loan, like the principal.
    expect(partnerLoanBalance(db, companyId, aoife.id, makeDate(2025, 12, 31))).toBe(10_500_000);

    const entry = db.select().from(journalEntries)
      .where(eq(journalEntries.id, result.journalEntryId)).get()!;
    expect(entry.sourceType).toBe('partner_loan_interest');
    expect(entry.entryDate).toBe('2025-12-31');
    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id)).all();
    expect(lines).toHaveLength(2);

    const audit = db.select().from(auditEvents)
      .where(and(
        eq(auditEvents.entityType, 'partner'), eq(auditEvents.entityId, aoife.id),
        eq(auditEvents.action, 'loan_interest_accrued'),
      )).get();
    expect(JSON.parse(audit!.newValue as string).amountMinor).toBe(5_000_00);

    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });

  it('accrues nothing on the days the loan stands at nothing', () => {
    recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced', amountMinor: 10_000_000,
      date: '2025-07-01', recordedBy: 'Aoife',
    });

    // Only 184 days carry the balance (1 July to 31 December 2025).
    const result = recordPartnerLoanInterest(db, {
      companyId, partnerId: aoife.id, rateBasisPoints: 500,
      from: '2025-01-01', to: '2025-12-31', recordedBy: 'Aoife',
    });
    expect(result.amountMinor).toBe(Math.round((10_000_000 * 184 * 500) / (10_000 * 365)));
  });

  it('refuses when there is no loan to accrue on, or nothing to accrue', () => {
    const partnerId = aoife.id;
    expect(() => recordPartnerLoanInterest(db, {
      companyId, partnerId, rateBasisPoints: 500, from: '2025-01-01', to: '2025-12-31',
      recordedBy: 'Aoife',
    })).toThrow(/Record the loan first/);

    recordPartnerLoan(db, {
      companyId, partnerId, direction: 'advanced', amountMinor: 1_000,
      date: '2025-03-01', recordedBy: 'Aoife',
    });
    recordPartnerLoan(db, {
      companyId, partnerId, direction: 'repaid', amountMinor: 1_000,
      date: '2025-03-02', recordedBy: 'Aoife',
    });
    expect(() => recordPartnerLoanInterest(db, {
      companyId, partnerId, rateBasisPoints: 500, from: '2025-06-01', to: '2025-06-30',
      recordedBy: 'Aoife',
    })).toThrow(/No interest accrues/);
  });

  it('refuses a period that ends before it starts, a non-annual rate and an unknown partner', () => {
    expect(() => recordPartnerLoanInterest(db, {
      companyId, partnerId: aoife.id, rateBasisPoints: 500,
      from: '2025-12-31', to: '2025-01-01', recordedBy: 'Aoife',
    })).toThrow(/ends after the day it starts/);
    expect(() => recordPartnerLoanInterest(db, {
      companyId, partnerId: aoife.id, rateBasisPoints: 0,
      from: '2025-01-01', to: '2025-12-31', recordedBy: 'Aoife',
    })).toThrow(PartnerLoanInterestError);
    expect(() => recordPartnerLoanInterest(db, {
      companyId, partnerId: 'ptn_nobody', rateBasisPoints: 500,
      from: '2025-01-01', to: '2025-12-31', recordedBy: 'Aoife',
    })).toThrow(/not found/);
  });
});

const income = (amountMinor: number, date: string) => {
  const byCode = db.select().from(accounts).where(eq(accounts.companyId, companyId)).all();
  const bank = byCode.find((a) => a.code === '1000')!;
  const fees = byCode.find((a) => a.code === '4020')!;
  return postJournalEntry(db, {
    companyId, entryDate: asIsoDate(date), narrative: `Fees ${date}`, sourceType: 'bank_transaction',
    sourceId: `f-${date}-${amountMinor}`, baseCurrency: 'EUR',
    lines: [
      { accountId: bank.id, debitMinor: amountMinor },
      { accountId: fees.id, creditMinor: amountMinor },
    ],
  });
};

describe('partner loan interest in the tax computation (#464)', () => {
  const recordInterest = () => recordPartnerLoanInterest(db, {
    companyId, partnerId: aoife.id, rateBasisPoints: 500,
    from: '2025-01-01', to: '2025-12-31', recordedBy: 'Aoife',
  });

  beforeEach(() => {
    recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced', amountMinor: 10_000_000,
      date: '2025-01-01', recordedBy: 'Aoife',
    });
    // Fees of 10,000.00, so the trade's result is the interest and nothing else.
    income(1_000_000, '2025-06-01');
  });

  it('adds an undecided interest line back, with a finding naming the pending choice', () => {
    const interest = recordInterest();

    const base = computeBase(db, { companyId, from: '2025-01-01', to: '2025-12-31' });
    // The interest is a finance cost in the accounting profit; until decided,
    // the conservative treatment adds it back.
    expect(base.accountingProfitMinor).toBe(500_000);
    expect(base.adjustedMinor).toBe(1_000_000);

    const addBack = base.lines.find((l) => l.kind === 'add_back');
    expect(addBack).toBeDefined();
    expect(addBack!.amountMinor).toBe(5_000_00);
    expect(addBack!.label).toContain('partner');

    const interestDecision = base.decisions.find(
      (d) => d.subjectId === interestJournalLineId(interest.journalEntryId),
    );
    expect(interestDecision).toBeDefined();
    expect(interestDecision!.options.map((o) => o.choice)).toEqual(
      ['partner_interest_add_back', 'partner_interest_deductible'],
    );
    expect(interestDecision!.decided).toBeNull();

    expect(base.findings.some((f) => f.includes('added back until the decision is recorded')
      && f.includes('s.81'))).toBe(true);
  });

  it('restores the deduction when the person records "deductible"', () => {
    const interest = recordInterest();
    recordCtDecision(db, {
      companyId, subjectType: 'journal_line', subjectId: interestJournalLineId(interest.journalEntryId),
      periodEnd: '2025-12-31', choice: 'partner_interest_deductible', decidedBy: 'Accountant',
    });

    const base = computeBase(db, { companyId, from: '2025-01-01', to: '2025-12-31' });
    expect(base.adjustedMinor).toBe(500_000);
    expect(base.lines.find((l) => l.kind === 'add_back')).toBeUndefined();

    const interestDecision = base.decisions.find(
      (d) => d.subjectId === interestJournalLineId(interest.journalEntryId),
    );
    expect(interestDecision!.decided).toBe('partner_interest_deductible');
  });

  it('excludes the interest from every partner\'s share, and the books balance', () => {
    const interest = recordInterest();
    recordCtDecision(db, {
      companyId, subjectType: 'journal_line', subjectId: interestJournalLineId(interest.journalEntryId),
      periodEnd: '2025-12-31', choice: 'partner_interest_deductible', decidedBy: 'Accountant',
    });

    const computation = computeIncomeTax(db, { companyId, year: 2025 });
    // 10,000.00 of fees less the 5,000.00 of interest is 5,000.00, shared
    // 50/50. The interest itself is in neither share: it is Aoife's own income,
    // credited to her loan account.
    expect(computation.individuals).toHaveLength(2);
    for (const individual of computation.individuals) {
      expect(individual.profitMinor).toBe(250_000);
    }
    expect(computation.findings.some(
      (f) => f.includes('Aoife') && f.includes('own income') && f.includes('#458'),
    )).toBe(true);

    expect(partnerLoanInterestForPeriod(db, { companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') }))
      .toEqual([{ partner: expect.objectContaining({ name: 'Aoife' }), amountMinor: 5_000_00 }]);
    expect(trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) }).balanced).toBe(true);
  });
});

function interestJournalLineId(journalEntryId: string): string {
  const line = db.select().from(journalLines)
    .where(and(
      eq(journalLines.journalEntryId, journalEntryId),
      eq(journalLines.baseDebitMinor, 5_000_00),
    )).get();
  return line!.id;
}

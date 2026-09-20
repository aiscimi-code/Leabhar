/**
 * Comprehensive double-entry integrity tests (Work Package 04).
 *
 * These tests prove that SUM(debits) == SUM(credits) across every category of
 * accounting transaction Leabhar must handle, and that the journal engine
 * rejects unbalanced entries.
 *
 * The existing engine already enforces this invariant (`journal.ts`); these
 * tests strengthen coverage without rewriting the implementation — they verify
 * the invariant holds from the perspective of each transaction type the trust
 * programme requires.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from './journal';
import { journalLines } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { makeDate } from '../dates';
import { UnbalancedJournalError, InvalidLineError } from './errors';
import type { JournalLineInput } from './journal';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let byKey: Record<string, string>;

/** Helper: a debit line */
function debit(cents: number) { return { debitMinor: cents }; }
/** Helper: a credit line */
function credit(cents: number) { return { creditMinor: cents }; }

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Integrity Ltd',
    vatNumber: 'IE1234567T',
    vatRegistrationStatus: 'registered',
    financialYearEndDay: 31,
    financialYearEndMonth: 12,
    seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  byKey = created.accountsByKey;
});

/**
 * Helper: post an entry and assert that posted lines balance in base currency.
 * Returns the posted journal's line rows for further inspection.
 */
function postAndCheck(lines: JournalLineInput[], narrative: string) {
  const entry = postJournalEntry(db, {
    companyId,
    entryDate: makeDate(2025, 6, 15),
    narrative,
    sourceType: 'manual_adjustment',
    baseCurrency: 'EUR',
    lines,
  });
  const rows = db.select().from(journalLines)
    .where(eq(journalLines.journalEntryId, entry.id)).all();
  const totalDebit = rows.reduce((s, l) => s + (l.baseDebitMinor ?? 0), 0);
  const totalCredit = rows.reduce((s, l) => s + (l.baseCreditMinor ?? 0), 0);
  expect(totalDebit).toBe(totalCredit);
  return { entry, rows, totalDebit, totalCredit };
}

// Account accessors — use codes directly for income/expense, system keys for VAT/bank
const BANK = () => byKey['bank_control']!;
const VAT_INPUT = () => byKey['vat_on_purchases']!;
const VAT_OUTPUT = () => byKey['vat_on_sales']!;
const DCA = () => byKey['directors_current_account']!;
const EXPENSE = () => byCode['6120']!; // Office expenses
const INCOME = () => byCode['4000']!; // Software sales
const OTHER_INCOME = () => byCode['4090']!; // Other income
const CAP_EQ = () => byKey['computer_equipment']!;

describe('double-entry integrity — SUM(debits) == SUM(credits)', () => {
  it('income', () => {
    const r = postAndCheck([
      { accountId: BANK(), ...debit(500_000) },
      { accountId: INCOME(), ...credit(368_000) },
      { accountId: VAT_OUTPUT(), ...credit(132_000) },
    ], 'Standard-rated sale');
    expect(r.totalDebit).toBe(500_000);
    expect(r.totalCredit).toBe(500_000);
  });

  it('expenses', () => {
    const r = postAndCheck([
      { accountId: EXPENSE(), ...debit(23_000) },
      { accountId: VAT_INPUT(), ...debit(5_290) },
      { accountId: BANK(), ...credit(28_290) },
    ], 'Standard-rated purchase');
    expect(r.totalDebit).toBe(28_290);
    expect(r.totalCredit).toBe(28_290);
  });

  it('VAT', () => {
    // VAT return payment: VAT payable to Revenue
    const r = postAndCheck([
      { accountId: VAT_OUTPUT(), ...debit(132_000) },
      { accountId: BANK(), ...credit(132_000) },
    ], 'VAT payment to Revenue');
    expect(r.totalDebit).toBe(132_000);
    expect(r.totalCredit).toBe(132_000);
  });

  it('refunds', () => {
    // VAT refund from Revenue: VAT reclaimable
    const r = postAndCheck([
      { accountId: BANK(), ...debit(50_000) },
      { accountId: VAT_OUTPUT(), ...credit(50_000) },
    ], 'VAT refund received');
    expect(r.totalDebit).toBe(50_000);
    expect(r.totalCredit).toBe(50_000);
  });

  it('credit notes', () => {
    // Credit note: reduces both expense and VAT input
    const r = postAndCheck([
      { accountId: EXPENSE(), ...credit(10_000) },
      { accountId: VAT_INPUT(), ...credit(2_300) },
      { accountId: BANK(), ...debit(12_300) },
    ], 'Credit note received');
    expect(r.totalDebit).toBe(12_300);
    expect(r.totalCredit).toBe(12_300);
  });

  it('capital purchases', () => {
    // Capital purchase of equipment — goes to PPE (asset), not expense
    const r = postAndCheck([
      { accountId: CAP_EQ(), ...debit(123_000) },
      { accountId: VAT_INPUT(), ...debit(28_290) },
      { accountId: BANK(), ...credit(151_290) },
    ], 'Capital purchase of computer equipment');
    expect(r.totalDebit).toBe(151_290);
    expect(r.totalCredit).toBe(151_290);
  });

  it('loans', () => {
    // Director loan advance: liability increases, bank increases
    const r = postAndCheck([
      { accountId: BANK(), ...debit(100_000) },
      { accountId: DCA(), ...credit(100_000) },
    ], 'Director loan advance');
    expect(r.totalDebit).toBe(100_000);
    expect(r.totalCredit).toBe(100_000);
  });

  it('loan repayments', () => {
    // Director repays loan: liability decreases, bank decreases
    const r = postAndCheck([
      { accountId: DCA(), ...debit(50_000) },
      { accountId: BANK(), ...credit(50_000) },
    ], 'Director loan repayment');
    expect(r.totalDebit).toBe(50_000);
    expect(r.totalCredit).toBe(50_000);
  });

  it('grants', () => {
    // State grant: non-repayable, treated as income
    const r = postAndCheck([
      { accountId: BANK(), ...debit(250_000) },
      { accountId: OTHER_INCOME(), ...credit(250_000) },
    ], 'State grant received');
    expect(r.totalDebit).toBe(250_000);
    expect(r.totalCredit).toBe(250_000);
  });

  it('director-paid expenses', () => {
    // Director pays on behalf of company: company owes director
    const r = postAndCheck([
      { accountId: EXPENSE(), ...debit(40_000) },
      { accountId: VAT_INPUT(), ...debit(9_200) },
      { accountId: DCA(), ...credit(49_200) },
    ], 'Director pays supplier');
    expect(r.totalDebit).toBe(49_200);
    expect(r.totalCredit).toBe(49_200);
  });

  it('bank charges', () => {
    // Bank charge: expense to P&L (no VAT — bank charges excluded)
    const r = postAndCheck([
      { accountId: byCode['6100']!, ...debit(2_000) }, // Bank charges
      { accountId: BANK(), ...credit(2_000) },
    ], 'Bank charge');
    expect(r.totalDebit).toBe(2_000);
    expect(r.totalCredit).toBe(2_000);
  });

  it('FX', () => {
    // USD transaction at 0.92 rate: $100 → €92 net + €21.16 VAT = €113.16 gross
    // In EUR minor units: net 9200, vat 2116, gross 11316
    const r = postAndCheck([
      { accountId: EXPENSE(), ...debit(9_200) },
      { accountId: VAT_INPUT(), ...debit(2_116) },
      { accountId: BANK(), ...credit(11_316) },
    ], 'US SaaS subscription (reverse charge)');
    expect(r.totalDebit).toBe(11_316);
    expect(r.totalCredit).toBe(11_316);
  });

  it('adjustments', () => {
    // Year-end accrual adjustment (using accruals liability)
    const r = postAndCheck([
      { accountId: EXPENSE(), ...debit(50_000) },
      { accountId: byCode['2300']!, ...credit(50_000) }, // Accruals
    ], 'Accrued expenses adjustment');
    expect(r.totalDebit).toBe(50_000);
    expect(r.totalCredit).toBe(50_000);
  });
});

describe('double-entry integrity — invalid journals are rejected', () => {
  it('rejects a journal where debits exceed credits', () => {
    expect(() => postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Unbalanced: debit > credit',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: EXPENSE(), debitMinor: 10_000 },
        { accountId: BANK(), creditMinor: 9_900 },
      ],
    })).toThrow(UnbalancedJournalError);
  });

  it('rejects a journal where credits exceed debits', () => {
    expect(() => postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Unbalanced: credit > debit',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: EXPENSE(), debitMinor: 9_900 },
        { accountId: BANK(), creditMinor: 10_000 },
      ],
    })).toThrow(UnbalancedJournalError);
  });

  it('rejects a journal with only one line', () => {
    expect(() => postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Single line',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: EXPENSE(), debitMinor: 10_000 },
      ],
    })).toThrow(/at least two lines/);
  });

  it('rejects a journal where both sides are zero', () => {
    expect(() => postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Zero entry',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: EXPENSE() },
        { accountId: BANK() },
      ],
    })).toThrow(InvalidLineError);
  });

  it('rejects a journal where some lines are missing debit/credit', () => {
    expect(() => postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Missing value',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: EXPENSE(), debitMinor: 10_000 },
        { accountId: BANK() }, // no credit or debit
      ],
    })).toThrow(InvalidLineError);
  });

  it('rejects a line with both debit and credit set', () => {
    expect(() => postJournalEntry(db, {
      companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Both debit and credit',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: EXPENSE(), debitMinor: 5_000, creditMinor: 5_000 },
        { accountId: BANK(), creditMinor: 10_000 },
      ],
    })).toThrow(InvalidLineError);
  });
});

describe('double-entry integrity — multi-line entries', () => {
  it('three-line balanced entry (income split)', () => {
    postAndCheck([
      { accountId: BANK(), ...debit(100_000) },
      { accountId: INCOME(), ...credit(70_000) },
      { accountId: INCOME(), ...credit(30_000) },
    ], 'Income from two sources');
  });

  it('four-line balanced entry (VAT split)', () => {
    postAndCheck([
      { accountId: EXPENSE(), ...debit(50_000) },
      { accountId: VAT_INPUT(), ...debit(8_000) },
      { accountId: EXPENSE(), ...debit(30_000) },
      { accountId: BANK(), ...credit(88_000) },
    ], 'Two purchases with VAT');
  });
});

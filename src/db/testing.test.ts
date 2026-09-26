import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedTestBook, insertTestBankTransaction } from './testing';
import { accountingPeriods, bankAccounts, companies, vatPeriods } from './schema';

describe('seedTestBook', () => {
  it('creates a registered company with 2025 periods and a bank account', () => {
    const book = seedTestBook();

    const company = book.db.select().from(companies).where(eq(companies.id, book.companyId)).get()!;
    expect(company.legalName).toBe('Test Book Ltd');
    expect(company.vatRegistrationStatus).toBe('registered');

    const years = book.db.select().from(accountingPeriods)
      .where(eq(accountingPeriods.companyId, book.companyId)).all()
      .filter((p) => p.kind === 'financial_year');
    expect(years).toHaveLength(1);
    expect(years[0]!.startDate).toBe('2025-01-01');
    expect(years[0]!.endDate).toBe('2025-12-31');

    expect(book.db.select().from(vatPeriods)
      .where(eq(vatPeriods.companyId, book.companyId)).all().length).toBeGreaterThan(0);

    const account = book.db.select().from(bankAccounts)
      .where(eq(bankAccounts.id, book.bankAccountId)).get()!;
    expect(account.companyId).toBe(book.companyId);

    expect(book.accountsByCode['4020']).toBeDefined();
    expect(book.treatmentsByCode['IE_STD']).toBeDefined();
  });

  it('passes options through to createCompany', () => {
    const book = seedTestBook({
      legalName: 'Override Ltd',
      vatAccountingBasis: 'invoice',
      vatRegistrationStatus: 'not_registered',
      financialYearEndMonth: 6,
      seedYears: [2026],
    });

    const company = book.db.select().from(companies).where(eq(companies.id, book.companyId)).get()!;
    expect(company.legalName).toBe('Override Ltd');
    expect(company.vatAccountingBasis).toBe('invoice');
    expect(company.vatRegistrationStatus).toBe('not_registered');
    expect(company.financialYearEndMonth).toBe(6);
  });

  it('composes with insertTestBankTransaction', () => {
    const book = seedTestBook();
    const transactionId = insertTestBankTransaction(book.db, {
      companyId: book.companyId,
      bankAccountId: book.bankAccountId,
      amountMinor: -1_234,
    });
    expect(transactionId).toMatch(/^btx_/);
  });
});

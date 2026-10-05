import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { computeIncomeTax } from './computation';
import { asIsoDate } from '../dates';

const setup = () => {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: 'Aoife Byrne', entityType: 'sole_trader', tradeCommencedOn: '2023-01-01',
    financialYearEndMonth: 12, financialYearEndDay: 31,
    vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025, 2026],
  });
  const income = (amountMinor: number, date: string) => postJournalEntry(db, {
    companyId: created.companyId, entryDate: asIsoDate(date), narrative: `Fees ${date}`,
    sourceType: 'bank_transaction', sourceId: `f-${date}-${amountMinor}`, baseCurrency: 'EUR',
    lines: [
      { accountId: created.accountsByKey['bank_control']!, debitMinor: amountMinor },
      { accountId: created.accountsByCode['4020']!, creditMinor: amountMinor },
    ],
  });
  return { db, ...created, income };
};

describe('computeIncomeTax Class S disregard (#487)', () => {
  it('charges no Class S below the €5,000 prescribed amount', () => {
    const { db, companyId, income } = setup();
    income(300_000, '2026-06-01');
    const c = computeIncomeTax(db, { companyId, year: 2026 });
    expect(c.individuals[0]!.prsiMinor).toBe(0);
    expect(c.findings.some((f) => f.includes('prescribed amount'))).toBe(true);
  });

  it('applies the €650 Class S floor just above the prescribed amount', () => {
    const { db, companyId, income } = setup();
    income(600_000, '2026-06-01');
    expect(computeIncomeTax(db, { companyId, year: 2026 }).individuals[0]!.prsiMinor).toBe(65_000);
  });
});

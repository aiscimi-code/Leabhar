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

describe('Class S prescribed amount (#487)', () => {
  it('charges no Class S below \u20ac5,000 and the \u20ac650 floor above it', () => {
    const low = setup();
    low.income(300_000, '2026-06-01');
    const lowComp = computeIncomeTax(low.db, { companyId: low.companyId, year: 2026 });
    expect(lowComp.individuals[0]!.prsiMinor).toBe(0);
    expect(lowComp.findings.some((f) => f.includes('prescribed amount'))).toBe(true);

    const mid = setup();
    mid.income(600_000, '2026-06-01');
    expect(computeIncomeTax(mid.db, { companyId: mid.companyId, year: 2026 }).individuals[0]!.prsiMinor).toBe(65_000);
  });
});

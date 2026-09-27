import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { addPartner } from '../config/partners';
import { asIsoDate } from '../dates';
import { buildForm11 } from './form11';

const setup = (entityType: 'sole_trader' | 'partnership', tradeCommencedOn: string) => {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: entityType === 'sole_trader' ? 'Aoife Byrne' : 'Byrne & Walsh', entityType, tradeCommencedOn,
    vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
  });
  const income = (amountMinor: number, date: string) => postJournalEntry(db, {
    companyId: created.companyId, entryDate: asIsoDate(date), narrative: `Fees ${date}`, sourceType: 'bank_transaction',
    sourceId: `f-${date}-${amountMinor}`, baseCurrency: 'EUR',
    lines: [{ accountId: created.accountsByKey['bank_control']!, debitMinor: amountMinor }, { accountId: created.accountsByCode['4020']!, creditMinor: amountMinor }],
  });
  const expense = (amountMinor: number, date: string) => postJournalEntry(db, {
    companyId: created.companyId, entryDate: asIsoDate(date), narrative: `Costs ${date}`, sourceType: 'bank_transaction',
    sourceId: `e-${date}-${amountMinor}`, baseCurrency: 'EUR',
    lines: [{ accountId: created.accountsByCode['6070']!, debitMinor: amountMinor }, { accountId: created.accountsByKey['bank_control']!, creditMinor: amountMinor }],
  });
  return { db, ...created, income, expense };
};

describe('buildForm11 (epic #312)', () => {
  it('lays out the trade and the person, reconciles the tax to the payments, and states the provision', () => {
    const s = setup('sole_trader', '2025-01-01');
    s.income(5_000_000, '2025-06-01');
    s.income(6_000_000, '2026-06-01');
    const f = buildForm11(s.db, { companyId: s.companyId, year: 2026 });
    expect(f.year).toBe(2026);
    expect(f.computation.assessableProfitMinor).toBe(6_000_000);
    const trade = f.sections[0]!;
    expect(trade.title).toContain('Trading income');
    expect(trade.lines.some((l) => l.label.includes('Basis period 2026-01-01 to 2026-12-31'))).toBe(true);
    expect(trade.lines.at(-1)).toMatchObject({ label: 'Assessable trading profit', amountMinor: 6_000_000 });
    const mine = f.sections[1]!;
    expect(mine.title).toContain('Aoife Byrne');
    // Income tax 1,120,000 + USC 133,282 + PRSI 252,000.
    expect(mine.lines.at(-1)).toMatchObject({ label: 'Total liability', amountMinor: 1_505_282 });
    // The self-assessment reconciliation: 90% of this year (1,354,754) against
    // 100% of the last year's (824,600: income tax 720,000 and USC 104,600; no PRSI rate for 2025).
    expect(f.selfAssessment).toHaveLength(1);
    const sa = f.selfAssessment[0]!;
    expect(sa).toMatchObject({
      liabilityMinor: 1_505_282, preliminaryTaxMinor: 824_600, balanceMinor: 680_682, balanceDueDate: '2027-10-31',
    });
    expect(sa.working).toContain('s.959AO');
    // The provision: what to set aside, and when, and that it comes from drawings.
    const pr = f.provision[0]!;
    expect(pr.payments).toEqual([
      { dueDate: '2026-10-31', amountMinor: 824_600, description: 'Preliminary tax (s.959AO)' },
      { dueDate: '2027-10-31', amountMinor: 680_682, description: 'Balance with the return' },
    ]);
    expect(pr.note).toContain('drawings');
    expect(f.findings.some((x) => x.includes('PPS'))).toBe(true);
    expect(f.findings.some((x) => x.includes('non-trading income'))).toBe(true);
  });

  it('reconciles a year with no profits to nothing payable, and no provision', () => {
    const s = setup('sole_trader', '2025-01-01');
    s.income(5_000_000, '2025-06-01');
    const f = buildForm11(s.db, { companyId: s.companyId, year: 2026 });
    const sa = f.selfAssessment[0]!;
    expect(sa.liabilityMinor).toBe(0);
    expect(sa.preliminaryTaxMinor).toBe(0);
    expect(sa.balanceMinor).toBe(0);
    expect(f.provision[0]!.payments.every((p) => p.amountMinor === 0)).toBe(true);
  });

  it('gives each partner their own computation, reconciliation and provision (s.1008)', () => {
    const s = setup('partnership', '2025-01-01');
    addPartner(s.db, { companyId: s.companyId, name: 'Aoife', shareBasisPoints: 5000, joinedOn: '2025-01-01', recordedBy: 'Aoife', isPrecedentPartner: true });
    addPartner(s.db, { companyId: s.companyId, name: 'Brian', shareBasisPoints: 5000, joinedOn: '2025-01-01', recordedBy: 'Aoife' });
    s.income(4_000_000, '2025-06-01');
    s.income(6_000_000, '2026-06-01');
    const f = buildForm11(s.db, { companyId: s.companyId, year: 2026 });
    expect(f.sections.filter((x) => x.title.startsWith('Tax computation'))).toHaveLength(2);
    expect(f.selfAssessment.map((x) => x.name).sort()).toEqual(['Aoife', 'Brian']);
    expect(f.provision.map((x) => x.name).sort()).toEqual(['Aoife', 'Brian']);
    // Each is assessed on their half of 60,000, and reconciles to their own preliminary tax.
    expect(f.selfAssessment.every((x) => x.liabilityMinor === f.computation.individuals[0]!.totalMinor)).toBe(true);
    expect(f.selfAssessment.every((x) => x.preliminaryTaxMinor === f.computation.individuals[0]!.preliminaryTaxMinor)).toBe(true);
    expect(f.findings.some((x) => x.includes('their own Form 11'))).toBe(true);
  });

  it('carries a loss through the form, with nothing to pay on it', () => {
    const s = setup('sole_trader', '2025-01-01');
    s.income(1_000_000, '2025-06-01');
    s.expense(6_000_000, '2025-06-02');
    const f = buildForm11(s.db, { companyId: s.companyId, year: 2025 });
    const mine = f.sections[1]!;
    expect(mine.lines.some((l) => l.label.includes('Loss carried forward against later profits of the trade (s.382)'))).toBe(true);
    expect(f.selfAssessment[0]!.balanceMinor).toBe(0);
    expect(f.computation.tradingLossMinor).toBe(5_000_000);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { addPartner, setPartnerShare, allocateByShares } from '../config/partners';
import { recordPartnerLoan } from './loans';
import { partnerAllocationStatement, form1Firms, PartnershipReportError } from './report';
import { postJournalEntry } from '../accounting/journal';
import { makeDate, asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let aoife: { id: string; currentAccountId: string | null };
let brian: { id: string };

const setup = () => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Byrne & Walsh', entityType: 'partnership', tradeCommencedOn: '2023-01-01',
    vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025, 2026],
  });
  companyId = created.companyId;
  aoife = addPartner(db, {
    companyId, name: 'Aoife', shareBasisPoints: 5_000, joinedOn: '2023-01-01',
    recordedBy: 'Aoife', isPrecedentPartner: true, taxReference: '123A',
  });
  brian = addPartner(db, { companyId, name: 'Brian', shareBasisPoints: 5_000, joinedOn: '2023-01-01', recordedBy: 'Aoife' });
  return created;
};

const income = (created: ReturnType<typeof setup>, amountMinor: number, date: string) =>
  postJournalEntry(db, {
    companyId, entryDate: asIsoDate(date), narrative: `Fees ${date}`, sourceType: 'bank_transaction',
    sourceId: `f-${date}-${amountMinor}`, baseCurrency: 'EUR',
    lines: [
      { accountId: created.accountsByKey['bank_control']!, debitMinor: amountMinor },
      { accountId: created.accountsByCode['4020']!, creditMinor: amountMinor },
    ],
  });

beforeEach(setup);

describe('partnerAllocationStatement', () => {
  it('allocates the accounting result by the shares in force, with each partner\'s balances', () => {
    const created = setup();
    income(created, 3_650_000, '2025-03-01');
    recordPartnerLoan(db, {
      companyId, partnerId: aoife.id, direction: 'advanced',
      amountMinor: 1_000_000, date: makeDate(2025, 2, 1), recordedBy: 'Aoife',
    });

    const statement = partnerAllocationStatement(db, {
      companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31'),
    });
    expect(statement.firmName).toBe('Byrne & Walsh');
    expect(statement.resultMinor).toBe(3_650_000);
    expect(statement.segments).toEqual([
      { from: '2025-01-01', to: '2025-12-31', shares: [
        { partnerId: aoife.id, name: 'Aoife', shareBasisPoints: 5_000 },
        { partnerId: brian.id, name: 'Brian', shareBasisPoints: 5_000 },
      ] },
    ]);
    const byName = Object.fromEntries(statement.rows.map((r) => [r.name, r]));
    expect(byName.Aoife!.allocatedResultMinor).toBe(1_825_000);
    expect(byName.Brian!.allocatedResultMinor).toBe(1_825_000);
    expect(byName.Aoife!.weightedShareBasisPoints).toBe(5_000);
    // The loan is a liability of its own: it shows in the loan column, and
    // nowhere in the capital or current account.
    expect(byName.Aoife!.loanBalanceMinor).toBe(1_000_000);
    expect(byName.Brian!.loanBalanceMinor).toBeNull();
    expect(byName.Aoife!.capitalBalanceMinor).toBe(0);
    expect(byName.Aoife!.currentBalanceMinor).toBe(0);
  });

  it('never hands a gap in the shares to a partner as a rounding residue', () => {
    setPartnerShare(db, { companyId, partnerId: brian.id, shareBasisPoints: 4_000, effectiveFrom: '2025-01-01', recordedBy: 'test' });
    const parts = allocateByShares(db, companyId, { from: '2025-01-01', to: '2025-12-31', amountMinor: 1_000_000 });
    // 50% + 40%: 90% is allocated as recorded, and the missing 10% stays unallocated.
    expect(parts.reduce((s, p) => s + p.amountMinor, 0)).toBe(900_000);
  });

  it('allocates day by day through a share change, agreeing with allocateByShares', () => {
    const created = setup();
    income(created, 3_650_000, '2025-03-01');
    setPartnerShare(db, { companyId, partnerId: aoife.id, shareBasisPoints: 7_000, effectiveFrom: '2025-07-02', recordedBy: 'Aoife' });
    setPartnerShare(db, { companyId, partnerId: brian.id, shareBasisPoints: 3_000, effectiveFrom: '2025-07-02', recordedBy: 'Aoife' });

    const statement = partnerAllocationStatement(db, {
      companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31'),
    });
    const parts = allocateByShares(db, companyId, { from: '2025-01-01', to: '2025-12-31', amountMinor: 3_650_000 });
    // 182 days at 50/50, 183 days at 70/30 of 36,500.
    expect(Object.fromEntries(parts.map((p) => [p.partner.name, p.amountMinor])))
      .toEqual({ Aoife: 910_000 + 1_281_000, Brian: 910_000 + 549_000 });
    expect(statement.rows.reduce((s, r) => s + r.allocatedResultMinor, 0)).toBe(3_650_000);
    const byName = Object.fromEntries(statement.rows.map((r) => [r.name, r.allocatedResultMinor]));
    expect(byName).toEqual({
      Aoife: parts.find((p) => p.partner.name === 'Aoife')!.amountMinor,
      Brian: parts.find((p) => p.partner.name === 'Brian')!.amountMinor,
    });
  });

  it('reports the findings a partnership\'s record carries, and refuses a non-partnership', () => {
    const created = setup();
    income(created, 1_000_000, '2025-03-01');
    const statement = partnerAllocationStatement(db, {
      companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31'),
    });
    expect(statement.findings).toEqual([]);

    const { db: companyDb } = createTestDatabase();
    const co = createCompany(companyDb, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    expect(() => partnerAllocationStatement(companyDb, {
      companyId: co.companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31'),
    })).toThrow(PartnershipReportError);
  });
});

describe('form1Firms', () => {
  it('states the firm\'s profit and each partner\'s share of it, as the income tax computation computed them', () => {
    const created = setup();
    income(created, 3_650_000, '2025-03-01');
    const form = form1Firms(db, { companyId, year: 2025 });

    expect(form.firmName).toBe('Byrne & Walsh');
    expect(form.precedentPartner).toMatchObject({ name: 'Aoife', taxReference: '123A' });
    expect(form.basis).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
    expect(form.assessableProfitMinor).toBe(3_650_000);
    expect(form.partners).toHaveLength(2);
    const aoifeRow = form.partners.find((p) => p.name === 'Aoife')!;
    expect(aoifeRow.profitMinor).toBe(1_825_000);
    expect(aoifeRow.weightedShareBasisPoints).toBe(5_000);
    expect(aoifeRow.taxReference).toBe('123A');
    expect(form.dates).toMatchObject({ preliminaryTaxDue: '2025-10-31', returnDue: '2026-10-31' });
    expect(form.partners.reduce((s, p) => s + p.profitMinor, 0)).toBe(3_650_000);
  });

  it('carries the computation\'s findings, including a missing precedent partner', () => {
    const { db: freshDb } = createTestDatabase();
    const created = createCompany(freshDb, {
      legalName: 'Solo & Co', entityType: 'partnership', tradeCommencedOn: '2023-01-01',
      vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025],
    });
    // One partner, not the precedent partner, holding 60% of the shares.
    addPartner(freshDb, {
      companyId: created.companyId, name: 'Aoife', shareBasisPoints: 6_000,
      joinedOn: '2023-01-01', recordedBy: 'Aoife',
    });
    postJournalEntry(freshDb, {
      companyId: created.companyId, entryDate: asIsoDate('2025-03-01'), narrative: 'Fees',
      sourceType: 'bank_transaction', sourceId: 'f-1', baseCurrency: 'EUR',
      lines: [
        { accountId: created.accountsByKey['bank_control']!, debitMinor: 1_000_000 },
        { accountId: created.accountsByCode['4020']!, creditMinor: 1_000_000 },
      ],
    });
    const form = form1Firms(freshDb, { companyId: created.companyId, year: 2025 });
    expect(form.precedentPartner).toBeNull();
    expect(form.findings.some((f) => f.includes('add up to 60%'))).toBe(true);
    expect(form.findings.some((f) => f.includes('No precedent partner'))).toBe(true);
  });
});

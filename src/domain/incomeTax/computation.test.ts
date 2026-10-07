import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { setPartnerActivityStatus, addPartner, setPartnerShare, PartnerError } from '../config/partners';
import { recordCtDecision, CtDecisionError } from '../corporationTax/computation';
import { computeIncomeTax, IncomeTaxError, type IndividualLiability } from './computation';
import { asIsoDate } from '../dates';
import { accounts, fixedAssets, partners } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ids } from '@/lib/ids';
import { multiplyRational } from '../money';

const setup = (entityType: 'sole_trader' | 'partnership', tradeCommencedOn: string, yearEndMonth = 12) => {
  const { db } = createTestDatabase();
  const created = createCompany(db, {
    legalName: entityType === 'sole_trader' ? 'Aoife Byrne' : 'Byrne & Walsh', entityType, tradeCommencedOn,
    financialYearEndMonth: yearEndMonth, financialYearEndDay: yearEndMonth === 6 ? 30 : 31,
    vatRegistrationStatus: 'registered', seedYears: [2023, 2024, 2025, 2026],
  });
  const income = (amountMinor: number, date: string) => postJournalEntry(db, {
    companyId: created.companyId, entryDate: asIsoDate(date), narrative: `Fees ${date}`, sourceType: 'bank_transaction',
    sourceId: `f-${date}-${amountMinor}`, baseCurrency: 'EUR',
    lines: [{ accountId: created.accountsByKey['bank_control']!, debitMinor: amountMinor }, { accountId: created.accountsByCode['4020']!, creditMinor: amountMinor }],
  });
  return { db, ...created, income };
};

describe('entity types', () => {
  it('gives a sole trader a capital account and drawings, and no corporation tax or directors accounts', () => {
    const { db, companyId } = setup('sole_trader', '2023-01-01');
    const names = new Map(db.select().from(accounts).where(eq(accounts.companyId, companyId)).all().map((a) => [a.code, a.name]));
    expect([names.get('3000'), names.get('3200'), names.has('2200'), names.has('6160')]).toEqual(['Capital account', 'Drawings', false, false]);
  });

  it('refuses income tax for a company, and partners for anything but a partnership', () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Co Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    expect(() => computeIncomeTax(db, { companyId, year: 2025 })).toThrow(IncomeTaxError);
    expect(() => addPartner(db, { companyId, name: 'X', shareBasisPoints: 10_000, joinedOn: '2025-01-01', recordedBy: 'Me' })).toThrow(PartnerError);
  });
});

describe('sole trader', () => {
  it('charges 2025 income tax and USC at the Finance Act 2024 bands and credits', () => {
    const { db, companyId, income } = setup('sole_trader', '2023-01-01');
    income(6_000_000, '2025-06-01');
    const c = computeIncomeTax(db, { companyId, year: 2025 });
    expect(c.basis).toMatchObject({ from: '2025-01-01', to: '2025-12-31' });
    const me = c.individuals[0]!;
    // 44,000 at 20% + 16,000 at 40% - 2,000 personal - 2,000 earned income credit.
    expect(me.incomeTaxMinor).toBe(1_120_000);
    // 12,012 at 0.5% + 15,370 at 2% + 32,618 at 3%.
    expect(me.uscMinor).toBe(134_600);
    // PRSI Class S: 4.1% on 45,000 to 30 September, 4.2% on 15,000 from 1 October (#711).
    expect(me.prsiMinor).toBe(184_500 + 63_000);
    expect(c.findings.some((f) => f.endsWith('PRSI Class S at 4.1% on 45000.00 (2025-01-01 to 2025-09-30) and '
      + '4.2% on 15000.00 (2025-10-01 to 2025-12-31), the year\'s income apportioned by time, with the 650.00 minimum.'))).toBe(true);
    expect(c.dates).toMatchObject({ preliminaryTaxDue: '2025-10-31', returnDue: '2026-10-31' });
    expect(c.decisions[0]).toMatchObject({ subjectType: 'personal_status', suggested: 'single' });
  });

  it('uses the band and credit of the status a person records', () => {
    const { db, companyId, income } = setup('sole_trader', '2023-01-01');
    income(6_000_000, '2025-06-01');
    recordCtDecision(db, { companyId, subjectType: 'personal_status', subjectId: companyId, periodEnd: '2025-12-31', choice: 'married_one_income', decidedBy: 'Aoife' });
    // 53,000 at 20% + 7,000 at 40% - 4,000 - 2,000.
    expect(computeIncomeTax(db, { companyId, year: 2025 }).individuals[0]!.incomeTaxMinor).toBe(740_000);
  });

  it('applies the 2026 USC bands and PRSI Class S from the 2026 rules', () => {
    const { db, companyId, income } = setup('sole_trader', '2023-01-01');
    income(6_000_000, '2026-06-01');
    const me = computeIncomeTax(db, { companyId, year: 2026 }).individuals[0]!;
    // 12,012 at 0.5% + 16,688 at 2% + 31,300 at 3%.
    expect(me.uscMinor).toBe(6006 + 33_376 + 93_900);
    // 4.2% on 45,000 to 30 September, 4.35% on 15,000 from 1 October (SWMPA 2024 s.3(3); #711).
    expect(me.prsiMinor).toBe(189_000 + 65_250);
  });

  it('computes no PRSI for 2024: no Class S rate is curated before 1 October 2024 (#711)', () => {
    const { db, companyId, income } = setup('sole_trader', '2023-01-01');
    income(6_000_000, '2024-06-01');
    const c = computeIncomeTax(db, { companyId, year: 2024 });
    expect(c.individuals[0]!.prsiMinor).toBeNull();
    expect(c.findings.some((f) => f.startsWith('No PRSI Class S rate is available for 2024-01-01 to 2024-09-30'))).toBe(true);
  });

  it('taxes the first year from commencement and the second on the 12-month account (s.66)', () => {
    const { db, companyId, income } = setup('sole_trader', '2024-07-01');
    income(3_000_000, '2024-09-01');
    income(5_000_000, '2025-03-01');
    expect(computeIncomeTax(db, { companyId, year: 2024 })).toMatchObject({ basis: { from: '2024-07-01', to: '2024-12-31' }, assessableProfitMinor: 3_000_000 });
    expect(computeIncomeTax(db, { companyId, year: 2025 })).toMatchObject({ basis: { from: '2025-01-01', to: '2025-12-31' }, assessableProfitMinor: 5_000_000 });
  });

  it('reduces the third year by the second year\'s excess only when the s.66(3) election is recorded (issue #485)', () => {
    const { db, companyId, income } = setup('sole_trader', '2024-07-01', 6);
    income(12_000_000, '2024-08-01'); // year to 30 June 2025
    income(6_000_000, '2025-08-01');  // year to 30 June 2026
    const second = computeIncomeTax(db, { companyId, year: 2025 });
    expect(second.basis).toMatchObject({ from: '2024-07-01', to: '2025-06-30' });
    expect(second.assessableProfitMinor).toBe(12_000_000);
    // Actual 2025: 6/12 of 120,000 + 6/12 of 60,000 (whole months are apportioned as months, #671).
    const actual2025 = 6_000_000 + 3_000_000;
    const excess = Math.min(12_000_000 - actual2025, 6_000_000);

    // The relief is elective: with no election recorded it is not applied, and
    // the decision is offered with the excess as its amount.
    const undec = computeIncomeTax(db, { companyId, year: 2026 });
    expect(undec.thirdYearReliefMinor).toBe(0);
    expect(undec.basisProfitMinor).toBe(6_000_000);
    const pending = undec.decisions.find((d) => d.subjectType === 'basis_election')!;
    expect(pending.amountMinor).toBe(excess);
    expect(pending.suggested).toBe('elect');
    expect(undec.findings.some((f) => f.includes('s.66(3)') && f.includes('No election is recorded'))).toBe(true);

    recordCtDecision(db, { companyId, subjectType: 'basis_election', subjectId: companyId, periodEnd: '2026-12-31', choice: 'elect', decidedBy: 'Trader' });
    const third = computeIncomeTax(db, { companyId, year: 2026 });
    expect(third.thirdYearReliefMinor).toBe(excess);
    expect(third.basisProfitMinor).toBe(6_000_000 - excess);
    expect(third.findings.some((f) => f.includes('s.66(3) election is recorded'))).toBe(true);
  });
});

describe('partnership', () => {
  it('apportions the profit by the shares in force, day by day through a change (s.1008)', () => {
    const { db, companyId, income } = setup('partnership', '2023-01-01');
    const a = addPartner(db, { companyId, name: 'Aoife', shareBasisPoints: 5000, joinedOn: '2023-01-01', recordedBy: 'Aoife', isPrecedentPartner: true });
    const b = addPartner(db, { companyId, name: 'Brian', shareBasisPoints: 5000, joinedOn: '2023-01-01', recordedBy: 'Aoife' });
    setPartnerShare(db, { companyId, partnerId: a.id, shareBasisPoints: 7000, effectiveFrom: '2025-07-02', recordedBy: 'Aoife' });
    setPartnerShare(db, { companyId, partnerId: b.id, shareBasisPoints: 3000, effectiveFrom: '2025-07-02', recordedBy: 'Aoife' });
    income(3_650_000, '2025-03-01');
    const c = computeIncomeTax(db, { companyId, year: 2025 });
    const byName = Object.fromEntries(c.individuals.map((i) => [i.name, i.profitMinor]));
    // 182 days at 50/50, 183 days at 70/30 of 36,500.
    expect(byName).toEqual({ Aoife: 910_000 + 1_281_000, Brian: 910_000 + 549_000 });
    expect(c.findings.some((f) => f.includes('add up to'))).toBe(false);
    expect(db.select().from(accounts).where(eq(accounts.companyId, companyId)).all().filter((x) => x.name.includes('Aoife')).length).toBe(2);
  });

  it('flags shares that do not add up to 100% and a missing precedent partner', () => {
    const { db, companyId, income } = setup('partnership', '2023-01-01');
    addPartner(db, { companyId, name: 'Aoife', shareBasisPoints: 6000, joinedOn: '2023-01-01', recordedBy: 'Aoife' });
    income(1_000_000, '2025-03-01');
    const f = computeIncomeTax(db, { companyId, year: 2025 }).findings;
    expect(f.some((x) => x.includes('add up to 60%'))).toBe(true);
    expect(f.some((x) => x.includes('No precedent partner'))).toBe(true);
  });
});

/** Post a deductible expense against the bank, for a loss. */
const expense = (s: ReturnType<typeof setup>, amountMinor: number, date: string) => postJournalEntry(s.db, {
  companyId: s.companyId, entryDate: asIsoDate(date), narrative: `Costs ${date}`, sourceType: 'bank_transaction',
  sourceId: `e-${date}-${amountMinor}`, baseCurrency: 'EUR',
  lines: [{ accountId: s.accountsByCode['6070']!, debitMinor: amountMinor }, { accountId: s.accountsByKey['bank_control']!, creditMinor: amountMinor }],
});

describe('capital allowances for the year of assessment (s.284, issue #285)', () => {
  it('gives each year of assessment its own allowance, and a balancing allowance the apportioned treatment loses', () => {
    const s = setup('sole_trader', '2024-07-01', 6);
    s.db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: s.companyId, name: 'Oven', assetCategory: 'plant_machinery',
      purchaseDate: '2024-08-01', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
      disposalDate: '2025-05-31', disposalProceedsMinor: 3_000_000,
    }).run();
    s.income(10_000_000, '2024-09-01');
    s.income(10_000_000, '2025-03-01');
    const y2024 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    // The first basis period is 1 July to 31 December 2024 (184 days): 12.5% of
    // €80,000 for the year of assessment, reduced proportionately (s.284(2)(b)).
    expect(y2024.basis).toMatchObject({ from: '2024-07-01', to: '2024-12-31' });
    expect(y2024.capitalAllowancesMinor).toBe(-multiplyRational(1_000_000, 184, 366));
    // The second year's basis is the 12 months to 30 June 2025, which is not
    // apportioned: the oven was in use at the end of the 2024 basis period, so
    // its 2024 claim counts (s.292) and the 2025 disposal gives a balancing
    // allowance (s.288). Apportioning the accounting period's allowances
    // instead would have counted no claim at all and lost the balancing allowance.
    const y2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    const firstYearClaim = multiplyRational(1_000_000, 184, 366);
    expect(y2025.capitalAllowancesMinor).toBe(-((8_000_000 - firstYearClaim) - 3_000_000));
    expect(y2025.assessableProfitMinor).toBe(20_000_000 + y2025.capitalAllowancesMinor);
    expect(y2025.capitalAllowanceLines.some((l) => l.label.includes('balancing allowances'))).toBe(true);
  });

  it('gives a full year allowance for a 12-month basis period after a short first one', () => {
    const s = setup('sole_trader', '2024-10-01', 6);
    s.db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: s.companyId, name: 'Server', assetCategory: 'computer_equipment',
      purchaseDate: '2024-10-15', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
    }).run();
    s.income(6_000_000, '2024-11-01');
    s.income(6_000_000, '2025-03-01');
    const y2024 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    expect(y2024.capitalAllowancesMinor).toBe(-multiplyRational(1_000_000, 92, 366));
    const y2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    // The basis period (the actual year 2025, as no account of 12 months ends
    // in it) is a year long: a full year's allowance, not a scaled one.
    expect(y2025.capitalAllowancesMinor).toBe(-1_000_000);
  });
});

describe('trading losses (ss.381, 382; issue #285)', () => {
  it('carries a trading loss forward and uses it in a later year (s.382)', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(1_000_000, '2024-06-01');
    expense(s, 6_000_000, '2024-06-02');
    const loss = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    expect(loss.tradingLossMinor).toBe(5_000_000);
    const me = loss.individuals[0]!;
    expect(me.profitMinor).toBe(-5_000_000);
    expect(me.lossCarriedForwardMinor).toBe(5_000_000);
    expect(me.totalMinor).toBe(0);
    s.income(8_000_000, '2025-06-01');
    const y2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    const me25 = y2025.individuals[0]!;
    expect(me25).toMatchObject({ profitMinor: 8_000_000, broughtForwardLossUsedMinor: 5_000_000 });
    // Taxed on the profit after the loss: €30,000, so 20% less the credits.
    expect(me25.incomeTaxMinor).toBe(600_000 - 400_000);
    expect(me25.lossCarriedForwardMinor).toBe(0);
  });

  it('applies a person\'s s.381 claim to the amount they record, and refuses one without an amount', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(1_000_000, '2024-06-01');
    expense(s, 6_000_000, '2024-06-02');
    const loss = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    const pending = loss.decisions.find((d) => d.subjectType === 'income_tax_loss_claim')!;
    expect(pending).toMatchObject({ suggested: 'carry_forward', decided: null, amountMinor: 5_000_000 });
    expect(() => recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'income_tax_loss_claim', subjectId: s.companyId,
      periodEnd: '2024-12-31', choice: 'claim_381', decidedBy: 'Aoife',
    })).toThrow(CtDecisionError);
    recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'income_tax_loss_claim', subjectId: s.companyId,
      periodEnd: '2024-12-31', choice: 'claim_381', decidedBy: 'Aoife', amountMinor: 2_000_000,
    });
    const claimed = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    expect(claimed.individuals[0]!).toMatchObject({ claimedAgainstOtherIncomeMinor: 2_000_000, lossCarriedForwardMinor: 3_000_000 });
    expect(claimed.findings.some((f) => f.includes('other income of the same year'))).toBe(true);
    s.income(4_000_000, '2025-06-01');
    const y2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(y2025.individuals[0]!).toMatchObject({ profitMinor: 4_000_000, broughtForwardLossUsedMinor: 3_000_000 });
  });

  it('treats an allowance-created loss as a trading loss only under the recorded s.392 election, and caps s.381 without it (issue #467)', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(200_000, '2025-06-01');
    s.db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: s.companyId, name: 'Oven', assetCategory: 'plant_machinery',
      purchaseDate: '2025-02-01', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
    }).run();
    // 2025: profit 2,000 less the 10,000 allowance = a loss of 8,000, all of it
    // created by the allowances.
    const c = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(c).toMatchObject({ lossBeforeAllowancesMinor: 0, allowanceLossMinor: 800_000, tradingLossMinor: 800_000 });
    // No election recorded: the allowance part is not a trading loss. The
    // unused allowances are carried forward as allowances (s.304(2)).
    expect(c.individuals[0]!.lossCarriedForwardMinor).toBe(0);
    const pending = c.decisions.find((d) => d.subjectType === 'allowance_loss_election')!;
    expect(pending.amountMinor).toBe(800_000);
    expect(pending.suggested).toBe('elect');
    expect(c.findings.some((f) => f.includes('s.392') && f.includes('s.304(2)'))).toBe(true);

    // An s.381 claim cannot reach the allowance-created part without the
    // election: the recorded claim of 8,000 is capped at the loss before
    // allowances, which is nil here.
    recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'income_tax_loss_claim', subjectId: s.companyId,
      periodEnd: '2025-12-31', choice: 'claim_381', decidedBy: 'Aoife', amountMinor: 800_000,
    });
    const capped = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(capped.individuals[0]!.claimedAgainstOtherIncomeMinor).toBe(0);
    expect(capped.findings.some((f) => f.includes('capped at') && f.includes('before capital allowances'))).toBe(true);

    // Electing under s.392 treats the allowances as a trading loss: the same
    // recorded claim now reaches it.
    recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'allowance_loss_election', subjectId: s.companyId,
      periodEnd: '2025-12-31', choice: 'elect', decidedBy: 'Aoife',
    });
    const elected = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(elected.individuals[0]!).toMatchObject({ claimedAgainstOtherIncomeMinor: 800_000, lossCarriedForwardMinor: 0 });
  });

  it('carries the allowances forward as allowances without the s.392 election, so the next year still gets them (issue #467)', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(200_000, '2025-06-01');
    s.income(3_000_000, '2026-06-01');
    s.db.insert(fixedAssets).values({
      id: ids.fixedAsset(), companyId: s.companyId, name: 'Oven', assetCategory: 'plant_machinery',
      purchaseDate: '2025-02-01', costMinor: 8_000_000, currency: 'EUR',
      baseCostMinor: 8_000_000, baseCurrency: 'EUR',
      capitalAllowanceRateBasisPoints: 1250, capitalAllowanceYears: 8, status: 'active',
    }).run();
    // 2025: profit 2,000 less the 10,000 allowance. No election: 8,000 of
    // allowances are unused, carried forward as allowances — not lost.
    const y2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(y2025.individuals[0]!).toMatchObject({ lossCarriedForwardMinor: 0, allowancesCarriedForwardMinor: 800_000 });
    // 2026: profit 30,000 less that year's 10,000 allowance = 20,000, less the
    // 8,000 carried forward = 12,000 taxed.
    const y2026 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2026 });
    expect(y2026.individuals[0]!).toMatchObject({
      profitMinor: 2_000_000, allowancesBroughtForwardUsedMinor: 800_000, allowancesCarriedForwardMinor: 0,
    });
    const form = y2026.individuals[0]!;
    expect(form.incomeTax[0]!.label).toContain('12000.00');
  });

  it('gives no earned income credit to a sleeping partner, and flags an unrecorded status (issue #493)', () => {
    const s = setup('partnership', '2024-01-01');
    const active = addPartner(s.db, {
      companyId: s.companyId, name: 'Aoife', shareBasisPoints: 5000, joinedOn: '2024-01-01',
      recordedBy: 'Aoife', isPrecedentPartner: true, activityStatus: 'active',
    });
    const sleeping = addPartner(s.db, {
      companyId: s.companyId, name: 'Brian', shareBasisPoints: 5000, joinedOn: '2024-01-01',
      recordedBy: 'Aoife', activityStatus: 'sleeping',
    });
    expect(sleeping.activityStatus).toBe('sleeping');
    s.income(6_000_000, '2025-06-01');
    const c = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    const byName = Object.fromEntries(c.individuals.map((i) => [i.name, i])) as Record<string, IndividualLiability>;
    // Both taxed on a 30,000 share at the same band and personal credit...
    expect(byName.Aoife!.incomeTax.some((l) => l.label.includes('earned income tax credit'))).toBe(true);
    // ...but a sleeping partner's share is not earned income (s.1008(5)): no credit.
    expect(byName.Brian!.incomeTax.some((l) => l.label.includes('earned income tax credit'))).toBe(false);
    expect(byName.Brian!.incomeTaxMinor - byName.Aoife!.incomeTaxMinor).toBe(200_000);
    expect(c.findings.some((f) => f.includes('Brian') && f.includes('s.1008(5)'))).toBe(true);

    // An unrecorded status is flagged, never silently either way.
    setPartnerActivityStatus(s.db, { companyId: s.companyId, partnerId: sleeping.id, activityStatus: 'active', recordedBy: 'Aoife' });
    s.db.update(partners).set({ activityStatus: null }).where(eq(partners.id, active.id)).run();
    const flagged = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(flagged.findings.some((f) => f.includes('Aoife') && f.includes('status is not recorded'))).toBe(true);
    expect(flagged.individuals.find((i) => i.name === 'Aoife')!.incomeTax.some((l) => l.label.includes('earned income tax credit'))).toBe(true);
  });

  it('limits an s.381 claim to the year\'s own loss: losses brought forward stay under s.382', () => {
    const s = setup('sole_trader', '2024-01-01');
    s.income(1_000_000, '2024-06-01');
    expense(s, 6_000_000, '2024-06-02'); // 2024: a loss of 50,000.00
    s.income(1_000_000, '2025-06-01');
    expense(s, 2_000_000, '2025-06-02'); // 2025: a loss of 10,000.00
    recordCtDecision(s.db, {
      companyId: s.companyId, subjectType: 'income_tax_loss_claim', subjectId: s.companyId,
      periodEnd: '2025-12-31', choice: 'claim_381', decidedBy: 'Aoife', amountMinor: 3_000_000,
    });
    const y2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(y2025.individuals[0]!).toMatchObject({
      profitMinor: -1_000_000, claimedAgainstOtherIncomeMinor: 1_000_000, lossCarriedForwardMinor: 5_000_000,
    });
  });

  it('splits a partnership loss by the shares and carries each partner\'s own loss forward (ss.381(2), 382)', () => {
    const s = setup('partnership', '2024-01-01');
    addPartner(s.db, { companyId: s.companyId, name: 'Aoife', shareBasisPoints: 5000, joinedOn: '2024-01-01', recordedBy: 'Aoife', isPrecedentPartner: true });
    addPartner(s.db, { companyId: s.companyId, name: 'Brian', shareBasisPoints: 5000, joinedOn: '2024-01-01', recordedBy: 'Aoife' });
    s.income(1_000_000, '2024-06-01');
    expense(s, 5_000_000, '2024-06-02');
    const c2024 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2024 });
    expect(Object.fromEntries(c2024.individuals.map((i) => [i.name, i.lossCarriedForwardMinor])))
      .toEqual({ Aoife: 2_000_000, Brian: 2_000_000 });
    s.income(6_000_000, '2025-06-01');
    const c2025 = computeIncomeTax(s.db, { companyId: s.companyId, year: 2025 });
    expect(Object.fromEntries(c2025.individuals.map((i) => [i.name, i.broughtForwardLossUsedMinor])))
      .toEqual({ Aoife: 2_000_000, Brian: 2_000_000 });
    expect(c2025.individuals.every((i) => i.incomeTaxMinor === 0)).toBe(true);
  });
});

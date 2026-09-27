import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { seedTestBook, insertTestBankTransaction } from '@/db/testing';
import { journalLines, irishTaxRules, reviewItems, bankTransactions } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { accountBalance } from '../accounting/ledger';
import { systemAccountId } from '../config/setup';
import { loadStatutoryKnowledgeBase } from '../rules/knowledgeBase';
import { setRuleReviewStatus } from '../rules/review';
import { createEmployee, setEmploymentTerms, recordCessation } from './employees';
import { recordRpn } from './rpn';
import {
  createPayRun, postPayRun, reversePayRun, payNetWages, payslipsOfRun, recomputePayRun, setPayslipInputs, getPayRun,
} from './runs';
import { payPayrollLiabilities, reconcilePayroll, monthlyPayrollSummary, yearEndSummary } from './reports';
import { PayrollError } from './figures';

const USC_2026 = [
  { rateBasisPoints: 50, yearlyBandMinor: 1_201_200 },
  { rateBasisPoints: 200, yearlyBandMinor: 1_668_800 },
  { rateBasisPoints: 300, yearlyBandMinor: 4_134_400 },
  { rateBasisPoints: 800, yearlyBandMinor: null },
];

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;

beforeEach(() => {
  ({ db, companyId, bankAccountId } = seedTestBook({ seedYears: [2026] }));
});

const balance = (key: Parameters<typeof systemAccountId>[2], asOf = '2026-12-31') =>
  accountBalance(db, { companyId, accountId: systemAccountId(db, companyId, key), asOf: asOf as never });

function salaried(overrides: Partial<Parameters<typeof createEmployee>[1]> = {}) {
  const e = createEmployee(db, {
    companyId, recordedBy: 'owner', firstName: 'Aoife', lastName: 'Byrne', ppsn: '1234567T',
    employerReference: 'E001', startDate: '2025-06-01', payFrequency: 'monthly', ...overrides,
  });
  setEmploymentTerms(db, { companyId, employeeId: e.id, effectiveFrom: e.startDate, recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 4_800_000 });
  return e;
}

function rpnFor(employeeId: string, extra: Partial<Parameters<typeof recordRpn>[1]> = {}) {
  return recordRpn(db, {
    companyId, employeeId, recordedBy: 'owner', rpnNumber: '1', taxYear: 2026, effectiveFrom: '2026-01-01',
    taxBasis: 'cumulative', yearlyTaxCreditsMinor: 400_000, yearlySrcopMinor: 4_400_000,
    uscStatus: 'ordinary', uscBasis: 'cumulative', uscBands: USC_2026, ...extra,
  });
}

const month = (payDate: string, weeks = 4) =>
  createPayRun(db, { companyId, payFrequency: 'monthly', payDate, insurableWeeks: weeks, createdBy: 'owner' });

describe('a monthly pay run on the cumulative basis (issues #526, #527)', () => {
  it('computes PAYE, USC, PRSI and net pay from the RPN and the 2026 rules', () => {
    const e = salaried();
    rpnFor(e.id);
    const [slip] = payslipsOfRun(db, month('2026-01-30').id);
    expect(slip).toMatchObject({
      taxBasis: 'cumulative', uscBasis: 'cumulative', grossPayMinor: 400_000, payForTaxMinor: 400_000,
      taxMinor: 53_333, uscMinor: 8_107,
      // €4,000 over 4 weeks is €1,000 a week: full employee rate 4.2%; employer 10.25% (over €552) and NTF 1%.
      prsiEmployeeMinor: 16_800, prsiEmployerMinor: 41_000, ntfLevyMinor: 4_000,
      netPayMinor: 400_000 - 53_333 - 8_107 - 16_800,
    });
    expect(slip!.lines).toHaveLength(1);
    expect(slip!.ruleFigures.map((f) => f.ruleKey)).toContain('prsi.class_a_employee_rate');
  });

  it('carries the cumulative figures into month 2, and pays a year\'s salary exactly', () => {
    const e = salaried();
    rpnFor(e.id);
    postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    const [feb] = payslipsOfRun(db, month('2026-02-27').id);
    // Cumulative tax to month 2 is €1,066.67; €533.33 was deducted in month 1.
    expect([feb!.cumulativePayForTaxMinor, feb!.cumulativeTaxMinor, feb!.taxMinor]).toEqual([800_000, 106_667, 53_334]);
  });

  it('posts a balanced payroll journal to the payroll accounts', () => {
    const e = salaried();
    rpnFor(e.id);
    const run = postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    expect(run.status).toBe('posted');
    const lines = db.select().from(journalLines).where(eq(journalLines.journalEntryId, run.journalEntryId!)).all();
    const dr = lines.reduce((s, l) => s + l.baseDebitMinor, 0);
    const cr = lines.reduce((s, l) => s + l.baseCreditMinor, 0);
    expect(dr).toBe(cr);
    expect([balance('wages_expense'), balance('employer_prsi_expense')]).toEqual([400_000, 45_000]);
    expect([balance('paye_payable'), balance('usc_payable'), balance('prsi_payable'), balance('net_wages_payable')])
      .toEqual([53_333, 8_107, 61_800, 321_760]);
  });

  it('ends with every payroll control account at zero once net pay and Revenue are paid', () => {
    const e = salaried();
    rpnFor(e.id);
    const run = postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    const wages = insertTestBankTransaction(db, { companyId, bankAccountId, amountMinor: -321_760, transactionDate: '2026-01-30' });
    payNetWages(db, { companyId, runId: run.id, bankTransactionId: wages, paidBy: 'owner' });
    expect(db.select().from(bankTransactions).where(eq(bankTransactions.id, wages)).get()!.status).toBe('posted');
    expect(monthlyPayrollSummary(db, companyId, '2026-01').totals.dueToRevenueMinor).toBe(123_240);
    payPayrollLiabilities(db, { companyId, month: '2026-01', date: '2026-02-23', paidBy: 'owner' });
    expect(['paye_payable', 'usc_payable', 'prsi_payable', 'net_wages_payable'].map((k) => balance(k as never))).toEqual([0, 0, 0, 0]);
    const rec = reconcilePayroll(db, { companyId, asOf: '2026-02-28' });
    expect(rec.accounts.every((a) => !a.differenceMinor)).toBe(true);
    expect([rec.unpaidNetPay, rec.unremittedMonths, rec.cumulativeMismatches]).toEqual([[], [], []]);
  });

  it('refuses a bank line that does not match the net pay, and a second remittance', () => {
    const e = salaried();
    rpnFor(e.id);
    const run = postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    const wrong = insertTestBankTransaction(db, { companyId, bankAccountId, amountMinor: -300_000, transactionDate: '2026-01-30' });
    expect(() => payNetWages(db, { companyId, runId: run.id, bankTransactionId: wrong, paidBy: 'owner' })).toThrow(/must match exactly/);
    payPayrollLiabilities(db, { companyId, month: '2026-01', date: '2026-02-23', paidBy: 'owner' });
    expect(() => payPayrollLiabilities(db, { companyId, month: '2026-01', date: '2026-02-24', paidBy: 'owner' })).toThrow(/already paid/);
  });

  it('reports what reaches a payroll account outside payroll as a difference, and adjusts nothing', () => {
    const e = salaried();
    rpnFor(e.id);
    postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    const rec = reconcilePayroll(db, { companyId, asOf: '2026-01-31' });
    expect(rec.unpaidNetPay).toHaveLength(1);
    expect(rec.unremittedMonths).toEqual([{ month: '2026-01', dueMinor: 123_240 }]);
    expect(rec.accounts.find((a) => a.key === 'paye_payable')).toMatchObject({ ledgerMinor: 53_333, expectedMinor: 53_333, differenceMinor: 0 });
    expect(db.select().from(reviewItems).where(eq(reviewItems.kind, 'reconciliation_difference')).all()).toHaveLength(0);
  });
});

describe('the pay run lifecycle (issue #527)', () => {
  it('refuses to post a draft whose figures changed since it was computed, until it is recomputed', () => {
    const e = salaried();
    const run = month('2026-01-30');
    expect(payslipsOfRun(db, run.id)[0]!.taxBasis).toBe('emergency_initial');
    rpnFor(e.id);
    expect(() => postPayRun(db, { companyId, runId: run.id, postedBy: 'owner' })).toThrow(/out of date/);
    recomputePayRun(db, { companyId, runId: run.id });
    expect(postPayRun(db, { companyId, runId: run.id, postedBy: 'owner' }).status).toBe('posted');
  });

  it('posts runs in pay date order and reverses them latest first', () => {
    const e = salaried();
    rpnFor(e.id);
    const feb = month('2026-02-27');
    const jan = month('2026-01-30');
    postPayRun(db, { companyId, runId: feb.id, postedBy: 'owner' });
    expect(() => postPayRun(db, { companyId, runId: jan.id, postedBy: 'owner' })).toThrow(/pay date order/);
    expect(() => reversePayRun(db, { companyId, runId: feb.id, reason: '', reversedBy: 'owner' })).toThrow(/reason/);
    reversePayRun(db, { companyId, runId: feb.id, reason: 'Run in the wrong order', reversedBy: 'owner' });
    expect(balance('net_wages_payable')).toBe(0);
    recomputePayRun(db, { companyId, runId: jan.id });
    postPayRun(db, { companyId, runId: jan.id, postedBy: 'owner' });
    const feb2 = month('2026-02-27');
    postPayRun(db, { companyId, runId: feb2.id, postedBy: 'owner' });
    expect(() => reversePayRun(db, { companyId, runId: jan.id, reason: 'x', reversedBy: 'owner' })).toThrow(/Reverse that one first/);
    // The reversed February run is not in February's second computation.
    expect(payslipsOfRun(db, feb2.id)[0]!.cumulativePayForTaxMinor).toBe(800_000);
  });

  it('never changes a posted run', () => {
    const e = salaried();
    rpnFor(e.id);
    const run = postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    expect(() => setPayslipInputs(db, { companyId, runId: run.id, employeeId: e.id, inputs: {} })).toThrow(/never changed/);
    expect(() => recomputePayRun(db, { companyId, runId: run.id })).toThrow(PayrollError);
  });

  it('refuses to reverse a run whose net pay has been paid', () => {
    const e = salaried();
    rpnFor(e.id);
    const run = postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    payNetWages(db, { companyId, runId: run.id, date: '2026-01-30', paidBy: 'owner' });
    expect(() => reversePayRun(db, { companyId, runId: run.id, reason: 'x', reversedBy: 'owner' })).toThrow(/already been paid/);
    expect(getPayRun(db, companyId, run.id).status).toBe('posted');
  });

  it('posts a director\'s pay to directors\' remuneration', () => {
    const e = salaried({ isDirector: true });
    rpnFor(e.id);
    postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    expect([balance('directors_remuneration'), balance('wages_expense')]).toEqual([400_000, 0]);
  });
});

describe('pay elements (issue #525)', () => {
  function hourly() {
    const e = createEmployee(db, {
      companyId, recordedBy: 'owner', firstName: 'Seán', lastName: 'Ó Briain', ppsn: '1234567TW',
      employerReference: 'E002', startDate: '2026-01-01', payFrequency: 'weekly',
    });
    setEmploymentTerms(db, { companyId, employeeId: e.id, effectiveFrom: '2026-01-01', recordedBy: 'owner', payBasis: 'hourly', hourlyRateMinor: 1_600 });
    rpnFor(e.id, { yearlyTaxCreditsMinor: 400_000 });
    return e;
  }

  it('pays hours × rate, overtime × multiplier, and a bonus; taxes a benefit without paying it', () => {
    const e = hourly();
    const run = createPayRun(db, {
      companyId, payFrequency: 'weekly', payDate: '2026-01-09', createdBy: 'owner',
      inputs: { [e.id]: {
        hoursHundredths: 3_900,
        overtime: [{ hoursHundredths: 250, multiplierBasisPoints: 15_000 }],
        bonuses: [{ kind: 'bonus', amountMinor: 5_000 }],
        benefits: [{ category: 'other', amountMinor: 2_000, description: 'Gym membership' }],
      } },
    });
    const [slip] = payslipsOfRun(db, run.id);
    // 39 × €16 = €624; 2.5 × €16 × 1.5 = €60; bonus €50: gross €734. Benefit €20: notional.
    expect(slip!.lines.map((l) => [l.kind, l.amountMinor])).toEqual([['hourly', 62_400], ['overtime', 6_000], ['bonus', 5_000], ['benefit_in_kind', 2_000]]);
    expect([slip!.grossPayMinor, slip!.notionalPayMinor, slip!.payForTaxMinor, slip!.reckonableEarningsMinor]).toEqual([73_400, 2_000, 75_400, 75_400]);
    expect(slip!.netPayMinor).toBe(73_400 - slip!.taxMinor - slip!.uscMinor - slip!.prsiEmployeeMinor);
    const posted = postPayRun(db, { companyId, runId: run.id, postedBy: 'owner' });
    // The benefit is never cash: wages are the gross cash pay only.
    expect(balance('wages_expense')).toBe(73_400);
    expect(balance('net_wages_payable')).toBe(slip!.netPayMinor);
    expect(posted.periodNumber).toBe(2);
  });

  it('refuses overtime without a multiplier: no premium is assumed', () => {
    const e = hourly();
    expect(() => createPayRun(db, {
      companyId, payFrequency: 'weekly', payDate: '2026-01-09', createdBy: 'owner',
      inputs: { [e.id]: { overtime: [{ hoursHundredths: 100, multiplierBasisPoints: 0 }] } },
    })).toThrow(/multiplier/);
  });

  it('deducts an employee pension from pay for tax only, and posts the employer\'s as a cost', () => {
    const e = salaried();
    setEmploymentTerms(db, {
      companyId, employeeId: e.id, effectiveFrom: '2026-01-01', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 4_800_000,
      pensionScheme: 'occupational', pensionEmployeeBasisPoints: 500, pensionEmployerBasisPoints: 500,
    });
    rpnFor(e.id);
    const run = month('2026-01-30');
    const [slip] = payslipsOfRun(db, run.id);
    expect([slip!.pensionEmployeeMinor, slip!.payForTaxMinor, slip!.payForUscMinor, slip!.reckonableEarningsMinor])
      .toEqual([20_000, 380_000, 400_000, 400_000]);
    postPayRun(db, { companyId, runId: run.id, postedBy: 'owner' });
    expect([balance('pension_payable'), balance('employer_pension_expense')]).toEqual([40_000, 20_000]);
  });
});

describe('the emergency basis (S.I. 345/2018 reg.19; S.I. 510/2018 reg.19)', () => {
  it('taxes an employee without a PPSN at 40% and charges USC at 8%', () => {
    const e = createEmployee(db, {
      companyId, recordedBy: 'owner', firstName: 'No', lastName: 'Number', employerReference: 'E009', startDate: '2026-01-01',
      payFrequency: 'monthly', address: 'Main Street, Ennis', dateOfBirth: '1990-05-01',
    });
    setEmploymentTerms(db, { companyId, employeeId: e.id, effectiveFrom: '2026-01-01', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 2_400_000 });
    const [slip] = payslipsOfRun(db, month('2026-01-30').id);
    expect([slip!.taxBasis, slip!.taxMinor, slip!.uscBasis, slip!.uscMinor]).toEqual(['emergency_no_ppsn', 80_000, 'emergency', 16_000]);
  });

  it('gives a PPSN holder a single person\'s monthly cut-off for the first month, then 40%, then refunds on the RPN', () => {
    const e = salaried({ startDate: '2026-01-01' });
    // First month: cut-off €44,000 ÷ 12 = €3,666.67, no credits: €733.33 + €133.33.
    const jan = postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    expect(payslipsOfRun(db, jan.id)[0]).toMatchObject({ taxBasis: 'emergency_initial', taxMinor: 86_666 });
    // 27 February is still within one month of the first payment on 30 January (reg.19(3)(a)); 28 February is not.
    expect(payslipsOfRun(db, month('2026-02-27').id)[0]!.taxBasis).toBe('emergency_initial');
    const feb = postPayRun(db, { companyId, runId: month('2026-02-28').id, postedBy: 'owner' });
    expect(payslipsOfRun(db, feb.id)[0]).toMatchObject({ taxBasis: 'emergency_higher', taxMinor: 160_000 });
    rpnFor(e.id);
    const [mar] = payslipsOfRun(db, month('2026-03-31').id);
    // Cumulative to month 3: €12,000 pay; cut-off €11,000; credits €1,000: €2,200 + €400 − €1,000 = €1,600,
    // less €2,466.66 deducted on the emergency basis: a refund of €866.66 (reg.19(4)).
    expect([mar!.taxBasis, mar!.cumulativeTaxMinor, mar!.taxMinor]).toEqual(['cumulative', 160_000, -86_666]);
  });
});

describe('what the engine refuses to guess', () => {
  it('stops a payslip whose PRSI rate a person rejected on the rule review screen', () => {
    const e = salaried();
    rpnFor(e.id);
    loadStatutoryKnowledgeBase(db, { companyId });
    const rule = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'prsi.class_a_employee_rate'), eq(irishTaxRules.effectiveFrom, '2025-10-01'))).get()!;
    setRuleReviewStatus(db, { ruleId: rule.id, status: 'rejected', reviewedBy: 'accountant' });
    expect(() => month('2026-01-30')).toThrow(/rejected on the rule review screen/);
  });

  it('refuses a PRSI class it does not compute', () => {
    const e = salaried({ prsiClass: 'S' });
    rpnFor(e.id);
    expect(() => month('2026-01-30')).toThrow(/Only Class A/);
  });

  it('refuses a monthly run without its insurable weeks', () => {
    salaried();
    expect(() => createPayRun(db, { companyId, payFrequency: 'monthly', payDate: '2026-01-30', createdBy: 'owner' })).toThrow(/insurable weeks/);
  });

  it('refuses new terms dated on or before a posted payslip', () => {
    const e = salaried();
    rpnFor(e.id);
    postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    expect(() => setEmploymentTerms(db, {
      companyId, employeeId: e.id, effectiveFrom: '2026-01-15', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 5_000_000,
    })).toThrow(/posted payslip/);
  });

  it('leaves a ceased employee off later runs', () => {
    const a = salaried();
    rpnFor(a.id);
    const b = salaried({ firstName: 'Brian', employerReference: 'E003' });
    rpnFor(b.id);
    recordCessation(db, { companyId, employeeId: b.id, leftOn: '2026-01-15', recordedBy: 'owner' });
    expect(payslipsOfRun(db, month('2026-02-27').id).map((p) => p.employeeId)).toEqual([a.id]);
  });
});

describe('the year-end summary (issue #527)', () => {
  it('totals each employee\'s posted payslips for the year', () => {
    const e = salaried();
    rpnFor(e.id);
    postPayRun(db, { companyId, runId: month('2026-01-30').id, postedBy: 'owner' });
    postPayRun(db, { companyId, runId: month('2026-02-27').id, postedBy: 'owner' });
    const [row] = yearEndSummary(db, companyId, 2026);
    expect(row).toMatchObject({ employeeId: e.id, insurableWeeks: 8 });
    expect([row!.totals.payForTaxMinor, row!.totals.taxMinor, row!.totals.payslips]).toEqual([800_000, 106_667, 2]);
  });
});

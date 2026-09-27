import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { seedTestBook } from '@/db/testing';
import { employmentTerms } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { createEmployee, recordPpsn, setEmploymentTerms, termsOn } from './employees';
import { recordRpn, rpnOn } from './rpn';
import { createPayRun, payslipsOfRun } from './runs';

let db: AppDatabase;
let companyId: string;
beforeEach(() => { ({ db, companyId } = seedTestBook({ seedYears: [2026] })); });

const base = { recordedBy: 'owner', firstName: 'Niamh', lastName: 'Walsh', employerReference: 'E1', startDate: '2026-01-01', payFrequency: 'weekly' as const };

describe('employee records (issue #524)', () => {
  it('refuses a PPSN that fails its check character, and a duplicate employer reference', () => {
    expect(() => createEmployee(db, { companyId, ...base, ppsn: '1234567A' })).toThrow(/check character/);
    createEmployee(db, { companyId, ...base, ppsn: '1234567T' });
    expect(() => createEmployee(db, { companyId, ...base, ppsn: '1234567TW' })).toThrow(/already used/);
  });

  it('requires the address and date of birth when there is no PPSN (reg.17(2)(a)), and records a PPSN given later', () => {
    expect(() => createEmployee(db, { companyId, ...base })).toThrow(/address and date of birth/);
    const e = createEmployee(db, { companyId, ...base, address: 'Galway', dateOfBirth: '1995-02-02' });
    expect(recordPpsn(db, { companyId, employeeId: e.id, ppsn: '1234567t', recordedBy: 'owner' }).ppsn).toBe('1234567T');
    expect(() => recordPpsn(db, { companyId, employeeId: e.id, ppsn: '1234567TW', recordedBy: 'owner' })).toThrow(/already has/);
  });

  it('supersedes employment terms from a date, closing the earlier row rather than editing it', () => {
    const e = createEmployee(db, { companyId, ...base, ppsn: '1234567T' });
    const first = setEmploymentTerms(db, { companyId, employeeId: e.id, effectiveFrom: '2026-01-01', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 3_000_000 });
    setEmploymentTerms(db, { companyId, employeeId: e.id, effectiveFrom: '2026-07-01', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 3_300_000 });
    expect(db.select().from(employmentTerms).where(eq(employmentTerms.id, first.id)).get()!.effectiveTo).toBe('2026-07-01');
    expect([termsOn(db, e.id, '2026-06-30')!.annualSalaryMinor, termsOn(db, e.id, '2026-07-01')!.annualSalaryMinor]).toEqual([3_000_000, 3_300_000]);
    expect(() => setEmploymentTerms(db, { companyId, employeeId: e.id, effectiveFrom: '2026-03-01', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 1 }))
      .toThrow(/later date/);
    expect(() => setEmploymentTerms(db, { companyId, employeeId: e.id, effectiveFrom: '2026-08-01', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 1, pensionEmployeeBasisPoints: 500 }))
      .toThrow(/need a scheme/);
  });
});

describe('RPNs (issue #526)', () => {
  it('uses the latest RPN from on or before the pay date, and never lets one reach back behind a later one', () => {
    const e = createEmployee(db, { companyId, ...base, ppsn: '1234567T' });
    const rpn = (n: string, from: string) => recordRpn(db, {
      companyId, employeeId: e.id, recordedBy: 'owner', rpnNumber: n, taxYear: 2026, effectiveFrom: from, taxBasis: 'cumulative',
      yearlyTaxCreditsMinor: 400_000, yearlySrcopMinor: 4_400_000, uscStatus: 'exempt', uscBasis: 'cumulative', uscBands: [],
    });
    const one = rpn('1', '2026-01-01');
    const two = rpn('2', '2026-03-01');
    expect(two.supersedesRpnId).toBe(one.id);
    expect([rpnOn(db, e.id, '2026-02-28')!.rpnNumber, rpnOn(db, e.id, '2026-03-01')!.rpnNumber]).toEqual(['1', '2']);
    expect(() => rpn('3', '2026-02-01')).toThrow(/never reaches back/);
    expect(() => rpn('4', '2025-12-01')).toThrow(/one tax year/);
  });

  it('taxes a weekly payment on 31 December on a week 1 basis (reg.15) and deducts no USC for an exempt RPN', () => {
    const e = createEmployee(db, { companyId, ...base, ppsn: '1234567T' });
    setEmploymentTerms(db, { companyId, employeeId: e.id, effectiveFrom: '2026-01-01', recordedBy: 'owner', payBasis: 'salary', annualSalaryMinor: 2_600_000 });
    recordRpn(db, {
      companyId, employeeId: e.id, recordedBy: 'owner', rpnNumber: '1', taxYear: 2026, effectiveFrom: '2026-01-01', taxBasis: 'cumulative',
      yearlyTaxCreditsMinor: 400_000, yearlySrcopMinor: 4_400_000, uscStatus: 'exempt', uscBasis: 'cumulative', uscBands: [],
    });
    const [slip] = payslipsOfRun(db, createPayRun(db, { companyId, payFrequency: 'weekly', payDate: '2026-12-31', createdBy: 'owner' }).id);
    // Week 53: one more €500; cut-off €846.15 and credits €76.92 for one week: €100 − €76.92 = €23.08.
    expect([slip!.periodNumber, slip!.taxBasis, slip!.grossPayMinor, slip!.taxMinor, slip!.uscBasis, slip!.uscMinor])
      .toEqual([53, 'week1', 50_000, 2_308, 'exempt', 0]);
    expect(slip!.findings.join(' ')).toMatch(/beyond the 52 periods/);
  });
});

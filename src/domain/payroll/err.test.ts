import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { seedTestBook } from '@/db/testing';
import { companyOfficers, expenseClaimLines, expenseRates, reviewItems, reportableBenefits } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { ids } from '@/lib/ids';
import { asIsoDate } from '../dates';
import { createExpenseClaim, approveExpenseClaim, reimburseExpenseClaim } from '../expenses/claims';
import { createEmployee } from './employees';
import {
  recordSmallBenefit, recordRemoteWorkingAllowance, recordTravelSubsistence, reportExpenseClaim,
  correctReportableBenefit, markBenefitsSubmitted, errParticulars, reconcileErr,
} from './err';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let officerId: string;
let employeeId: string;

beforeEach(() => {
  const book = seedTestBook({ seedYears: [2025, 2026] });
  ({ db, companyId } = book);
  byCode = book.accountsByCode;
  officerId = ids.officer();
  db.insert(companyOfficers).values({ id: officerId, companyId, name: 'Mary Byrne', role: 'director' }).run();
  employeeId = createEmployee(db, {
    companyId, recordedBy: 'owner', firstName: 'Mary', lastName: 'Byrne', ppsn: '1234567T', employerReference: 'D01',
    startDate: '2024-01-01', payFrequency: 'monthly', isDirector: true, officerId,
  }).id;
});

const small = (providedOn: string, amountMinor: number) =>
  recordSmallBenefit(db, { companyId, employeeId, providedOn, amountMinor, description: 'Voucher', recordedBy: 'owner' });

function reimbursedClaim(lines: Parameters<typeof createExpenseClaim>[1]['lines']) {
  const claim = createExpenseClaim(db, { companyId, claimant: { officerId }, title: 'Site visits', lines });
  approveExpenseClaim(db, { companyId, claimId: claim.claimId });
  reimburseExpenseClaim(db, { companyId, claimId: claim.claimId, date: asIsoDate('2025-06-02') });
  return claim.claimId;
}

const mileageRate = () => db.select().from(expenseRates)
  .where(and(eq(expenseRates.companyId, companyId), eq(expenseRates.code, 'car_upto_1200cc_band1'))).get()!.id;

describe('small benefits (TCA s.112B, FA 2024 s.8)', () => {
  it('accepts five incentives within €1,500 a year and refuses a sixth', () => {
    for (const d of ['2025-01-10', '2025-03-10', '2025-05-10', '2025-07-10', '2025-09-10']) small(d, 20_000);
    expect(() => small('2025-12-10', 10_000)).toThrow(/incentive number 6.*taxable in full/);
  });

  it('refuses the benefit that takes the year over €1,500, in full rather than the excess (TDM 38-03-33 example 5)', () => {
    small('2025-03-15', 20_000);
    small('2025-06-20', 75_000);
    expect(() => small('2025-12-20', 75_000)).toThrow(/1700\.00, over the 1500\.00 limit/);
    // A new year starts again.
    expect(small('2026-01-05', 150_000).amountMinor).toBe(150_000);
  });

  it('tests incentives in date order and has no rule to apply before 2025', () => {
    small('2025-06-01', 10_000);
    expect(() => small('2025-02-01', 10_000)).toThrow(/date order/);
    expect(() => small('2024-12-01', 10_000)).toThrow(/does not cover 2024-12-01/);
  });
});

describe('the remote working daily allowance (TDM 38-03-33 §4.1)', () => {
  it('records up to €3.20 a day with the days, and refuses more', () => {
    const b = recordRemoteWorkingAllowance(db, { companyId, employeeId, paidOn: '2025-05-25', daysHundredths: 1_000, amountMinor: 3_200, recordedBy: 'owner' });
    expect([b.category, b.daysHundredths]).toEqual(['remote_working_daily_allowance', 1_000]);
    expect(() => recordRemoteWorkingAllowance(db, { companyId, employeeId, paidOn: '2025-06-05', daysHundredths: 1_000, amountMinor: 5_000, recordedBy: 'owner' }))
      .toThrow(/at most 32\.00.*excess through payroll/);
  });
});

describe('travel and subsistence from an expense claim (S.I. 1/2024)', () => {
  it('classifies mileage as unvouched travel and reports the business share on the reimbursement date', () => {
    const claimId = reimbursedClaim([
      { lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'Cork site visit', accountId: byCode['6110']!, rateId: mileageRate(), units: 1500, businessUseBasisPoints: 8_000 },
      { lineType: 'receipt', date: asIsoDate('2025-05-14'), description: 'Stationery', accountId: byCode['6120']!, amountMinor: 1_000 },
    ]);
    const [b, ...rest] = reportExpenseClaim(db, { companyId, claimId, recordedBy: 'owner' });
    expect(rest).toHaveLength(0);
    // 1,500 km at 41.80c = €627.00, 80% business: €501.60. The stationery receipt is not travel or subsistence.
    expect([b!.employeeId, b!.subcategory, b!.amountMinor, b!.providedOn]).toEqual([employeeId, 'travel_unvouched', 50_160, '2025-06-02']);
    expect(() => reportExpenseClaim(db, { companyId, claimId, recordedBy: 'owner' })).toThrow(/already prepared/);
  });

  it('leaves a travel line without a receipt for the person to classify', () => {
    const claimId = reimbursedClaim([{ lineType: 'travel', date: asIsoDate('2025-05-05'), description: 'Taxi', amountMinor: 2_500, accountId: byCode['6110']! }]);
    expect(() => reportExpenseClaim(db, { companyId, claimId, recordedBy: 'owner' })).toThrow(/Classify it/);
    const lineId = db.select().from(expenseClaimLines).where(eq(expenseClaimLines.claimId, claimId)).get()!.id;
    const [b] = reportExpenseClaim(db, { companyId, claimId, recordedBy: 'owner', classifications: { [lineId]: 'travel_unvouched' } });
    expect(b!.subcategory).toBe('travel_unvouched');
  });

  it('refuses a claim whose claimant is not a payroll employee', () => {
    const other = ids.officer();
    db.insert(companyOfficers).values({ id: other, companyId, name: 'Seán Kelly', role: 'director' }).run();
    const claim = createExpenseClaim(db, { companyId, claimant: { officerId: other }, title: 'Trip', lines: [
      { lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'Visit', accountId: byCode['6110']!, rateId: mileageRate(), units: 100 },
    ] });
    approveExpenseClaim(db, { companyId, claimId: claim.claimId });
    reimburseExpenseClaim(db, { companyId, claimId: claim.claimId, date: asIsoDate('2025-06-02') });
    expect(() => reportExpenseClaim(db, { companyId, claimId: claim.claimId, recordedBy: 'owner' })).toThrow(/not linked to a payroll employee/);
  });
});

describe('preparation, correction and reconciliation (issue #533)', () => {
  it('lists the reg.10A particulars, and records the ROS submission against the row submitted', () => {
    const b = recordTravelSubsistence(db, { companyId, employeeId, paidOn: '2025-04-01', subcategory: 'eating_on_site', amountMinor: 1_500, description: 'Site lunch', recordedBy: 'owner' });
    expect(errParticulars(db, companyId, { from: '2025-01-01', to: '2025-12-31' })).toEqual([expect.objectContaining({
      benefitId: b.id, name: 'Mary Byrne', ppsn: '1234567T', address: null, employerReference: 'D01',
      amountMinor: 1_500, category: 'travel_and_subsistence', subcategory: 'eating_on_site', status: 'prepared',
    })]);
    const [done] = markBenefitsSubmitted(db, { companyId, benefitIds: [b.id], submittedOn: '2025-04-01', reference: 'ROS-1', submittedBy: 'owner' });
    expect(done).toMatchObject({ status: 'submitted', submissionReference: 'ROS-1' });
    expect(() => markBenefitsSubmitted(db, { companyId, benefitIds: [b.id], submittedOn: '2025-04-02', reference: 'x', submittedBy: 'owner' })).toThrow(/only a prepared/);
  });

  it('corrects by superseding, never editing, and the correction must be submitted in turn', () => {
    const b = recordTravelSubsistence(db, { companyId, employeeId, paidOn: '2025-04-01', subcategory: 'travel_vouched', amountMinor: 1_500, description: 'Train', recordedBy: 'owner' });
    const c = correctReportableBenefit(db, { companyId, benefitId: b.id, amountMinor: 1_200, reason: 'Fare was €12', recordedBy: 'owner' });
    expect(db.select().from(reportableBenefits).where(eq(reportableBenefits.id, b.id)).get()!).toMatchObject({ status: 'superseded', amountMinor: 1_500 });
    expect(c).toMatchObject({ status: 'prepared', amountMinor: 1_200, supersedesId: b.id });
    expect(errParticulars(db, companyId, { from: '2025-01-01', to: '2025-12-31' }).map((p) => p.benefitId)).toEqual([c.id]);
  });

  it('flags a reimbursed claim not reported, a benefit not submitted, and a late submission', () => {
    const claimId = reimbursedClaim([{ lineType: 'mileage', date: asIsoDate('2025-05-14'), description: 'Visit', accountId: byCode['6110']!, rateId: mileageRate(), units: 100 }]);
    const late = recordTravelSubsistence(db, { companyId, employeeId, paidOn: '2025-04-01', subcategory: 'emergency_travel', amountMinor: 900, description: 'Call-out', recordedBy: 'owner' });
    markBenefitsSubmitted(db, { companyId, benefitIds: [late.id], submittedOn: '2025-04-03', reference: 'ROS-2', submittedBy: 'owner' });
    let rec = reconcileErr(db, { companyId, asOf: '2025-06-30' });
    expect(rec.claims).toEqual([expect.objectContaining({ claimId, reportableMinor: 4_180, preparedMinor: 0 })]);
    expect(rec.late).toEqual([{ benefitId: late.id, providedOn: '2025-04-01', submittedOn: '2025-04-03' }]);
    expect(db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `err_claim:${claimId}`)).get()).toBeTruthy();
    const [prepared] = reportExpenseClaim(db, { companyId, claimId, recordedBy: 'owner' });
    rec = reconcileErr(db, { companyId, asOf: '2025-06-30' });
    expect(rec.claims).toEqual([]);
    expect(rec.unsubmitted).toEqual([{ benefitId: prepared!.id, providedOn: '2025-06-02', amountMinor: 4_180 }]);
  });
});

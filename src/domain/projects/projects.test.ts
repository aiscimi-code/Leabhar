import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { journalLines } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { createCompany } from '../config/setup';
import { postJournalEntry, reverseJournalEntry } from '../accounting/journal';
import { asIsoDate } from '../dates';
import { createProject, setProjectStatus } from '../construction/projects';
import {
  createJob, allocateToProject, removeProjectAllocation, setProjectBudget, budgetOn, setOverheadRate, projectResult,
  projectProfitability, workInProgress,
} from '.';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let bank: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Obair Ltd', seedYears: [2026] });
  ({ companyId } = created);
  byCode = created.accountsByCode;
  bank = created.accountsByKey['bank_control']!;
});

function post(code: string, amount: number, date = '2026-03-01', income = false) {
  const entry = postJournalEntry(db, {
    companyId, entryDate: asIsoDate(date), narrative: code, sourceType: 'manual_adjustment', baseCurrency: 'EUR',
    lines: income
      ? [{ accountId: bank, debitMinor: amount }, { accountId: byCode[code]!, creditMinor: amount }]
      : [{ accountId: byCode[code]!, debitMinor: amount }, { accountId: bank, creditMinor: amount }],
  });
  return { entryId: entry.id, lineId: db.select().from(journalLines).where(eq(journalLines.journalEntryId, entry.id)).all().find((l) => l.accountId === byCode[code])!.id };
}

describe('project income and costs (issue #550)', () => {
  it('allocates lines by category, never over 100%, with jobs and budget revisions', () => {
    const project = createProject(db, { companyId, code: 'P1', name: 'Fit-out', startsOn: '2026-01-01', recordedBy: 'o' });
    const kitchen = createJob(db, { companyId, projectId: project.id, code: 'K', name: 'Kitchen', recordedBy: 'o' });
    const fees = post('4020', 5_000_000, '2026-03-01', true);
    const subbie = post('5010', 2_000_000);
    const wages = post('5000', 1_000_000);
    allocateToProject(db, { companyId, journalLineId: fees.lineId, projectId: project.id, jobId: kitchen.id, category: 'income', basisPoints: 10_000, recordedBy: 'o' });
    allocateToProject(db, { companyId, journalLineId: subbie.lineId, projectId: project.id, jobId: kitchen.id, category: 'contractors', basisPoints: 10_000, recordedBy: 'o' });
    const half = allocateToProject(db, { companyId, journalLineId: wages.lineId, projectId: project.id, category: 'labour', basisPoints: 5_000, recordedBy: 'o' });
    expect(() => allocateToProject(db, { companyId, journalLineId: wages.lineId, projectId: project.id, category: 'labour', basisPoints: 5_001, recordedBy: 'o' }))
      .toThrow(/50\.00% is left/);
    expect(() => allocateToProject(db, { companyId, journalLineId: fees.lineId, projectId: project.id, category: 'materials', basisPoints: 1, recordedBy: 'o' }))
      .toThrow(/project cost is an expense line/);

    const r = projectResult(db, { companyId, projectId: project.id, to: '2026-12-31' });
    expect(r.actual).toMatchObject({ income: 5_000_000, contractors: 2_000_000, labour: 500_000 });
    expect([r.directCostsMinor, r.grossMarginMinor, r.netMarginMinor, r.marginBasisPoints]).toEqual([2_500_000, 2_500_000, 2_500_000, 5000]);
    expect(r.jobs[0]).toMatchObject({ grossMarginMinor: 3_000_000 });

    setProjectBudget(db, { companyId, projectId: project.id, category: 'income', amountMinor: 6_000_000, effectiveFrom: '2026-01-01', recordedBy: 'o' });
    setProjectBudget(db, { companyId, projectId: project.id, category: 'income', amountMinor: 7_000_000, effectiveFrom: '2026-06-01', note: 'Variation', recordedBy: 'o' });
    expect([budgetOn(db, project.id, '2026-03-31').income, budgetOn(db, project.id, '2026-12-31').income]).toEqual([6_000_000, 7_000_000]);

    removeProjectAllocation(db, { companyId, allocationId: half.id, reason: 'Wrong project', actor: 'o' });
    expect(projectResult(db, { companyId, projectId: project.id, to: '2026-12-31' }).actual.labour).toBe(0);
  });

  it('a reversed cost leaves the project where it was', () => {
    const project = createProject(db, { companyId, code: 'P1', name: 'Fit-out', startsOn: '2026-01-01', recordedBy: 'o' });
    const cost = post('5020', 300_000);
    allocateToProject(db, { companyId, journalLineId: cost.lineId, projectId: project.id, category: 'materials', basisPoints: 10_000, recordedBy: 'o' });
    reverseJournalEntry(db, { companyId, entryId: cost.entryId, reversalDate: asIsoDate('2026-03-05'), reason: 'Duplicate' });
    expect(projectResult(db, { companyId, projectId: project.id, to: '2026-12-31' }).actual.materials).toBe(0);
  });
});

describe('overheads, profitability and WIP (issue #551)', () => {
  it('absorbs overheads at the rate in force on each cost\'s date, instead of the overheads allocated', () => {
    const project = createProject(db, { companyId, code: 'P1', name: 'Fit-out', startsOn: '2026-01-01', recordedBy: 'o' });
    const a = post('5000', 1_000_000, '2026-02-01');
    const b = post('5000', 1_000_000, '2026-07-01');
    const rent = post('6100', 400_000, '2026-03-01');
    for (const l of [a, b]) allocateToProject(db, { companyId, journalLineId: l.lineId, projectId: project.id, category: 'labour', basisPoints: 10_000, recordedBy: 'o' });
    allocateToProject(db, { companyId, journalLineId: rent.lineId, projectId: project.id, category: 'overheads', basisPoints: 10_000, recordedBy: 'o' });
    expect(projectResult(db, { companyId, projectId: project.id, to: '2026-12-31' }).overheadsChargedMinor).toBe(400_000);
    setOverheadRate(db, { companyId, projectId: project.id, rateBasisPoints: 1_000, effectiveFrom: '2026-01-01', basis: '2025 overheads over direct costs', recordedBy: 'o' });
    setOverheadRate(db, { companyId, projectId: project.id, rateBasisPoints: 2_000, effectiveFrom: '2026-06-01', basis: 'Revised', recordedBy: 'o' });
    // 10% of the February labour, 20% of July's.
    const r = projectResult(db, { companyId, projectId: project.id, to: '2026-12-31' });
    expect([r.absorbedOverheadsMinor, r.overheadsChargedMinor, r.netMarginMinor]).toEqual([300_000, 300_000, -2_300_000]);
  });

  it('ranks projects by margin and reports what no project carries', () => {
    const p1 = createProject(db, { companyId, code: 'P1', name: 'One', startsOn: '2026-01-01', recordedBy: 'o' });
    const p2 = createProject(db, { companyId, code: 'P2', name: 'Two', startsOn: '2026-01-01', recordedBy: 'o' });
    const i1 = post('4020', 1_000_000, '2026-03-01', true);
    const i2 = post('4020', 3_000_000, '2026-03-02', true);
    post('4020', 50_000, '2026-03-03', true);
    const c = post('5010', 1_000_000);
    allocateToProject(db, { companyId, journalLineId: i1.lineId, projectId: p1.id, category: 'income', basisPoints: 10_000, recordedBy: 'o' });
    allocateToProject(db, { companyId, journalLineId: i2.lineId, projectId: p2.id, category: 'income', basisPoints: 10_000, recordedBy: 'o' });
    allocateToProject(db, { companyId, journalLineId: c.lineId, projectId: p2.id, category: 'contractors', basisPoints: 6_000, recordedBy: 'o' });
    const r = projectProfitability(db, { companyId, from: '2026-01-01', to: '2026-12-31' });
    expect(r.projects.map((x) => [x.project.code, x.netMarginMinor])).toEqual([['P2', 2_400_000], ['P1', 1_000_000]]);
    expect(r.unallocated).toEqual({ incomeMinor: 50_000, costsMinor: 400_000 });
  });

  it('values WIP at cost less what billings cover at the budgeted margin, and flags a project without a budget', () => {
    const p1 = createProject(db, { companyId, code: 'P1', name: 'One', startsOn: '2026-01-01', recordedBy: 'o' });
    const p2 = createProject(db, { companyId, code: 'P2', name: 'Two', startsOn: '2026-01-01', recordedBy: 'o' });
    setProjectBudget(db, { companyId, projectId: p1.id, category: 'income', amountMinor: 10_000_000, effectiveFrom: '2026-01-01', recordedBy: 'o' });
    setProjectBudget(db, { companyId, projectId: p1.id, category: 'labour', amountMinor: 6_000_000, effectiveFrom: '2026-01-01', recordedBy: 'o' });
    const cost = post('5000', 4_000_000);
    const bill = post('4020', 5_000_000, '2026-03-10', true);
    allocateToProject(db, { companyId, journalLineId: cost.lineId, projectId: p1.id, category: 'labour', basisPoints: 10_000, recordedBy: 'o' });
    allocateToProject(db, { companyId, journalLineId: bill.lineId, projectId: p1.id, category: 'income', basisPoints: 10_000, recordedBy: 'o' });
    const w = workInProgress(db, { companyId, asOf: '2026-06-30' });
    // €50,000 billed at a 60% budget cost ratio covers €30,000 of the €40,000 incurred: €10,000 WIP.
    expect(w.lines.find((l) => l.project.id === p1.id)).toMatchObject({ budgetCostRatioBasisPoints: 6000, costsCoveredByBillingMinor: 3_000_000, wipMinor: 1_000_000 });
    expect(w.lines.find((l) => l.project.id === p2.id)).toMatchObject({ wipMinor: null });
    expect(w.totalMinor).toBe(1_000_000);
    setProjectStatus(db, { companyId, projectId: p1.id, status: 'completed', endsOn: '2026-06-30' });
    expect(workInProgress(db, { companyId, asOf: '2026-06-30' }).lines.map((l) => l.project.code)).toEqual(['P2']);
  });
});

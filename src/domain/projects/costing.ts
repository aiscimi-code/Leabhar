import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accounts, auditEvents, jobs, journalEntries, journalLines, projectAllocations, projectBudgets, projectOverheadRates, projects,
  PROJECT_COST_CATEGORIES,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { multiplyRational } from '../money';
import { postedPnlLines } from '../accounting/postedPnl';
import { ConstructionError, requireConstructionDate, requireProject, type Project } from '../construction/projects';

/**
 * Project and job costing (EPIC 27, issues #550, #551): income and costs by
 * category as allocations of posted lines (ADR 0016's pattern), effective-
 * dated budgets and overhead absorption rates, margin and profitability, and
 * work in progress. Analysis only: nothing here posts.
 */

export type ProjectCategory = (typeof PROJECT_COST_CATEGORIES)[number];
export type Job = typeof jobs.$inferSelect;
const DIRECT: ProjectCategory[] = ['labour', 'materials', 'contractors', 'other_direct'];
const FULL = 10_000;
const eur = (m: number) => (m / 100).toFixed(2);

export function createJob(db: AppDatabase, p: { companyId: string; projectId: string; code: string; name: string; recordedBy: string }): Job {
  const project = requireProject(db, p.companyId, p.projectId);
  const code = p.code.trim();
  if (!code || !p.name.trim()) throw new ConstructionError('Give the job a code and a name.');
  if (db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.projectId, project.id), eq(jobs.code, code))).get()) {
    throw new ConstructionError(`${project.code} already has a job ${code}.`);
  }
  const id = ids.job();
  db.insert(jobs).values({ id, companyId: p.companyId, projectId: project.id, code, name: p.name.trim(), recordedBy: p.recordedBy }).run();
  return db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}

export function setJobStatus(db: AppDatabase, p: { companyId: string; jobId: string; status: Job['status'] }): Job {
  const job = db.select().from(jobs).where(and(eq(jobs.id, p.jobId), eq(jobs.companyId, p.companyId))).get();
  if (!job) throw new ConstructionError(`Job ${p.jobId} not found.`);
  db.update(jobs).set({ status: p.status, updatedAt: nowIso() }).where(eq(jobs.id, job.id)).run();
  return db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
}

export function listJobs(db: AppDatabase, companyId: string, projectId?: string): Job[] {
  const where = [eq(jobs.companyId, companyId)];
  if (projectId) where.push(eq(jobs.projectId, projectId));
  return db.select().from(jobs).where(and(...where)).orderBy(asc(jobs.code)).all();
}

/** Allocate a share of a posted line to a project (and job) by category (issue #550). */
export function allocateToProject(db: AppDatabase, p: {
  companyId: string; journalLineId: string; projectId: string; jobId?: string | null; category: ProjectCategory; basisPoints: number;
  recordedBy: string;
}) {
  return db.transaction(() => {
    const row = db.select({ line: journalLines, entry: journalEntries, account: accounts }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(and(eq(journalLines.id, p.journalLineId), eq(journalLines.companyId, p.companyId))).get();
    if (!row) throw new ConstructionError(`Journal line ${p.journalLineId} not found.`);
    if (!row.entry.isPosted) throw new ConstructionError('Only a posted line is allocated.');
    if (row.entry.reversalOfId) throw new ConstructionError('A reversing entry takes the allocation of the line it reverses: allocate the original.');
    if (row.account.type !== 'income' && row.account.type !== 'expense') {
      throw new ConstructionError(`${row.account.code} ${row.account.name} is not an income or expense account.`);
    }
    if (!PROJECT_COST_CATEGORIES.includes(p.category)) throw new ConstructionError(`The category is one of: ${PROJECT_COST_CATEGORIES.join(', ')}.`);
    if ((p.category === 'income') !== (row.account.type === 'income')) {
      throw new ConstructionError(p.category === 'income' ? 'Project income is an income line.' : 'A project cost is an expense line.');
    }
    if (!Number.isInteger(p.basisPoints) || p.basisPoints <= 0 || p.basisPoints > FULL) {
      throw new ConstructionError('The share is between 0.01% and 100% (1 to 10000 basis points).');
    }
    const project = requireProject(db, p.companyId, p.projectId);
    if (p.jobId) {
      const job = db.select().from(jobs).where(and(eq(jobs.id, p.jobId), eq(jobs.companyId, p.companyId))).get();
      if (!job || job.projectId !== project.id) throw new ConstructionError('That job is not one of the project\'s.');
    }
    const taken = db.select({ bp: projectAllocations.basisPoints }).from(projectAllocations)
      .where(eq(projectAllocations.journalLineId, row.line.id)).all().reduce((s, a) => s + a.bp, 0);
    if (taken + p.basisPoints > FULL) {
      throw new ConstructionError(`${(taken / 100).toFixed(2)}% of the line is already allocated to projects: ${((FULL - taken) / 100).toFixed(2)}% is left.`);
    }
    const id = ids.projectAllocation();
    db.insert(projectAllocations).values({
      id, companyId: p.companyId, journalLineId: row.line.id, projectId: project.id, jobId: p.jobId ?? null, category: p.category,
      basisPoints: p.basisPoints, recordedBy: p.recordedBy,
    }).run();
    return db.select().from(projectAllocations).where(eq(projectAllocations.id, id)).get()!;
  });
}

export function removeProjectAllocation(db: AppDatabase, p: { companyId: string; allocationId: string; reason: string; actor: string }) {
  const a = db.select().from(projectAllocations)
    .where(and(eq(projectAllocations.id, p.allocationId), eq(projectAllocations.companyId, p.companyId))).get();
  if (!a) throw new ConstructionError(`Allocation ${p.allocationId} not found.`);
  if (!p.reason.trim()) throw new ConstructionError('Give the reason the allocation is removed.');
  db.transaction(() => {
    db.delete(projectAllocations).where(eq(projectAllocations.id, a.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: p.companyId, occurredAt: nowIso(), entityType: 'project_allocation', entityId: a.id, action: 'unmapped',
      previousValue: JSON.stringify(a), source: 'user', actor: p.actor, reason: p.reason.trim(), requestId: null,
    }).run();
  });
}

/** A budget for a category from a date (issue #550): a revision is a new row, the old one kept. */
export function setProjectBudget(db: AppDatabase, p: {
  companyId: string; projectId: string; category: ProjectCategory; amountMinor: number; effectiveFrom: string; note?: string | null; recordedBy: string;
}) {
  const project = requireProject(db, p.companyId, p.projectId);
  if (!PROJECT_COST_CATEGORIES.includes(p.category)) throw new ConstructionError(`The category is one of: ${PROJECT_COST_CATEGORIES.join(', ')}.`);
  if (!Number.isInteger(p.amountMinor) || p.amountMinor < 0) throw new ConstructionError('The budget is a whole number of cent, nil or more.');
  const effectiveFrom = requireConstructionDate(p.effectiveFrom, 'The date the budget applies from');
  const id = ids.projectBudget();
  db.insert(projectBudgets).values({
    id, companyId: p.companyId, projectId: project.id, category: p.category, amountMinor: p.amountMinor, effectiveFrom,
    note: p.note?.trim() || null, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(projectBudgets).where(eq(projectBudgets.id, id)).get()!;
}

/** The budget in force on a date, by category: each category's latest row on or before it. */
export function budgetOn(db: AppDatabase, projectId: string, date: string): Partial<Record<ProjectCategory, number>> {
  const out: Partial<Record<ProjectCategory, number>> = {};
  const rows = db.select().from(projectBudgets).where(and(eq(projectBudgets.projectId, projectId), lte(projectBudgets.effectiveFrom, date)))
    .orderBy(asc(projectBudgets.effectiveFrom), asc(projectBudgets.createdAt)).all();
  for (const r of rows) out[r.category] = r.amountMinor;
  return out;
}

/** The overhead absorption rate the person sets for a project from a date (issue #551). Effective-dated. */
export function setOverheadRate(db: AppDatabase, p: {
  companyId: string; projectId: string; rateBasisPoints: number; effectiveFrom: string; basis: string; recordedBy: string;
}) {
  const project = requireProject(db, p.companyId, p.projectId);
  if (!Number.isInteger(p.rateBasisPoints) || p.rateBasisPoints < 0 || p.rateBasisPoints > 100_000) {
    throw new ConstructionError('The rate is a percentage of direct costs, in basis points (1500 is 15%).');
  }
  if (!p.basis.trim()) throw new ConstructionError('Say how the rate was arrived at (last year\'s overheads over direct costs, say).');
  const id = ids.projectOverheadRate();
  db.insert(projectOverheadRates).values({
    id, companyId: p.companyId, projectId: project.id, rateBasisPoints: p.rateBasisPoints,
    effectiveFrom: requireConstructionDate(p.effectiveFrom, 'The date the rate applies from'), basis: p.basis.trim(), recordedBy: p.recordedBy,
  }).run();
  return db.select().from(projectOverheadRates).where(eq(projectOverheadRates.id, id)).get()!;
}

function overheadRateOn(db: AppDatabase, projectId: string, date: string): number | null {
  return db.select().from(projectOverheadRates).where(and(eq(projectOverheadRates.projectId, projectId), lte(projectOverheadRates.effectiveFrom, date)))
    .orderBy(desc(projectOverheadRates.effectiveFrom), desc(projectOverheadRates.createdAt)).get()?.rateBasisPoints ?? null;
}

export interface CategoryFigures { income: number; labour: number; materials: number; contractors: number; other_direct: number; overheads: number }
const emptyFigures = (): CategoryFigures => ({ income: 0, labour: 0, materials: 0, contractors: 0, other_direct: 0, overheads: 0 });

export interface ProjectResult {
  project: Project;
  actual: CategoryFigures;
  directCostsMinor: number;
  grossMarginMinor: number;
  /** Overheads at the project's absorption rate on each direct cost's date; null where no rate is set. */
  absorbedOverheadsMinor: number | null;
  /** What the margin deducts: the absorbed overheads where a rate is set, else the overheads allocated. */
  overheadsChargedMinor: number;
  netMarginMinor: number;
  /** Net margin as basis points of income; null without income. */
  marginBasisPoints: number | null;
  budget: Partial<Record<ProjectCategory, number>>;
  jobs: Array<{ job: Job; actual: CategoryFigures; grossMarginMinor: number }>;
}

interface Amount { projectId: string; jobId: string | null; category: ProjectCategory; entryDate: string; amountMinor: number }

/** Every allocated amount in a range, reversals following their originals. */
function projectAmounts(db: AppDatabase, companyId: string, range?: { from: string; to: string }): { amounts: Amount[]; unallocated: CategoryTotals } {
  const lines = postedPnlLines(db, companyId, range);
  const byLine = new Map<string, Array<typeof projectAllocations.$inferSelect>>();
  for (const a of db.select().from(projectAllocations).where(eq(projectAllocations.companyId, companyId)).all()) {
    byLine.set(a.journalLineId, [...(byLine.get(a.journalLineId) ?? []), a]);
  }
  const amounts: Amount[] = [];
  const unallocated: CategoryTotals = { incomeMinor: 0, costsMinor: 0 };
  for (const l of lines) {
    const allocs = l.allocationLineId ? byLine.get(l.allocationLineId) ?? [] : [];
    let allocated = 0;
    for (const a of allocs) {
      const amount = multiplyRational(l.amountMinor, a.basisPoints, FULL);
      allocated += amount;
      amounts.push({ projectId: a.projectId, jobId: a.jobId, category: a.category, entryDate: l.entryDate, amountMinor: amount });
    }
    const rest = l.amountMinor - allocated;
    if (l.accountType === 'income') unallocated.incomeMinor += rest;
    else unallocated.costsMinor += rest;
  }
  return { amounts, unallocated };
}

interface CategoryTotals { incomeMinor: number; costsMinor: number }

function figuresOf(amounts: Amount[]): CategoryFigures {
  const f = emptyFigures();
  for (const a of amounts) f[a.category] += a.amountMinor;
  return f;
}

function resultFor(db: AppDatabase, project: Project, amounts: Amount[], budgetDate: string, companyId: string): ProjectResult {
  const mine = amounts.filter((a) => a.projectId === project.id);
  const actual = figuresOf(mine);
  const directCostsMinor = DIRECT.reduce((s, c) => s + actual[c], 0);
  let absorbed: number | null = null;
  for (const a of mine.filter((x) => DIRECT.includes(x.category))) {
    const rate = overheadRateOn(db, project.id, a.entryDate);
    if (rate === null) continue;
    absorbed = (absorbed ?? 0) + multiplyRational(a.amountMinor, rate, FULL);
  }
  const grossMarginMinor = actual.income - directCostsMinor;
  const overheadsChargedMinor = absorbed ?? actual.overheads;
  const netMarginMinor = grossMarginMinor - overheadsChargedMinor;
  return {
    project, actual, directCostsMinor, grossMarginMinor, absorbedOverheadsMinor: absorbed, overheadsChargedMinor, netMarginMinor,
    marginBasisPoints: actual.income > 0 ? multiplyRational(netMarginMinor, FULL, actual.income) : null,
    budget: budgetOn(db, project.id, budgetDate),
    jobs: listJobs(db, companyId, project.id).map((job) => {
      const f = figuresOf(mine.filter((a) => a.jobId === job.id));
      return { job, actual: f, grossMarginMinor: f.income - DIRECT.reduce((s, c) => s + f[c], 0) };
    }),
  };
}

/** A project's income, costs and margin, for a period or to date, against the budget in force at its end (issues #550, #551). */
export function projectResult(db: AppDatabase, p: { companyId: string; projectId: string; from?: string; to: string }): ProjectResult {
  const project = requireProject(db, p.companyId, p.projectId);
  const to = requireConstructionDate(p.to, 'The end date');
  const { amounts } = projectAmounts(db, p.companyId, { from: p.from ? requireConstructionDate(p.from, 'The start date') : '0000-01-01', to });
  return resultFor(db, project, amounts, to, p.companyId);
}

export interface Profitability { from: string; to: string; projects: ProjectResult[]; unallocated: CategoryTotals }

/** Every project ranked by net margin for a period, with what no project carries (issue #551). */
export function projectProfitability(db: AppDatabase, p: { companyId: string; from: string; to: string }): Profitability {
  const from = requireConstructionDate(p.from, 'The start date');
  const to = requireConstructionDate(p.to, 'The end date');
  const { amounts, unallocated } = projectAmounts(db, p.companyId, { from, to });
  const list = db.select().from(projects).where(eq(projects.companyId, p.companyId)).all()
    .map((project) => resultFor(db, project, amounts, to, p.companyId))
    .sort((a, b) => b.netMarginMinor - a.netMarginMinor);
  return { from, to, projects: list, unallocated };
}

export interface WipLine {
  project: Project;
  directCostsToDateMinor: number;
  billedToDateMinor: number;
  /** The budget's direct costs over its income: the share of billings that covers cost. */
  budgetCostRatioBasisPoints: number | null;
  costsCoveredByBillingMinor: number | null;
  wipMinor: number | null;
  finding: string | null;
}

/**
 * Work in progress at a date (issue #551): for each project not completed,
 * its direct costs to date less the part of its billings that covers cost at
 * the budgeted margin. Without a budget the covered cost cannot be measured,
 * and the project is flagged instead. Reported, not posted (#552).
 */
export function workInProgress(db: AppDatabase, p: { companyId: string; asOf: string }): { asOf: string; method: string; lines: WipLine[]; totalMinor: number } {
  const asOf = requireConstructionDate(p.asOf, 'The date');
  const { amounts } = projectAmounts(db, p.companyId, { from: '0000-01-01', to: asOf });
  const lines = db.select().from(projects).where(eq(projects.companyId, p.companyId)).all()
    .filter((project) => project.status === 'active' && project.startsOn <= asOf)
    .map((project): WipLine => {
      const f = figuresOf(amounts.filter((a) => a.projectId === project.id));
      const direct = DIRECT.reduce((s, c) => s + f[c], 0);
      const budget = budgetOn(db, project.id, asOf);
      const budgetDirect = DIRECT.reduce((s, c) => s + (budget[c] ?? 0), 0);
      if (!budget.income) {
        return { project, directCostsToDateMinor: direct, billedToDateMinor: f.income, budgetCostRatioBasisPoints: null,
          costsCoveredByBillingMinor: null, wipMinor: null,
          finding: `${project.code} has no income budget: the cost its billings cover cannot be measured. Set a budget to value its WIP.` };
      }
      const ratio = multiplyRational(budgetDirect, FULL, budget.income);
      const covered = multiplyRational(f.income, ratio, FULL);
      return { project, directCostsToDateMinor: direct, billedToDateMinor: f.income, budgetCostRatioBasisPoints: ratio,
        costsCoveredByBillingMinor: covered, wipMinor: Math.max(direct - covered, 0),
        finding: direct - covered < 0 ? `${project.code} has billed ${eur(covered - direct)} of cost ahead of the work: billings on account, not WIP.` : null };
    });
  return {
    asOf, lines, totalMinor: lines.reduce((s, l) => s + (l.wipMinor ?? 0), 0),
    method: 'Direct costs to date less the cost covered by billings to date at the budgeted cost ratio (budget direct costs over budget income).',
  };
}

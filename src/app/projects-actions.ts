'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { actorName, requireActor } from '@/lib/session';
import { parseAmount } from '@/domain/money';
import { parsePercent } from '@/domain/farm';
import { createJob, allocateToProject, setProjectBudget, setOverheadRate, type ProjectCategory } from '@/domain/projects';

/** Project and job costing mutations (EPIC 27, issues #550, #551). The domain owns every figure. */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };
const fail = (e: unknown): ActionResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) });
const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const done = (message: string): ActionResult => {
  revalidatePath('/projects');
  return { ok: true, message };
};

export async function createJobAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('projects.manage');
    createJob(getDb(), { companyId: requireCompany().id, projectId: text(f, 'projectId'), code: text(f, 'code'), name: text(f, 'name'), recordedBy: await actorName() });
    return done('Job added.');
  } catch (e) { return fail(e); }
}

export async function allocateToProjectAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('projects.manage');
    allocateToProject(getDb(), {
      companyId: requireCompany().id, journalLineId: text(f, 'journalLineId'), projectId: text(f, 'projectId'), jobId: text(f, 'jobId') || null,
      category: text(f, 'category') as ProjectCategory, basisPoints: parsePercent(text(f, 'percent')), recordedBy: await actorName(),
    });
    return done('Allocated.');
  } catch (e) { return fail(e); }
}

export async function setProjectBudgetAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('projects.manage');
    const company = requireCompany();
    setProjectBudget(getDb(), {
      companyId: company.id, projectId: text(f, 'projectId'), category: text(f, 'category') as ProjectCategory,
      amountMinor: parseAmount(text(f, 'amount'), company.baseCurrency), effectiveFrom: text(f, 'effectiveFrom'), note: text(f, 'note') || null,
      recordedBy: await actorName(),
    });
    return done('Budget recorded.');
  } catch (e) { return fail(e); }
}

export async function setOverheadRateAction(f: FormData): Promise<ActionResult> {
  try {
    await requireActor('projects.manage');
    setOverheadRate(getDb(), {
      companyId: requireCompany().id, projectId: text(f, 'projectId'), rateBasisPoints: parsePercent(text(f, 'percent')),
      effectiveFrom: text(f, 'effectiveFrom'), basis: text(f, 'basis'), recordedBy: await actorName(),
    });
    return done('Overhead rate recorded.');
  } catch (e) { return fail(e); }
}

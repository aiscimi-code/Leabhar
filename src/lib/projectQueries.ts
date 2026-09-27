import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, journalEntries, journalLines, projectAllocations } from '@/db/schema';
import { listProjects } from '@/domain/construction';
import { listJobs, projectProfitability, workInProgress } from '@/domain/projects';
import { requireCompany } from './queries';

/** Read models for the projects screen (EPIC 27). Every figure is the domain's. */
export function projectsPage(year: number, asOf: string) {
  const db = getDb();
  const company = requireCompany();
  const lines = db.select({
    id: journalLines.id, entryDate: journalEntries.entryDate, narrative: journalEntries.narrative, accountCode: accounts.code,
    accountType: accounts.type, debit: journalLines.baseDebitMinor, credit: journalLines.baseCreditMinor,
  }).from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.companyId, company.id), eq(journalEntries.isPosted, true), inArray(accounts.type, ['income', 'expense'])))
    .orderBy(desc(journalEntries.entryDate)).limit(300).all();
  const taken = new Map<string, number>();
  if (lines.length) {
    for (const a of db.select().from(projectAllocations).where(inArray(projectAllocations.journalLineId, lines.map((l) => l.id))).all()) {
      taken.set(a.journalLineId, (taken.get(a.journalLineId) ?? 0) + a.basisPoints);
    }
  }
  return {
    company,
    projects: listProjects(db, company.id),
    jobs: listJobs(db, company.id),
    profitability: projectProfitability(db, { companyId: company.id, from: `${year}-01-01`, to: `${year}-12-31` }),
    wip: workInProgress(db, { companyId: company.id, asOf }),
    lines: lines.map((l) => ({ ...l, allocatedBasisPoints: taken.get(l.id) ?? 0 })).filter((l) => l.allocatedBasisPoints < 10_000).slice(0, 100),
  };
}

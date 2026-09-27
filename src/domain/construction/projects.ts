import { and, asc, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { customers, projects, sites } from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso } from '../dates';

/**
 * Projects and sites (EPIC 26, issue #548). A project is the unit EPIC 27
 * costs and measures; a site is where work is carried out, named on a
 * relevant contract's notification (s.530B(1)(a)).
 */

export class ConstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConstructionError';
  }
}

export type Project = typeof projects.$inferSelect;
export type Site = typeof sites.$inferSelect;

export function requireConstructionDate(value: string, what: string): string {
  if (!isIsoDate(value)) throw new ConstructionError(`${what} is a YYYY-MM-DD date.`);
  return asIsoDate(value);
}

export function createProject(db: AppDatabase, p: {
  companyId: string; code: string; name: string; customerId?: string | null; startsOn: string; endsOn?: string | null;
  notes?: string | null; recordedBy: string;
}): Project {
  const code = p.code.trim();
  if (!code || !p.name.trim()) throw new ConstructionError('Give the project a code and a name.');
  const startsOn = requireConstructionDate(p.startsOn, 'The start date');
  const endsOn = p.endsOn ? requireConstructionDate(p.endsOn, 'The end date') : null;
  if (endsOn && endsOn < startsOn) throw new ConstructionError('A project ends on or after it starts.');
  if (p.customerId) {
    const c = db.select().from(customers).where(and(eq(customers.id, p.customerId), eq(customers.companyId, p.companyId))).get();
    if (!c) throw new ConstructionError(`Customer ${p.customerId} not found.`);
  }
  if (db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, p.companyId), eq(projects.code, code))).get()) {
    throw new ConstructionError(`Project code ${code} is already in use.`);
  }
  const id = ids.project();
  db.insert(projects).values({
    id, companyId: p.companyId, code, name: p.name.trim(), customerId: p.customerId ?? null, startsOn, endsOn,
    notes: p.notes?.trim() || null, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(projects).where(eq(projects.id, id)).get()!;
}

export function setProjectStatus(db: AppDatabase, p: {
  companyId: string; projectId: string; status: Project['status']; endsOn?: string | null;
}): Project {
  const project = requireProject(db, p.companyId, p.projectId);
  const endsOn = p.endsOn ? requireConstructionDate(p.endsOn, 'The end date') : project.endsOn;
  if (endsOn && endsOn < project.startsOn) throw new ConstructionError('A project ends on or after it starts.');
  db.update(projects).set({ status: p.status, endsOn, updatedAt: nowIso() }).where(eq(projects.id, project.id)).run();
  return db.select().from(projects).where(eq(projects.id, project.id)).get()!;
}

export function requireProject(db: AppDatabase, companyId: string, idOrCode: string): Project {
  const p = db.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.id, idOrCode))).get()
    ?? db.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.code, idOrCode))).get();
  if (!p) throw new ConstructionError(`Project ${idOrCode} not found.`);
  return p;
}

export function listProjects(db: AppDatabase, companyId: string): Project[] {
  return db.select().from(projects).where(eq(projects.companyId, companyId)).orderBy(asc(projects.code)).all();
}

export function createSite(db: AppDatabase, p: {
  companyId: string; name: string; address: string; eircode?: string | null; projectId?: string | null; recordedBy: string;
}): Site {
  if (!p.name.trim() || !p.address.trim()) throw new ConstructionError('Give the site a name and its address.');
  const projectId = p.projectId ? requireProject(db, p.companyId, p.projectId).id : null;
  const eircode = p.eircode?.trim().toUpperCase().replace(/\s+/g, '') || null;
  if (eircode && !/^[A-Z]\d{2}[A-Z0-9]{4}$/.test(eircode)) throw new ConstructionError(`${p.eircode} is not an Eircode (A65 F4E2).`);
  const id = ids.site();
  db.insert(sites).values({
    id, companyId: p.companyId, projectId, name: p.name.trim(), address: p.address.trim(), eircode, recordedBy: p.recordedBy,
  }).run();
  return db.select().from(sites).where(eq(sites.id, id)).get()!;
}

export function requireSite(db: AppDatabase, companyId: string, siteId: string): Site {
  const s = db.select().from(sites).where(and(eq(sites.id, siteId), eq(sites.companyId, companyId))).get();
  if (!s) throw new ConstructionError(`Site ${siteId} not found.`);
  return s;
}

export function listSites(db: AppDatabase, companyId: string): Site[] {
  return db.select().from(sites).where(eq(sites.companyId, companyId)).orderBy(asc(sites.name)).all();
}

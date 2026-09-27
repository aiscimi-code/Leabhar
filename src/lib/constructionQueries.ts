import { and, desc, eq, gt } from 'drizzle-orm';
import { getDb } from '@/db';
import { invoices, suppliers } from '@/db/schema';
import {
  listProjects, listSites, listSubcontractors, listRctContracts, listRctPayments, rctPeriod,
} from '@/domain/construction';
import { requireCompany } from './queries';

/** Read models for the construction screen (EPIC 26). Every figure is the domain's, or Revenue's as recorded. */
export function constructionPage(period: string) {
  const db = getDb();
  const company = requireCompany();
  return {
    company,
    projects: listProjects(db, company.id),
    sites: listSites(db, company.id),
    subcontractors: listSubcontractors(db, company.id),
    contracts: listRctContracts(db, company.id),
    payments: listRctPayments(db, company.id),
    period: rctPeriod(db, { companyId: company.id, period }),
    suppliers: db.select().from(suppliers).where(eq(suppliers.companyId, company.id)).all(),
    openInvoices: db.select().from(invoices).where(and(eq(invoices.companyId, company.id), eq(invoices.direction, 'purchase'), gt(invoices.outstandingMinor, 0)))
      .orderBy(desc(invoices.invoiceDate)).limit(100).all(),
  };
}

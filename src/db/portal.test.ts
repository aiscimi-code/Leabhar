import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPortalDatabase, serializePortalDatabase, closePortalDatabase } from './portal';
import { companies } from './schema';
import { createCompany } from '@/domain/config/setup';

describe('portal database (issue #166)', () => {
  it('opens a fresh in-memory database with the schema already migrated', () => {
    const db = createPortalDatabase();
    try {
      // No throw means the migrations ran: the table exists to query.
      expect(db.select().from(companies).all()).toEqual([]);
    } finally {
      closePortalDatabase(db);
    }
  });

  it('round-trips a database through serialize and reopen', () => {
    const db = createPortalDatabase();
    const created = createCompany(db, { legalName: 'Round Trip Ltd', seedYears: [2025] });
    const bytes = serializePortalDatabase(db);
    closePortalDatabase(db);

    const reopened = createPortalDatabase(bytes);
    try {
      const company = reopened.select().from(companies)
        .where(eq(companies.id, created.companyId)).get();
      expect(company?.legalName).toBe('Round Trip Ltd');
    } finally {
      closePortalDatabase(reopened);
    }
  });

  it('keeps two databases opened from the same bytes independent of each other', () => {
    const db = createPortalDatabase();
    createCompany(db, { legalName: 'Original Ltd', seedYears: [2025] });
    const bytes = serializePortalDatabase(db);
    closePortalDatabase(db);

    const a = createPortalDatabase(bytes);
    const b = createPortalDatabase(bytes);
    try {
      a.update(companies).set({ legalName: 'Changed in A' }).run();
      const bCompany = b.select().from(companies).get();
      // A different in-memory instance, deserialized separately — a write to
      // one must never leak into the other.
      expect(bCompany?.legalName).toBe('Original Ltd');
    } finally {
      closePortalDatabase(a);
      closePortalDatabase(b);
    }
  });
});

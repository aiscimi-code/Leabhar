import { desc, isNull } from 'drizzle-orm';
import { createDatabase, type AppDatabase } from '@/db';
import { companies } from '@/db/schema';

/**
 * DB and company resolution for the CLI and other non-Next.js callers.
 *
 * The web app reaches these through `src/lib/queries.ts`, which uses the
 * process-wide `getDb()` cache. The CLI is short-lived: it opens its own handle,
 * does its work, and lets the process exit. Same trust model as `db:migrate`
 * and `db:seed` — local-only, direct file access, no auth.
 */
export function getAgentDb(): AppDatabase {
  return createDatabase();
}

/**
 * The most recently created company still being worked on. Mirrors
 * `activeCompany()` in `src/lib/queries.ts` but against the caller's own DB
 * handle rather than the cached one. Archived businesses (issue #297) are not
 * the working set.
 */
export function requireCompany(db: AppDatabase) {
  const company = db.select().from(companies)
    .where(isNull(companies.archivedAt))
    .orderBy(desc(companies.createdAt)).get();
  if (!company) {
    throw new Error('No company has been set up. Run npm run db:seed first.');
  }
  return company;
}

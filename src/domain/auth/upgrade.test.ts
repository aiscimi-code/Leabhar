import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { openSqlite } from '@/db';
import * as schema from '@/db/schema';
import { hashPassword } from './auth';
import { assertMemberAllowed } from './permissions';
import { inviteUser } from './users';

/**
 * A book created before issue #298 upgrades without anyone losing access:
 * the old 'user' role becomes bookkeeper, and every active user becomes a
 * member of every company already in the book (migration 0016).
 */
describe('upgrading a book from before business membership', () => {
  it('keeps every existing user able to work, including after the first invitation', () => {
    // A copy of the migrations that stops just before 0016.
    const dir = mkdtempSync(join(tmpdir(), 'leabhar-upgrade-'));
    try {
      cpSync('./drizzle', dir, { recursive: true });
      const journalPath = join(dir, 'meta', '_journal.json');
      const full = readFileSync(journalPath, 'utf8');
      const journal = JSON.parse(full) as { entries: Array<{ tag: string }> };
      const cut = journal.entries.findIndex((e) => e.tag.startsWith('0016_'));
      expect(cut).toBeGreaterThan(0);
      writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, cut) }));

      const sqlite = openSqlite(':memory:');
      const db = drizzle(sqlite, { schema });
      migrate(db, { migrationsFolder: dir });

      // The old book: one company, its owner and a day-to-day 'user'. The
      // company is a raw row rather than `createCompany`, because the old
      // schema predates every table a newer `createCompany` seeds (the civil
      // service expense rates of 0029 among them) — the upgrade under test is
      // the users/membership one, not the chart.
      const companyId = 'co_old_book';
      sqlite.prepare(
        `INSERT INTO companies (id, legal_name) VALUES (?, ?)`,
      ).run(companyId, 'Old Book Ltd');
      const insertUser = sqlite.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, password_salt, role, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      );
      const { hash, salt } = hashPassword('correct horse battery');
      insertUser.run('usr_owner', 'owner', 'Owner', hash, salt, 'owner');
      insertUser.run('usr_worker', 'worker', 'Worker', hash, salt, 'user');

      // The upgrade.
      writeFileSync(journalPath, full);
      migrate(db, { migrationsFolder: dir });

      const worker = db.select().from(schema.users).where(eq(schema.users.id, 'usr_worker')).get()!;
      expect(worker.role).toBe('bookkeeper');
      expect(db.select().from(schema.companyMembers).all()).toHaveLength(2);
      expect(assertMemberAllowed(db, 'usr_worker', companyId, 'transactions.classify')).toBe('bookkeeper');
      expect(assertMemberAllowed(db, 'usr_owner', companyId, 'users.manage')).toBe('owner');

      // The first invitation adds a membership row; nobody already in the
      // book is locked out by it.
      inviteUser(db, { companyId, actorId: 'usr_owner', username: 'accountant', role: 'accountant' });
      expect(assertMemberAllowed(db, 'usr_owner', companyId, 'users.manage')).toBe('owner');
      expect(assertMemberAllowed(db, 'usr_worker', companyId, 'journals.post')).toBe('bookkeeper');
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

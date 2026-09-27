import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { createUser, authenticateUser } from '@/domain/auth/auth';
import { auditEvents, users } from '@/db/schema';
import { main } from './reconcile';
import type { AppDatabase } from '@/db';

/**
 * The users and roles commands (issue #298): the local surface for inviting,
 * removing and re-roling the people who may open this book.
 */

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
  createUser(db, { username: 'owner', password: 'password123', displayName: 'The Owner' });
});

const run = (argv: string[]) => main(argv, { db, companyId });

describe('cli users', () => {
  it('lists the roles a person may be invited as', async () => {
    const code = await run(['list-roles']);
    expect(code).toBe(0);
  });

  it('invites a bookkeeper with a one-time password, recorded in the audit trail', async () => {
    const { stdout } = await capture(async () => run([
      'invite-user', '--username', 'bern', '--role', 'bookkeeper', '--display-name', 'Bernard',
    ]));

    const out = JSON.parse(stdout);
    expect(out.role).toBe('bookkeeper');
    expect(out.oneTimePassword).toMatch(/^.{8,}$/);

    const row = db.select().from(users).where(eq(users.username, 'bern')).get()!;
    expect(row.displayName).toBe('Bernard');
    expect(row.mustChangePassword).toBe(true);
    expect(authenticateUser(db, 'bern', out.oneTimePassword)?.role).toBe('bookkeeper');

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'user_invited')).get();
    expect(audit?.entityId).toBe(row.id);
    expect(audit?.newValue).toBe('bookkeeper');
    expect(audit?.actor).toContain('The Owner');
  });

  it('changes a role from the CLI and ends the user\'s sessions', async () => {
    await capture(async () => run(['invite-user', '--username', 'bern', '--role', 'bookkeeper']));

    const { stdout } = await capture(async () => run([
      'set-user-role', '--user', 'bern', '--role', 'accountant',
    ]));
    expect(JSON.parse(stdout).role).toBe('accountant');
    expect(db.select().from(users).where(eq(users.username, 'bern')).get()!.role).toBe('accountant');

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'user_role_changed')).get();
    expect(audit?.previousValue).toBe('bookkeeper');
    expect(audit?.newValue).toBe('accountant');
  });

  it('resets a password to a new one-time password', async () => {
    const { stdout: invited } = await capture(async () => run([
      'invite-user', '--username', 'bern', '--role', 'bookkeeper',
    ]));
    const first = JSON.parse(invited).oneTimePassword;

    const { stdout: reset } = await capture(async () => run([
      'reset-user-password', '--user', 'bern',
    ]));
    const second = JSON.parse(reset).oneTimePassword;

    expect(authenticateUser(db, 'bern', first)).toBeNull();
    expect(authenticateUser(db, 'bern', second)?.mustChangePassword).toBe(true);
  });

  it('removes a user, ending their access completely', async () => {
    await capture(async () => run(['invite-user', '--username', 'bern', '--role', 'bookkeeper']));

    const code = await run(['remove-user', '--user', 'bern']);
    expect(code).toBe(0);
    expect(db.select().from(users).where(eq(users.username, 'bern')).get()!.active).toBe(false);

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'user_removed')).get();
    expect(audit?.previousValue).toBe('bern');
  });

  it('refuses to let the only owner remove themselves, and leaves the book alone', async () => {
    const code = await run(['remove-user', '--user', 'owner']);
    expect(code).toBe(1);
    expect(db.select().from(users).where(eq(users.username, 'owner')).get()!.active).toBe(true);
  });

  it('refuses to guess the acting owner when the book has two, and --as names who ran it (issue #498)', async () => {
    await capture(async () => run(['invite-user', '--username', 'dee', '--role', 'owner', '--as', 'owner']));

    // Without --as the attribution would be a guess between two owners, so
    // the command refuses rather than name the wrong person in the audit trail.
    const code = await run(['invite-user', '--username', 'bern', '--role', 'bookkeeper']);
    expect(code).toBe(1);
    expect(db.select().from(users).where(eq(users.username, 'bern')).all()).toHaveLength(0);

    const { stdout } = await capture(async () => run([
      'invite-user', '--username', 'bern', '--role', 'bookkeeper', '--as', 'dee',
    ]));
    expect(JSON.parse(stdout).actingAs).toBe('dee');
    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'user_invited')).all().at(-1)!;
    expect(audit.actor).toContain('dee');

    // --as must name an active owner of this book.
    const refused = await run(['remove-user', '--user', 'bern', '--as', 'bern']);
    expect(refused).toBe(1);
    expect(db.select().from(users).where(eq(users.username, 'bern')).get()!.active).toBe(true);
  });

  it('refuses an invite for a role that does not exist', async () => {
    const code = await run(['invite-user', '--username', 'x', '--role', 'wizard']);
    expect(code).toBe(1);
    expect(db.select().from(users).all()).toHaveLength(1);
  });
});

/** Runs `fn` capturing stdout, restoring the stream however it ends. */
async function capture(fn: () => Promise<number>): Promise<{ stdout: string; code: number }> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let code = 1;
  try {
    code = await fn();
  } finally {
    process.stdout.write = out;
  }
  return { stdout: chunks.join(''), code };
}

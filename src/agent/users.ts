import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { users } from '@/db/schema';
import {
  inviteUser, removeUser, changeUserRole, resetUserPassword, listBookUsers, invitableRoles,
} from '@/domain/auth/users';
import { type Role } from '@/domain/auth/permissions';
import type { InviteUserInput, UserRefInput, SetUserRoleInput } from './schema';

/**
 * CLI access to the book's user administration (issue #298).
 *
 * The CLI runs on the owner's own machine against the owner's own database
 * file, so it acts as the book's active owner — but it never bypasses the
 * domain layer: every call goes through the same permission matrix and
 * owner-continuity guards the web UI uses, and lands in the same audit
 * trail. A book with no active owner cannot be administered from the
 * terminal; create the first user from the app's login screen.
 */

/**
 * The owner the CLI acts as (issue #498). The attribution is never a guess:
 * an explicit `--as <user>` names the acting owner, and a book with more than
 * one active owner refuses to run without one — otherwise the audit trail
 * would record whichever owner the query happened to return first.
 */
function actingOwner(db: AppDatabase, as?: string): { id: string; username: string } {
  if (as) {
    const row = db.select().from(users).where(eq(users.id, resolveUserId(db, as))).get();
    if (!row || !row.active || row.role !== 'owner') {
      throw new Error(`--as ${as}: not an active owner of this book. list-users shows the owners.`);
    }
    return { id: row.id, username: row.username };
  }
  const owners = db.select().from(users)
    .where(and(eq(users.active, true), eq(users.role, 'owner'))).all();
  if (owners.length === 0) {
    throw new Error('This book has no active owner, so nobody may administer it from the terminal. Create the first user from the app\'s login screen.');
  }
  if (owners.length > 1) {
    const names = owners.map((o) => o.username).join(', ');
    throw new Error(`This book has ${owners.length} active owners (${names}), so the terminal cannot guess who is acting. Pass --as <username> to name yourself.`);
  }
  const owner = owners[0]!;
  return { id: owner.id, username: owner.username };
}

/** Accept "ausername" or "usr_ab12..." — the way every other CLI command resolves ids. */
function resolveUserId(db: AppDatabase, ref: string): string {
  const byUsername = db.select().from(users).where(eq(users.username, ref)).get();
  if (byUsername) return byUsername.id;
  const byId = db.select().from(users).where(eq(users.id, ref)).get();
  if (!byId) throw new Error(`No user "${ref}". Try a username, or list-users for the ids.`);
  return byId.id;
}

export function listUsersCli(db: AppDatabase, as?: string) {
  const acting = actingOwner(db, as);
  const rows = listBookUsers(db);
  return {
    actingAs: acting.username,
    roleLabels: invitableRoles().reduce<Record<string, string>>((acc, r) => {
      acc[r.role] = r.label; return acc;
    }, {}),
    users: rows.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      role: u.role,
      active: u.active,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt,
    })),
  };
}

export function listRolesCli() {
  return invitableRoles();
}

export function inviteUserCli(db: AppDatabase, input: InviteUserInput) {
  const actor = actingOwner(db, input.as);
  const result = inviteUser(db, {
    companyId: input.companyId,
    actorId: actor.id,
    username: input.username,
    displayName: input.displayName,
    role: input.role,
  });
  return {
    invited: result.username,
    role: result.role,
    userId: result.userId,
    oneTimePassword: result.oneTimePassword,
    handover: 'Give the one-time password to the person directly. They must change it at first login, and it is never shown again.',
    actingAs: actor.username,
  };
}

export function removeUserCli(db: AppDatabase, input: UserRefInput) {
  const actor = actingOwner(db, input.as);
  const userId = resolveUserId(db, input.user);
  if (userId === actor.id) {
    throw new Error('You cannot remove yourself. Another owner must remove you.');
  }
  removeUser(db, { companyId: input.companyId, actorId: actor.id, userId });
  return { removed: input.user, userId, actingAs: actor.username };
}

export function setUserRoleCli(db: AppDatabase, input: SetUserRoleInput) {
  const actor = actingOwner(db, input.as);
  const userId = resolveUserId(db, input.user);
  changeUserRole(db, {
    companyId: input.companyId,
    actorId: actor.id,
    userId,
    role: input.role,
  });
  return { user: input.user, userId, role: input.role, actingAs: actor.username };
}

export function resetUserPasswordCli(db: AppDatabase, input: UserRefInput) {
  const actor = actingOwner(db, input.as);
  const userId = resolveUserId(db, input.user);
  const oneTimePassword = resetUserPassword(db, {
    companyId: input.companyId, actorId: actor.id, userId,
  });
  return {
    user: input.user,
    userId,
    oneTimePassword,
    handover: 'Their old password no longer works and their sessions have ended. Give them this one-time password directly; they must change it at first login.',
    actingAs: actor.username,
  };
}

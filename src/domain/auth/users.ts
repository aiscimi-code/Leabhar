import { randomBytes } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { users, sessions, companyMembers, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { hashPassword, verifyPassword } from './auth';
import {
  assertMemberAllowed, ROLES, ROLE_LABELS, type Role,
} from './permissions';

/**
 * User lifecycle for a local book (issue #298): invite, remove, change role.
 *
 * "Invite" here is local-first: there is no server to send an invitation to,
 * so inviting means creating the user with a one-time password the invoker
 * hands over out of band, which the new user must replace at first login.
 *
 * Every change is written to `audit_events` inside the same transaction as the
 * change itself, and the owner-continuity guard stops the one change that
 * would brick a book: removing or demoting its last owner.
 */

export interface InvitedUser {
  userId: string;
  username: string;
  role: Role;
  /** The one-time password. Shown once; never stored in the clear. */
  oneTimePassword: string;
}

/** A readable one-time password: letters and digits, no ambiguous characters. */
function generateOneTimePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function assertValidUsername(username: string): void {
  if (username.length < 2 || username.length > 40) {
    throw new Error('Username must be between 2 and 40 characters.');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    throw new Error('Username may contain only letters, digits, dots, underscores and hyphens.');
  }
}

function assertValidPassword(password: string): void {
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
}

function usernameTaken(db: AppDatabase, username: string): boolean {
  return db.select().from(users).where(eq(users.username, username)).get() !== undefined;
}

/** The number of users who could still administer the book. */
function activeOwnerCount(db: AppDatabase): number {
  return db.select().from(users)
    .where(and(eq(users.active, true), eq(users.role, 'owner'))).all().length;
}

/**
 * Refuse to remove or demote the last owner. A book whose only owner is a
 * read-only user is locked out of its own administration, and the only fix
 * would be editing the database by hand — which the audit trail would then
 * not describe. Nothing is silently repaired; the change is refused instead.
 */
function assertOwnerContinuity(db: AppDatabase, userId: string, newRole: Role | null): void {
  const target = db.select().from(users).where(eq(users.id, userId)).get();
  if (!target || target.role !== 'owner') return;
  if (newRole === 'owner') return;
  const otherOwners = db.select().from(users)
    .where(and(eq(users.active, true), eq(users.role, 'owner'), ne(users.id, userId))).all().length;
  if (otherOwners === 0) {
    throw new Error('This is the book\'s only owner. Invite another owner first, or keep this one.');
  }
}

/** The transaction handle a callback inside `db.transaction` receives. */
type DbTx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

function audit(
  tx: DbTx,
  input: { companyId: string; action: 'user_invited' | 'user_removed' | 'user_role_changed' | 'user_password_changed'; actorId: string; entityId: string; field?: string; previousValue?: string; newValue?: string },
): void {
  const actor = tx.select().from(users).where(eq(users.id, input.actorId)).get();
  tx.insert(auditEvents).values({
    id: ids.audit(),
    companyId: input.companyId,
    occurredAt: nowIso(),
    entityType: 'user',
    entityId: input.entityId,
    action: input.action,
    field: input.field ?? null,
    previousValue: input.previousValue ?? null,
    newValue: input.newValue ?? null,
    source: 'user',
    actor: actor ? `${actor.displayName} (${actor.username})` : 'user',
  }).run();
}

/** Everyone with a login for this book, removed users included, newest first. */
export function listBookUsers(db: AppDatabase): Array<{
  id: string; username: string; displayName: string; role: Role;
  active: boolean; mustChangePassword: boolean; lastLoginAt: string | null;
}> {
  return db.select().from(users).orderBy(users.createdAt).all().map((u) => ({
    id: u.id, username: u.username, displayName: u.displayName, role: u.role,
    active: u.active, mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt,
  }));
}

/**
 * Invite a user to this book: a login with a one-time password, membership of
 * the company, and an audit record. The role decides what they may do (see
 * permissions.ts); membership decides which book they may do it in.
 */
export function inviteUser(
  db: AppDatabase,
  input: { companyId: string; actorId: string; username: string; displayName?: string; role: Role },
): InvitedUser {
  assertMemberAllowed(db, input.actorId, input.companyId, 'users.manage');

  if (!ROLES.includes(input.role)) throw new Error(`Unknown role "${input.role}".`);
  assertValidUsername(input.username);
  if (usernameTaken(db, input.username)) throw new Error(`The username "${input.username}" is already taken.`);

  const oneTimePassword = generateOneTimePassword();
  const { hash, salt } = hashPassword(oneTimePassword);
  const userId = ids.user();

  db.transaction((tx) => {
    tx.insert(users).values({
      id: userId,
      username: input.username,
      displayName: input.displayName?.trim() || input.username,
      passwordHash: hash,
      passwordSalt: salt,
      role: input.role,
      mustChangePassword: true,
      active: true,
    }).run();

    tx.insert(companyMembers).values({
      id: ids.member(),
      companyId: input.companyId,
      userId,
    }).run();

    audit(tx, {
      companyId: input.companyId,
      action: 'user_invited',
      actorId: input.actorId,
      entityId: userId,
      field: 'role',
      newValue: input.role,
    });
  });

  return { userId, username: input.username, role: input.role, oneTimePassword };
}

/**
 * Remove a user from the book. The user row stays (sessions and audit records
 * reference it, and the audit trail must keep naming them), but access ends:
 * deactivated, every session deleted, every membership gone.
 */
export function removeUser(
  db: AppDatabase,
  input: { companyId: string; actorId: string; userId: string },
): void {
  assertMemberAllowed(db, input.actorId, input.companyId, 'users.manage');

  if (input.actorId === input.userId) {
    throw new Error('You cannot remove yourself. Another owner must remove you.');
  }
  const target = db.select().from(users).where(eq(users.id, input.userId)).get();
  if (!target) throw new Error('No such user.');
  if (!target.active) throw new Error('This user has already been removed.');
  assertOwnerContinuity(db, input.userId, null);

  db.transaction((tx) => {
    tx.update(users).set({ active: false, updatedAt: nowIso() })
      .where(eq(users.id, input.userId)).run();
    tx.delete(sessions).where(eq(sessions.userId, input.userId)).run();
    tx.delete(companyMembers).where(eq(companyMembers.userId, input.userId)).run();

    audit(tx, {
      companyId: input.companyId,
      action: 'user_removed',
      actorId: input.actorId,
      entityId: input.userId,
      field: 'username',
      previousValue: target.username,
    });
  });
}

/**
 * Change what a user may do in the book. Recorded as previous/new role so the
 * audit trail answers "who let the bookkeeper file VAT?" years later.
 */
export function changeUserRole(
  db: AppDatabase,
  input: { companyId: string; actorId: string; userId: string; role: Role },
): void {
  assertMemberAllowed(db, input.actorId, input.companyId, 'users.manage');

  if (!ROLES.includes(input.role)) throw new Error(`Unknown role "${input.role}".`);
  if (input.actorId === input.userId) {
    throw new Error('You cannot change your own role. Another owner must change it.');
  }
  const target = db.select().from(users).where(eq(users.id, input.userId)).get();
  if (!target || !target.active) throw new Error('No such active user.');
  if (target.role === input.role) return;
  assertOwnerContinuity(db, input.userId, input.role);

  db.transaction((tx) => {
    tx.update(users).set({ role: input.role, updatedAt: nowIso() })
      .where(eq(users.id, input.userId)).run();
    // A role change ends the user's sessions: their next request re-reads the
    // new role instead of acting on a session issued under the old one.
    tx.delete(sessions).where(eq(sessions.userId, input.userId)).run();

    audit(tx, {
      companyId: input.companyId,
      action: 'user_role_changed',
      actorId: input.actorId,
      entityId: input.userId,
      field: 'role',
      previousValue: target.role,
      newValue: input.role,
    });
  });
}

/**
 * Issue a new one-time password. Done by an owner when someone has forgotten
 * theirs; the old password stops working immediately and every session ends.
 */
export function resetUserPassword(
  db: AppDatabase,
  input: { companyId: string; actorId: string; userId: string },
): string {
  assertMemberAllowed(db, input.actorId, input.companyId, 'users.manage');

  const target = db.select().from(users).where(eq(users.id, input.userId)).get();
  if (!target || !target.active) throw new Error('No such active user.');

  const oneTimePassword = generateOneTimePassword();
  const { hash, salt } = hashPassword(oneTimePassword);

  db.transaction((tx) => {
    tx.update(users).set({
      passwordHash: hash, passwordSalt: salt, mustChangePassword: true, updatedAt: nowIso(),
    }).where(eq(users.id, input.userId)).run();
    tx.delete(sessions).where(eq(sessions.userId, input.userId)).run();

    audit(tx, {
      companyId: input.companyId,
      action: 'user_password_changed',
      actorId: input.actorId,
      entityId: input.userId,
      field: 'password_reset',
    });
  });

  return oneTimePassword;
}

/**
 * Replace your own password — the required first act for an invited user, and
 * the ordinary "change password" for everyone else. Ends every other session
 * so a password change is also a "sign me out everywhere" the user controls.
 */
export function changeOwnPassword(
  db: AppDatabase,
  input: { userId: string; currentPassword: string; newPassword: string; keepSessionTokenHash?: string },
): void {
  const user = db.select().from(users).where(eq(users.id, input.userId)).get();
  if (!user || !user.active) throw new Error('Sign in again: your session has expired.');

  if (!verifyPassword(input.currentPassword, user.passwordHash, user.passwordSalt)) {
    throw new Error('That is not your current password.');
  }
  assertValidPassword(input.newPassword);

  const { hash, salt } = hashPassword(input.newPassword);

  db.transaction((tx) => {
    tx.update(users).set({
      passwordHash: hash, passwordSalt: salt, mustChangePassword: false, updatedAt: nowIso(),
    }).where(eq(users.id, input.userId)).run();

    const stale = input.keepSessionTokenHash
      ? and(eq(sessions.userId, input.userId), ne(sessions.tokenHash, input.keepSessionTokenHash))
      : eq(sessions.userId, input.userId);
    tx.delete(sessions).where(stale).run();
  });
}

/** The roles an invoker may hand out, with the label the UI shows. */
export function invitableRoles(): Array<{ role: Role; label: string }> {
  return ROLES.map((role) => ({ role, label: ROLE_LABELS[role] }));
}

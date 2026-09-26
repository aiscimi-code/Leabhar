import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { auditEvents, sessions, users, companyMembers } from '@/db/schema';
import type { AppDatabase } from '@/db';
import { createUser, authenticateUser, createSession } from './auth';
import { createCompany } from '../config/setup';
import { PermissionError } from './permissions';
import {
  inviteUser, removeUser, changeUserRole, resetUserPassword, changeOwnPassword, listBookUsers,
} from './users';

/**
 * The user lifecycle of a local book (issue #298): invite with a one-time
 * password, remove, change role, reset password. Everything must land in the
 * audit trail, and the last owner must never be removable or demotable.
 */

let db: AppDatabase;
let companyId: string;
let ownerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
  const owner = createUser(db, { username: 'owner', password: 'password123', displayName: 'The Owner' });
  ownerId = owner.id;
});

const lastAudit = () => db.select().from(auditEvents)
  .where(and(eq(auditEvents.entityType, 'user'))).all().at(-1)!;

describe('inviteUser', () => {
  it('creates a user on a one-time password and records the invite', () => {
    const invited = inviteUser(db, {
      companyId, actorId: ownerId, username: 'bern', displayName: 'Bernard', role: 'bookkeeper',
    });

    expect(invited.role).toBe('bookkeeper');
    expect(invited.oneTimePassword.length).toBeGreaterThanOrEqual(8);

    const row = db.select().from(users).where(eq(users.id, invited.userId)).get()!;
    expect(row.mustChangePassword).toBe(true);
    expect(row.active).toBe(true);

    // The one-time password works, exactly once shown, and the new user is a
    // member of the business they were invited to.
    expect(authenticateUser(db, 'bern', invited.oneTimePassword)?.role).toBe('bookkeeper');
    expect(db.select().from(companyMembers)
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, invited.userId))).get())
      .toBeDefined();

    const audit = lastAudit();
    expect(audit.action).toBe('user_invited');
    expect(audit.newValue).toBe('bookkeeper');
    expect(audit.entityId).toBe(invited.userId);
    expect(audit.actor).toContain('The Owner');
  });

  it('refuses a username that is already taken', () => {
    inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });
    expect(() => inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'auditor' }))
      .toThrow(/already taken/);
  });

  it('refuses an invite from anyone but the owner', () => {
    const bookkeeper = inviteUser(db, {
      companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper',
    });
    expect(() => inviteUser(db, {
      companyId, actorId: bookkeeper.userId, username: 'someone', role: 'readonly',
    })).toThrow(PermissionError);
  });

  it('leaves nothing behind when it refuses', () => {
    expect(() => inviteUser(db, { companyId, actorId: ownerId, username: 'x', role: 'bookkeeper' }))
      .toThrow(/2 and 40/);
    expect(db.select().from(users).all()).toHaveLength(1);
    expect(db.select().from(companyMembers).all()).toHaveLength(1);
  });
});

describe('removeUser', () => {
  it('ends access completely: deactivated, signed out, no longer a member', () => {
    const invited = inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });
    const authed = authenticateUser(db, 'bern', invited.oneTimePassword)!;
    const session = createSession(db, authed);

    removeUser(db, { companyId, actorId: ownerId, userId: invited.userId });

    expect(db.select().from(users).where(eq(users.id, invited.userId)).get()!.active).toBe(false);
    expect(db.select().from(sessions).where(eq(sessions.userId, invited.userId)).all()).toHaveLength(0);
    expect(db.select().from(companyMembers).where(eq(companyMembers.userId, invited.userId)).all()).toHaveLength(0);
    expect(authenticateUser(db, 'bern', invited.oneTimePassword)).toBeNull();

    const audit = lastAudit();
    expect(audit.action).toBe('user_removed');
    expect(audit.previousValue).toBe('bern');
  });

  it('refuses to let a user remove themselves', () => {
    expect(() => removeUser(db, { companyId, actorId: ownerId, userId: ownerId }))
      .toThrow(/cannot remove yourself/);
  });

  it('refuses to remove the last owner — a book always keeps one', () => {
    // With two owners, one removing the other is fine: one remains.
    const second = inviteUser(db, { companyId, actorId: ownerId, username: 'deirdre', role: 'owner' });
    expect(() => removeUser(db, { companyId, actorId: second.userId, userId: ownerId })).not.toThrow();
    expect(db.select().from(users).where(eq(users.id, ownerId)).get()!.active).toBe(false);

    // deirdre is now the only owner. The only person who could remove them is
    // themselves, and that is refused — the book cannot lock itself out of
    // its own administration.
    expect(() => removeUser(db, { companyId, actorId: second.userId, userId: second.userId }))
      .toThrow(/cannot remove yourself/);
    expect(db.select().from(users).where(eq(users.id, second.userId)).get()!.active).toBe(true);
  });
});

describe('changeUserRole', () => {
  it('records the previous and the new role', () => {
    const invited = inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });

    changeUserRole(db, { companyId, actorId: ownerId, userId: invited.userId, role: 'accountant' });

    expect(db.select().from(users).where(eq(users.id, invited.userId)).get()!.role).toBe('accountant');
    const audit = lastAudit();
    expect(audit.action).toBe('user_role_changed');
    expect(audit.previousValue).toBe('bookkeeper');
    expect(audit.newValue).toBe('accountant');
  });

  it('ends the changed user\'s sessions so the new role applies immediately', () => {
    const invited = inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });
    const authed = authenticateUser(db, 'bern', invited.oneTimePassword)!;
    createSession(db, authed);

    changeUserRole(db, { companyId, actorId: ownerId, userId: invited.userId, role: 'readonly' });

    expect(db.select().from(sessions).where(eq(sessions.userId, invited.userId)).all()).toHaveLength(0);
  });

  it('refuses a self-promotion or self-demotion', () => {
    expect(() => changeUserRole(db, { companyId, actorId: ownerId, userId: ownerId, role: 'readonly' }))
      .toThrow(/own role/);
  });

  it('may demote one of several owners — the book keeps the other', () => {
    const second = inviteUser(db, { companyId, actorId: ownerId, username: 'deirdre', role: 'owner' });
    changeUserRole(db, { companyId, actorId: ownerId, userId: second.userId, role: 'readonly' });
    expect(db.select().from(users).where(eq(users.id, second.userId)).get()!.role).toBe('readonly');
    expect(db.select().from(users).where(eq(users.id, ownerId)).get()!.role).toBe('owner');
  });

  it('refuses a change from anyone but the owner', () => {
    const invited = inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });
    expect(() => changeUserRole(db, {
      companyId, actorId: invited.userId, userId: ownerId, role: 'readonly',
    })).toThrow(PermissionError);
  });
});

describe('passwords', () => {
  it('reset issues a one-time password and kills the old one', () => {
    const invited = inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });
    const authed = authenticateUser(db, 'bern', invited.oneTimePassword)!;
    createSession(db, authed);

    const oneTime = resetUserPassword(db, { companyId, actorId: ownerId, userId: invited.userId });

    expect(authenticateUser(db, 'bern', invited.oneTimePassword)).toBeNull();
    expect(authenticateUser(db, 'bern', oneTime)?.mustChangePassword).toBe(true);
    expect(db.select().from(sessions).where(eq(sessions.userId, invited.userId)).all()).toHaveLength(0);
    expect(lastAudit().action).toBe('user_password_changed');
  });

  it('changeOwnPassword replaces the one-time password and clears the flag', () => {
    const invited = inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });
    const authed = authenticateUser(db, 'bern', invited.oneTimePassword)!;
    const kept = createSession(db, authed);
    createSession(db, authed);

    changeOwnPassword(db, {
      userId: invited.userId,
      currentPassword: invited.oneTimePassword,
      newPassword: 'a-fresh-password',
      keepSessionTokenHash: hashOf(kept.token),
    });

    const row = db.select().from(users).where(eq(users.id, invited.userId)).get()!;
    expect(row.mustChangePassword).toBe(false);
    expect(authenticateUser(db, 'bern', 'a-fresh-password')?.role).toBe('bookkeeper');
    // The session the change was made from survives; the other one is gone.
    const remaining = db.select().from(sessions).where(eq(sessions.userId, invited.userId)).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.tokenHash).toBe(hashOf(kept.token));
  });

  it('refuses a change without the current password', () => {
    const invited = inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });
    expect(() => changeOwnPassword(db, {
      userId: invited.userId, currentPassword: 'wrong', newPassword: 'a-fresh-password',
    })).toThrow(/not your current password/);
  });
});

describe('listBookUsers', () => {
  it('lists everyone with their role and state, removed users included', () => {
    const invited = inviteUser(db, { companyId, actorId: ownerId, username: 'bern', role: 'bookkeeper' });
    const second = inviteUser(db, { companyId, actorId: ownerId, username: 'deirdre', role: 'owner' });

    removeUser(db, { companyId, actorId: second.userId, userId: invited.userId });

    const listed = listBookUsers(db);
    expect(listed.map((u) => u.username)).toEqual(['owner', 'bern', 'deirdre']);
    const bern = listed.find((u) => u.username === 'bern')!;
    expect(bern.active).toBe(false);
    expect(listed.find((u) => u.username === 'deirdre')!.role).toBe('owner');
  });
});

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

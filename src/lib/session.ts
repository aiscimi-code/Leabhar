import { cookies } from 'next/headers';
import { getDb } from '@/db';
import { verifySession, type AuthUser } from '@/domain/auth/auth';
import { sessionCookieName } from '@/domain/auth/constants';
import { assertAllowed, assertMemberAllowed, type Action } from '@/domain/auth/permissions';
import { activeCompany } from './queries';

/** The signed-in user, verified against the database (not just the cookie). */
export async function currentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  return verifySession(getDb(), store.get(sessionCookieName)?.value);
}

/** Who to record as having made a decision: the signed-in user's name. */
export async function actorName(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('Sign in again: your session has expired.');
  return user.displayName || user.username;
}

/**
 * The permission gate every mutating server action passes through (issue #298).
 *
 * Checks three things, in order: someone is signed in, they have replaced
 * their one-time password (a user still on an invoker's password cannot act),
 * and their role permits this action on this company (the active one, or the
 * one named). The matrix itself lives
 * in src/domain/auth/permissions.ts — this function applies it, it does not
 * decide it. Throws with a message the UI can show as-is.
 *
 * When no company exists yet, only `company.manage` is allowed (create the
 * first book or load a demo). Membership cannot be checked until there is a
 * company to be a member of.
 */
export async function requireActor(action: Action, companyId?: string): Promise<AuthUser> {
  const user = await currentUser();
  if (!user) throw new Error('Sign in again: your session has expired.');
  if (user.mustChangePassword) {
    throw new Error('Change your password first (Setup → Change password): you are still on the one-time password your invoker set.');
  }
  const db = getDb();
  if (companyId) {
    assertMemberAllowed(db, user.id, companyId, action);
    return user;
  }
  const company = activeCompany();
  if (!company) {
    if (action !== 'company.manage') {
      throw new Error('No company has been set up yet.');
    }
    assertAllowed(user.role, action);
    return user;
  }
  assertMemberAllowed(db, user.id, company.id, action);
  return user;
}

import { cookies } from 'next/headers';
import { getDb } from '@/db';
import { verifySession, type AuthUser } from '@/domain/auth/auth';
import { sessionCookieName } from '@/domain/auth/constants';

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

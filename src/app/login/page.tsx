import { cookies } from 'next/headers';
import { getDb } from '@/db';
import { userCount, verifySession, sessionCookieName } from '@/domain/auth/auth';
import { LoginForm } from '@/components/LoginForm';
import { loginAction, setupAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Login or first-run setup page.
 *
 * If no user exists yet, this is the setup screen. Otherwise it's the
 * login screen. Both are server-rendered so the decision is made before
 * any client JavaScript runs.
 */
export default async function LoginPage() {
  const db = getDb();
  const hasUser = userCount(db) > 0;
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  const existingSession = verifySession(db, token);

  if (existingSession) {
    // Already logged in — redirect to home.
    // Using a meta refresh since this is a server component.
    return (
      <meta httpEquiv="refresh" content="0; url=/" />
    );
  }

  return (
    <LoginForm
      mode={hasUser ? 'login' : 'setup'}
      action={hasUser ? loginAction : setupAction}
    />
  );
}

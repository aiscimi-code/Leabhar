import { getDb } from '@/db';
import { assertMemberAllowed, type Action } from '@/domain/auth/permissions';
import { currentUser } from './session';
import { requireCompany } from './queries';

/**
 * The permission gate for API routes (issue #372), the read-route counterpart
 * of `requireActor` for server actions.
 *
 * Middleware runs on the Edge and can only check that a session cookie exists;
 * it cannot verify the session against the database, so a removed user's
 * stale cookie passes it. This helper verifies the session, then applies the
 * role matrix (`docs/API.md` rule 3): 401 when nobody is signed in, 403 with
 * the matrix's own message when the role or membership refuses.
 *
 * Returns the refusal as a `Response` for the route to return as-is, or
 * `null` when the caller may proceed.
 */
export async function requireApiActor(action: Action): Promise<Response | null> {
  const user = await currentUser();
  if (!user) return new Response('Not signed in.', { status: 401 });
  if (user.mustChangePassword) {
    return new Response(
      'Change your password first: you are still on the one-time password your invoker set.',
      { status: 403 },
    );
  }
  try {
    assertMemberAllowed(getDb(), user.id, requireCompany().id, action);
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Not allowed.', { status: 403 });
  }
  return null;
}

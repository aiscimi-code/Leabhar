import { version } from '../../../../package.json';

export const dynamic = 'force-dynamic';

/**
 * Minimal liveness check for the packaged launcher (issue #61) —
 * scripts/launcher.cjs polls this instead of the site root, so a 200 here
 * means "the Next.js server itself is up and serving," distinct from
 * whether the app underneath it (database, migrations) is healthy. Kept
 * dependency-free on purpose: it must never fail for a reason other than
 * "the server process isn't actually listening yet."
 */
export async function GET(): Promise<Response> {
  return Response.json({ status: 'ok', version });
}

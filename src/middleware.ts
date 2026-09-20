import { NextRequest, NextResponse } from 'next/server';
import { sessionCookieName } from '@/domain/auth/constants';

/**
 * Authentication middleware (issue #46).
 *
 * Redirects unauthenticated requests to /login. When no user exists yet,
 * the login page shows the first-run setup screen instead.
 *
 * Middleware runs on the Edge runtime and cannot access the database, so
 * it checks only for the cookie's presence. Full session verification
 * (expiry, active user) happens in the server component / action layer.
 * The cookie is httpOnly and set only by the login action, so presence
 * is a strong signal of a real session.
 */

const PUBLIC_PATHS = ['/login'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow the login page, static assets, and the portal (issue #166):
  // the portal has its own per-vault password, unrelated to this app's
  // single local-install login, and by design keeps nothing server-side for
  // that login to gate access to in the first place.
  if (
    PUBLIC_PATHS.includes(pathname)
    || pathname.startsWith('/_next')
    || pathname.startsWith('/favicon')
    || pathname.startsWith('/portal')
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get(sessionCookieName)?.value;

  if (token) {
    return NextResponse.next();
  }

  // No session cookie — redirect to login.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - /_next/* (Next.js internals)
     * - /favicon.ico
     * - /login (the login page itself)
     * - /portal/* (issue #166 — its own password, no server-side session)
     */
    '/((?!_next|favicon.ico|login|portal).*)',
  ],
};

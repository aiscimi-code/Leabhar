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
 *
 * www.fgi.ie (and the apex, which redirects here) is the public Vercel
 * deployment. That host has no local database, so the installed-app login
 * cannot run there. Visitors are sent to /portal, which is the hosted site.
 */

const PUBLIC_PATHS = ['/login', '/api/health'];

const PUBLIC_SITE_HOSTS = new Set(['fgi.ie', 'www.fgi.ie']);

function requestHost(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const raw = forwarded || request.headers.get('host') || request.nextUrl.host;
  const host = raw.split(':')[0] ?? '';
  return host.toLowerCase();
}

function continueRequest(request: NextRequest, markPortal: boolean) {
  if (!markPortal) return NextResponse.next();
  const headers = new Headers(request.headers);
  headers.set('x-leabhar-portal', '1');
  return NextResponse.next({ request: { headers } });
}

function isPublicSite(request: NextRequest): boolean {
  return PUBLIC_SITE_HOSTS.has(requestHost(request));
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const onPortal = pathname === '/portal' || pathname.startsWith('/portal/');

  // The public domain only serves the portal. Every other route in this app
  // reads the on-disk database, which does not exist on Vercel.
  if (isPublicSite(request)) {
    const allowed =
      onPortal
      || pathname.startsWith('/_next')
      || pathname.startsWith('/favicon')
      || pathname === '/api/health';
    if (!allowed) {
      const portalUrl = request.nextUrl.clone();
      portalUrl.pathname = '/portal';
      portalUrl.search = '';
      return NextResponse.redirect(portalUrl);
    }
    return continueRequest(request, onPortal);
  }

  // Always allow the login page, static assets, the portal (issue #166),
  // and the health check (issue #61): the packaged launcher polls
  // /api/health before any user has ever logged in — a session cookie
  // can't exist yet at that point, so gating it behind auth would mean
  // the launcher's readiness check can never succeed. The portal has its
  // own per-vault password, unrelated to this app's single local-install
  // login, and by design keeps nothing server-side for that login to gate
  // access to in the first place.
  if (
    PUBLIC_PATHS.includes(pathname)
    || pathname.startsWith('/_next')
    || pathname.startsWith('/favicon')
    || onPortal
  ) {
    return continueRequest(request, onPortal);
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
     * - /api/health (issue #61 — polled by the launcher before any login exists)
     *
     * /portal is matched so this function can mark the request. The portal
     * keeps its own vault password and is not gated by the local session.
     * /login is matched on purpose: the public domain redirects it to /portal.
     * On a local install it is still allowed through below.
     */
    '/((?!_next|favicon.ico|api/health).*)',
  ],
};

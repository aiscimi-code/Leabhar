import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
import { sessionCookieName } from '@/domain/auth/constants';

function request(path: string, cookie?: string, host = 'localhost:3000'): NextRequest {
  const req = new NextRequest(new URL(path, `http://${host}`));
  if (cookie) req.cookies.set(sessionCookieName, cookie);
  return req;
}

/** The request headers the middleware forwards to the app, as Next.js records them on the response. */
function forwarded(res: Response, name: string): string | null {
  return res.headers.get(`x-middleware-request-${name}`);
}

describe('middleware', () => {
  it('drops a client-sent x-leabhar-public or x-leabhar-portal on an ordinary path (issue #482)', () => {
    // A stale cookie plus a hand-set header must not skip the root layout's
    // session check, nor render the app as the portal.
    const req = request('/reports', 'a-stale-session-token');
    req.headers.set('x-leabhar-public', '1');
    req.headers.set('x-leabhar-portal', '1');
    const res = middleware(req);
    expect(res.headers.get('location')).toBeNull();
    expect(forwarded(res, 'x-leabhar-public')).toBeNull();
    expect(forwarded(res, 'x-leabhar-portal')).toBeNull();
    // Without an override Next.js forwards the client's own headers untouched,
    // so the middleware must send an explicit header set, and that set must not
    // carry either marker.
    const override = res.headers.get('x-middleware-override-headers');
    expect(override).not.toBeNull();
    expect(override).not.toMatch(/x-leabhar-(public|portal)/);
  });

  it('marks /login public itself, whatever the client sent', () => {
    const res = middleware(request('/login'));
    expect(forwarded(res, 'x-leabhar-public')).toBe('1');
  });


  it('lets /api/health through with no session cookie (issue #61)', () => {
    // The packaged launcher polls this before any user has ever logged in —
    // gating it behind auth would mean the launcher's readiness check can
    // never succeed, since no session cookie can exist yet at that point.
    const res = middleware(request('/api/health'));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects an ordinary protected path to /login with no session cookie', () => {
    const res = middleware(request('/dashboard'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('lets an ordinary path through once a session cookie is present', () => {
    const res = middleware(request('/dashboard', 'a-real-session-token'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('still lets /login through with no session cookie', () => {
    const res = middleware(request('/login'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('sends the public site root to the portal, not the local login', () => {
    const res = middleware(request('/', undefined, 'www.fgi.ie'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://www.fgi.ie/portal');
  });

  it('sends the apex host to the portal as well', () => {
    const res = middleware(request('/login', undefined, 'fgi.ie'));
    expect(res.headers.get('location')).toBe('http://fgi.ie/portal');
  });

  it('honours x-forwarded-host when Vercel rewrites the host header', () => {
    const req = request('/transactions', undefined, 'leabhar.vercel.app');
    req.headers.set('x-forwarded-host', 'www.fgi.ie');
    const res = middleware(req);
    expect(res.headers.get('location')).toBe('http://leabhar.vercel.app/portal');
  });

  it('still sends a local install root to login', () => {
    const res = middleware(request('/'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });
});

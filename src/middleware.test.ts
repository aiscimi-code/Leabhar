import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';
import { sessionCookieName } from '@/domain/auth/constants';

function request(path: string, cookie?: string): NextRequest {
  const req = new NextRequest(new URL(path, 'http://localhost:3000'));
  if (cookie) req.cookies.set(sessionCookieName, cookie);
  return req;
}

describe('middleware', () => {
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
});

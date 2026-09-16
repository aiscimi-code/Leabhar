'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import {
  authenticateUser, createSession, createUser, userCount,
  sessionCookieName, sessionExpiryDays,
} from '@/domain/auth/auth';
import type { ActionResult } from '../settings-actions';

/**
 * Server actions for login and first-run setup.
 *
 * On success, a session cookie is set and the user is redirected to home.
 */

export async function loginAction(formData: FormData): Promise<ActionResult> {
  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!username || !password) {
    return { ok: false, error: 'Username and password are required.' };
  }

  const db = getDb();
  const user = authenticateUser(db, username, password);

  if (!user) {
    return { ok: false, error: 'Incorrect username or password.' };
  }

  const session = createSession(db, user);
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: sessionExpiryDays * 24 * 60 * 60,
    path: '/',
  });

  redirect('/');
}

export async function setupAction(formData: FormData): Promise<ActionResult> {
  const db = getDb();

  if (userCount(db) > 0) {
    return { ok: false, error: 'A user already exists. Use the login page instead.' };
  }

  const username = String(formData.get('username') ?? '');
  const password = String(formData.get('password') ?? '');
  const displayName = String(formData.get('displayName') ?? '');

  if (!username || username.length < 2) {
    return { ok: false, error: 'Username must be at least 2 characters.' };
  }
  if (!password || password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters.' };
  }

  const user = createUser(db, { username, password, displayName: displayName || undefined });
  const session = createSession(db, user);
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: sessionExpiryDays * 24 * 60 * 60,
    path: '/',
  });

  redirect('/');
}

export async function logoutAction(): Promise<ActionResult> {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;

  if (token) {
    const db = getDb();
    const { deleteSession } = await import('@/domain/auth/auth');
    deleteSession(db, token);
  }

  cookieStore.delete(sessionCookieName);
  redirect('/login');
}

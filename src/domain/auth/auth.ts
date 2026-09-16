import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, and, lt } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { users, sessions } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';

/**
 * Local single-user authentication (README §3, issue #46).
 *
 * One user, one session at a time. scrypt for the password hash, a
 * random token hashed with SHA-256 for the session cookie. Nothing
 * leaves the machine; the cookie is httpOnly and local-only.
 */

const SESSION_COOKIE = 'leabhar-session';
const SESSION_DAYS = 30;

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: 'owner' | 'user' | 'readonly';
}

export interface SessionResult {
  user: AuthUser;
  token: string;
  expiresAt: string;
}

// ---- Password hashing ----

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): boolean {
  const computed = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

// ---- Session management ----

export function createSession(
  db: AppDatabase,
  user: AuthUser,
  ip?: string,
): SessionResult {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashTokenSha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.insert(sessions).values({
    id: ids.session(),
    userId: user.id,
    tokenHash,
    expiresAt,
    createdIp: ip ?? null,
  }).run();

  return { user, token, expiresAt };
}

function hashTokenSha256(token: string): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(token).digest('hex');
}

export function verifySession(
  db: AppDatabase,
  token: string | undefined,
): AuthUser | null {
  if (!token) return null;
  const tokenHash = hashTokenSha256(token);

  const session = db.select().from(sessions)
    .where(eq(sessions.tokenHash, tokenHash)).get();

  if (!session) return null;
  if (session.expiresAt < nowIso()) return null;

  const user = db.select().from(users)
    .where(eq(users.id, session.userId)).get();

  if (!user || !user.active) return null;

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

export function deleteSession(db: AppDatabase, token: string): void {
  const tokenHash = hashTokenSha256(token);
  db.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
}

export function cleanExpiredSessions(db: AppDatabase): void {
  db.delete(sessions).where(lt(sessions.expiresAt, nowIso())).run();
}

// ---- User management ----

export function userCount(db: AppDatabase): number {
  return db.select().from(users).all().length;
}

export function createUser(
  db: AppDatabase,
  input: { username: string; password: string; displayName?: string },
): AuthUser {
  const { hash, salt } = hashPassword(input.password);
  const id = ids.user();

  db.insert(users).values({
    id,
    username: input.username,
    displayName: input.displayName ?? input.username,
    passwordHash: hash,
    passwordSalt: salt,
    role: 'owner',
    active: true,
  }).run();

  return { id, username: input.username, displayName: input.displayName ?? input.username, role: 'owner' };
}

export function authenticateUser(
  db: AppDatabase,
  username: string,
  password: string,
): AuthUser | null {
  const user = db.select().from(users)
    .where(eq(users.username, username)).get();

  if (!user || !user.active) return null;
  if (!verifyPassword(password, user.passwordHash, user.passwordSalt)) return null;

  db.update(users).set({ lastLoginAt: nowIso() })
    .where(eq(users.id, user.id)).run();

  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}

// ---- Cookie helpers ----

export const sessionCookieName = SESSION_COOKIE;
export const sessionExpiryDays = SESSION_DAYS;

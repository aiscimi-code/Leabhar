import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { users, companyMembers } from '@/db/schema';

/**
 * The permission matrix (issue #298).
 *
 * One table decides what each role may do. It lives in the domain layer so
 * every surface — the web UI's server actions, the CLI, a future MCP or API —
 * answers the same question the same way. Nothing else in the codebase decides
 * who may do what; a surface either consults this module or enforces nothing.
 *
 * Local-first (see docs/ROLES.md): these are people opening one book on one
 * machine. There is no server to protect against, so the matrix is about who
 * may change the books of account — an accountant opening a client's book, an
 * auditor inspecting it, a bookkeeper doing the day-to-day work in it.
 */

/** The roles a user of this book may hold. */
export const ROLES = [
  'owner', 'director', 'accountant', 'bookkeeper', 'employee', 'farm_manager', 'auditor', 'readonly',
] as const;

export type Role = (typeof ROLES)[number];

/** What a role is for, shown on the invite screen and in docs/ROLES.md. */
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner — full control of this book, including its users',
  director: 'Director — runs the business, but does not administer the book',
  accountant: 'Accountant — prepares accounts and returns; no user administration',
  bookkeeper: 'Bookkeeper — day-to-day entry work; does not file returns',
  employee: 'Employee — submits receipts and documents only',
  farm_manager: 'Farm manager — records the farm\'s day-to-day transactions',
  auditor: 'Auditor — reads everything, including the audit trail; changes nothing',
  readonly: 'Read-only — views the books and nothing else',
};

/** The actions the matrix governs. Kept coarse: one per capability, not per screen. */
export const ACTIONS = [
  'books.read',            // view any figure, document or report in the book
  'audit.read',           // read the audit trail
  'reports.export',       // export packs, statements and listings
  'documents.ingest',      // import or scan documents in
  'banking.import',       // import bank statements
  'banking.reconcile',    // reconcile bank accounts
  'transactions.classify', // classify or reclassify a bank transaction
  'parties.manage',        // suppliers, customers and their VAT status
  'capital_goods.manage',  // register capital goods and record their scheme intervals
  'ct.decisions',          // corporation tax treatments and computations
  'documents.review',     // confirm or reject an extraction, match or link
  'documents.post',       // post a confirmed document as an invoice
  'invoices.manage',      // create, void or settle sales and purchase invoices
  'journals.post',        // post manual journals and adjustments
  'vat.file',             // close, lock, amend or file a VAT period
  'config.manage',        // chart of accounts, rates, treatments, company settings
  'rules.manage',         // create, edit or disable classification rules
  'company.manage',       // create a company, change its identity, periods
  'backup.manage',        // create, verify or restore a backup
  'users.manage',         // invite, remove or change the role of a user
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * The matrix itself: the roles allowed for each action.
 *
 * Principles:
 * - reading the books is broad (anyone the owner gave a login to may look);
 * - changing the books narrows fast, and filing with Revenue narrowest;
 * - only the owner administers the book itself — its users, its company
 *   identity and its backups;
 * - the auditor reads everything including the audit trail and changes
 *   nothing, which is what distinguishes it from plain read-only.
 */
export const PERMISSIONS: Record<Action, readonly Role[]> = {
  'books.read': ['owner', 'director', 'accountant', 'bookkeeper', 'employee', 'farm_manager', 'auditor', 'readonly'],
  'audit.read': ['owner', 'director', 'accountant', 'auditor'],
  'reports.export': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager', 'auditor'],
  'documents.ingest': ['owner', 'director', 'accountant', 'bookkeeper', 'employee', 'farm_manager'],
  'banking.import': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'banking.reconcile': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'transactions.classify': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'parties.manage': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'capital_goods.manage': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'ct.decisions': ['owner', 'director', 'accountant'],
  'documents.review': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'documents.post': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'invoices.manage': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'journals.post': ['owner', 'director', 'accountant', 'bookkeeper'],
  'vat.file': ['owner', 'director', 'accountant'],
  'config.manage': ['owner', 'director', 'accountant'],
  'rules.manage': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager'],
  'company.manage': ['owner', 'director'],
  'backup.manage': ['owner', 'director'],
  'users.manage': ['owner'],
};

/** May this role perform this action? */
export function can(role: Role, action: Action): boolean {
  return PERMISSIONS[action].includes(role);
}

/** The roles that may perform an action — the invite screen offers exactly these. */
export function rolesAllowed(action: Action): readonly Role[] {
  return PERMISSIONS[action];
}

/** Thrown when a role may not perform an action. Carries both halves of the refusal. */
export class PermissionError extends Error {
  constructor(readonly role: Role, readonly action: Action) {
    super(`A ${role} may not perform "${action}". Ask the book's owner to do it, or to change your role.`);
    this.name = 'PermissionError';
  }
}

/** Refuse, with a reason the UI can show as-is. */
export function assertAllowed(role: Role, action: Action): void {
  if (!can(role, action)) throw new PermissionError(role, action);
}

// ---- Membership (business membership, issue #298) ----

/**
 * The user row as the permission layer sees it: `null` when the user does not
 * exist or has been removed. A removed user's session must stop working even
 * if its cookie is still present, so membership checks read the database, not
 * the session's cached role.
 */
export function effectiveUser(db: AppDatabase, userId: string): { role: Role } | null {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !user.active) return null;
  return { role: user.role };
}

/** Is this user a member of this company's books? */
export function isCompanyMember(db: AppDatabase, userId: string, companyId: string): boolean {
  const membership = db.select().from(companyMembers)
    .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId))).get();
  if (membership) return true;

  // Books created before membership existed (issue #298) have no rows: the
  // first user set the book up, so they are the owner of everything in it.
  const memberCount = db.select().from(companyMembers).all().length;
  if (memberCount === 0) {
    const user = db.select().from(users).where(eq(users.id, userId)).get();
    if (user?.role === 'owner') return true;
  }
  return false;
}

/**
 * The full check a mutating path owes: the user exists, is a member of the
 * company, and their role permits the action. Membership without permission is
 * a viewer with a login; permission without membership is a role that cannot
 * touch this particular book.
 */
export function assertMemberAllowed(
  db: AppDatabase,
  userId: string,
  companyId: string,
  action: Action,
): Role {
  const user = effectiveUser(db, userId);
  if (!user) throw new Error('This user no longer has access to the book. Sign in again.');
  if (!isCompanyMember(db, userId, companyId)) {
    throw new Error('This user is not a member of this company\'s books.');
  }
  assertAllowed(user.role, action);
  return user.role;
}

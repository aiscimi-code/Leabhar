import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { users, companyMembers } from '@/db/schema';
import { createUser } from './auth';
import { createCompany } from '../config/setup';
import {
  PERMISSIONS, ROLES, ACTIONS, can, assertAllowed, rolesAllowed,
  PermissionError, effectiveUser, isCompanyMember, assertMemberAllowed,
  type Action, type Role,
} from './permissions';

/**
 * The permission matrix (issue #298). The expected table below is written out
 * cell by cell — not derived from the module — so this test fails if anyone
 * changes what a role may do without saying so here.
 */

// The matrix as this test expects it. Every action x every role has a cell.
const EXPECTED: Record<Action, readonly Role[]> = {
  'books.read': ['owner', 'director', 'accountant', 'bookkeeper', 'employee', 'farm_manager', 'auditor', 'readonly'],
  'audit.read': ['owner', 'director', 'accountant', 'auditor'],
  'reports.export': ['owner', 'director', 'accountant', 'bookkeeper', 'farm_manager', 'auditor'],
  'documents.ingest': ['owner', 'director', 'accountant', 'bookkeeper', 'employee', 'farm_manager'],
  'documents.manage': ['owner', 'director', 'accountant'],
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

describe('permission matrix', () => {
  it('covers every action with the expected set of roles', () => {
    for (const action of ACTIONS) {
      expect(PERMISSIONS[action], `matrix row for ${action}`).toEqual(EXPECTED[action]);
    }
  });

  it('answers every cell: each role against each action', () => {
    for (const action of ACTIONS) {
      for (const role of ROLES) {
        expect(
          can(role, action),
          `cell (${role}, ${action})`,
        ).toBe(EXPECTED[action].includes(role));
      }
    }
  });

  it('keeps the expected table exhaustive: no action or role exists outside it', () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const roles of Object.values(EXPECTED)) {
      for (const role of roles) expect(ROLES).toContain(role);
    }
  });

  it('gives read-only nothing but the books', () => {
    for (const action of ACTIONS) {
      expect(can('readonly', action)).toBe(action === 'books.read');
    }
  });

  it('gives the auditor the books, the audit trail and exports, and nothing else', () => {
    for (const action of ACTIONS) {
      const expected = action === 'books.read' || action === 'audit.read' || action === 'reports.export';
      expect(can('auditor', action), `auditor ${action}`).toBe(expected);
    }
  });

  it('lets an employee submit documents and change nothing else', () => {
    for (const action of ACTIONS) {
      const expected = action === 'books.read' || action === 'documents.ingest';
      expect(can('employee', action), `employee ${action}`).toBe(expected);
    }
  });

  it('reserves user administration for the owner alone', () => {
    expect(rolesAllowed('users.manage')).toEqual(['owner']);
  });

  it('does not let a bookkeeper file a VAT return', () => {
    expect(can('bookkeeper', 'vat.file')).toBe(false);
    expect(can('accountant', 'vat.file')).toBe(true);
  });

  it('throws a PermissionError that names the role and the action', () => {
    expect(() => assertAllowed('bookkeeper', 'users.manage')).toThrow(PermissionError);
    try {
      assertAllowed('bookkeeper', 'users.manage');
    } catch (e) {
      const err = e as PermissionError;
      expect(err.role).toBe('bookkeeper');
      expect(err.action).toBe('users.manage');
      expect(err.message).toContain('bookkeeper');
    }
  });
});

describe('business membership', () => {
  function setup() {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Member Ltd', seedYears: [2025] });
    const owner = createUser(db, { username: 'owner', password: 'password123' });
    return { db, companyId, owner };
  }

  it('makes the first user a member of the company', () => {
    const { db, companyId, owner } = setup();
    expect(isCompanyMember(db, owner.id, companyId)).toBe(true);
    expect(assertMemberAllowed(db, owner.id, companyId, 'users.manage')).toBe('owner');
  });

  it('reads the role from the database, not the session that asked', () => {
    const { db, companyId, owner } = setup();
    expect(effectiveUser(db, owner.id)).toEqual({ role: 'owner' });
    expect(isCompanyMember(db, owner.id, companyId)).toBe(true);
  });

  it('refuses a user who is not a member of the company, whatever their role', () => {
    const { db, companyId } = setup();
    // A user row with no membership: possible only by editing the database
    // directly, which is exactly what this check exists to catch.
    db.insert(users).values({
      id: 'usr_outsider', username: 'outsider', displayName: 'Outsider',
      passwordHash: 'x', passwordSalt: 'y', role: 'owner', active: true,
    }).run();

    expect(isCompanyMember(db, 'usr_outsider', companyId)).toBe(false);
    expect(() => assertMemberAllowed(db, 'usr_outsider', companyId, 'books.read'))
      .toThrow(/not a member/);
  });

  it('refuses a removed user even on a membership row that somehow survived', () => {
    const { db, companyId, owner } = setup();
    db.update(users).set({ active: false }).where(eq(users.id, owner.id)).run();

    expect(effectiveUser(db, owner.id)).toBeNull();
    expect(() => assertMemberAllowed(db, owner.id, companyId, 'books.read'))
      .toThrow(/no longer has access/);
  });

  it('still admits the owner of a book created before membership rows existed', () => {
    const { db, companyId } = setup();
    db.delete(companyMembers).run(); // a pre-#298 book has no membership rows

    const owner = db.select().from(users).get()!;
    expect(isCompanyMember(db, owner.id, companyId)).toBe(true);
  });
});

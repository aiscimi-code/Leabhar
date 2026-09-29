import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { storeDocument } from './storage';
import { deleteDocument, archiveDocument } from './lifecycle';
import {
  setRetentionPolicy, retentionPolicies, resolveRetentionPolicy, retentionStatus, retentionEndsOn,
  seedDefaultRetentionPolicies, DEFAULT_RETENTION_YEARS, RETENTION_NEVER_DISPOSE_TYPES,
  RETENTION_EXTENSION_CONDITIONS, DocumentRetentionError,
} from './retention';
import { documents, auditEvents, documentRetentionPolicies } from '@/db/schema';
import { asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';

/**
 * Retention (issue #429). The invariants under test:
 * a policy is effective-dated and supersedes rather than overwrites (#6), a
 * document resolves the policy of its own day, and nothing is ever disposed
 * automatically (#7) — the module only lists.
 */
let db: AppDatabase;
let companyId: string;
let root: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
  root = mkdtempSync(join(tmpdir(), 'retention-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The seeded defaults (issue #432) are in force in every new book; tests that
 * need a book with no policy remove them first. */
const clearSeededPolicies = () =>
  db.delete(documentRetentionPolicies).where(eq(documentRetentionPolicies.companyId, companyId)).run();

const store = (name: string, documentDate: string | null) => storeDocument(db, {
  companyId, filename: name, content: Buffer.from(`${name}-${Math.random()}`), root,
  documentDate,
});

const set = (appliesTo: 'all' | 'supplier_invoice' | 'contract', retainYears: number, effectiveFrom: string) =>
  setRetentionPolicy(db, { companyId, appliesTo, retainYears, effectiveFrom: asIsoDate(effectiveFrom), actor: 'joe' });

describe('setRetentionPolicy', () => {
  it('records a policy and audits it', () => {
    const policy = set('all', 6, '2020-01-01');
    expect(policy.retainYears).toBe(6);
    expect(db.select().from(auditEvents)
      .where(and(eq(auditEvents.entityType, 'document_retention_policy'), eq(auditEvents.action, 'created')))
      .all()).toHaveLength(1);
  });

  it('supersedes the previous policy for the scope, never overwrites it', () => {
    set('all', 6, '2020-01-01');
    set('all', 3, '2026-01-01');
    const rows = retentionPolicies(db, companyId).filter((p) => p.appliesTo === 'all' && p.createdBy === 'joe');
    expect(rows).toHaveLength(2);
    const earlier = rows.find((p) => p.effectiveFrom === '2020-01-01')!;
    expect(earlier.supersededAt).toBe('2026-01-01');
    const current = rows.find((p) => p.effectiveFrom === '2026-01-01')!;
    expect(current.supersededAt).toBeNull();
  });

  it('rejects a negative or fractional period, an unknown type and a bad date', () => {
    expect(() => set('all', -1, '2020-01-01')).toThrow(DocumentRetentionError);
    expect(() => set('all', 2.5, '2020-01-01')).toThrow(DocumentRetentionError);
    // 'statement' is not a value documents.document_type can hold.
    expect(() => setRetentionPolicy(db, {
      companyId, appliesTo: 'statement' as 'contract', retainYears: 6,
      effectiveFrom: asIsoDate('2020-01-01'), actor: 'joe',
    })).toThrow(DocumentRetentionError);
    expect(() => setRetentionPolicy(db, {
      companyId, appliesTo: 'all', retainYears: 6,
      effectiveFrom: 'January' as never, actor: 'joe',
    })).toThrow(DocumentRetentionError);
  });
});

describe('resolveRetentionPolicy', () => {
  it('resolves the policy in force on the document own day, across a supersede', () => {
    set('all', 6, '2020-01-01');
    set('all', 3, '2026-01-01');
    const resolve = (type: 'supplier_invoice', asOf: string) =>
      resolveRetentionPolicy(db, { companyId, documentType: type, asOf: asIsoDate(asOf) });
    expect(resolve('supplier_invoice', '2022-06-01')?.retainYears).toBe(6);
    expect(resolve('supplier_invoice', '2025-12-31')?.retainYears).toBe(6);
    expect(resolve('supplier_invoice', '2026-01-01')?.retainYears).toBe(3);
  });

  it('prefers the type-specific policy over the default', () => {
    set('all', 6, '2020-01-01');
    set('contract', 10, '2021-01-01');
    expect(resolveRetentionPolicy(db, { companyId, documentType: 'contract', asOf: asIsoDate('2022-01-01') })?.retainYears).toBe(10);
    expect(resolveRetentionPolicy(db, { companyId, documentType: 'receipt', asOf: asIsoDate('2022-01-01') })?.retainYears).toBe(6);
  });

  it('returns nothing when no policy covers the date', () => {
    clearSeededPolicies();
    expect(resolveRetentionPolicy(db, { companyId, documentType: 'receipt', asOf: asIsoDate('2022-01-01') })).toBeNull();
    set('all', 6, '2020-01-01');
    expect(resolveRetentionPolicy(db, { companyId, documentType: 'receipt', asOf: asIsoDate('2019-12-31') })).toBeNull();
  });
});

describe('retentionStatus', () => {
  it('lists documents past their policy and never disposes anything', () => {
    set('all', 6, '2010-01-01');
    const old = store('old-invoice.pdf', '2015-03-14');
    store('recent-invoice.pdf', '2023-03-14');

    const status = retentionStatus(db, { companyId, asOf: asIsoDate('2026-01-01') });
    expect(status.eligible.map((e) => e.documentId)).toEqual([old.documentId]);
    // The clock runs from the end of the financial year containing the
    // document's own date (issue #432), so 2015-03-14 becomes 2021-12-31.
    expect(status.eligible[0]).toMatchObject({
      documentDate: '2015-03-14', eligibleFrom: '2021-12-31', retainYears: 6,
    });
    // Nothing changed in the database by looking.
    expect(db.select().from(documents).where(eq(documents.id, old.documentId)).get()!.archived).toBe(false);
  });

  it('runs the clock from the filed date when the document states none', () => {
    set('all', 6, '2010-01-01');
    const undated = store('undated-contract.pdf', null);
    // Filed today, kept six years from the filed date: past retention by 2040
    // whenever today is.
    const status = retentionStatus(db, { companyId, asOf: asIsoDate('2040-01-01') });
    expect(status.eligible.map((e) => e.documentId)).toContain(undated.documentId);
  });

  it('resolves each document against the policy of its own day', () => {
    // In force until 2026: 6 years. From 2026: 3 years.
    set('all', 6, '2010-01-01');
    set('all', 3, '2026-01-01');
    const filedEarly = store('filed-early.pdf', '2018-01-01');   // 6-year policy of its day: due 2024
    const filedLate = store('filed-late.pdf', '2027-01-01');     // 3-year policy of its day: due 2030
    const status = retentionStatus(db, { companyId, asOf: asIsoDate('2028-01-01') });
    expect(status.eligible.map((e) => e.documentId)).toEqual([filedEarly.documentId]);
    expect(status.withoutPolicy.map((e) => e.documentId)).not.toContain(filedLate.documentId);
  });

  it('reports documents with no policy in force instead of guessing one', () => {
    clearSeededPolicies();
    const doc = store('orphan.pdf', '2020-01-01');
    const status = retentionStatus(db, { companyId, asOf: asIsoDate('2026-01-01') });
    expect(status.eligible).toEqual([]);
    expect(status.withoutPolicy.map((e) => e.documentId)).toEqual([doc.documentId]);
  });

  it('ignores archived documents', () => {
    set('all', 6, '2010-01-01');
    const old = store('disposed.pdf', '2015-03-14');
    db.update(documents).set({ archived: true }).where(eq(documents.id, old.documentId)).run();
    expect(retentionStatus(db, { companyId, asOf: asIsoDate('2026-01-01') }).eligible).toEqual([]);
  });
});

describe('seeded defaults (#432)', () => {
  it('seeds a 6-year default for every type and never-dispose for company documents and contracts', () => {
    const seeded = retentionPolicies(db, companyId).filter((p) => p.createdBy === 'system');
    expect(seeded.map((p) => p.appliesTo).sort()).toEqual(['all', 'company_document', 'contract']);
    const all = seeded.find((p) => p.appliesTo === 'all')!;
    expect(all.retainYears).toBe(DEFAULT_RETENTION_YEARS);
    expect(all.neverDispose).toBe(false);
    expect(all.note).toContain('s.84(3)');
    expect(all.note).toContain('s.886');
    expect(all.note).toContain('s.285');
    for (const type of RETENTION_NEVER_DISPOSE_TYPES) {
      const never = seeded.find((p) => p.appliesTo === type)!;
      expect(never.neverDispose).toBe(true);
      expect(never.retainYears).toBe(0);
    }
    // They are in force from the book's earliest date, so an old document resolves one.
    const contract = storeDocument(db, {
      companyId, filename: 'old-lease.pdf', content: Buffer.from('lease'),
      root, documentDate: '2015-06-30', documentType: 'contract',
    });
    const row = db.select().from(documents).where(eq(documents.id, contract.documentId)).get()!;
    const policy = resolveRetentionPolicy(db, { companyId, documentType: 'contract', asOf: asIsoDate('2015-06-30') });
    expect(policy?.neverDispose).toBe(true);
    expect(retentionEndsOn(db, companyId, row)).toMatchObject({ eligibleFrom: null, neverDispose: true });
  });

  it('never lists a never-dispose document as past retention, and never deletes it', () => {
    const constitution = storeDocument(db, {
      companyId, filename: 'constitution.pdf', content: Buffer.from('constitution'),
      root, documentDate: '2000-01-01', documentType: 'company_document',
    });
    const status = retentionStatus(db, { companyId, asOf: asIsoDate('2030-01-01') });
    expect(status.eligible.map((e) => e.documentId)).not.toContain(constitution.documentId);
    expect(status.withoutPolicy.map((e) => e.documentId)).not.toContain(constitution.documentId);

    // Deletion is the second step of retirement (ADR 0010): archive first.
    archiveDocument(db, {
      companyId, documentId: constitution.documentId, actor: 'joe', reason: 'Past retention',
    });
    expect(() => deleteDocument(db, {
      companyId, documentId: constitution.documentId, actor: 'joe',
      reason: 'Past retention', storageRootPath: root,
    })).toThrow(/never-dispose/);
  });

  it('states the conditions that extend retention with every expiry', () => {
    const status = retentionStatus(db, { companyId, asOf: asIsoDate('2026-01-01') });
    expect(status.expiryConditions).toBe(RETENTION_EXTENSION_CONDITIONS);
    expect(status.expiryConditions).toContain('s.84(4)');
    expect(status.expiryConditions).toContain('s.886');
    expect(status.expiryConditions).toContain('Companies Act 2014 s.285');
    expect(status.expiryConditions).not.toContain('uncorroborated');
  });

  it('lets a person supersede a seeded default, and refuses a never-dispose policy that states years', () => {
    setRetentionPolicy(db, {
      companyId, appliesTo: 'all', retainYears: 3, effectiveFrom: asIsoDate('2026-01-01'), actor: 'joe',
    });
    const current = resolveRetentionPolicy(db, { companyId, documentType: 'receipt', asOf: asIsoDate('2026-06-01') });
    expect(current?.retainYears).toBe(3);
    expect(current?.createdBy).toBe('joe');

    expect(() => setRetentionPolicy(db, {
      companyId, appliesTo: 'tax_document', retainYears: 6, neverDispose: true,
      effectiveFrom: asIsoDate('2026-01-01'), actor: 'joe',
    })).toThrow(/Leave the period at 0/);
  });

  it('seedDefaultRetentionPolicies does not duplicate a book that already has policies', () => {
    // The seed runs inside createCompany; calling it again by hand would be a
    // mistake. It refuses rather than stack a second set.
    expect(() => seedDefaultRetentionPolicies(db, companyId, { effectiveFrom: asIsoDate('1900-01-01') }))
      .toThrow(DocumentRetentionError);
  });

  it('applies the defaults to an existing book with none, in the person\'s name and audited', () => {
    // A book created before the defaults were seeded has no policy at all.
    clearSeededPolicies();
    seedDefaultRetentionPolicies(db, companyId, { effectiveFrom: asIsoDate('2020-01-01'), actor: 'Mary' });

    const rows = db.select().from(documentRetentionPolicies)
      .where(eq(documentRetentionPolicies.companyId, companyId)).all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.createdBy === 'Mary')).toBe(true);
    const audited = db.select().from(auditEvents).where(and(
      eq(auditEvents.companyId, companyId), eq(auditEvents.entityType, 'document_retention_policy'),
      eq(auditEvents.actor, 'Mary'),
    )).all();
    expect(audited.map((e) => e.entityId).sort()).toEqual(rows.map((r) => r.id).sort());
  });
});

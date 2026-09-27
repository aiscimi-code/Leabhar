import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { storeDocument } from './storage';
import {
  setRetentionPolicy, retentionPolicies, resolveRetentionPolicy, retentionStatus,
  DocumentRetentionError,
} from './retention';
import { documents, auditEvents } from '@/db/schema';
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
    const rows = retentionPolicies(db, companyId).filter((p) => p.appliesTo === 'all');
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
    expect(status.eligible[0]).toMatchObject({
      documentDate: '2015-03-14', eligibleFrom: '2021-03-14', retainYears: 6,
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

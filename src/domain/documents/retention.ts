import { and, eq, isNull, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { documents, documentRetentionPolicies, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { addYears, isIsoDate, nowIso, today, type IsoDate } from '../dates';
import { AccountingError } from '../accounting/errors';
import { ALL_DOCUMENT_TYPES, isVaultDocumentType, VAULT_TYPE_LABELS, type DocumentType } from './types';

/**
 * Document retention (issue #429).
 *
 * Two invariants shape this module:
 *
 *  - **Effective-dated, never overwritten (#6).** A policy is in force from
 *    its `effectiveFrom` until the policy that supersedes it takes over. A
 *    document resolves the policy as of its own date, so changing the policy
 *    today never re-times history.
 *  - **Nothing is silently disposed (#7).** A policy never deletes anything.
 *    It computes when a document may be disposed of, and the retention screen
 *    lists those documents for a person to decide. Disposal itself is an
 *    explicit, audited archive (`lifecycle.archiveDocument`).
 *
 * No periods are seeded: whether and for how long to keep each kind of
 * document is the owner's decision (issue #432).
 */

export class DocumentRetentionError extends AccountingError {}

/** `'all'`, or the document type the policy applies to. */
export type RetentionScope = 'all' | DocumentType;

export interface RetentionPolicy {
  id: string;
  appliesTo: RetentionScope;
  retainYears: number;
  effectiveFrom: IsoDate;
  supersededAt: IsoDate | null;
  note: string | null;
  createdAt: string;
}

export interface SetRetentionPolicyInput {
  companyId: string;
  appliesTo: RetentionScope;
  /** Whole years, counted from the document's own date. Zero means "no minimum". */
  retainYears: number;
  effectiveFrom: IsoDate;
  note?: string | null;
  actor: string;
  requestId?: string;
}

/**
 * Set a retention policy. The previous policy for the same scope is superseded
 * from this date — never overwritten — so a document dated before the change
 * still resolves the policy that was in force when it was filed.
 */
export function setRetentionPolicy(db: AppDatabase, input: SetRetentionPolicyInput): RetentionPolicy {
  if (!(ALL_DOCUMENT_TYPES as string[]).includes(input.appliesTo) && input.appliesTo !== 'all') {
    throw new DocumentRetentionError(`Unknown document type "${input.appliesTo}".`);
  }
  if (!Number.isInteger(input.retainYears) || input.retainYears < 0) {
    throw new DocumentRetentionError('Retention is a whole number of years, and cannot be negative.');
  }
  if (!isIsoDate(input.effectiveFrom)) {
    throw new DocumentRetentionError('The effective date must be a date (YYYY-MM-DD).');
  }

  const timestamp = nowIso();
  const policyId = ids.retentionPolicy();

  db.transaction((tx) => {
    // Any open policy for the same scope that starts before this one is
    // superseded from this date; a later-dated one keeps running until it
    // reaches its own start.
    const open = tx.select().from(documentRetentionPolicies)
      .where(and(
        eq(documentRetentionPolicies.companyId, input.companyId),
        eq(documentRetentionPolicies.appliesTo, input.appliesTo),
        isNull(documentRetentionPolicies.supersededAt),
      )).all()
      .filter((row) => row.effectiveFrom < input.effectiveFrom);
    for (const row of open) {
      tx.update(documentRetentionPolicies).set({
        supersededAt: input.effectiveFrom, supersededById: policyId, updatedAt: timestamp,
      }).where(eq(documentRetentionPolicies.id, row.id)).run();
      tx.insert(auditEvents).values({
        id: ids.audit(), companyId: input.companyId, occurredAt: timestamp,
        entityType: 'document_retention_policy', entityId: row.id, action: 'updated',
        field: 'supersededAt', previousValue: JSON.stringify(null),
        newValue: JSON.stringify(input.effectiveFrom),
        source: 'user', actor: input.actor,
        reason: `Superseded by a policy of ${input.retainYears} years from ${input.effectiveFrom}.`,
        requestId: input.requestId ?? null,
      }).run();
    }

    tx.insert(documentRetentionPolicies).values({
      id: policyId,
      companyId: input.companyId,
      appliesTo: input.appliesTo,
      retainYears: input.retainYears,
      effectiveFrom: input.effectiveFrom,
      note: input.note ?? null,
      createdBy: input.actor,
      createdAt: timestamp, updatedAt: timestamp,
    }).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: input.companyId, occurredAt: timestamp,
      entityType: 'document_retention_policy', entityId: policyId, action: 'created',
      newValue: JSON.stringify({
        appliesTo: input.appliesTo, retainYears: input.retainYears, effectiveFrom: input.effectiveFrom,
      }),
      source: 'user', actor: input.actor,
      reason: `Keep ${scopeLabel(input.appliesTo)} for ${input.retainYears} year${input.retainYears === 1 ? '' : 's'}.`,
      requestId: input.requestId ?? null,
    }).run();
  });

  return {
    id: policyId, appliesTo: input.appliesTo, retainYears: input.retainYears,
    effectiveFrom: input.effectiveFrom, supersededAt: null,
    note: input.note ?? null, createdAt: timestamp,
  };
}

/** Every policy for the company, newest first, superseded rows included. */
export function retentionPolicies(db: AppDatabase, companyId: string): RetentionPolicy[] {
  return db.select().from(documentRetentionPolicies)
    .where(eq(documentRetentionPolicies.companyId, companyId))
    .orderBy(desc(documentRetentionPolicies.effectiveFrom)).all()
    .map(toPolicy);
}

/**
 * The policy in force for a document of this type on this date: the most
 * specific scope first, and within a scope the row whose window contains the
 * date.
 */
export function resolveRetentionPolicy(
  db: AppDatabase,
  params: { companyId: string; documentType: DocumentType; asOf: IsoDate },
): RetentionPolicy | null {
  for (const scope of [params.documentType, 'all'] as const) {
    const row = db.select().from(documentRetentionPolicies)
      .where(and(
        eq(documentRetentionPolicies.companyId, params.companyId),
        eq(documentRetentionPolicies.appliesTo, scope),
      )).all()
      .filter((r) => r.effectiveFrom <= params.asOf && (r.supersededAt === null || params.asOf < r.supersededAt))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    if (row) return toPolicy(row);
  }
  return null;
}

export interface RetentionStatus {
  asOf: IsoDate;
  /** Documents whose policy has run out, so a person may dispose of them. */
  eligible: Array<{
    documentId: string;
    filename: string;
    documentType: DocumentType;
    documentDate: IsoDate;
    eligibleFrom: IsoDate;
    retainYears: number;
  }>;
  /** Documents with no policy in force as of their own date. */
  withoutPolicy: Array<{ documentId: string; filename: string; documentType: DocumentType }>;
}

/**
 * Which documents may be disposed of as of a date, and which have no policy.
 * Read-only: it lists; it never disposes.
 */
export function retentionStatus(
  db: AppDatabase,
  params: { companyId: string; asOf?: IsoDate },
): RetentionStatus {
  const asOf = params.asOf ?? today();
  const status: RetentionStatus = { asOf, eligible: [], withoutPolicy: [] };

  for (const doc of db.select().from(documents)
    .where(and(eq(documents.companyId, params.companyId), eq(documents.archived, false))).all()) {
    // The clock runs from the document's own date — the date that decides
    // which period and return it belongs to — or from when it was filed when
    // it states no date (an undated contract, say).
    const anchor = (doc.documentDate && isIsoDate(doc.documentDate) ? doc.documentDate : doc.uploadedAt.slice(0, 10)) as IsoDate;
    const policy = resolveRetentionPolicy(db, {
      companyId: params.companyId, documentType: doc.documentType, asOf: anchor,
    });
    if (!policy) {
      status.withoutPolicy.push({
        documentId: doc.id, filename: doc.originalFilename, documentType: doc.documentType,
      });
      continue;
    }
    const eligibleFrom = addYears(anchor, policy.retainYears);
    if (eligibleFrom <= asOf) {
      status.eligible.push({
        documentId: doc.id, filename: doc.originalFilename, documentType: doc.documentType,
        documentDate: anchor, eligibleFrom, retainYears: policy.retainYears,
      });
    }
  }
  status.eligible.sort((a, b) => a.eligibleFrom.localeCompare(b.eligibleFrom));
  return status;
}

function scopeLabel(scope: RetentionScope): string {
  return scope === 'all' ? 'every document type with no specific policy' : labelFor(scope);
}

function labelFor(scope: DocumentType): string {
  return isVaultDocumentType(scope) ? VAULT_TYPE_LABELS[scope] : scope;
}

function toPolicy(row: typeof documentRetentionPolicies.$inferSelect): RetentionPolicy {
  return {
    id: row.id, appliesTo: row.appliesTo as RetentionScope, retainYears: row.retainYears,
    effectiveFrom: row.effectiveFrom as IsoDate, supersededAt: (row.supersededAt as IsoDate) ?? null,
    note: row.note, createdAt: row.createdAt,
  };
}


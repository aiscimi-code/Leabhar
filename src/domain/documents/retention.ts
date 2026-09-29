import { and, eq, isNull, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, documents, documentRetentionPolicies, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { addYears, asIsoDate, isIsoDate, nowIso, today, type IsoDate } from '../dates';
import { AccountingError } from '../accounting/errors';
import { accountingYearContaining } from '../vat/apportionment';
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
 * Default policies are seeded for every new book (issue #432): six years for
 * every type the sources state (VATCA 2010 s.84(3); TCA 1997 s.886;
 * Companies Act 2014 s.285), never dispose for company constitutional
 * documents and for contracts, which property and capital goods turn on.
 * They are effective-dated policies like any other: the person can change or
 * supersede them, never silently.
 */

export class DocumentRetentionError extends AccountingError {}

/** `'all'`, or the document type the policy applies to. */
export type RetentionScope = 'all' | DocumentType;

export interface RetentionPolicy {
  id: string;
  appliesTo: RetentionScope;
  retainYears: number;
  neverDispose: boolean;
  effectiveFrom: IsoDate;
  supersededAt: IsoDate | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface SetRetentionPolicyInput {
  companyId: string;
  appliesTo: RetentionScope;
  /** Whole years, counted from the end of the financial year containing the document's own date. Zero means "no minimum". */
  retainYears: number;
  /** Keep the documents for the life they belong to: no expiry is ever computed (issue #432). */
  neverDispose?: boolean;
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
  if (input.neverDispose && input.retainYears !== 0) {
    throw new DocumentRetentionError(
      'A never-dispose policy keeps the documents for the life they belong to, so it states no years. Leave the period at 0.',
    );
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
      neverDispose: input.neverDispose ?? false,
      effectiveFrom: input.effectiveFrom,
      note: input.note ?? null,
      createdBy: input.actor,
      createdAt: timestamp, updatedAt: timestamp,
    }).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: input.companyId, occurredAt: timestamp,
      entityType: 'document_retention_policy', entityId: policyId, action: 'created',
      newValue: JSON.stringify({
        appliesTo: input.appliesTo, retainYears: input.retainYears,
        neverDispose: input.neverDispose ?? false, effectiveFrom: input.effectiveFrom,
      }),
      source: 'user', actor: input.actor,
      reason: input.neverDispose
        ? `Keep ${scopeLabel(input.appliesTo)} for the life they belong to: never dispose.`
        : `Keep ${scopeLabel(input.appliesTo)} for ${input.retainYears} year${input.retainYears === 1 ? '' : 's'}.`,
      requestId: input.requestId ?? null,
    }).run();
  });

  return {
    id: policyId, appliesTo: input.appliesTo, retainYears: input.retainYears,
    neverDispose: input.neverDispose ?? false,
    effectiveFrom: input.effectiveFrom, supersededAt: null,
    note: input.note ?? null, createdBy: input.actor, createdAt: timestamp,
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

/**
 * The date from which a document may be disposed of under the policy in force
 * as of its own date, or null when no policy covers it. The clock runs from
 * the end of the financial year containing the document's own date (or the
 * date it was filed, when it states none), which is never earlier than the
 * statutory "latest transaction" the sources name, and one date per year
 * (issue #432). A never-dispose policy has no expiry at all.
 */
export function retentionEndsOn(
  db: AppDatabase, companyId: string, doc: Pick<typeof documents.$inferSelect, 'documentDate' | 'uploadedAt' | 'documentType'>,
): { eligibleFrom: IsoDate | null; retainYears: number; neverDispose: boolean } | null {
  const anchor = (doc.documentDate && isIsoDate(doc.documentDate) ? doc.documentDate : doc.uploadedAt.slice(0, 10)) as IsoDate;
  const policy = resolveRetentionPolicy(db, { companyId, documentType: doc.documentType, asOf: anchor });
  if (!policy) return null;
  if (policy.neverDispose) return { eligibleFrom: null, retainYears: policy.retainYears, neverDispose: true };
  return {
    eligibleFrom: addYears(clockStart(db, companyId, anchor), policy.retainYears),
    retainYears: policy.retainYears, neverDispose: false,
  };
}

/** The end of the financial year containing the date, where the clock starts. */
function clockStart(db: AppDatabase, companyId: string, anchor: IsoDate): IsoDate {
  return asIsoDate(accountingYearContaining(db, companyId, anchor).end);
}

export interface RetentionStatus {
  asOf: IsoDate;
  /**
   * The conditions that extend retention past the policy, stated with every
   * expiry (issue #432). The six-year company-record figure is Companies Act
   * 2014 s.285, cited beside VATCA s.84(3) and TCA s.886 (issue #557).
   */
  expiryConditions: string;
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
  const status: RetentionStatus = { asOf, expiryConditions: RETENTION_EXTENSION_CONDITIONS, eligible: [], withoutPolicy: [] };

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
    // A never-dispose policy keeps the document for the life it belongs to,
    // so it is never listed as past retention (issue #432).
    if (policy.neverDispose) continue;
    const eligibleFrom = addYears(clockStart(db, params.companyId, anchor), policy.retainYears);
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

/**
 * What can extend retention past the stated period (issue #432). Stated with
 * every expiry: the person confirms none applies before anything is disposed.
 */
export const RETENTION_EXTENSION_CONDITIONS =
  'Retention extends while a Revenue inquiry, investigation, claim or appeal is open, until it ends '
  + '(VATCA 2010 s.84(4)), and a year whose return was never delivered is not closed off (TCA 1997 s.886). '
  + 'Company accounting records are kept for at least 6 years after the end of the financial year they '
  + 'relate to (Companies Act 2014 s.285). Confirm none of these applies before disposing of anything.';

/** The default every new book is seeded with (issue #432). */
export const DEFAULT_RETENTION_YEARS = 6;

/** Types whose documents are kept for the life they belong to by default (issue #432). */
export const RETENTION_NEVER_DISPOSE_TYPES: DocumentType[] = ['company_document', 'contract'];

/**
 * Seed the default retention policies into a new book (issue #432): six years
 * for every type (VATCA 2010 s.84(3); TCA 1997 s.886; Companies Act 2014 s.285),
 * never dispose for the company's own constitutional documents and for
 * contracts, which property and capital goods turn on (VATCA s.84(4)). Each is
 * an effective-dated policy the person can supersede, like any other — never
 * overwritten, never silent.
 */
export function seedDefaultRetentionPolicies(
  db: AppDatabase, companyId: string, params: {
    effectiveFrom: IsoDate;
    /**
     * Who applied the defaults, when a person does so for an existing book
     * (issue #432). Each policy is then audited in their name; a new book's
     * seed, like its chart, is part of creating it.
     */
    actor?: string;
  },
): void {
  // A book that already has a policy of its own is never re-seeded: the
  // defaults are a starting point, not something that overwrites a decision.
  const existing = db.select({ id: documentRetentionPolicies.id }).from(documentRetentionPolicies)
    .where(eq(documentRetentionPolicies.companyId, companyId)).limit(1).get();
  if (existing) {
    throw new DocumentRetentionError(
      `This book already has a retention policy, so the defaults are not seeded again (issue #432).`,
    );
  }
  const timestamp = nowIso();
  const rows: Array<typeof documentRetentionPolicies.$inferInsert> = [
    {
      id: ids.retentionPolicy(), companyId, appliesTo: 'all',
      retainYears: DEFAULT_RETENTION_YEARS, neverDispose: false,
      effectiveFrom: params.effectiveFrom,
      note: 'Seeded default (issue #432): VAT records 6 years from the latest transaction (VATCA 2010 '
        + 's.84(3)); books and records 6 years after the transactions (TCA 1997 s.886); company accounting '
        + 'records at least 6 years after the end of the financial year (Companies Act 2014 s.285). The clock '
        + 'runs from the end of the financial year containing the document\u2019s own date.',
      createdBy: 'system', createdAt: timestamp, updatedAt: timestamp,
    },
    ...RETENTION_NEVER_DISPOSE_TYPES.map((type) => ({
      id: ids.retentionPolicy(), companyId, appliesTo: type,
      retainYears: 0, neverDispose: true,
      effectiveFrom: params.effectiveFrom,
      note: 'Seeded default (issue #432): never dispose — '
        + (type === 'company_document'
          ? 'company constitutional documents and statutory registers are kept for the company\u2019s life.'
          : 'contracts for property or capital goods are kept while the asset is held, plus 6 years '
            + '(VATCA s.84(4)); the books cannot know when the asset leaves the register.'),
      createdBy: 'system', createdAt: timestamp, updatedAt: timestamp,
    })),
  ];
  for (const row of rows) {
    db.insert(documentRetentionPolicies).values(params.actor ? { ...row, createdBy: params.actor } : row).run();
    if (params.actor) {
      db.insert(auditEvents).values({
        id: ids.audit(), companyId, occurredAt: timestamp,
        entityType: 'document_retention_policy', entityId: row.id!, action: 'created',
        newValue: JSON.stringify({
          appliesTo: row.appliesTo, retainYears: row.retainYears, neverDispose: row.neverDispose,
          effectiveFrom: row.effectiveFrom, seededDefault: true,
        }),
        source: 'user', actor: params.actor,
        reason: 'The default retention policies applied to an existing book (issue #432).',
      }).run();
    }
  }
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
    neverDispose: row.neverDispose,
    effectiveFrom: row.effectiveFrom as IsoDate, supersededAt: (row.supersededAt as IsoDate) ?? null,
    note: row.note, createdBy: row.createdBy, createdAt: row.createdAt,
  };
}

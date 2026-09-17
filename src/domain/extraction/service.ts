import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  documents, documentExtractions, suppliers, customers, companies,
  accounts, vatTreatments, auditEvents, reviewItems,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { readDocument } from '../documents/storage';
import { LocalExtractionProvider } from './localProvider';
import { AnthropicExtractionProvider } from './anthropicProvider';
import type { ExtractionProvider, ExtractionContext, ExtractionResult } from './types';

/**
 * Extraction service (README §12).
 *
 * Provider selection is deliberate: the configured provider is tried, and the
 * deterministic local extractor runs as a fallback whenever the configured one
 * is unavailable or fails. The application therefore never depends on an LLM
 * being reachable, which is README §3's requirement, and a network outage
 * degrades extraction quality rather than stopping bookkeeping.
 */

export function buildProviders(): ExtractionProvider[] {
  const configured = (process.env.EXTRACTION_PROVIDER ?? 'local').toLowerCase();
  const local = new LocalExtractionProvider();
  const anthropic = new AnthropicExtractionProvider();

  if (configured === 'anthropic' && anthropic.isAvailable()) return [anthropic, local];
  return [local];
}

/** Assemble what an extractor needs to know about this company. */
export function buildExtractionContext(
  db: AppDatabase, companyId: string,
): ExtractionContext {
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new Error(`Company ${companyId} not found.`);

  const supplierRows = db.select({
    id: suppliers.id, name: suppliers.name, matchKey: suppliers.matchKey,
    aliases: suppliers.aliases, countryCode: suppliers.countryCode,
    vatNumber: suppliers.vatNumber,
    defaultAccountId: suppliers.defaultAccountId,
    defaultVatTreatmentId: suppliers.defaultVatTreatmentId,
  }).from(suppliers)
    .where(and(eq(suppliers.companyId, companyId), eq(suppliers.active, true))).all();

  const accountRows = db.select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.active, true))).all();
  const accountCodeById = new Map(accountRows.map((a) => [a.id, a.code]));

  const treatmentRows = db.select({
    id: vatTreatments.id, code: vatTreatments.code,
    name: vatTreatments.name, description: vatTreatments.description,
  }).from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, companyId), eq(vatTreatments.active, true))).all();
  const treatmentCodeById = new Map(treatmentRows.map((t) => [t.id, t.code]));

  return {
    knownSuppliers: supplierRows.map((s) => ({
      id: s.id, name: s.name, matchKey: s.matchKey, aliases: s.aliases,
      countryCode: s.countryCode, vatNumber: s.vatNumber,
      defaultAccountCode: s.defaultAccountId ? accountCodeById.get(s.defaultAccountId) ?? null : null,
      defaultVatTreatmentCode: s.defaultVatTreatmentId
        ? treatmentCodeById.get(s.defaultVatTreatmentId) ?? null : null,
    })),
    knownCustomers: db.select({
      id: customers.id, name: customers.name,
      matchKey: customers.matchKey, aliases: customers.aliases,
    }).from(customers).where(eq(customers.companyId, companyId)).all(),
    companyVatNumber: company.vatNumber,
    companyName: company.tradingName ?? company.legalName,
    baseCurrency: company.baseCurrency,
    availableAccountCodes: accountRows.map((a) => ({ code: a.code, name: a.name })),
    availableVatTreatments: treatmentRows.map((t) => ({
      code: t.code, name: t.name, description: t.description,
    })),
  };
}

export interface ExtractDocumentResult {
  documentId: string;
  extractionId: string;
  result: ExtractionResult;
  /** True when the result was confident enough to write onto the document. */
  applied: boolean;
  needsReview: boolean;
}

/**
 * Confidence at or above this writes suggested values onto the document.
 * Below it, the document goes to the review queue with the extraction attached
 * but nothing written — README §12 requires uncertain results go to review.
 */
export const APPLY_THRESHOLD = 60;

export async function extractDocument(
  db: AppDatabase,
  params: {
    companyId: string;
    documentId: string;
    providers?: ExtractionProvider[];
    storageRootPath?: string;
    actor?: string;
    requestId?: string;
  },
): Promise<ExtractDocumentResult> {
  const { content, document } = readDocument(
    db, params.companyId, params.documentId, params.storageRootPath,
  );
  const context = buildExtractionContext(db, params.companyId);
  const providers = params.providers ?? buildProviders();

  db.update(documents).set({ extractionStatus: 'extracting' })
    .where(eq(documents.id, params.documentId)).run();

  let result: ExtractionResult | undefined;
  const attempts: ExtractionResult[] = [];

  for (const provider of providers) {
    if (!provider.isAvailable()) continue;
    const attempt = await provider.extract({
      content, mimeType: document.mimeType,
      filename: document.originalFilename, context,
    });
    attempts.push(attempt);
    if (attempt.status !== 'failed') { result = attempt; break; }
  }

  // Every provider failed: keep the best attempt so the failure is inspectable.
  result ??= attempts[0] ?? {
    provider: 'none', providerVersion: '0', textExtractionMethod: 'none',
    extractedText: '', fields: (await import('./types')).emptyFields(),
    overallConfidence: 0, status: 'failed' as const,
    errorMessage: 'No extraction provider was available.',
    durationMs: 0, observations: ['No extraction provider was available.'],
  };

  const extractionId = ids.extraction();
  const timestamp = nowIso();
  const applied = result.status !== 'failed' && result.overallConfidence >= APPLY_THRESHOLD;
  const needsReview = !applied || result.observations.length > 0;

  db.transaction((tx) => {
    tx.insert(documentExtractions).values({
      id: extractionId,
      companyId: params.companyId,
      documentId: params.documentId,
      provider: result!.provider,
      providerVersion: result!.providerVersion,
      model: result!.model ?? null,
      extractedText: result!.extractedText.slice(0, 500_000),
      textExtractionMethod: result!.textExtractionMethod,
      fields: Object.fromEntries(
        Object.entries(result!.fields).map(([key, field]) => [
          key, { value: field.value, confidence: field.confidence, evidence: field.evidence },
        ]),
      ),
      overallConfidence: result!.overallConfidence,
      status: result!.status,
      errorMessage: result!.errorMessage ?? null,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: result!.durationMs,
    }).run();

    const fields = result!.fields;
    const update: Partial<typeof documents.$inferInsert> = {
      extractionStatus: result!.status === 'failed' ? 'failed' : 'extracted',
      classificationStatus: applied ? 'suggested' : 'needs_review',
      updatedAt: timestamp,
    };

    if (applied) {
      // Written as SUGGESTIONS. Provenance says so, and nothing downstream
      // treats these as confirmed until a person confirms them.
      if (fields.documentDate.value) update.documentDate = fields.documentDate.value;
      if (fields.invoiceNumber.value) update.invoiceNumber = fields.invoiceNumber.value;
      if (fields.currency.value) update.currency = fields.currency.value;
      if (fields.netMinor.value !== null) update.netMinor = fields.netMinor.value;
      if (fields.vatMinor.value !== null) update.vatMinor = fields.vatMinor.value;
      if (fields.grossMinor.value !== null) update.grossMinor = fields.grossMinor.value;
      if (fields.documentType.value && fields.documentType.confidence >= 60) {
        update.documentType = fields.documentType.value as typeof documents.$inferInsert['documentType'];
      }

      const supplier = matchSupplierByName(db, params.companyId, fields.supplierName.value);
      if (supplier) {
        update.supplierId = supplier;
      } else if (fields.supplierName.value && fields.supplierName.confidence >= APPLY_THRESHOLD) {
        // No existing supplier matches the extracted name. Create one so that
        // document↔bank matching has identity evidence to work with. The new
        // supplier is an AI proposal (see createSupplierFromExtraction).
        const country = fields.supplierCountry?.value ?? null;
        const vat = fields.supplierVatNumber?.value ?? null;
        const created = createSupplierFromExtraction(db, {
          companyId: params.companyId,
          name: fields.supplierName.value,
          countryCode: country,
          vatNumber: vat,
          documentId: params.documentId,
          actor: params.actor ?? 'system',
        });
        update.supplierId = created.supplierId;
      }

      const accountId = accountIdForCode(db, params.companyId, fields.suggestedAccountCode.value);
      if (accountId) update.suggestedAccountId = accountId;

      const treatmentId = treatmentIdForCode(
        db, params.companyId, fields.suggestedVatTreatment.value,
      );
      if (treatmentId) update.suggestedVatTreatmentId = treatmentId;

      update.source = result!.provider === 'local' ? 'derived' : 'ai';
      update.confidence = result!.overallConfidence;
      update.provenanceStatus = 'ai_suggestion';
    }

    tx.update(documents).set(update).where(eq(documents.id, params.documentId)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: timestamp,
      entityType: 'document',
      entityId: params.documentId,
      action: result!.provider === 'local' ? 'updated' : 'ai_suggested',
      newValue: JSON.stringify({
        provider: result!.provider, confidence: result!.overallConfidence,
        status: result!.status, applied,
      }),
      source: result!.provider === 'local' ? 'derived' : 'ai',
      actor: params.actor ?? 'system',
      requestId: params.requestId ?? null,
    }).run();

    // ---- Review items ----
    if (result!.status === 'failed') {
      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: 'extraction_failed',
        severity: 'warning',
        title: `Could not read "${document.originalFilename}"`,
        detail: result!.errorMessage
          ?? result!.observations.join(' ')
          ?? 'Nothing could be extracted from this document.',
        entityType: 'document',
        entityId: params.documentId,
        dedupeKey: `document:${params.documentId}:extraction_failed`,
      });
    } else if (!applied) {
      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: 'unresolved_ai_suggestion',
        severity: 'warning',
        title: `"${document.originalFilename}" needs checking`,
        detail: `Extraction confidence was ${result!.overallConfidence}%, below the `
          + `${APPLY_THRESHOLD}% threshold for filling fields automatically. `
          + 'Enter the details yourself, or confirm the suggestions.',
        entityType: 'document',
        entityId: params.documentId,
        dedupeKey: `document:${params.documentId}:low_confidence`,
        context: {
          confidence: result!.overallConfidence,
          fields: Object.fromEntries(
            Object.entries(result!.fields)
              .filter(([, f]) => f.value !== null)
              .map(([k, f]) => [k, { value: f.value, confidence: f.confidence }]),
          ),
        },
      });
    }

    for (const observation of result!.observations) {
      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: 'other',
        severity: 'info',
        title: `Note on "${document.originalFilename}"`,
        detail: observation,
        entityType: 'document',
        entityId: params.documentId,
        dedupeKey: `document:${params.documentId}:obs:${hash(observation)}`,
      });
    }

    if (document.isDuplicateOf) {
      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: 'suspected_duplicate',
        severity: 'warning',
        title: `"${document.originalFilename}" is byte-identical to a document already stored`,
        detail: 'The existing document has not been touched. Confirm whether this is a '
          + 'genuine second copy or a re-upload of the same one.',
        entityType: 'document',
        entityId: params.documentId,
        dedupeKey: `document:${params.documentId}:duplicate`,
        context: { duplicateOf: document.isDuplicateOf },
      });
    }
  });

  return { documentId: params.documentId, extractionId, result, applied, needsReview };
}

function matchSupplierByName(
  db: AppDatabase, companyId: string, name: string | null,
): string | null {
  if (!name) return null;
  const key = normaliseName(name);
  const rows = db.select({ id: suppliers.id, matchKey: suppliers.matchKey })
    .from(suppliers).where(eq(suppliers.companyId, companyId)).all();
  return rows.find((r) => r.matchKey === key)?.id ?? null;
}

export function normaliseName(name: string): string {
  return name.toLowerCase()
    .replace(/\b(limited|ltd|plc|inc|incorporated|llc|gmbh|bv|sarl|pbc|co)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

/**
 * Create a supplier from an extracted name, or link an existing one.
 *
 * Extraction only *matches* an existing supplier (`matchSupplierByName`); with an
 * empty suppliers table identity evidence never exists, so document↔bank
 * matching can never reach `canAutoMatch`. This bridges that gap: when an
 * extraction carries a `supplierName` but no supplier matches, create one.
 *
 * The new supplier is an AI proposal, not a confirmation. It carries no
 * `user_confirmed` provenance — a person can edit or replace it — and the
 * document it came from keeps its own `provenanceStatus: 'ai_suggestion'`. The
 * creation is recorded in the audit trail so a user can see where the supplier
 * came from. (README §10, §17: AI may propose; it may never overwrite
 * `user_confirmed`.)
 */
export function createSupplierFromExtraction(
  db: AppDatabase,
  params: {
    companyId: string;
    name: string;
    countryCode?: string | null;
    vatNumber?: string | null;
    /** Link this document's supplier_id to the created/found supplier. */
    documentId?: string;
    actor?: string;
  },
): { supplierId: string; created: boolean } {
  const matchKey = normaliseName(params.name);
  if (!matchKey) throw new Error('A supplier name cannot be empty.');

  const existing = db.select({ id: suppliers.id }).from(suppliers)
    .where(and(eq(suppliers.companyId, params.companyId), eq(suppliers.matchKey, matchKey)))
    .get();
  if (existing) {
    if (params.documentId) linkDocumentSupplier(db, params, existing.id);
    return { supplierId: existing.id, created: false };
  }

  const supplierId = ids.supplier();
  const timestamp = nowIso();
  db.transaction((tx) => {
    tx.insert(suppliers).values({
      id: supplierId,
      companyId: params.companyId,
      name: params.name,
      matchKey,
      countryCode: params.countryCode ?? null,
      vatNumber: params.vatNumber ?? null,
      notes: 'Created from an extraction. Review and confirm the details.',
    }).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: timestamp,
      entityType: 'supplier',
      entityId: supplierId,
      action: 'created',
      newValue: JSON.stringify({
        name: params.name, matchKey,
        countryCode: params.countryCode ?? null, vatNumber: params.vatNumber ?? null,
        documentId: params.documentId ?? null,
      }),
      source: 'ai',
      actor: params.actor ?? 'system',
      reason: params.documentId
        ? `Created from extraction of document ${params.documentId}`
        : 'Created from an extraction',
    }).run();

    if (params.documentId) {
      tx.update(documents).set({ supplierId, updatedAt: timestamp })
        .where(eq(documents.id, params.documentId)).run();
    }
  });

  return { supplierId, created: true };
}

function linkDocumentSupplier(
  db: AppDatabase,
  params: { documentId?: string },
  supplierId: string,
): void {
  if (!params.documentId) return;
  db.update(documents).set({ supplierId, updatedAt: nowIso() })
    .where(eq(documents.id, params.documentId)).run();
}

function accountIdForCode(db: AppDatabase, companyId: string, code: string | null): string | null {
  if (!code) return null;
  return db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)))
    .get()?.id ?? null;
}

function treatmentIdForCode(
  db: AppDatabase, companyId: string, code: string | null,
): string | null {
  if (!code) return null;
  return db.select({ id: vatTreatments.id }).from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, companyId), eq(vatTreatments.code, code)))
    .get()?.id ?? null;
}

function hash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** Insert a review item, or refresh the existing one with the same dedupe key. */
export function upsertReviewItem(
  tx: Tx | AppDatabase,
  item: {
    companyId: string;
    kind: typeof reviewItems.$inferInsert['kind'];
    severity: typeof reviewItems.$inferInsert['severity'];
    title: string;
    detail: string;
    entityType: string;
    entityId: string;
    dedupeKey: string;
    context?: Record<string, unknown>;
    suggestedActions?: Array<{ label: string; action: string; payload?: Record<string, unknown> }>;
    vatPeriodId?: string | null;
  },
): void {
  const existing = tx.select({ id: reviewItems.id }).from(reviewItems)
    .where(and(
      eq(reviewItems.companyId, item.companyId),
      eq(reviewItems.dedupeKey, item.dedupeKey),
    )).get();

  if (existing) {
    tx.update(reviewItems).set({
      severity: item.severity, title: item.title, detail: item.detail,
      context: item.context ?? {}, status: 'open', updatedAt: nowIso(),
    }).where(eq(reviewItems.id, existing.id)).run();
    return;
  }

  tx.insert(reviewItems).values({
    id: ids.reviewItem(),
    companyId: item.companyId,
    kind: item.kind,
    severity: item.severity,
    title: item.title,
    detail: item.detail,
    entityType: item.entityType,
    entityId: item.entityId,
    context: item.context ?? {},
    suggestedActions: item.suggestedActions ?? [],
    dedupeKey: item.dedupeKey,
    vatPeriodId: item.vatPeriodId ?? null,
    status: 'open',
  }).run();
}

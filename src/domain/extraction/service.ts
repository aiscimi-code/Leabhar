import { and, eq, like, or } from 'drizzle-orm';
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
import { emptyFields } from './types';
import { writeDocumentDraft, flagAwaitingConfirmation } from '../documents/review';

/**
 * Extraction service (README §12).
 *
 * Provider selection is deliberate: the configured provider is tried, and the
 * deterministic local extractor runs as a fallback whenever the configured one
 * is unavailable or fails. The application therefore never depends on an LLM
 * being reachable, which is README §3's requirement, and a network outage
 * degrades extraction quality rather than stopping bookkeeping.
 */

/**
 * The providers to try, from the company's own choice of engine (issue #202):
 * 'local' — this app's scripts, nothing leaves the machine; 'anthropic' — an
 * AI model, only when the user has chosen it and a key is configured, with the
 * local scripts as the fallback. Whatever reads the document, a person
 * confirms it before it is used.
 */
export function buildProviders(engine: 'local' | 'anthropic' = 'local'): ExtractionProvider[] {
  const local = new LocalExtractionProvider();
  const anthropic = new AnthropicExtractionProvider();
  if (engine === 'anthropic' && anthropic.isAvailable()) return [anthropic, local];
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
  /** True when the reading was written onto the document as its (unconfirmed) draft. */
  applied: boolean;
  /** Always true until a person confirms the document (issue #202). */
  needsReview: boolean;
}

/**
 * Read a document and record what was read as an UNCONFIRMED draft.
 *
 * Nothing written here is treated as fact: the document stays
 * `reviewStatus: 'unreviewed'` and goes on the review queue, and matching,
 * VAT, suggestions and reports ignore it until a person has compared the
 * draft with the page and confirmed it (src/domain/documents/review.ts).
 * A supplier is suggested only when one already exists by that name — a new
 * party record is created from confirmed data, never from an unchecked read.
 */
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
  const company = db.select({ extractionEngine: companies.extractionEngine }).from(companies)
    .where(eq(companies.id, params.companyId)).get();
  const providers = params.providers ?? buildProviders(company?.extractionEngine ?? 'local');

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
  const final: ExtractionResult = result ?? attempts[0] ?? {
    provider: 'none', providerVersion: '0', textExtractionMethod: 'none',
    extractedText: '', fields: emptyFields(), lines: [], vatTotals: [], vatLegends: [],
    overallConfidence: 0, status: 'failed' as const,
    errorMessage: 'No extraction provider was available.',
    durationMs: 0, observations: ['No extraction provider was available.'],
  };

  return recordExtraction(db, { ...params, document, result: final });
}

/**
 * Read a document from text recognised elsewhere — OCR run in the browser on
 * the review screen (issue #202) — through the same local reader a PDF's text
 * layer goes through, and record it the same way.
 */
export function extractDocumentFromText(
  db: AppDatabase,
  params: {
    companyId: string;
    documentId: string;
    text: string;
    method: 'ocr' | 'provided';
    actor?: string;
    requestId?: string;
  },
): ExtractDocumentResult {
  const document = db.select().from(documents)
    .where(and(eq(documents.id, params.documentId), eq(documents.companyId, params.companyId))).get();
  if (!document) throw new Error(`Document ${params.documentId} not found.`);
  const context = buildExtractionContext(db, params.companyId);
  const observations = params.method === 'ocr'
    ? ['Read by OCR on this computer. OCR can misread digits and letters — check every figure against the image.']
    : [];
  const result = new LocalExtractionProvider()
    .fromText(params.text, params.method, context, document.originalFilename, observations);
  return recordExtraction(db, { ...params, document, result });
}

function recordExtraction(
  db: AppDatabase,
  params: {
    companyId: string;
    documentId: string;
    document: typeof documents.$inferSelect;
    result: ExtractionResult;
    actor?: string;
    requestId?: string;
  },
): ExtractDocumentResult {
  const { result, document } = params;
  const extractionId = ids.extraction();
  const timestamp = nowIso();
  const confirmed = document.reviewStatus === 'confirmed';
  const applied = result.status !== 'failed' && !confirmed;

  db.transaction((tx) => {
    tx.insert(documentExtractions).values({
      id: extractionId,
      companyId: params.companyId,
      documentId: params.documentId,
      provider: result.provider,
      providerVersion: result.providerVersion,
      model: result.model ?? null,
      extractedText: result.extractedText.slice(0, 500_000),
      textExtractionMethod: result.textExtractionMethod,
      fields: Object.fromEntries(
        Object.entries(result.fields).map(([key, field]) => [
          key, { value: field.value, confidence: field.confidence, evidence: field.evidence },
        ]),
      ),
      lines: result.lines,
      vatTotals: result.vatTotals,
      overallConfidence: result.overallConfidence,
      status: result.status,
      errorMessage: result.errorMessage ?? null,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: result.durationMs,
    }).run();

    tx.update(documents).set({
      extractionStatus: result.status === 'failed' ? 'failed' : 'extracted',
      updatedAt: timestamp,
    }).where(eq(documents.id, params.documentId)).run();

    if (applied) {
      const f = result.fields;
      const supplierId = matchSupplierByName(tx, params.companyId, f.supplierName.value);
      const customerId = matchCustomerByName(tx, params.companyId, f.customerName.value);
      const typeValue = f.documentType.value && f.documentType.confidence >= 60 && f.documentType.value !== 'unknown'
        ? f.documentType.value as NonNullable<typeof documents.$inferInsert['documentType']>
        : undefined;
      writeDocumentDraft(tx, {
        companyId: params.companyId,
        documentId: params.documentId,
        source: result.provider === 'local' ? 'derived' : 'ai',
        confidence: result.overallConfidence,
        values: {
          documentType: typeValue,
          invoiceNumber: f.invoiceNumber.value,
          documentDate: f.documentDate.value,
          dueDate: f.dueDate.value,
          supplyDate: f.supplyDate.value,
          currency: f.currency.value,
          supplierNameStated: f.supplierName.value,
          supplierAddress: f.supplierAddress.value,
          supplierVatNumber: f.supplierVatNumber.value,
          supplierCountry: f.supplierCountry.value,
          customerNameStated: f.customerName.value,
          customerAddress: f.customerAddress.value,
          customerVatNumber: f.customerVatNumber.value,
          customerCountry: f.customerCountry.value,
          vatLegends: result.vatLegends,
          paymentTerms: f.paymentTerms.value,
          originalDocumentNumber: f.originalDocumentNumber.value,
          netMinor: f.netMinor.value,
          vatMinor: f.vatMinor.value,
          grossMinor: f.grossMinor.value,
        },
        lines: result.lines
          .filter((l) => (l.description ?? '').trim() !== '')
          .map((l) => ({
            description: l.description!, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor,
            netMinor: l.netMinor, vatRateBasisPoints: l.vatRateBasisPoints, vatMinor: l.vatMinor,
            grossMinor: l.grossMinor,
          })),
        vatTotals: result.vatTotals.map((t) => ({
          rateBasisPoints: t.rateBasisPoints, label: t.label, netMinor: t.netMinor, vatMinor: t.vatMinor,
        })),
      });
      tx.update(documents).set({
        ...(supplierId ? { supplierId } : {}),
        ...(customerId ? { customerId } : {}),
        suggestedAccountId: accountIdForCode(tx, params.companyId, f.suggestedAccountCode.value),
        suggestedVatTreatmentId: treatmentIdForCode(tx, params.companyId, f.suggestedVatTreatment.value),
        classificationStatus: result.status === 'succeeded' ? 'suggested' : 'needs_review',
        source: result.provider === 'local' ? 'derived' : 'ai',
        confidence: result.overallConfidence,
        provenanceStatus: 'ai_suggestion',
      }).where(eq(documents.id, params.documentId)).run();
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: timestamp,
      entityType: 'document',
      entityId: params.documentId,
      action: result.provider === 'local' ? 'updated' : 'ai_suggested',
      newValue: JSON.stringify({
        provider: result.provider, method: result.textExtractionMethod,
        confidence: result.overallConfidence, status: result.status,
        lines: result.lines.length, vatTotals: result.vatTotals.length, draftWritten: applied,
      }),
      source: result.provider === 'local' ? 'derived' : 'ai',
      actor: params.actor ?? 'system',
      requestId: params.requestId ?? null,
    }).run();

    // ---- Review items ----
    // A new reading replaces the previous reading's notes; they are closed with
    // the reason recorded rather than left to contradict the new one.
    const closed = nowIso();
    tx.update(reviewItems).set({
      status: 'resolved', resolvedAt: closed, resolvedBy: 'system',
      resolution: `Superseded by a later reading (${result.provider}, ${result.textExtractionMethod}).`,
      updatedAt: closed,
    }).where(and(
      eq(reviewItems.companyId, params.companyId),
      eq(reviewItems.status, 'open'),
      or(
        like(reviewItems.dedupeKey, `document:${params.documentId}:obs:%`),
        ...(result.status !== 'failed' ? [eq(reviewItems.dedupeKey, `document:${params.documentId}:extraction_failed`)] : []),
      ),
    )).run();

    if (result.status === 'failed') {
      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: 'extraction_failed',
        severity: 'warning',
        title: `Could not read "${document.originalFilename}"`,
        detail: (result.errorMessage
          ?? result.observations.join(' '))
          || 'Nothing could be extracted from this document. Enter its details by hand on the review screen.',
        entityType: 'document',
        entityId: params.documentId,
        dedupeKey: `document:${params.documentId}:extraction_failed`,
      });
    }
    if (!confirmed) {
      flagAwaitingConfirmation(tx, {
        companyId: params.companyId,
        documentId: params.documentId,
        filename: document.originalFilename,
        detail: `Read ${result.status === 'failed' ? 'nothing' : `with ${result.overallConfidence}% confidence`}`
          + ` (${result.lines.length} line${result.lines.length === 1 ? '' : 's'}). Compare every value with the `
          + 'document, correct anything wrong, add anything missing, and confirm. Nothing uses this document until you do.',
      });
    } else {
      upsertReviewItem(tx, {
        companyId: params.companyId,
        kind: 'other',
        severity: 'info',
        title: `"${document.originalFilename}" was read again`,
        detail: 'This document is already confirmed, so the new reading was stored for comparison and the '
          + 'confirmed values were left unchanged. Reopen the document if they need correcting.',
        entityType: 'document',
        entityId: params.documentId,
        dedupeKey: `document:${params.documentId}:reread:${extractionId}`,
      });
    }

    for (const observation of result.observations) {
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

  return { documentId: params.documentId, extractionId, result, applied, needsReview: !confirmed };
}

function matchSupplierByName(
  db: Tx | AppDatabase, companyId: string, name: string | null,
): string | null {
  if (!name) return null;
  const key = normaliseName(name);
  const rows = db.select({ id: suppliers.id, matchKey: suppliers.matchKey })
    .from(suppliers).where(eq(suppliers.companyId, companyId)).all();
  return rows.find((r) => r.matchKey === key)?.id ?? null;
}

function matchCustomerByName(
  db: Tx | AppDatabase, companyId: string, name: string | null,
): string | null {
  if (!name) return null;
  const key = normaliseName(name);
  const rows = db.select({ id: customers.id, matchKey: customers.matchKey })
    .from(customers).where(eq(customers.companyId, companyId)).all();
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

function accountIdForCode(db: Tx | AppDatabase, companyId: string, code: string | null): string | null {
  if (!code) return null;
  return db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)))
    .get()?.id ?? null;
}

function treatmentIdForCode(
  db: Tx | AppDatabase, companyId: string, code: string | null,
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

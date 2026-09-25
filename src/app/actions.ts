'use server';

import { revalidatePath } from 'next/cache';
import { eq, and } from 'drizzle-orm';
import { getDb, resetDatabase } from '@/db';
import { reviewItems, documents, bankTransactions, companies } from '@/db/schema';
import { requireCompany } from '@/lib/queries';
import { classifyTransaction, reclassifyTransaction } from '@/domain/banking/classify';
import { acceptMatch, rejectMatch, findMatchesForDocument, matchAllUnmatched, linkDocument, unmatchDocument } from '@/domain/matching/service';
import { transitionVatPeriod, type VatPeriodStatus } from '@/domain/vat/periodClose';
import { storeDocument } from '@/domain/documents/storage';
import { extractDocument, extractDocumentFromText } from '@/domain/extraction/service';
import {
  confirmDocument, rejectDocument, reopenDocument, type ReviewedDocumentValues,
} from '@/domain/documents/review';
import { actorName } from '@/lib/session';
import { scanWatchFolder } from '@/domain/documents/watch';
import { importStatement } from '@/domain/banking/import';
import { seedDemoCompany } from '@/db/seed/demo';
import { runMigrations } from '@/db/migrate';
import { createBackup, restoreBackup, verifyBackup } from '@/domain/backup/backup';
import { nowIso } from '@/domain/dates';
import { loadStatutoryKnowledgeBase } from '@/domain/rules/knowledgeBase';

/**
 * Server actions.
 *
 * Every one delegates to the domain layer rather than touching the database
 * directly, so the invariants — balanced journals, immutable evidence, audited
 * changes — hold no matter which screen the change came from.
 */

export type ActionResult = { ok: true; message: string; warnings?: string[] } | { ok: false; error: string };

function fail(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export async function classifyTransactionAction(formData: FormData): Promise<ActionResult> {
  try {
    const db = getDb();
    const company = requireCompany();
    const transactionId = String(formData.get('transactionId'));
    const accountId = String(formData.get('accountId'));
    const vatTreatmentId = String(formData.get('vatTreatmentId'));
    const reason = formData.get('reason') ? String(formData.get('reason')) : null;

    if (!accountId || !vatTreatmentId) {
      return { ok: false, error: 'Choose both an account and a VAT treatment.' };
    }

    const existing = db.select({ journalEntryId: bankTransactions.journalEntryId })
      .from(bankTransactions).where(eq(bankTransactions.id, transactionId)).get();

    // A manual FX rate from the form, when the transaction is in a foreign
    // currency and no statement rate is stored. Sent as a numerator and
    // denominator (integers) to avoid floating-point loss.
    const fxNumerator = formData.get('fxRateNumerator');
    const fxDenominator = formData.get('fxRateDenominator');
    const fxRate = fxNumerator && fxDenominator
      ? {
          numerator: Number(fxNumerator),
          denominator: Number(fxDenominator),
          source: 'manual' as const,
        }
      : undefined;

    if (existing?.journalEntryId) {
      if (!reason) {
        return {
          ok: false,
          error: 'This transaction is already posted. Give a reason for the change — it is '
            + 'recorded in the audit trail alongside the reversal.',
        };
      }
      reclassifyTransaction(db, {
        companyId: company.id, bankTransactionId: transactionId,
        accountId, vatTreatmentId, reason, fxRate,
        source: 'user', provenanceStatus: 'user_confirmed', actor: 'user',
      });
      revalidatePath('/transactions');
      revalidatePath(`/transactions/${transactionId}`);
      return { ok: true, message: 'Reclassified. The original entry was reversed, not edited.' };
    }

    classifyTransaction(db, {
      companyId: company.id, bankTransactionId: transactionId,
      accountId, vatTreatmentId, fxRate,
      source: 'user', provenanceStatus: 'user_confirmed', actor: 'user',
    });

    revalidatePath('/transactions');
    revalidatePath(`/transactions/${transactionId}`);
    revalidatePath('/');
    return { ok: true, message: 'Posted to the ledger.' };
  } catch (error) {
    return fail(error);
  }
}

export async function acceptMatchAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    acceptMatch(getDb(), {
      companyId: company.id,
      documentId: String(formData.get('documentId')),
      bankTransactionId: String(formData.get('bankTransactionId')),
      actor: 'user',
      reason: formData.get('reason') ? String(formData.get('reason')) : 'Accepted by user',
    });
    revalidatePath('/review');
    revalidatePath('/documents');
    revalidatePath('/transactions');
    return { ok: true, message: 'Match accepted.' };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectMatchAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    rejectMatch(getDb(), {
      companyId: company.id,
      documentId: String(formData.get('documentId')),
      bankTransactionId: String(formData.get('bankTransactionId')),
      actor: 'user',
      reason: formData.get('reason') ? String(formData.get('reason')) : undefined,
    });
    revalidatePath('/review');
    revalidatePath('/documents');
    return { ok: true, message: 'Match rejected.' };
  } catch (error) {
    return fail(error);
  }
}

export async function linkDocumentAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const documentId = String(formData.get('documentId'));
    const bankTransactionId = String(formData.get('bankTransactionId'));
    if (!documentId || !bankTransactionId) {
      return { ok: false, error: 'A document and a transaction are both required.' };
    }
    linkDocument(getDb(), {
      companyId: company.id,
      documentId,
      bankTransactionId,
      actor: 'user',
      reason: formData.get('reason') ? String(formData.get('reason')) : undefined,
    });
    revalidatePath('/transactions');
    revalidatePath(`/transactions/${bankTransactionId}`);
    revalidatePath('/documents');
    revalidatePath(`/documents/${documentId}`);
    revalidatePath('/review');
    return { ok: true, message: 'Document linked.' };
  } catch (error) {
    return fail(error);
  }
}

export async function unmatchDocumentAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const documentId = String(formData.get('documentId'));
    if (!documentId) {
      return { ok: false, error: 'A document is required.' };
    }
    unmatchDocument(getDb(), {
      companyId: company.id,
      documentId,
      actor: 'user',
      reason: formData.get('reason') ? String(formData.get('reason')) : 'Unlinked by user',
    });
    revalidatePath('/transactions');
    revalidatePath('/documents');
    revalidatePath(`/documents/${documentId}`);
    revalidatePath('/review');
    return { ok: true, message: 'Document unlinked.' };
  } catch (error) {
    return fail(error);
  }
}

export async function transitionVatPeriodAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const vatPeriodId = String(formData.get('vatPeriodId'));
    const to = String(formData.get('to')) as VatPeriodStatus;
    const result = transitionVatPeriod(getDb(), {
      companyId: company.id, vatPeriodId, to,
      reason: formData.get('reason') ? String(formData.get('reason')) : undefined,
      submissionReference: formData.get('submissionReference')
        ? String(formData.get('submissionReference')) : undefined,
      actor: 'user',
    });
    revalidatePath('/vat');
    revalidatePath(`/vat/${vatPeriodId}`);
    return {
      ok: true,
      message: to === 'ready'
        ? 'Internal checks passed. This period is marked ready for your review — it is '
          + 'not a statement that the return is correct.'
        : `Period moved to ${result.status}.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function resolveReviewItemAction(formData: FormData): Promise<ActionResult> {
  try {
    const db = getDb();
    const company = requireCompany();
    const id = String(formData.get('reviewItemId'));
    const action = String(formData.get('action'));

    db.update(reviewItems).set({
      status: action === 'dismiss' ? 'dismissed' : 'resolved',
      resolvedAt: nowIso(),
      resolvedBy: 'user',
      resolution: formData.get('resolution') ? String(formData.get('resolution'))
        : action === 'dismiss' ? 'Dismissed by user' : 'Marked resolved by user',
      updatedAt: nowIso(),
    }).where(and(eq(reviewItems.id, id), eq(reviewItems.companyId, company.id))).run();

    revalidatePath('/review');
    revalidatePath('/');
    return { ok: true, message: action === 'dismiss' ? 'Dismissed.' : 'Marked resolved.' };
  } catch (error) {
    return fail(error);
  }
}

export async function uploadDocumentAction(formData: FormData): Promise<ActionResult> {
  try {
    const db = getDb();
    const company = requireCompany();
    const files = formData.getAll('files').filter((f): f is File => f instanceof File);
    if (files.length === 0) return { ok: false, error: 'Choose at least one file.' };

    let stored = 0;
    const warnings: string[] = [];

    for (const file of files) {
      const content = Buffer.from(await file.arrayBuffer());
      const result = storeDocument(db, {
        companyId: company.id, filename: file.name, content, uploadedBy: 'user',
      });
      stored += 1;
      if (result.isDuplicate) {
        warnings.push(
          `${file.name} is identical to a document already on file. It was flagged `
          + 'for review rather than overwriting it.',
        );
      }
      // Extraction writes a draft only. Nothing is matched or posted from it
      // until a person has checked it against the page and confirmed it.
      await extractDocument(db, {
        companyId: company.id, documentId: result.documentId, actor: 'user',
      });
    }

    revalidatePath('/documents');
    revalidatePath('/review');
    revalidatePath('/');
    return {
      ok: true,
      message: `${stored} document${stored === 1 ? '' : 's'} stored and read. Check and confirm `
        + `${stored === 1 ? 'it' : 'each one'} before it is used.`,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function scanWatchFolderAction(): Promise<ActionResult> {
  try {
    const db = getDb();
    const company = requireCompany();
    if (!company.documentWatchPath) {
      return {
        ok: false,
        error: 'No document watch folder is set. Add one in Settings → Company, '
          + 'under "Document ingest".',
      };
    }

    const outcome = await scanWatchFolder(db, {
      companyId: company.id, watchPath: company.documentWatchPath,
    });

    revalidatePath('/documents');
    revalidatePath('/review');
    revalidatePath('/');

    const parts: string[] = [];
    if (outcome.ingested > 0) {
      parts.push(`${outcome.ingested} new document${outcome.ingested === 1 ? '' : 's'} ingested.`);
    }
    if (outcome.duplicates > 0) {
      parts.push(`${outcome.duplicates} already on file and flagged for review.`);
    }
    if (outcome.inProgress > 0) {
      parts.push(`${outcome.inProgress} still being written — skipped, click again shortly.`);
    }
    if (outcome.toReview > 0) {
      parts.push(`${outcome.toReview} need your checking in the review queue.`);
    }
    if (outcome.moveFailed > 0) {
      parts.push(`${outcome.moveFailed} could not be moved to processed/.`);
    }
    if (outcome.ingested === 0 && outcome.duplicates === 0
        && outcome.inProgress === 0 && outcome.moveFailed === 0) {
      parts.push('No new documents found in the watch folder.');
    }

    const warnings = outcome.notes.length > 0 ? outcome.notes : undefined;
    return { ok: true, message: parts.join(' '), warnings };
  } catch (error) {
    return fail(error);
  }
}

export async function importStatementAction(formData: FormData): Promise<ActionResult> {
  try {
    const db = getDb();
    const company = requireCompany();
    const file = formData.get('file');
    const bankAccountId = String(formData.get('bankAccountId'));
    if (!(file instanceof File)) return { ok: false, error: 'Choose a statement file.' };
    if (!bankAccountId) return { ok: false, error: 'Choose which bank account this is for.' };

    const content = Buffer.from(await file.arrayBuffer());
    const format = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' as const : 'csv' as const;

    const result = await importStatement(db, {
      companyId: company.id, bankAccountId, filename: file.name,
      content, fileFormat: format, importedBy: 'user',
    });

    revalidatePath('/transactions');
    revalidatePath('/');

    const parts = [`${result.imported} new transaction${result.imported === 1 ? '' : 's'} imported.`];
    if (result.duplicates > 0) {
      parts.push(`${result.duplicates} already present and skipped. No duplicate transactions imported.`);
    }
    if (result.failed > 0) {
      parts.push(`${result.failed} row${result.failed === 1 ? '' : 's'} could not be read: `
        + result.errors.slice(0, 3).map((e) => `row ${e.rowNumber}, ${e.message}`).join('; '));
    }
    for (const warning of result.warnings) parts.push(warning);

    return { ok: true, message: parts.join(' ') };
  } catch (error) {
    return fail(error);
  }
}

// ---- Document review (issue #202) ----

export interface ConfirmDocumentInput {
  documentId: string;
  values: ReviewedDocumentValues;
  acknowledgedCheckCodes: string[];
  supplierId: string | null;
  customerId: string | null;
  createSupplier: boolean;
  createCustomer: boolean;
  note: string | null;
}

/**
 * Confirm a document with the values the person checked against the page,
 * then look for its bank transaction — matching only ever runs on confirmed
 * documents.
 */
export async function confirmDocumentAction(input: ConfirmDocumentInput): Promise<ActionResult> {
  try {
    const db = getDb();
    const company = requireCompany();
    const reviewedBy = await actorName();
    const result = confirmDocument(db, { companyId: company.id, ...input, reviewedBy });
    const match = findMatchesForDocument(db, { companyId: company.id, documentId: input.documentId });
    revalidatePath(`/documents/${input.documentId}`);
    revalidatePath('/documents');
    revalidatePath('/review');
    revalidatePath('/');
    const corrected = result.changedFields.length;
    return {
      ok: true,
      message: `Confirmed${corrected ? ` with ${corrected} correction${corrected === 1 ? '' : 's'}` : ''}. `
        + (match.applied ? 'Matched to its bank transaction.'
          : match.best ? 'A possible bank match is waiting for your decision.'
          : 'No bank transaction matches it yet.'),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectDocumentAction(documentId: string, reason: string): Promise<ActionResult> {
  try {
    const company = requireCompany();
    rejectDocument(getDb(), { companyId: company.id, documentId, reason, reviewedBy: await actorName() });
    revalidatePath(`/documents/${documentId}`);
    revalidatePath('/documents');
    revalidatePath('/review');
    return { ok: true, message: 'Rejected. The file is kept, but nothing will use it.' };
  } catch (error) {
    return fail(error);
  }
}

export async function reopenDocumentAction(documentId: string, reason: string): Promise<ActionResult> {
  try {
    const company = requireCompany();
    reopenDocument(getDb(), { companyId: company.id, documentId, reason, reviewedBy: await actorName() });
    revalidatePath(`/documents/${documentId}`);
    revalidatePath('/documents');
    revalidatePath('/review');
    return { ok: true, message: 'Reopened for correction.' };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Text recognised from the page image in the browser. It is read the same way
 * as a PDF's text layer and replaces the unconfirmed draft; the person still
 * checks every value before confirming.
 */
export async function readRecognisedTextAction(documentId: string, text: string): Promise<ActionResult> {
  try {
    if (text.length > 200_000) throw new Error('The recognised text is too long to be one document.');
    const company = requireCompany();
    const result = extractDocumentFromText(getDb(), {
      companyId: company.id, documentId, text, method: 'ocr', actor: await actorName(),
    });
    revalidatePath(`/documents/${documentId}`);
    return {
      ok: true,
      message: result.applied
        ? `Read ${result.result.lines.length} line${result.result.lines.length === 1 ? '' : 's'} from the recognised text. Check every value against the page.`
        : 'The text was recognised but stored only: this document is already confirmed.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function setExtractionEngineAction(engine: 'local' | 'anthropic'): Promise<ActionResult> {
  try {
    if (engine !== 'local' && engine !== 'anthropic') throw new Error('Unknown extraction engine.');
    const company = requireCompany();
    getDb().update(companies).set({ extractionEngine: engine, updatedAt: nowIso() })
      .where(eq(companies.id, company.id)).run();
    revalidatePath('/settings/company');
    return {
      ok: true,
      message: engine === 'local'
        ? 'Documents will be read on this computer. Nothing is sent anywhere.'
        : 'Documents will be sent to Anthropic to be read. You still confirm every one.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function rematchAllAction(): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const result = matchAllUnmatched(getDb(), { companyId: company.id });
    revalidatePath('/review');
    revalidatePath('/documents');
    return {
      ok: true,
      message: `${result.processed} document${result.processed === 1 ? '' : 's'} checked. `
        + `${result.autoMatched} matched automatically, ${result.needingReview} need your decision.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function loadDemoDataAction(): Promise<ActionResult> {
  try {
    const db = getDb();
    runMigrations(db);
    const existing = db.select({ id: companies.id }).from(companies).all();
    if (existing.length > 0) {
      return {
        ok: false,
        error: 'A company already exists in this database. Demo data is only loaded into an '
          + 'empty database, so it can never be mixed with real books.',
      };
    }
    const result = await seedDemoCompany(db);
    revalidatePath('/');
    return {
      ok: true,
      message: `Demo company created with ${result.counts.transactions} transactions and `
        + `${result.counts.documents} documents. It is labelled as demo data everywhere.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function createBackupAction(): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const result = await createBackup(getDb(), { companyId: company.id });
    revalidatePath('/settings/backup');
    return {
      ok: true,
      message: `Backup ${result.version} created at ${result.path} `
        + `(${(result.sizeBytes / 1024).toFixed(0)} KB, ${result.documentCount} documents).`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function restoreBackupAction(formData: FormData): Promise<ActionResult> {
  try {
    const path = formData.get('path');
    if (typeof path !== 'string' || !path) {
      return { ok: false, error: 'A backup path is required.' };
    }

    const force = formData.get('force') === 'true';
    const verification = verifyBackup(path);

    if (!verification.usable && !force) {
      return {
        ok: false,
        error: `This backup did not verify: ${verification.summary} `
          + 'Restoring it anyway requires the force option.',
      };
    }

    const result = await restoreBackup({ path, force });
    resetDatabase();

    revalidatePath('/settings/backup');
    revalidatePath('/');

    return {
      ok: true,
      message: `Restored backup v${verification.version}. `
        + `Your previous database and documents were moved to ${result.preRestoreCopy} `
        + '— that is your undo if the restore itself turns out to be the mistake. '
        + 'The application has reconnected to the restored database.',
      warnings: verification.usable ? undefined : [
        'This backup did not fully verify, but was restored because the force option was set.',
      ],
    };
  } catch (error) {
    return fail(error);
  }
}

/** Load the statutory knowledge base for the current company (issue #200). Idempotent. */
export async function loadStatutoryRulesAction(): Promise<ActionResult> {
  try {
    const db = getDb();
    const company = requireCompany();
    const result = loadStatutoryKnowledgeBase(db, { companyId: company.id });
    revalidatePath('/transactions');
    return {
      ok: true,
      message: `Statutory rules loaded: ${result.rulesAfter} rules from ${result.sourcesProcessed} source files `
        + `(${result.rulesAfter - result.rulesBefore} new). None is approved yet; every suggestion is flagged for review.`,
    };
  } catch (err) {
    return fail(err);
  }
}

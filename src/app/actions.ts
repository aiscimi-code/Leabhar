'use server';

import { revalidatePath } from 'next/cache';
import { eq, and } from 'drizzle-orm';
import { getDb, resetDatabase } from '@/db';
import { reviewItems, documents, bankTransactions, bankAccounts, companies, invoices as invoicesTable } from '@/db/schema';
import { requireCompany } from '@/lib/queries';
import { classifyTransaction, reclassifyTransaction } from '@/domain/banking/classify';
import { acceptMatch, rejectMatch, findMatchesForDocument, matchAllUnmatched, linkDocument, unmatchDocument, withdrawMatchRejection, MatchError } from '@/domain/matching/service';
import { linkBankTransactionToJournal } from '@/domain/banking/journalLink';
import { allocatePaymentOnAccount } from '@/domain/invoicing/onAccount';
import { applyCreditNote, unapplyCreditNote, refundOnAccount } from '@/domain/invoicing/customerCredit';
import { createInvoice } from '@/domain/invoicing/invoices';
import { parseVatFxRate } from '@/domain/invoicing/vatFxRate';
import { writeOffBadDebt, reverseBadDebtWriteOff } from '@/domain/invoicing/badDebts';
import { recordDeemedSupply } from '@/domain/vat/deemedSupply';
import { produceReminderLetter } from '@/domain/invoicing/receivables';
import { setSupplierTerms } from '@/domain/parties/supplierAccount';
import { reconcileSupplierStatement } from '@/domain/invoicing/supplierStatements';
import {
  createPurchaseOrder, linkBillToPurchaseOrder, unlinkBillFromPurchaseOrder, cancelPurchaseOrder,
} from '@/domain/invoicing/purchaseOrders';
import {
  createRecurringBill, runExpectedBills, matchExpectedBill, unmatchExpectedBill, dismissExpectedBill,
  deactivateRecurringBill,
} from '@/domain/invoicing/expectedBills';
import {
  createRecurringInvoice, postDueRecurringInvoices, deactivateRecurringInvoice,
} from '@/domain/invoicing/recurringInvoices';
import {
  setCustomerTerms, addCustomerContact, setBillingContact, deactivateCustomerContact,
} from '@/domain/parties/customerAccount';
import { transitionVatPeriod, type VatPeriodStatus } from '@/domain/vat/periodClose';
import { storeDocument } from '@/domain/documents/storage';
import { ALL_DOCUMENT_TYPES, isVaultDocumentType, VAULT_TYPE_LABELS } from '@/domain/documents/types';
import { extractDocument, extractDocumentFromText } from '@/domain/extraction/service';
import {
  confirmDocument, rejectDocument, reopenDocument, type ReviewedDocumentValues,
} from '@/domain/documents/review';
import { requireActor, actorName } from '@/lib/session';
import { postDocumentAsInvoice, type LineCoding } from '@/domain/consolidation/postDocument';
import {
  settleBankTransaction, settlementRateNeed, previewSettlement, type SettleAllocation, type SettlementRateNeed,
} from '@/domain/consolidation/settle';
import type { PaymentWriteOffReason } from '@/domain/invoicing/payments';
import { parseDecimalRate, parseAmount, parsePercentBasisPoints } from '@/domain/money';
import { reversePayment } from '@/domain/invoicing/reversal';
import { asIsoDate } from '@/domain/dates';
import { scanWatchFolder } from '@/domain/documents/watch';
import {
  archiveDocument, restoreDocument, deleteDocument,
} from '@/domain/documents/lifecycle';
import {
  setRetentionPolicy, retentionEndsOn, seedDefaultRetentionPolicies, RETENTION_EXTENSION_CONDITIONS,
} from '@/domain/documents/retention';
import { importStatement, recordManualTransaction, rollbackStatementImport } from '@/domain/banking/import';
import { detectStatementFormat } from '@/domain/banking/structuredStatements';
import { seedDemoCompany, type DemoEntityType } from '@/db/seed/demo';
import { archiveCompany } from '@/domain/config/businessProfile';
import { runMigrations } from '@/db/migrate';
import { createBackup, restoreBackup, verifyBackup } from '@/domain/backup/backup';
import { nowIso } from '@/domain/dates';

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
    await requireActor('transactions.classify');
    const db = getDb();
    const company = requireCompany();
    const transactionId = String(formData.get('transactionId'));
    const accountId = String(formData.get('accountId'));
    const vatTreatmentId = String(formData.get('vatTreatmentId'));
    const reason = formData.get('reason') ? String(formData.get('reason')) : null;
    // Only when the transaction's own VAT return is locked or filed (issue #226):
    // the date of an open period to make the correction in.
    const correctionDate = formData.get('correctionDate') ? asIsoDate(String(formData.get('correctionDate'))) : undefined;
    // Business/private apportionment (issue #306): unset or 100 means wholly business.
    const businessPct = formData.get('businessUsePct');
    const businessUseBasisPoints = businessPct && String(businessPct).trim() !== ''
      ? Math.round(Number(businessPct) * 100) : undefined;
    const privateUseAccountId = formData.get('privateUseAccountId')
      && String(formData.get('privateUseAccountId')).trim() !== ''
      ? String(formData.get('privateUseAccountId')) : null;

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
        accountId, vatTreatmentId, reason, fxRate, reversalDate: correctionDate,
        businessUseBasisPoints: businessUseBasisPoints,
        privateUseAccountId: privateUseAccountId,
        source: 'user', provenanceStatus: 'user_confirmed', actor: 'user',
      });
      revalidatePath('/transactions');
      revalidatePath(`/transactions/${transactionId}`);
      return { ok: true, message: 'Reclassified. The original entry was reversed, not edited.' };
    }

    classifyTransaction(db, {
      companyId: company.id, bankTransactionId: transactionId,
      accountId, vatTreatmentId, fxRate, vatDeclarationDate: correctionDate,
      businessUseBasisPoints: businessUseBasisPoints,
      privateUseAccountId: privateUseAccountId,
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
    await requireActor('documents.review');
    const company = requireCompany();
    acceptMatch(getDb(), {
      companyId: company.id,
      documentId: String(formData.get('documentId')),
      bankTransactionId: String(formData.get('bankTransactionId')),
      actor: await actorName(),
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
    await requireActor('documents.review');
    const company = requireCompany();
    rejectMatch(getDb(), {
      companyId: company.id,
      documentId: String(formData.get('documentId')),
      bankTransactionId: String(formData.get('bankTransactionId')),
      actor: await actorName(),
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
    await requireActor('documents.review');
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
      actor: await actorName(),
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

export async function withdrawMatchRejectionAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('documents.review');
    const company = requireCompany();
    const documentId = String(formData.get('documentId') ?? '');
    withdrawMatchRejection(getDb(), {
      companyId: company.id,
      documentId,
      bankTransactionId: String(formData.get('bankTransactionId') ?? ''),
      actor: await actorName(),
      reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath('/review');
    revalidatePath('/documents');
    revalidatePath(`/documents/${documentId}`);
    return { ok: true, message: 'Rejection withdrawn. The pairing can be suggested again.' };
  } catch (error) {
    return fail(error);
  }
}

export async function linkJournalAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('transactions.classify');
    const company = requireCompany();
    const bankTransactionId = String(formData.get('bankTransactionId') ?? '');
    linkBankTransactionToJournal(getDb(), {
      companyId: company.id,
      bankTransactionId,
      journalEntryId: String(formData.get('journalEntryId') ?? ''),
      actor: await actorName(),
      reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath('/transactions');
    revalidatePath(`/transactions/${bankTransactionId}`);
    revalidatePath('/reconcile');
    return { ok: true, message: 'Bank line linked to the journal already in the ledger.' };
  } catch (error) {
    return fail(error);
  }
}

export async function unmatchDocumentAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('documents.review');
    const company = requireCompany();
    const documentId = String(formData.get('documentId'));
    if (!documentId) {
      return { ok: false, error: 'A document is required.' };
    }
    unmatchDocument(getDb(), {
      companyId: company.id,
      documentId,
      actor: await actorName(),
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
    await requireActor('vat.file');
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
    await requireActor('documents.review');
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
    const actor = await requireActor('documents.ingest');
    const db = getDb();
    const company = requireCompany();
    const files = formData.getAll('files').filter((f): f is File => f instanceof File);
    if (files.length === 0) return { ok: false, error: 'Choose at least one file.' };

    // "File as" (issue #427): a person may declare the document's type at
    // upload. Only the vault types (contract, Revenue document, grant letter,
    // payslip, company document) can be declared here — for those, the
    // declaration is the confirmation and the invoice reader does not run.
    // Everything else is read as evidence of a supply and waits for review.
    const declared = String(formData.get('documentType') ?? 'auto');
    if (declared !== 'auto' && !(ALL_DOCUMENT_TYPES as string[]).includes(declared)) {
      return { ok: false, error: `Unknown document type "${declared}".` };
    }
    const fileAsVault = declared !== 'auto' && isVaultDocumentType(declared);

    let stored = 0;
    const warnings: string[] = [];

    for (const file of files) {
      const content = Buffer.from(await file.arrayBuffer());
      const result = storeDocument(db, {
        companyId: company.id, filename: file.name, content, uploadedBy: 'user',
        ...(fileAsVault
          ? {
            documentType: declared as 'contract',
            // The person filing it says what it is; there are no figures to
            // check against the page, so their word is the confirmation.
            confirmedBy: actor.displayName || actor.username,
          }
          : {}),
      });
      stored += 1;
      if (result.isDuplicate) {
        warnings.push(
          `${file.name} is identical to a document already on file. It was flagged `
          + 'for review rather than overwriting it.',
        );
      }
      if (fileAsVault) continue;
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
      message: fileAsVault
        ? `${stored} ${VAULT_TYPE_LABELS[declared as 'contract'].toLowerCase()} `
          + `${stored === 1 ? 'document' : 'documents'} filed.`
        : `${stored} document${stored === 1 ? '' : 's'} stored and read. Check and confirm `
          + `${stored === 1 ? 'it' : 'each one'} before it is used.`,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function scanWatchFolderAction(): Promise<ActionResult> {
  try {
    await requireActor('documents.ingest');
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

/**
 * Retire a stored document (issue #430). Archive takes it out of the working
 * lists and is reversible; delete is permanent and only possible on an
 * archived document that supports nothing.
 */
export async function archiveDocumentAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('documents.manage');
    const db = getDb();
    const company = requireCompany();
    const documentId = String(formData.get('documentId') ?? '');
    archiveDocument(db, {
      companyId: company.id, documentId, actor: await actorName(), reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath('/documents');
    revalidatePath(`/documents/${documentId}`);
    return { ok: true, message: 'Archived. It is out of the working lists and can be restored.' };
  } catch (error) {
    return fail(error);
  }
}

export async function restoreDocumentAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('documents.manage');
    const db = getDb();
    const company = requireCompany();
    const documentId = String(formData.get('documentId') ?? '');
    restoreDocument(db, {
      companyId: company.id, documentId, actor: await actorName(), reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath('/documents');
    revalidatePath(`/documents/${documentId}`);
    return { ok: true, message: 'Restored to the working lists.' };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteDocumentAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('documents.manage');
    const db = getDb();
    const company = requireCompany();
    const documentId = String(formData.get('documentId') ?? '');
    const result = deleteDocument(db, {
      companyId: company.id, documentId, actor: await actorName(), reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath('/documents');
    return {
      ok: true,
      message: result.removedFile
        ? 'Deleted, and the stored file removed with it.'
        : 'Deleted. The stored file is kept: another document has the same bytes.',
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Apply the default retention policies to a book created before they were
 * seeded (issue #432). Refused once the book has any policy of its own: the
 * defaults are a starting point, never a change to a decision already made.
 */
export async function applyDefaultRetentionPoliciesAction(): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
    const company = requireCompany();
    seedDefaultRetentionPolicies(getDb(), company.id, {
      effectiveFrom: asIsoDate(company.tradeCommencedOn ?? company.dateIncorporated ?? '1900-01-01'),
      actor: await actorName(),
    });
    revalidatePath('/settings/retention');
    return { ok: true, message: 'Default policies applied: 6 years for every type, never dispose for company documents and contracts.' };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Set a retention policy (issue #429). The policy is effective-dated: the one
 * in force until now is superseded from this date, never overwritten, so a
 * document dated before the change still resolves the policy of its own day.
 */
export async function setRetentionPolicyAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
    const db = getDb();
    const company = requireCompany();
    const appliesTo = String(formData.get('appliesTo') ?? 'all');
    const neverDispose = formData.get('neverDispose') === 'on';
    const retainYears = Number(formData.get('retainYears')) || 0;
    const effectiveFrom = asIsoDate(String(formData.get('effectiveFrom') ?? ''));
    const note = formData.get('note') ? String(formData.get('note')) : null;
    setRetentionPolicy(db, {
      companyId: company.id,
      appliesTo: appliesTo === 'all' ? 'all' : appliesTo as 'contract',
      retainYears,
      neverDispose,
      effectiveFrom,
      note,
      actor: await actorName(),
    });
    revalidatePath('/settings/retention');
    revalidatePath('/documents');
    return {
      ok: true,
      message: neverDispose
        ? `Policy set: keep ${appliesTo === 'all' ? 'every type without a specific policy' : appliesTo} `
          + 'for the life they belong to — never dispose.'
        : `Policy set: keep ${appliesTo === 'all' ? 'every type without a specific policy' : appliesTo} `
          + `for ${retainYears} year${retainYears === 1 ? '' : 's'} from ${effectiveFrom}.`,
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Dispose of a document that has passed retention: an explicit, audited
 * archive with a reason, decided by a person (issue #429).
 */
export async function disposeDocumentAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('documents.manage');
    const db = getDb();
    const company = requireCompany();
    const documentId = String(formData.get('documentId') ?? '');
    const reason = String(formData.get('reason') ?? '').trim();
    if (!reason) return { ok: false, error: 'Say why this document may be disposed of.' };
    // The person confirms no condition extends retention before anything is
    // disposed (issue #432): an open Revenue inquiry, investigation, claim or
    // appeal (VATCA s.84(4)), or a year whose return was never delivered
    // (TCA s.886).
    if (formData.get('confirmNoExtension') !== 'on') {
      return { ok: false, error: RETENTION_EXTENSION_CONDITIONS };
    }
    const doc = db.select().from(documents)
      .where(and(eq(documents.companyId, company.id), eq(documents.id, documentId))).get();
    if (doc && retentionEndsOn(db, company.id, doc)?.neverDispose) {
      return {
        ok: false,
        error: 'This type of document is kept for the life it belongs to under a never-dispose policy '
          + '(issue #432). Reclassify the document, or supersede the policy, if that is wrong.',
      };
    }
    archiveDocument(db, {
      companyId: company.id, documentId, actor: await actorName(),
      reason: `Past retention: ${reason}`,
    });
    revalidatePath('/settings/retention');
    revalidatePath('/documents');
    return { ok: true, message: 'Archived as disposed of. The reason is on the audit trail.' };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Record a movement with no statement line behind it — petty cash, most
 * often (issue #377). The person recording it is the evidence.
 */
export async function recordManualTransactionAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('banking.import');
    const db = getDb();
    const company = requireCompany();
    const bankAccountId = String(formData.get('bankAccountId') ?? '');
    const account = db.select().from(bankAccounts)
      .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, company.id))).get();
    if (!account) return { ok: false, error: 'Choose which account this movement is on.' };
    const amount = String(formData.get('amount') ?? '').trim();
    if (!amount) return { ok: false, error: 'Enter the amount: negative for money out, positive for money in.' };
    recordManualTransaction(db, {
      companyId: company.id,
      bankAccountId,
      transactionDate: String(formData.get('transactionDate') ?? ''),
      description: String(formData.get('description') ?? ''),
      amountMinor: parseAmount(amount, account.currency),
      reference: String(formData.get('reference') ?? '').trim() || null,
      recordedBy: await actorName(),
    });
    revalidatePath('/transactions');
    revalidatePath('/import');
    return { ok: true, message: 'Recorded. Classify it on the Transactions page like any other line.' };
  } catch (error) {
    return fail(error);
  }
}

/** Undo a statement import that went wrong (issue #379). */
export async function rollbackImportAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('banking.import');
    const company = requireCompany();
    const result = rollbackStatementImport(getDb(), {
      companyId: company.id,
      importId: String(formData.get('importId') ?? ''),
      reason: String(formData.get('reason') ?? ''),
      actor: await actorName(),
    });
    revalidatePath('/import');
    revalidatePath('/transactions');
    revalidatePath('/reconcile');
    return {
      ok: true,
      message: `Import undone: ${result.linesRolledBack} line${result.linesRolledBack === 1 ? '' : 's'} `
        + 'taken back out. They stay on record as rolled back; import the corrected file when ready.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function importStatementAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('banking.import');
    const db = getDb();
    const company = requireCompany();
    const file = formData.get('file');
    const bankAccountId = String(formData.get('bankAccountId'));
    if (!(file instanceof File)) return { ok: false, error: 'Choose a statement file.' };
    if (!bankAccountId) return { ok: false, error: 'Choose which bank account this is for.' };

    const content = Buffer.from(await file.arrayBuffer());
    const format = detectStatementFormat(file.name, content);

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
    await requireActor('documents.review');
    const db = getDb();
    const company = requireCompany();
    const reviewedBy = await actorName();
    const result = confirmDocument(db, { companyId: company.id, ...input, reviewedBy });
    // A vault document (contract, grant letter, payslip…) is evidence of
    // nothing to match; confirming it is fine, matching it is not even tried.
    let match: ReturnType<typeof findMatchesForDocument> | null = null;
    try {
      match = findMatchesForDocument(db, { companyId: company.id, documentId: input.documentId });
    } catch (error) {
      if (!(error instanceof MatchError)) throw error;
    }
    revalidatePath(`/documents/${input.documentId}`);
    revalidatePath('/documents');
    revalidatePath('/review');
    revalidatePath('/');
    const corrected = result.changedFields.length;
    return {
      ok: true,
      message: `Confirmed${corrected ? ` with ${corrected} correction${corrected === 1 ? '' : 's'}` : ''}. `
        + (match
          ? match.applied ? 'Matched to its bank transaction.'
            : match.best ? 'A possible bank match is waiting for your decision.'
            : 'No bank transaction matches it yet.'
          : 'It is not evidence of a supply, so it is not matched to anything.'),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function rejectDocumentAction(documentId: string, reason: string): Promise<ActionResult> {
  try {
    await requireActor('documents.review');
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
    await requireActor('documents.review');
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
    await requireActor('documents.ingest');
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

// ---- Consolidation (issue #203) ----

type FxInput = { numerator: number; denominator: number; source: string; date?: string };

/** Post a confirmed document as an invoice, from the person's coding of each line. */
export async function postDocumentAction(input: {
  documentId: string; coding: LineCoding[]; fxRate?: FxInput; vatDeclarationDate?: string; holdVat?: boolean;
}): Promise<ActionResult> {
  try {
    await requireActor('documents.post');
    const company = requireCompany();
    const created = postDocumentAsInvoice(getDb(), {
      companyId: company.id, documentId: input.documentId, coding: input.coding, fxRate: input.fxRate,
      vatDeclarationDate: input.vatDeclarationDate ? asIsoDate(input.vatDeclarationDate) : undefined,
      holdVatForMissingParticulars: input.holdVat,
      actor: await actorName(),
    });
    revalidatePath(`/documents/${input.documentId}`);
    revalidatePath('/documents');
    revalidatePath('/invoices');
    revalidatePath('/vat');
    return {
      ok: true,
      message: `Posted: net ${(created.netMinor / 100).toFixed(2)}, VAT ${(created.vatMinor / 100).toFixed(2)}`
        + `${created.vatDeferred ? ' (output VAT due when paid, cash receipts basis)' : ''}. `
        + 'Now settle its bank payment against it.',
    };
  } catch (error) {
    return fail(error);
  }
}

/** Settle a bank line against one or more invoices. */
/** A typed decimal rate as an exact fraction, or undefined when none was typed (issue #223). */
function typedFxRate(text: string | undefined): FxInput | undefined {
  if (!text?.trim()) return undefined;
  const rate = parseDecimalRate(text);
  if (!rate) throw new Error(`"${text}" is not an exchange rate. Enter a positive decimal, e.g. 1.0842.`);
  return { ...rate, source: 'user_supplied' };
}

/**
 * What the settle form needs as the person ticks invoices: whether a rate is
 * needed (and which way it converts), and what settling would post — per
 * invoice, the exchange difference and any remainder — computed by the domain
 * without writing anything (issue #223).
 */
export async function previewSettlementAction(input: {
  bankTransactionId: string; allocations: SettleAllocation[]; fxRateText?: string;
  writeOff?: { invoiceId: string; accountId: string; reason: PaymentWriteOffReason } | null;
}): Promise<{ need: SettlementRateNeed; preview: ReturnType<typeof previewSettlement> | null }> {
  await requireActor('invoices.manage');
  const company = requireCompany();
  const db = getDb();
  const need = settlementRateNeed(db, {
    companyId: company.id, bankTransactionId: input.bankTransactionId,
    invoiceIds: input.allocations.map((a) => a.invoiceId),
  });
  if (input.allocations.length === 0 || need.needed === 'unsupported') return { need, preview: null };
  let fxRate: FxInput | undefined;
  try {
    fxRate = typedFxRate(input.fxRateText);
  } catch (error) {
    return { need, preview: { ok: false, error: (error as Error).message } };
  }
  if (need.needed === true && !fxRate && !need.statementRate) return { need, preview: null };
  return {
    need,
    preview: previewSettlement(db, {
      companyId: company.id, bankTransactionId: input.bankTransactionId, allocations: input.allocations, fxRate,
      writeOff: input.writeOff ?? null,
    }),
  };
}

export async function settleTransactionAction(input: {
  bankTransactionId: string; allocations: SettleAllocation[]; fxRateText?: string; vatDeclarationDate?: string;
  /** The s.37(4) rate at the receipt for foreign-currency output VAT (issue #661). */
  vatFx?: { rate: string; currency: string; source?: string; date?: string };
  writeOff?: { invoiceId: string; accountId: string; reason: PaymentWriteOffReason } | null;
}): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const payment = settleBankTransaction(getDb(), {
      companyId: company.id, bankTransactionId: input.bankTransactionId, allocations: input.allocations,
      fxRate: typedFxRate(input.fxRateText), actor: await actorName(),
      vatFxRate: input.vatFx ? parseVatFxRate(input.vatFx) : null,
      vatDeclarationDate: input.vatDeclarationDate ? asIsoDate(input.vatDeclarationDate) : undefined,
      writeOff: input.writeOff ?? null,
    });
    revalidatePath(`/transactions/${input.bankTransactionId}`);
    revalidatePath('/transactions');
    revalidatePath('/invoices');
    revalidatePath('/review');
    revalidatePath('/');
    const parts = [payment.unallocatedMinor
      ? `Settled. ${(payment.unallocatedMinor / 100).toFixed(2)} is held on account and flagged for review.`
      : 'Settled in full.'];
    if (payment.writtenOffMinor !== 0) {
      parts.push(`${(payment.writtenOffMinor / 100).toFixed(2)} written off; VAT unchanged and flagged for review.`);
    }
    if (payment.fxDifferenceMinor !== 0) {
      parts.push(`An exchange difference of ${(payment.fxDifferenceMinor / 100).toFixed(2)} was posted.`);
    }
    return { ok: true, message: parts.join(' ') };
  } catch (error) {
    return fail(error);
  }
}

/** Apply money a payment holds on account to a later invoice of the same party (issue #386). */
export async function allocateOnAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const invoiceId = String(formData.get('invoiceId') ?? '');
    const vatDeclarationDate = formData.get('vatDeclarationDate') ? String(formData.get('vatDeclarationDate')) : null;
    const result = allocatePaymentOnAccount(getDb(), {
      companyId: company.id,
      paymentId: String(formData.get('paymentId') ?? ''),
      invoiceId,
      amountMinor: parseAmount(String(formData.get('amount') ?? ''), company.baseCurrency),
      actor: await actorName(),
      reason: formData.get('reason') ? String(formData.get('reason')) : null,
      vatDeclarationDate,
    });
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath('/invoices');
    revalidatePath('/review');
    const vatPart = result.vatReleasedMinor !== 0
      ? ` Its output VAT of ${(result.vatReleasedMinor / 100).toFixed(2)} became due, dated at the receipt `
        + `(s.80(1))${vatDeclarationDate ? ', declared in the period you named and flagged for review' : ''}.`
      : '';
    return {
      ok: true,
      message: (result.outstandingMinor === 0 ? 'Applied. The invoice is paid.' : 'Applied. The invoice is part-paid.')
        + vatPart,
    };
  } catch (error) {
    return fail(error);
  }
}

/** Reverse a settlement so the bank line can be settled again, correctly (issue #220). */
export async function reversePaymentAction(input: {
  paymentId: string; bankTransactionId: string; reason: string; reversalDate?: string;
}): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const result = reversePayment(getDb(), {
      companyId: company.id, paymentId: input.paymentId, reason: input.reason,
      reversalDate: input.reversalDate ? asIsoDate(input.reversalDate) : undefined,
      actor: await actorName(),
    });
    revalidatePath(`/transactions/${input.bankTransactionId}`);
    revalidatePath('/transactions');
    revalidatePath('/invoices');
    revalidatePath('/vat');
    revalidatePath('/');
    return {
      ok: true,
      message: `Reversed. ${result.invoiceStatuses.length} invoice${result.invoiceStatuses.length === 1 ? ' is' : 's are'} open again`
        + `${result.reversedVatEntryIds.length ? ' and the output VAT this receipt released is reversed' : ''}. `
        + 'Settle the bank line again against the right invoices.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function setExtractionEngineAction(engine: 'local' | 'anthropic'): Promise<ActionResult> {
  try {
    await requireActor('config.manage');
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
    await requireActor('documents.review');
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

export async function loadDemoDataAction(formData?: FormData): Promise<ActionResult> {
  try {
    await requireActor('company.manage');
    const db = getDb();
    runMigrations(db);
    const raw = formData ? String(formData.get('entityType') ?? 'company').trim() : 'company';
    const entityType: DemoEntityType =
      raw === 'sole_trader' || raw === 'partnership' || raw === 'company' ? raw : 'company';
    const existing = db.select().from(companies).all();
    if (existing.some((c) => !c.isDemo)) {
      return {
        ok: false,
        error: 'Demo data is only loaded when the book holds no real companies, so it can never '
          + 'be mixed with real books.',
      };
    }
    if (existing.some((c) => c.isDemo && c.entityType === entityType && !c.archivedAt)) {
      const label = entityType === 'sole_trader' ? 'sole trader'
        : entityType === 'partnership' ? 'partnership' : 'limited company';
      return {
        ok: false,
        error: `A demo ${label} is already the active book.`,
      };
    }
    // One active book at a time: put earlier demos away so the new one is the working set.
    for (const prior of existing.filter((c) => c.isDemo && !c.archivedAt)) {
      archiveCompany(db, {
        companyId: prior.id,
        basis: 'Replaced by another demo variant (issue #283).',
        confirmedBy: await actorName(),
      });
    }
    const result = await seedDemoCompany(db, { entityType });
    revalidatePath('/');
    revalidatePath('/settings/company');
    revalidatePath('/reports/year-end');
    const label = entityType === 'sole_trader' ? 'sole trader'
      : entityType === 'partnership' ? 'partnership' : 'limited company';
    return {
      ok: true,
      message: `Demo ${label} created with ${result.counts.transactions} transactions and `
        + `${result.counts.documents} documents. It is labelled as demo data everywhere.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function createBackupAction(): Promise<ActionResult> {
  try {
    await requireActor('backup.manage');
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
    await requireActor('backup.manage');
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

/** A customer's payment terms and credit limit (issue #392). A blank limit removes it. */
export async function setCustomerTermsAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('parties.manage');
    const company = requireCompany();
    const customerId = String(formData.get('customerId') ?? '');
    const limitText = String(formData.get('creditLimit') ?? '').trim();
    setCustomerTerms(getDb(), {
      companyId: company.id, customerId, actor: await actorName(),
      paymentTermsDays: Number(String(formData.get('paymentTermsDays') ?? '0')),
      creditLimitMinor: limitText ? parseAmount(limitText, company.baseCurrency) : null,
      reason: formData.get('reason') ? String(formData.get('reason')) : null,
    });
    revalidatePath(`/customers/${customerId}`);
    revalidatePath('/customers');
    return { ok: true, message: 'Terms saved. They apply to invoices from now on.' };
  } catch (error) {
    return fail(error);
  }
}

export async function addCustomerContactAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('parties.manage');
    const company = requireCompany();
    const customerId = String(formData.get('customerId') ?? '');
    addCustomerContact(getDb(), {
      companyId: company.id, customerId, actor: await actorName(),
      name: String(formData.get('name') ?? ''),
      role: formData.get('role') ? String(formData.get('role')) : null,
      email: formData.get('email') ? String(formData.get('email')) : null,
      phone: formData.get('phone') ? String(formData.get('phone')) : null,
      isBilling: formData.get('isBilling') === 'on',
    });
    revalidatePath(`/customers/${customerId}`);
    return { ok: true, message: 'Contact added.' };
  } catch (error) {
    return fail(error);
  }
}

export async function customerContactAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('parties.manage');
    const company = requireCompany();
    const contactId = String(formData.get('contactId') ?? '');
    const params = { companyId: company.id, contactId, actor: await actorName() };
    if (formData.get('op') === 'billing') setBillingContact(getDb(), params);
    else deactivateCustomerContact(getDb(), params);
    revalidatePath(`/customers/${String(formData.get('customerId') ?? '')}`);
    return { ok: true, message: formData.get('op') === 'billing' ? 'Billing contact changed.' : 'Contact removed from use.' };
  } catch (error) {
    return fail(error);
  }
}

/** A recurring sales invoice template with one line (issue #394). */
export async function createRecurringInvoiceAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const discountText = String(formData.get('discountPercent') ?? '').trim();
    const discountBasisPoints = discountText ? parsePercentBasisPoints(discountText) : null;
    if (discountText && discountBasisPoints === null) return { ok: false, error: `"${discountText}" is not a percentage.` };
    const endDate = String(formData.get('endDate') ?? '').trim();
    createRecurringInvoice(getDb(), {
      companyId: company.id,
      customerId: String(formData.get('customerId') ?? ''),
      name: String(formData.get('name') ?? ''),
      frequency: String(formData.get('frequency') ?? 'monthly') as 'monthly' | 'quarterly' | 'yearly',
      startDate: asIsoDate(String(formData.get('startDate') ?? '')),
      endDate: endDate ? asIsoDate(endDate) : null,
      lines: [{
        description: String(formData.get('description') ?? ''),
        netMinor: parseAmount(String(formData.get('net') ?? ''), company.baseCurrency),
        ...(discountBasisPoints !== null ? { discountBasisPoints } : {}),
        accountId: String(formData.get('accountId') ?? ''),
        vatTreatmentId: String(formData.get('vatTreatmentId') ?? ''),
      }],
      actor: await actorName(),
    });
    revalidatePath('/invoices/recurring');
    return { ok: true, message: 'Saved. Nothing is raised until you raise the due invoices.' };
  } catch (error) {
    return fail(error);
  }
}

export async function postDueRecurringInvoicesAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const result = postDueRecurringInvoices(getDb(), {
      companyId: company.id, upTo: asIsoDate(String(formData.get('upTo') ?? '')), actor: await actorName(),
    });
    revalidatePath('/invoices/recurring');
    revalidatePath('/invoices');
    revalidatePath('/review');
    return {
      ok: true,
      message: result.raised.length === 0 ? 'Nothing was due.' : `Raised ${result.raised.length} invoice${result.raised.length === 1 ? '' : 's'}.`,
      warnings: result.skipped.length > 0
        ? result.skipped.map((s) => `${s.templateName} for ${s.date} was not raised: ${s.reason}`)
        : undefined,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function deactivateRecurringInvoiceAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    deactivateRecurringInvoice(getDb(), {
      companyId: company.id, templateId: String(formData.get('templateId') ?? ''), actor: await actorName(),
    });
    revalidatePath('/invoices/recurring');
    return { ok: true, message: 'Stopped. Invoices already raised are unchanged.' };
  } catch (error) {
    return fail(error);
  }
}

/** Apply a credit note to an invoice of the same party, without cash (issue #402). */
export async function applyCreditNoteAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const creditNoteId = String(formData.get('creditNoteId') ?? '');
    const invoiceId = String(formData.get('invoiceId') ?? '');
    applyCreditNote(getDb(), {
      companyId: company.id, creditNoteId, invoiceId,
      amountMinor: parseAmount(String(formData.get('amount') ?? ''), company.baseCurrency),
      date: asIsoDate(String(formData.get('date') ?? new Date().toISOString().slice(0, 10))),
      actor: await actorName(), reason: formData.get('reason') ? String(formData.get('reason')) : null,
    });
    for (const id of [creditNoteId, invoiceId]) revalidatePath(`/invoices/${id}`);
    revalidatePath('/invoices');
    return { ok: true, message: 'Credit note applied. Nothing was posted: both sit on the same control account.' };
  } catch (error) {
    return fail(error);
  }
}

export async function unapplyCreditNoteAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    unapplyCreditNote(getDb(), {
      companyId: company.id, paymentId: String(formData.get('paymentId') ?? ''),
      actor: await actorName(), reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath(`/invoices/${String(formData.get('invoiceId') ?? '')}`);
    revalidatePath('/invoices');
    return { ok: true, message: 'Unapplied. Both documents are open again for that amount.' };
  } catch (error) {
    return fail(error);
  }
}

/** Refund money a customer's payment holds on account (issue #402). */
export async function refundOnAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const bankTransactionId = String(formData.get('bankTransactionId') ?? '').trim();
    refundOnAccount(getDb(), {
      companyId: company.id, paymentId: String(formData.get('paymentId') ?? ''),
      amountMinor: parseAmount(String(formData.get('amount') ?? ''), company.baseCurrency),
      ...(bankTransactionId
        ? { bankTransactionId }
        : { date: asIsoDate(String(formData.get('date') ?? '')), bankAccountId: String(formData.get('bankAccountId') ?? '') }),
      actor: await actorName(), reason: String(formData.get('reason') ?? ''),
    });
    revalidatePath(`/customers/${String(formData.get('customerId') ?? '')}`);
    revalidatePath('/transactions');
    return { ok: true, message: 'Refund posted.' };
  } catch (error) {
    return fail(error);
  }
}

/** A debit note: an additional charge against an earlier invoice (issue #403). One line. */
export async function raiseDebitNoteAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const db = getDb();
    const originalId = String(formData.get('invoiceId') ?? '');
    const original = db.select().from(invoicesTable).where(eq(invoicesTable.id, originalId)).get();
    if (!original || original.companyId !== company.id) return { ok: false, error: 'Invoice not found.' };
    const result = createInvoice(db, {
      companyId: company.id, direction: original.direction,
      invoiceDate: asIsoDate(String(formData.get('date') ?? new Date().toISOString().slice(0, 10))),
      customerId: original.customerId, supplierId: original.supplierId,
      currency: original.currency !== company.baseCurrency ? original.currency : undefined,
      isDebitNote: true, debitNoteOfId: original.id,
      lines: [{
        description: String(formData.get('description') ?? ''),
        netMinor: parseAmount(String(formData.get('net') ?? ''), original.currency),
        accountId: String(formData.get('accountId') ?? ''),
        vatTreatmentId: String(formData.get('vatTreatmentId') ?? ''),
      }],
      actor: await actorName(),
    });
    revalidatePath('/invoices');
    revalidatePath(`/invoices/${original.id}`);
    return { ok: true, message: 'Debit note raised.', warnings: result.warnings.length > 0 ? result.warnings : undefined };
  } catch (error) {
    return fail(error);
  }
}

/** Write a sales invoice off as a bad debt (issue #404). */
export async function writeOffBadDebtAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const invoiceId = String(formData.get('invoiceId') ?? '');
    const accountId = String(formData.get('accountId') ?? '').trim();
    const result = writeOffBadDebt(getDb(), {
      companyId: company.id, invoiceId, date: asIsoDate(String(formData.get('date') ?? '')),
      reason: String(formData.get('reason') ?? ''), actor: await actorName(), accountId: accountId || null,
    });
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath('/invoices');
    revalidatePath('/review');
    return {
      ok: true,
      message: `Written off: ${(result.writtenOffMinor / 100).toFixed(2)}.`,
      warnings: [result.vatCancelledMinor !== 0
        ? `${(result.vatCancelledMinor / 100).toFixed(2)} of deferred VAT was never due and has been cancelled.`
        : 'VAT already declared on it is not reclaimed here: see the review item about bad-debt relief.'],
    };
  } catch (error) {
    return fail(error);
  }
}

export async function reverseBadDebtAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const invoiceId = String(formData.get('invoiceId') ?? '');
    reverseBadDebtWriteOff(getDb(), {
      companyId: company.id, invoiceId, date: asIsoDate(String(formData.get('date') ?? '')),
      reason: String(formData.get('reason') ?? ''), actor: await actorName(),
    });
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath('/invoices');
    return { ok: true, message: 'Write-off reversed. The invoice is open again.' };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Record a deemed supply (issue #658). The person states the facts; the domain
 * works out whether it is a supply, the taxable amount and the VAT. When it is
 * not a supply, nothing is posted and the reason is shown.
 */
export async function recordDeemedSupplyAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('journals.post');
    const company = requireCompany();
    const field = (key: string) => String(formData.get(key) ?? '').trim();
    const yes = (key: string, question = 'every question') => {
      const value = field(key);
      if (value !== 'yes' && value !== 'no') throw new Error(`Answer ${question} yes or no: each one decides whether VAT is due.`);
      return value === 'yes';
    };
    const whole = (key: string, what: string) => {
      const value = field(key);
      if (!/^\d+$/.test(value)) throw new Error(`${what} must be a whole number.`);
      return Number(value);
    };
    const common = {
      companyId: company.id, date: field('date'), accountId: field('accountId'),
      description: field('description'), recordedBy: await actorName(),
    };
    const kind = field('kind');
    let result;
    if (kind === 'goods') {
      const use = field('use');
      if (use !== 'gift' && use !== 'private_use') throw new Error('Say whether the goods were given away or taken for private use.');
      result = recordDeemedSupply(getDb(), {
        ...common, kind, use, costMinor: parseAmount(field('cost'), company.baseCurrency),
        treatmentCode: field('treatmentCode'), taxDeductedOrTransferred: yes('taxDeductedOrTransferred'),
        ...(use === 'gift'
          ? {
            partOfSeriesToSamePerson: yes('partOfSeriesToSamePerson', 'whether the gift is one of a series to the same person'),
            industrialSamples: yes('industrialSamples', 'whether the gift is industrial samples'),
          }
          : {}),
      });
    } else if (kind === 'immovable_private_use') {
      result = recordDeemedSupply(getDb(), {
        ...common, kind, acquiredOn: field('acquiredOn'),
        acquisitionTaxableAmountMinor: parseAmount(field('acquisitionAmount'), company.baseCurrency),
        privateFloorArea: whole('privateFloorArea', 'The private floor area'),
        totalFloorArea: whole('totalFloorArea', 'The total floor area'),
        treatedAsBusinessAsset: yes('treatedAsBusinessAsset'),
      });
    } else {
      throw new Error('Say what kind of deemed supply this is.');
    }
    if (!result.posted) return { ok: true, message: 'Nothing posted: this is not a supply.', warnings: [result.reason] };
    revalidatePath('/vat');
    revalidatePath('/adjustments');
    revalidatePath('/review');
    return { ok: true, message: `Posted. ${result.working}` };
  } catch (error) {
    return fail(error);
  }
}

/** Record a payment reminder letter for a customer's overdue invoices (issue #405). */
export async function produceReminderAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const customerId = String(formData.get('customerId') ?? '');
    const result = produceReminderLetter(getDb(), {
      companyId: company.id, customerId, asOf: asIsoDate(String(formData.get('asOf') ?? '')),
      level: Number(String(formData.get('level') ?? '1')), actor: await actorName(),
    });
    revalidatePath('/receivables');
    revalidatePath(`/customers/${customerId}`);
    return { ok: true, message: `Reminder recorded for ${result.invoices} invoice${result.invoices === 1 ? '' : 's'}. Download it from the customer page.` };
  } catch (error) {
    return fail(error);
  }
}

/** A supplier's payment terms, for the due date of its bills (issue #410). */
export async function setSupplierTermsAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('parties.manage');
    const company = requireCompany();
    const supplierId = String(formData.get('supplierId') ?? '');
    setSupplierTerms(getDb(), {
      companyId: company.id, supplierId, actor: await actorName(),
      paymentTermsDays: Number(String(formData.get('paymentTermsDays') ?? '0')),
    });
    revalidatePath(`/suppliers/${supplierId}`);
    return { ok: true, message: 'Terms saved. They apply to bills posted from now on.' };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Raise a purchase order (issue #411). The form sends parallel `description`,
 * `quantity` and `net` fields, one set per line; blank lines are skipped.
 */
export async function createPurchaseOrderAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const descriptions = formData.getAll('description').map(String);
    const quantities = formData.getAll('quantity').map(String);
    const nets = formData.getAll('net').map(String);
    const lines = descriptions.flatMap((description, i) => {
      if (!description.trim() && !(nets[i] ?? '').trim()) return [];
      const qty = (quantities[i] ?? '').trim();
      const quantityMilli = qty ? Math.round(Number(qty) * 1000) : undefined;
      if (qty && (!Number.isFinite(Number(qty)) || Number(qty) * 1000 !== quantityMilli)) {
        throw new Error(`"${qty}" is not a quantity (up to three decimal places).`);
      }
      return [{ description, quantityMilli, netMinor: parseAmount(nets[i] ?? '', company.baseCurrency) }];
    });
    const expectedDate = String(formData.get('expectedDate') ?? '').trim();
    const notes = String(formData.get('notes') ?? '').trim();
    const { number } = createPurchaseOrder(getDb(), {
      companyId: company.id,
      supplierId: String(formData.get('supplierId') ?? ''),
      orderDate: asIsoDate(String(formData.get('orderDate') ?? '')),
      expectedDate: expectedDate ? asIsoDate(expectedDate) : null,
      lines, notes: notes || null, actor: await actorName(),
    });
    revalidatePath('/purchase-orders');
    return { ok: true, message: `${number} raised. It posts nothing; link each bill to it as it arrives.` };
  } catch (error) {
    return fail(error);
  }
}

export async function linkBillToPurchaseOrderAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const invoiceId = String(formData.get('invoiceId') ?? '');
    const summary = linkBillToPurchaseOrder(getDb(), {
      companyId: company.id, invoiceId, purchaseOrderId: String(formData.get('purchaseOrderId') ?? ''), actor: await actorName(),
    });
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath('/purchase-orders');
    return {
      ok: true,
      message: summary.billedMinor > summary.orderedMinor
        ? `Linked. ${summary.number} is now billed over what was ordered; that is flagged for review.`
        : `Linked to ${summary.number}.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function unlinkBillFromPurchaseOrderAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const invoiceId = String(formData.get('invoiceId') ?? '');
    unlinkBillFromPurchaseOrder(getDb(), { companyId: company.id, invoiceId, actor: await actorName() });
    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath('/purchase-orders');
    return { ok: true, message: 'Unlinked. The bill itself is unchanged.' };
  } catch (error) {
    return fail(error);
  }
}

export async function cancelPurchaseOrderAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    cancelPurchaseOrder(getDb(), {
      companyId: company.id, purchaseOrderId: String(formData.get('purchaseOrderId') ?? ''),
      reason: String(formData.get('reason') ?? ''), actor: await actorName(),
    });
    revalidatePath('/purchase-orders');
    return { ok: true, message: 'Cancelled. Bills already linked stay linked.' };
  } catch (error) {
    return fail(error);
  }
}

/** A recurring bill (issue #412): an expectation, never a posting. */
export async function createRecurringBillAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const endDate = String(formData.get('endDate') ?? '').trim();
    const toleranceText = String(formData.get('tolerancePercent') ?? '').trim();
    const toleranceBasisPoints = toleranceText ? parsePercentBasisPoints(toleranceText) : undefined;
    if (toleranceText && toleranceBasisPoints === null) return { ok: false, error: `"${toleranceText}" is not a percentage.` };
    const windowText = String(formData.get('windowDays') ?? '').trim();
    createRecurringBill(getDb(), {
      companyId: company.id,
      supplierId: String(formData.get('supplierId') ?? ''),
      name: String(formData.get('name') ?? ''),
      frequency: String(formData.get('frequency') ?? 'monthly') as 'monthly' | 'quarterly' | 'yearly',
      startDate: asIsoDate(String(formData.get('startDate') ?? '')),
      endDate: endDate ? asIsoDate(endDate) : null,
      expectedNetMinor: parseAmount(String(formData.get('net') ?? ''), company.baseCurrency),
      ...(toleranceBasisPoints != null ? { toleranceBasisPoints } : {}),
      ...(windowText ? { windowDays: Number(windowText) } : {}),
      actor: await actorName(),
    });
    revalidatePath('/bills/recurring');
    return { ok: true, message: 'Saved. Each occurrence is expected, never posted: the supplier\'s invoice is the bill.' };
  } catch (error) {
    return fail(error);
  }
}

export async function runExpectedBillsAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const result = runExpectedBills(getDb(), {
      companyId: company.id, asOf: asIsoDate(String(formData.get('asOf') ?? '')), actor: await actorName(),
    });
    revalidatePath('/bills/recurring');
    revalidatePath('/review');
    return {
      ok: true,
      message: `${result.raised.length} expected, ${result.matched.length} matched, ${result.missing.length} missing`
        + (result.ambiguous.length ? `, ${result.ambiguous.length} with more than one possible bill` : '') + '.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function matchExpectedBillAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const { differenceMinor } = matchExpectedBill(getDb(), {
      companyId: company.id, expectedBillId: String(formData.get('expectedBillId') ?? ''),
      invoiceId: String(formData.get('invoiceId') ?? ''), actor: await actorName(),
    });
    revalidatePath('/bills/recurring');
    return { ok: true, message: differenceMinor === 0 ? 'Matched.' : 'Matched. The bill differs from what was expected.' };
  } catch (error) {
    return fail(error);
  }
}

export async function unmatchExpectedBillAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    unmatchExpectedBill(getDb(), {
      companyId: company.id, expectedBillId: String(formData.get('expectedBillId') ?? ''),
      reason: String(formData.get('reason') ?? ''), actor: await actorName(),
    });
    revalidatePath('/bills/recurring');
    return { ok: true, message: 'Unmatched. The bill itself is unchanged.' };
  } catch (error) {
    return fail(error);
  }
}

export async function dismissExpectedBillAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    dismissExpectedBill(getDb(), {
      companyId: company.id, expectedBillId: String(formData.get('expectedBillId') ?? ''),
      reason: String(formData.get('reason') ?? ''), actor: await actorName(),
    });
    revalidatePath('/bills/recurring');
    return { ok: true, message: 'Dismissed: no bill is due for that occurrence.' };
  } catch (error) {
    return fail(error);
  }
}

export async function deactivateRecurringBillAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    deactivateRecurringBill(getDb(), {
      companyId: company.id, recurringBillId: String(formData.get('recurringBillId') ?? ''), actor: await actorName(),
    });
    revalidatePath('/bills/recurring');
    return { ok: true, message: 'Stopped. Occurrences already expected are kept.' };
  } catch (error) {
    return fail(error);
  }
}

/** Check a supplier's statement against our books (issue #413). Nothing is adjusted. */
export async function reconcileSupplierStatementAction(formData: FormData): Promise<ActionResult> {
  try {
    await requireActor('invoices.manage');
    const company = requireCompany();
    const supplierId = String(formData.get('supplierId') ?? '');
    const numbers = String(formData.get('invoiceNumbers') ?? '').split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
    const r = reconcileSupplierStatement(getDb(), {
      companyId: company.id, supplierId, asOf: asIsoDate(String(formData.get('asOf') ?? '')),
      statementBalanceMinor: parseAmount(String(formData.get('balance') ?? ''), company.baseCurrency),
      invoiceNumbers: numbers, actor: await actorName(),
    });
    revalidatePath(`/suppliers/${supplierId}`);
    revalidatePath('/review');
    const m = (minor: number) => (minor / 100).toFixed(2);
    if (r.differenceMinor === 0 && r.theirsNotHeld.length === 0 && r.oursNotOnTheirs.length === 0) {
      return { ok: true, message: `Agrees: ${m(r.ourBalanceMinor)} owed at ${r.asOf}.` };
    }
    return {
      ok: true,
      message: `Their ${m(r.theirBalanceMinor)} against our ${m(r.ourBalanceMinor)}: difference ${m(r.differenceMinor)}.`
        + (r.theirsNotHeld.length ? ` Not held by us: ${r.theirsNotHeld.join(', ')}.` : '')
        + (r.oursNotOnTheirs.length ? ` Not on theirs: ${r.oursNotOnTheirs.map((o) => o.number ?? o.invoiceId).join(', ')}.` : '')
        + ' Flagged for review.',
    };
  } catch (error) {
    return fail(error);
  }
}

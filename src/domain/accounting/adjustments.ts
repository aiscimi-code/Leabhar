import { and, eq, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  journalEntries, journalLines, accounts, companies, auditEvents, accountingPeriods,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, type IsoDate } from '../dates';
import { postJournalEntry, reverseJournalEntry } from './journal';
import { createVatEntries, assertVatPeriodWritable } from '../vat/engine';
import { AccountingError } from './errors';

export class AdjustmentError extends AccountingError {}

/**
 * Controlled manual adjustments (README §30).
 *
 * The governing instruction is the last line of §30: never rewrite historical
 * transactions to make figures balance, use adjustments. So this is the only
 * way to put a figure into the books by hand, and it is deliberately more
 * demanding than the other posting paths:
 *
 *  - a reason is mandatory, not optional;
 *  - an adjustment into a closed period must say why it belongs there;
 *  - an adjustment can be marked as needing approval before it counts.
 *
 * It is not a back door to the journal. It is the front door, with a log.
 */

export interface AdjustmentLineInput {
  accountId: string;
  debitMinor?: number;
  creditMinor?: number;
  memo?: string;
  supplierId?: string | null;
  customerId?: string | null;
  officerId?: string | null;
}

export interface CreateAdjustmentInput {
  companyId: string;
  date: IsoDate;
  description: string;
  /** Mandatory. Recorded in the audit trail and shown on the entry. */
  reason: string;
  lines: AdjustmentLineInput[];
  /** Optional VAT consequence, for adjustments that change a VAT position. */
  vat?: {
    treatmentId: string;
    direction: 'sales' | 'purchases';
    netMinor: number;
    statedVatMinor?: number;
    taxPointDate?: IsoDate;
  };
  documentId?: string | null;
  /** Hold the adjustment as a draft until someone approves it. */
  requiresApproval?: boolean;
  /** Post into a closed or locked period. Needs its own justification. */
  overrideLock?: { reason: string };
  actor?: string;
  requestId?: string;
}

export interface CreatedAdjustment {
  journalEntryId: string;
  entryNumber: number;
  totalMinor: number;
  vatEntryIds: string[];
  approved: boolean;
}

export function createAdjustment(
  db: AppDatabase, input: CreateAdjustmentInput,
): CreatedAdjustment {
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  if (!company) throw new AdjustmentError(`Company ${input.companyId} not found.`);

  if (!input.reason || input.reason.trim().length < 3) {
    throw new AdjustmentError(
      'A manual adjustment needs a reason. It is the only record of why a figure was put '
        + 'into the books by hand, and it is what an accountant will ask about first.',
    );
  }
  if (input.lines.length < 2) {
    throw new AdjustmentError('An adjustment needs at least two lines.');
  }

  // Unbalanced adjustments are the usual way books get silently broken, so the
  // check happens here with a clearer message than the engine's, before the
  // engine enforces it anyway.
  const totalDebit = input.lines.reduce((s, l) => s + (l.debitMinor ?? 0), 0);
  const totalCredit = input.lines.reduce((s, l) => s + (l.creditMinor ?? 0), 0);
  if (totalDebit !== totalCredit) {
    throw new AdjustmentError(
      `This adjustment does not balance: debits ${(totalDebit / 100).toFixed(2)} against `
        + `credits ${(totalCredit / 100).toFixed(2)}, a difference of `
        + `${((totalDebit - totalCredit) / 100).toFixed(2)}. Every adjustment must have an `
        + 'equal and opposite side — decide what the other side of this entry is.',
      { totalDebit, totalCredit, differenceMinor: totalDebit - totalCredit },
    );
  }

  for (const [index, line] of input.lines.entries()) {
    const account = db.select().from(accounts)
      .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, input.companyId)))
      .get();
    if (!account) {
      throw new AdjustmentError(`Line ${index + 1} names an account that does not exist.`);
    }
  }

  if (input.vat) {
    // A locked or filed VAT return is never changed (issue #226), not even by
    // an adjustment: correct it in an open period instead.
    assertVatPeriodWritable(db, input.companyId, input.vat.taxPointDate ?? input.date,
      'The VAT in this adjustment');
  }

  const journal = postJournalEntry(db, {
    companyId: input.companyId,
    entryDate: input.date,
    narrative: input.description,
    sourceType: 'manual_adjustment',
    entryType: 'adjustment',
    baseCurrency: company.baseCurrency,
    createdBy: input.actor ?? 'user',
    createdVia: 'user',
    requestId: input.requestId,
    notes: input.reason,
    overrideLock: input.overrideLock,
    lines: input.lines.map((line) => ({
      accountId: line.accountId,
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
      supplierId: line.supplierId,
      customerId: line.customerId,
      officerId: line.officerId,
      memo: line.memo ?? input.description,
    })),
  });

  const vatEntryIds: string[] = [];
  if (input.vat) {
    const created = createVatEntries(db, {
      companyId: input.companyId,
      journalEntryId: journal.id,
      sourceType: 'manual_adjustment',
      sourceId: journal.id,
      direction: input.vat.direction,
      treatmentId: input.vat.treatmentId,
      taxPointDate: input.vat.taxPointDate ?? input.date,
      netMinor: input.vat.netMinor,
      statedVatMinor: input.vat.statedVatMinor,
      currency: company.baseCurrency,
      baseCurrency: company.baseCurrency,
      source: 'user',
      provenanceStatus: 'manually_entered',
      notes: input.reason,
    });
    vatEntryIds.push(...created.entries.map((e) => e.id));
  }

  db.insert(auditEvents).values({
    id: ids.audit(),
    companyId: input.companyId,
    occurredAt: nowIso(),
    entityType: 'journal_entry',
    entityId: journal.id,
    action: 'adjustment_posted',
    newValue: JSON.stringify({
      date: input.date, description: input.description,
      totalMinor: totalDebit, lines: input.lines.length,
      requiresApproval: input.requiresApproval ?? false,
    }),
    source: 'user',
    actor: input.actor ?? 'user',
    reason: input.reason,
    requestId: input.requestId ?? null,
  }).run();

  return {
    journalEntryId: journal.id,
    entryNumber: journal.entryNumber,
    totalMinor: totalDebit,
    vatEntryIds,
    approved: !(input.requiresApproval ?? false),
  };
}

/**
 * Reverse an adjustment.
 *
 * Adjustments are journal entries, so this is the ordinary reversal path. It
 * exists separately only so the audit trail says "an adjustment was reversed"
 * rather than the more generic phrasing.
 */
export function reverseAdjustment(
  db: AppDatabase,
  params: {
    companyId: string; journalEntryId: string; reversalDate: IsoDate;
    reason: string; actor?: string;
  },
): { reversalEntryId: string; entryNumber: number } {
  if (!params.reason || params.reason.trim().length < 3) {
    throw new AdjustmentError('Reversing an adjustment needs a reason.');
  }

  const entry = db.select().from(journalEntries)
    .where(and(
      eq(journalEntries.id, params.journalEntryId),
      eq(journalEntries.companyId, params.companyId),
    )).get();
  if (!entry) throw new AdjustmentError(`Entry ${params.journalEntryId} not found.`);
  if (entry.entryType !== 'adjustment') {
    throw new AdjustmentError(
      `Entry ${entry.entryNumber} is not a manual adjustment. Reverse it from the record it `
        + 'belongs to, so the reversal appears in the right place.',
    );
  }

  const reversal = reverseJournalEntry(db, {
    companyId: params.companyId,
    entryId: params.journalEntryId,
    reversalDate: params.reversalDate,
    reason: params.reason,
    createdBy: params.actor ?? 'user',
  });

  return { reversalEntryId: reversal.id, entryNumber: reversal.entryNumber };
}

export interface AdjustmentSummary {
  entryId: string;
  entryNumber: number;
  entryDate: string;
  description: string;
  reason: string | null;
  totalMinor: number;
  createdBy: string;
  createdAt: string;
  reversedByEntryId: string | null;
  isReversal: boolean;
  lines: Array<{
    accountCode: string; accountName: string;
    debitMinor: number; creditMinor: number; memo: string | null;
  }>;
}

/** Every manual adjustment, for the audit-facing listing. */
export function listAdjustments(
  db: AppDatabase,
  params: { companyId: string; from?: IsoDate; to?: IsoDate },
): AdjustmentSummary[] {
  const entries = db.select().from(journalEntries)
    .where(and(
      eq(journalEntries.companyId, params.companyId),
      eq(journalEntries.entryType, 'adjustment'),
    ))
    .orderBy(desc(journalEntries.entryDate), desc(journalEntries.entryNumber)).all();

  return entries
    .filter((entry) => (!params.from || entry.entryDate >= params.from)
      && (!params.to || entry.entryDate <= params.to))
    .map((entry) => {
      const lines = db.select({
        line: journalLines, accountCode: accounts.code, accountName: accounts.name,
      })
        .from(journalLines)
        .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
        .where(eq(journalLines.journalEntryId, entry.id))
        .orderBy(journalLines.lineNumber).all();

      return {
        entryId: entry.id,
        entryNumber: entry.entryNumber,
        entryDate: entry.entryDate,
        description: entry.narrative,
        reason: entry.notes,
        totalMinor: lines.reduce((s, l) => s + l.line.baseDebitMinor, 0),
        createdBy: entry.createdBy,
        createdAt: entry.createdAt,
        reversedByEntryId: entry.reversedByEntryId,
        isReversal: entry.reversalOfId !== null,
        lines: lines.map(({ line, accountCode, accountName }) => ({
          accountCode, accountName,
          debitMinor: line.baseDebitMinor,
          creditMinor: line.baseCreditMinor,
          memo: line.memo,
        })),
      };
    });
}

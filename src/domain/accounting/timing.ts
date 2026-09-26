import { and, eq, desc, lte, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  timingAdjustments, journalEntries, journalLines, accounts, companies, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, asIsoDate, type IsoDate } from '../dates';
import { postJournalEntry, reverseJournalEntry, assertAccountingPeriodOpen, atomically } from './journal';
import { AccountingError, NoPeriodError, PeriodLockedError, MissingAccountError } from './errors';
import { systemAccountId } from '../config/setup';

export class TimingError extends AccountingError {}

/**
 * Accruals and prepayments (issues #367, #368).
 *
 * Both are entries that reverse themselves on a named date:
 *
 *  - an accrual puts a cost in the period it belongs to (Dr expense, Cr
 *    accruals) and takes it out when the invoice arrives, so the period-end
 *    accounts show the cost without waiting for paperwork;
 *  - a prepayment parks the paid-but-not-yet-incurred portion in the balance
 *    sheet (Dr prepayments, Cr expense) and releases it as the period it
 *    belongs to arrives.
 *
 * Neither claims input VAT. Input VAT comes only from a confirmed invoice, so
 * an accrual is posted without one and releases nothing to reclaim; when the
 * invoice is confirmed it is posted on its own, as ever.
 *
 * The journal entries are ordinary immutable entries. This module adds the
 * workflow on top: each posting records the date its reversal is due, and
 * `postDueTimingReversals` is the one sanctioned way the reversal happens —
 * through `reverseJournalEntry`, so the reversal is itself a proper entry that
 * references what it reverses.
 */

export type TimingKind = 'accrual' | 'prepayment';

export interface AccrualLineInput {
  /** The expense account the accrued cost belongs to. */
  accountId: string;
  amountMinor: number;
  memo?: string | null;
}

export interface PostedTimingAdjustment {
  timingId: string;
  journalEntryId: string;
  entryNumber: number;
  reversalDate: IsoDate;
  totalMinor: number;
}

function assertReason(reason: string): void {
  if (!reason || reason.trim().length < 3) {
    throw new TimingError(
      'An accrual or prepayment needs a reason. It moves a figure between periods, which '
        + 'is exactly the kind of entry an accountant will ask about first.',
    );
  }
}

function requireExpenseAccount(
  db: AppDatabase, companyId: string, accountId: string, what: string,
): typeof accounts.$inferSelect {
  const account = db.select().from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, companyId))).get();
  if (!account) {
    throw new MissingAccountError(`The account for ${what} does not exist.`, { accountId });
  }
  if (!account.active) {
    throw new MissingAccountError(
      `Account ${account.code} "${account.name}" is inactive and cannot take new postings.`,
      { accountId },
    );
  }
  if (account.type !== 'expense') {
    throw new TimingError(
      `Account ${account.code} "${account.name}" is a ${account.type} account, not an `
        + 'expense. The timing workflow moves costs between periods; anything else is a '
        + 'manual adjustment and should be posted as one.',
      { accountId, accountType: account.type },
    );
  }
  return account;
}

function assertAmount(amountMinor: number, what: string): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new TimingError(
      `The amount for ${what} must be a positive whole number of minor units.`,
      { amountMinor },
    );
  }
}

function recordTimingAdjustment(
  db: AppDatabase,
  params: {
    companyId: string;
    kind: TimingKind;
    journalEntryId: string;
    reversalDate: IsoDate;
    description: string;
    reason: string;
    actor: string;
    requestId?: string;
  },
): string {
  const id = ids.timingAdjustment();
  db.insert(timingAdjustments).values({
    id,
    companyId: params.companyId,
    kind: params.kind,
    journalEntryId: params.journalEntryId,
    reversalDate: params.reversalDate,
    description: params.description,
    reason: params.reason,
    createdBy: params.actor,
    source: 'user',
    provenanceStatus: 'manually_entered',
  }).run();

  db.insert(auditEvents).values({
    id: ids.audit(),
    companyId: params.companyId,
    occurredAt: nowIso(),
    entityType: 'timing_adjustment',
    entityId: id,
    action: 'created',
    field: params.kind,
    newValue: JSON.stringify({
      description: params.description,
      journalEntryId: params.journalEntryId,
      reversalDate: params.reversalDate,
    }),
    source: 'user',
    actor: params.actor,
    reason: params.reason,
    requestId: params.requestId ?? null,
  }).run();

  return id;
}

/**
 * Post an accrual: the expense belongs to this period, the invoice does not
 * exist yet. Debits the expense accounts, credits the accruals account, and
 * records the date the accrual comes off again.
 */
export function postAccrual(
  db: AppDatabase,
  input: {
    companyId: string;
    date: IsoDate;
    description: string;
    /** Mandatory: why the cost is being accrued. */
    reason: string;
    /** When the accrual comes off — typically when the invoice is expected. */
    reversalDate: IsoDate;
    /** The expense side: one or more expense accounts with positive amounts. */
    expenseLines: AccrualLineInput[];
    /** Defaults to the accruals system account. */
    accrualAccountId?: string;
    actor?: string;
    requestId?: string;
  },
): PostedTimingAdjustment {
  assertReason(input.reason);
  if (!input.description || input.description.trim().length < 3) {
    throw new TimingError('An accrual needs a description; it becomes the entry narrative.');
  }
  if (input.expenseLines.length < 1) {
    throw new TimingError('An accrual needs at least one expense line.');
  }
  if (input.reversalDate <= input.date) {
    throw new TimingError(
      'The reversal date must come after the accrual date. An accrual that reverses on the '
        + 'day it posts is a mistake, not a timing difference.',
      { date: input.date, reversalDate: input.reversalDate },
    );
  }

  return atomically(db, () => {
    const company = db.select().from(companies)
      .where(eq(companies.id, input.companyId)).get();
    if (!company) throw new TimingError(`Company ${input.companyId} not found.`);

    for (const [index, line] of input.expenseLines.entries()) {
      assertAmount(line.amountMinor, `accrual line ${index + 1}`);
      requireExpenseAccount(db, input.companyId, line.accountId, `accrual line ${index + 1}`);
    }

    const totalMinor = input.expenseLines.reduce((s, l) => s + l.amountMinor, 0);
    const accrualAccountId = input.accrualAccountId
      ?? systemAccountId(db, input.companyId, 'accruals');

    const journal = postJournalEntry(db, {
      companyId: input.companyId,
      entryDate: input.date,
      narrative: input.description,
      sourceType: 'accrual',
      sourceId: null,
      entryType: 'accrual',
      baseCurrency: company.baseCurrency,
      createdBy: input.actor ?? 'user',
      createdVia: 'user',
      requestId: input.requestId,
      notes: input.reason,
      lines: [
        ...input.expenseLines.map((line) => ({
          accountId: line.accountId,
          debitMinor: line.amountMinor,
          memo: line.memo ?? input.description,
        })),
        {
          accountId: accrualAccountId,
          creditMinor: totalMinor,
          memo: 'Accrued; reverses on ' + input.reversalDate,
        },
      ],
    });

    const timingId = recordTimingAdjustment(db, {
      companyId: input.companyId,
      kind: 'accrual',
      journalEntryId: journal.id,
      reversalDate: input.reversalDate,
      description: input.description,
      reason: input.reason,
      actor: input.actor ?? 'user',
      requestId: input.requestId,
    });

    return {
      timingId,
      journalEntryId: journal.id,
      entryNumber: journal.entryNumber,
      reversalDate: input.reversalDate,
      totalMinor,
    };
  });
}

/**
 * Post a prepayment: the cost was posted in full, but part of it belongs to a
 * later period. Moves the prepaid portion out of the expense account into the
 * prepayments account, and records when it releases back.
 */
export function postPrepayment(
  db: AppDatabase,
  input: {
    companyId: string;
    date: IsoDate;
    description: string;
    /** Mandatory: why the amount is prepaid. */
    reason: string;
    /** When the prepayment releases back into the expense account. */
    reversalDate: IsoDate;
    expenseAccountId: string;
    amountMinor: number;
    memo?: string | null;
    /** Defaults to the prepayments system account. */
    prepaymentAccountId?: string;
    actor?: string;
    requestId?: string;
  },
): PostedTimingAdjustment {
  assertReason(input.reason);
  if (!input.description || input.description.trim().length < 3) {
    throw new TimingError('A prepayment needs a description; it becomes the entry narrative.');
  }
  if (input.reversalDate <= input.date) {
    throw new TimingError(
      'The release date must come after the prepayment date. A prepayment that releases on '
        + 'the day it posts is a mistake, not a timing difference.',
      { date: input.date, reversalDate: input.reversalDate },
    );
  }
  assertAmount(input.amountMinor, 'prepayment');

  return atomically(db, () => {
    const company = db.select().from(companies)
      .where(eq(companies.id, input.companyId)).get();
    if (!company) throw new TimingError(`Company ${input.companyId} not found.`);

    requireExpenseAccount(db, input.companyId, input.expenseAccountId, 'the prepayment');

    const prepaymentAccountId = input.prepaymentAccountId
      ?? systemAccountId(db, input.companyId, 'prepayments');

    const journal = postJournalEntry(db, {
      companyId: input.companyId,
      entryDate: input.date,
      narrative: input.description,
      sourceType: 'prepayment',
      sourceId: null,
      entryType: 'prepayment',
      baseCurrency: company.baseCurrency,
      createdBy: input.actor ?? 'user',
      createdVia: 'user',
      requestId: input.requestId,
      notes: input.reason,
      lines: [
        {
          accountId: prepaymentAccountId,
          debitMinor: input.amountMinor,
          memo: input.memo ?? input.description,
        },
        {
          accountId: input.expenseAccountId,
          creditMinor: input.amountMinor,
          memo: 'Prepaid; releases on ' + input.reversalDate,
        },
      ],
    });

    const timingId = recordTimingAdjustment(db, {
      companyId: input.companyId,
      kind: 'prepayment',
      journalEntryId: journal.id,
      reversalDate: input.reversalDate,
      description: input.description,
      reason: input.reason,
      actor: input.actor ?? 'user',
      requestId: input.requestId,
    });

    return {
      timingId,
      journalEntryId: journal.id,
      entryNumber: journal.entryNumber,
      reversalDate: input.reversalDate,
      totalMinor: input.amountMinor,
    };
  });
}

export interface ReversedTimingAdjustment {
  timingId: string;
  kind: TimingKind;
  description: string;
  reversalDate: IsoDate;
  reversalEntryId: string;
  reversalEntryNumber: number;
}

export interface SkippedTimingReversal {
  timingId: string;
  kind: TimingKind;
  description: string;
  reversalDate: IsoDate;
  reason: string;
}

/**
 * Post the reversals that have fallen due: every accrual and prepayment whose
 * reversal date has arrived and whose entry is not yet reversed.
 *
 * Idempotent, because the reversal state lives on the journal entry itself
 * (`reversedByEntryId`): a run twice in the same day finds nothing left to do.
 * Every reversal date's accounting period is checked before anything posts, so
 * the run either completes or leaves nothing behind (issue #231). A reversal
 * whose period is missing or locked is skipped with the reason — it is never
 * moved to another date and never posted into a locked period.
 */
export function postDueTimingReversals(
  db: AppDatabase,
  params: { companyId: string; upTo: IsoDate; actor?: string; requestId?: string },
): { reversed: ReversedTimingAdjustment[]; skipped: SkippedTimingReversal[] } {
  return atomically(db, () => {
    const due = db.select({ timing: timingAdjustments, entry: journalEntries })
      .from(timingAdjustments)
      .innerJoin(journalEntries, eq(timingAdjustments.journalEntryId, journalEntries.id))
      .where(and(
        eq(timingAdjustments.companyId, params.companyId),
        lte(timingAdjustments.reversalDate, params.upTo),
        isNull(journalEntries.reversedByEntryId),
      ))
      .orderBy(timingAdjustments.reversalDate).all();

    const reversed: ReversedTimingAdjustment[] = [];
    const skipped: SkippedTimingReversal[] = [];
    const toReverse: Array<(typeof due)[number]> = [];

    for (const row of due) {
      try {
        assertAccountingPeriodOpen(db, params.companyId, row.timing.reversalDate);
      } catch (error) {
        if (error instanceof NoPeriodError || error instanceof PeriodLockedError) {
          skipped.push({
            timingId: row.timing.id,
            kind: row.timing.kind,
            description: row.timing.description,
            reversalDate: asIsoDate(row.timing.reversalDate),
            reason: error.message,
          });
          continue;
        }
        throw error;
      }
      toReverse.push(row);
    }

    for (const row of toReverse) {
      const kind = row.timing.kind === 'accrual' ? 'accrual' : 'prepayment';
      const reversal = reverseJournalEntry(db, {
        companyId: params.companyId,
        entryId: row.timing.journalEntryId,
        reversalDate: asIsoDate(row.timing.reversalDate),
        reason: `${kind === 'accrual' ? 'Accrual' : 'Prepayment'} "${row.timing.description}" `
          + `reversed as scheduled on ${row.timing.reversalDate}.`,
        createdBy: params.actor ?? 'system',
        requestId: params.requestId,
      });

      reversed.push({
        timingId: row.timing.id,
        kind,
        description: row.timing.description,
        reversalDate: asIsoDate(row.timing.reversalDate),
        reversalEntryId: reversal.id,
        reversalEntryNumber: reversal.entryNumber,
      });
    }

    return { reversed, skipped };
  });
}

/**
 * Reverse one timing adjustment early — the invoice arrived, or the person
 * knows better than the schedule. The reversal is still an ordinary reversing
 * entry, dated on the date given.
 */
export function reverseTimingAdjustment(
  db: AppDatabase,
  params: {
    companyId: string;
    timingId: string;
    reason: string;
    /** Defaults to the recorded reversal date. */
    reversalDate?: IsoDate;
    actor?: string;
    requestId?: string;
  },
): { reversalEntryId: string; entryNumber: number; reversalDate: IsoDate } {
  assertReason(params.reason);

  return atomically(db, () => {
    const row = db.select().from(timingAdjustments)
      .where(and(
        eq(timingAdjustments.id, params.timingId),
        eq(timingAdjustments.companyId, params.companyId),
      )).get();
    if (!row) throw new TimingError(`Timing adjustment ${params.timingId} not found.`);

    const entry = db.select().from(journalEntries)
      .where(eq(journalEntries.id, row.journalEntryId)).get();
    if (!entry) throw new TimingError(`Entry ${row.journalEntryId} not found.`);
    if (entry.reversedByEntryId) {
      throw new TimingError(
        `"${row.description}" was already reversed by entry ${entry.reversedByEntryId}. `
          + 'Reversing it twice would double the correction.',
        { timingId: row.id, reversalEntryId: entry.reversedByEntryId },
      );
    }

    const reversalDate = params.reversalDate ?? asIsoDate(row.reversalDate);
    if (reversalDate < asIsoDate(entry.entryDate)) {
      throw new TimingError(
        'The reversal cannot be dated before the entry it reverses.',
        { entryDate: entry.entryDate, reversalDate },
      );
    }

    const kind = row.kind === 'accrual' ? 'Accrual' : 'Prepayment';
    const reversal = reverseJournalEntry(db, {
      companyId: params.companyId,
      entryId: row.journalEntryId,
      reversalDate,
      reason: `${kind} "${row.description}" reversed early: ${params.reason}`,
      createdBy: params.actor ?? 'user',
      requestId: params.requestId,
    });

    db.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: nowIso(),
      entityType: 'timing_adjustment',
      entityId: row.id,
      action: 'reversed_early',
      previousValue: `scheduled for ${row.reversalDate}`,
      newValue: `reversed on ${reversalDate}`,
      source: 'user',
      actor: params.actor ?? 'user',
      reason: params.reason,
      requestId: params.requestId ?? null,
    }).run();

    return {
      reversalEntryId: reversal.id,
      entryNumber: reversal.entryNumber,
      reversalDate,
    };
  });
}

export interface TimingAdjustmentSummary {
  timingId: string;
  kind: TimingKind;
  description: string;
  reason: string;
  journalEntryId: string;
  entryNumber: number;
  entryDate: IsoDate;
  reversalDate: IsoDate;
  totalMinor: number;
  /** Whether the reversal has posted. */
  reversed: boolean;
  reversalEntryNumber: number | null;
  lines: Array<{
    accountCode: string;
    accountName: string;
    debitMinor: number;
    creditMinor: number;
  }>;
}

/**
 * Every accrual and prepayment, with its reversal state. The state is read
 * from the journal entry, so the listing cannot disagree with the books.
 */
export function listTimingAdjustments(
  db: AppDatabase,
  params: {
    companyId: string;
    kind?: TimingKind;
    /** Only those whose reversal has not posted yet. */
    outstandingOnly?: boolean;
  },
): TimingAdjustmentSummary[] {
  const conditions = [eq(timingAdjustments.companyId, params.companyId)];
  if (params.kind) conditions.push(eq(timingAdjustments.kind, params.kind));

  const rows = db.select({ timing: timingAdjustments, entry: journalEntries })
    .from(timingAdjustments)
    .innerJoin(journalEntries, eq(timingAdjustments.journalEntryId, journalEntries.id))
    .where(and(...conditions))
    .orderBy(desc(timingAdjustments.reversalDate)).all();

  const summaries = rows.map(({ timing, entry }) => {
    const lines = db.select({ line: journalLines, code: accounts.code, name: accounts.name })
      .from(journalLines)
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(eq(journalLines.journalEntryId, timing.journalEntryId))
      .orderBy(journalLines.lineNumber).all();

    const reversalEntry = entry.reversedByEntryId
      ? db.select({ entryNumber: journalEntries.entryNumber }).from(journalEntries)
        .where(eq(journalEntries.id, entry.reversedByEntryId)).get()
      : null;

    return {
      timingId: timing.id,
      kind: timing.kind,
      description: timing.description,
      reason: timing.reason,
      journalEntryId: timing.journalEntryId,
      entryNumber: entry.entryNumber,
      entryDate: asIsoDate(entry.entryDate),
      reversalDate: asIsoDate(timing.reversalDate),
      totalMinor: lines.reduce((s, l) => s + l.line.baseDebitMinor, 0),
      reversed: entry.reversedByEntryId !== null,
      reversalEntryNumber: reversalEntry?.entryNumber ?? null,
      lines: lines.map(({ line, code, name }) => ({
        accountCode: line.accountCode ?? code,
        accountName: line.accountName ?? name,
        debitMinor: line.baseDebitMinor,
        creditMinor: line.baseCreditMinor,
      })),
    };
  });

  return params.outstandingOnly ? summaries.filter((s) => !s.reversed) : summaries;
}

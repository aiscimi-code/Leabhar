import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  recurringJournals, recurringJournalLines, journalEntries, accounts,
  companies, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, addMonths, addYears, asIsoDate, type IsoDate } from '../dates';
import { postJournalEntry, assertAccountingPeriodOpen, atomically } from './journal';
import { AccountingError, NoPeriodError, PeriodLockedError } from './errors';

export class RecurringJournalError extends AccountingError {}

/**
 * Recurring journals (issue #366).
 *
 * A recurring journal is a template, not an entry. Nothing reaches the ledger
 * when it is defined; each occurrence is posted when it falls due, as an
 * ordinary immutable journal entry. The rule that matters is idempotency: an
 * occurrence is identified by its template and its date, so running the
 * due-post twice — or after a crash halfway through — posts each occurrence
 * once, never twice.
 *
 * The template's lines may be edited, because they are intent, not accounting
 * facts. Occurrences already posted are journal entries and stay immutable.
 */

export type RecurringFrequency = 'monthly' | 'quarterly' | 'yearly';

export interface RecurringLineInput {
  accountId: string;
  debitMinor?: number;
  creditMinor?: number;
  memo?: string | null;
}

export interface CreateRecurringJournalInput {
  companyId: string;
  /** The narrative every occurrence carries, e.g. "Office rent". */
  name: string;
  frequency: RecurringFrequency;
  /** First occurrence date. Later occurrences step from it by the frequency. */
  startDate: IsoDate;
  /** Inclusive last occurrence date; omit for "until deactivated". */
  endDate?: IsoDate | null;
  lines: RecurringLineInput[];
  notes?: string | null;
  createdBy?: string;
  requestId?: string;
}

interface ValidatedLine {
  accountId: string;
  debitMinor: number;
  creditMinor: number;
  memo: string | null;
}

/**
 * Validate template lines the way the posting engine validates journal lines,
 * but at definition time — a template that could never post is a trap for
 * whoever finds it at period end.
 */
function validateLines(
  db: AppDatabase, companyId: string, name: string, lines: RecurringLineInput[],
): ValidatedLine[] {
  if (lines.length < 2) {
    throw new RecurringJournalError(
      `The recurring journal "${name}" needs at least two lines.`, { name },
    );
  }

  const prepared = lines.map((line, index) => {
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    if (debit !== 0 && credit !== 0) {
      throw new RecurringJournalError(
        `Line ${index + 1} of "${name}" has both a debit and a credit. Split it into two lines.`,
        { name, line: index + 1 },
      );
    }
    if (debit === 0 && credit === 0) {
      throw new RecurringJournalError(
        `Line ${index + 1} of "${name}" has no amount.`, { name, line: index + 1 },
      );
    }
    if (debit < 0 || credit < 0) {
      throw new RecurringJournalError(
        `Line ${index + 1} of "${name}" has a negative amount. Use the opposite side.`,
        { name, line: index + 1 },
      );
    }

    const account = db.select().from(accounts)
      .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, companyId))).get();
    if (!account) {
      throw new RecurringJournalError(
        `Line ${index + 1} of "${name}" names an account that does not exist.`,
        { name, line: index + 1, accountId: line.accountId },
      );
    }
    if (!account.active) {
      throw new RecurringJournalError(
        `Line ${index + 1} of "${name}" posts to ${account.code} "${account.name}", which is `
          + 'inactive. Its history is intact, but it cannot take new postings.',
        { name, line: index + 1, accountId: line.accountId },
      );
    }

    return { accountId: line.accountId, debitMinor: debit, creditMinor: credit,
      memo: line.memo ?? null };
  });

  const totalDebit = prepared.reduce((s, l) => s + l.debitMinor, 0);
  const totalCredit = prepared.reduce((s, l) => s + l.creditMinor, 0);
  if (totalDebit !== totalCredit) {
    throw new RecurringJournalError(
      `The recurring journal "${name}" does not balance: debits ${totalDebit} against `
        + `credits ${totalCredit}, a difference of ${totalDebit - totalCredit} minor units. `
        + 'Every occurrence posts as a journal entry, so every occurrence must balance.',
      { name, totalDebitMinor: totalDebit, totalCreditMinor: totalCredit,
        differenceMinor: totalDebit - totalCredit },
    );
  }

  return prepared;
}

function assertFrequency(name: string, frequency: string): asserts frequency is RecurringFrequency {
  if (frequency !== 'monthly' && frequency !== 'quarterly' && frequency !== 'yearly') {
    throw new RecurringJournalError(
      `The recurring journal "${name}" steps by "${frequency}", which is not one of `
        + 'monthly, quarterly or yearly.',
      { name, frequency },
    );
  }
}

export function createRecurringJournal(
  db: AppDatabase, input: CreateRecurringJournalInput,
): string {
  if (!input.name || input.name.trim().length < 3) {
    throw new RecurringJournalError(
      'A recurring journal needs a name, because that name is the narrative of every '
        + 'entry it ever posts.',
    );
  }
  assertFrequency(input.name, input.frequency);
  if (input.endDate && input.endDate < input.startDate) {
    throw new RecurringJournalError(
      `The recurring journal "${input.name}" ends before it starts. The end date is the `
        + 'last occurrence, so it cannot come before the first one.',
      { name: input.name, startDate: input.startDate, endDate: input.endDate },
    );
  }

  const lines = validateLines(db, input.companyId, input.name, input.lines);

  const id = ids.recurringJournal();
  db.transaction((tx) => {
    tx.insert(recurringJournals).values({
      id,
      companyId: input.companyId,
      name: input.name,
      frequency: input.frequency,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      active: true,
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? 'user',
    }).run();

    lines.forEach((line, index) => {
      tx.insert(recurringJournalLines).values({
        id: ids.recurringJournalLine(),
        recurringJournalId: id,
        companyId: input.companyId,
        lineNumber: index + 1,
        accountId: line.accountId,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        memo: line.memo,
      }).run();
    });

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: nowIso(),
      entityType: 'recurring_journal',
      entityId: id,
      action: 'created',
      newValue: JSON.stringify({
        name: input.name, frequency: input.frequency,
        startDate: input.startDate, endDate: input.endDate ?? null,
        lines: lines.length,
      }),
      source: 'user',
      actor: input.createdBy ?? 'user',
      requestId: input.requestId ?? null,
    }).run();
  });

  return id;
}

export function updateRecurringJournal(
  db: AppDatabase,
  params: {
    companyId: string;
    recurringId: string;
    changes: {
      name?: string;
      frequency?: RecurringFrequency;
      startDate?: IsoDate;
      endDate?: IsoDate | null;
      active?: boolean;
      lines?: RecurringLineInput[];
      notes?: string | null;
    };
    actor?: string;
    requestId?: string;
  },
): void {
  const template = db.select().from(recurringJournals)
    .where(and(
      eq(recurringJournals.id, params.recurringId),
      eq(recurringJournals.companyId, params.companyId),
    )).get();
  if (!template) {
    throw new RecurringJournalError(`Recurring journal ${params.recurringId} not found.`);
  }

  const changes = params.changes;
  const name = changes.name ?? template.name;
  if (changes.name !== undefined && (!changes.name || changes.name.trim().length < 3)) {
    throw new RecurringJournalError(
      'A recurring journal needs a name, because that name is the narrative of every '
        + 'entry it ever posts.',
    );
  }
  if (changes.frequency !== undefined) assertFrequency(name, changes.frequency);

  const startDate = changes.startDate ?? asIsoDate(template.startDate);
  const endDate = changes.endDate !== undefined
    ? changes.endDate
    : (template.endDate ? asIsoDate(template.endDate) : null);
  if (endDate && endDate < startDate) {
    throw new RecurringJournalError(
      `The recurring journal "${name}" ends before it starts. The end date is the `
        + 'last occurrence, so it cannot come before the first one.',
      { name, startDate, endDate },
    );
  }

  // Editing a template changes only future occurrences. Occurrences already
  // posted are journal entries and stay exactly as they were posted.
  let validatedLines: ValidatedLine[] | null = null;
  if (changes.lines !== undefined) {
    validatedLines = validateLines(db, params.companyId, name, changes.lines);
  }

  db.transaction((tx) => {
    tx.update(recurringJournals).set({
      name,
      frequency: changes.frequency ?? template.frequency,
      startDate,
      endDate,
      active: changes.active ?? template.active,
      notes: changes.notes !== undefined ? changes.notes : template.notes,
      updatedAt: nowIso(),
    }).where(eq(recurringJournals.id, params.recurringId)).run();

    if (validatedLines) {
      tx.delete(recurringJournalLines)
        .where(eq(recurringJournalLines.recurringJournalId, params.recurringId)).run();
      validatedLines.forEach((line, index) => {
        tx.insert(recurringJournalLines).values({
          id: ids.recurringJournalLine(),
          recurringJournalId: params.recurringId,
          companyId: params.companyId,
          lineNumber: index + 1,
          accountId: line.accountId,
          debitMinor: line.debitMinor,
          creditMinor: line.creditMinor,
          memo: line.memo,
        }).run();
      });
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: nowIso(),
      entityType: 'recurring_journal',
      entityId: params.recurringId,
      action: 'updated',
      field: 'template',
      newValue: JSON.stringify(Object.keys(changes)),
      source: 'user',
      actor: params.actor ?? 'user',
      reason: 'Template edited; occurrences already posted are unchanged.',
      requestId: params.requestId ?? null,
    }).run();
  });
}

export interface RecurringOccurrence {
  date: IsoDate;
  templateId: string;
  templateName: string;
  entryId: string;
  entryNumber: number;
}

export interface SkippedOccurrence {
  templateId: string;
  templateName: string;
  date: IsoDate;
  reason: string;
}

/**
 * The date of occurrence `index` (0-based). Occurrences step from the start
 * date by the frequency; `addMonths` clamps to month-end, so a template
 * starting on the 31st posts on the 28th of February, not on a nonexistent
 * date.
 */
export function occurrenceDate(
  template: { frequency: RecurringFrequency; startDate: IsoDate },
  index: number,
): IsoDate {
  return index === 0 ? template.startDate
    : template.frequency === 'monthly' ? addMonths(template.startDate, index)
      : template.frequency === 'quarterly' ? addMonths(template.startDate, index * 3)
        : addYears(template.startDate, index);
}

/** Every occurrence date due on or before `upTo`, within the template's end date. */
export function dueOccurrenceDates(
  template: { frequency: RecurringFrequency; startDate: IsoDate; endDate: IsoDate | null },
  upTo: IsoDate,
): IsoDate[] {
  const dates: IsoDate[] = [];
  for (let index = 0; ; index++) {
    const date = occurrenceDate(template, index);
    if (date > upTo) break;
    if (template.endDate && date > template.endDate) break;
    dates.push(date);
    if (dates.length >= 1_000) {
      throw new RecurringJournalError(
        'More than 1,000 occurrences are due for one template. That means the start date '
          + 'is wrong or the template should have been deactivated long ago; fix the '
          + 'template rather than posting a decade of catch-up entries.',
        { frequency: template.frequency, startDate: template.startDate, upTo },
      );
    }
  }
  return dates;
}

/**
 * The first occurrence after `asOf` that has not been posted. Stepping starts
 * from the first occurrence that could possibly be after `asOf`, so a template
 * created years ago does not have to walk its whole history.
 */
function nextDue(
  template: { frequency: RecurringFrequency; startDate: IsoDate; endDate: IsoDate | null },
  postedDates: string[],
  asOf: IsoDate | null,
): IsoDate | null {
  const posted = new Set(postedDates);
  const step = template.frequency === 'monthly' ? 1
    : template.frequency === 'quarterly' ? 3 : 12;

  let index = 0;
  if (asOf) {
    const start = template.startDate.slice(0, 7).split('-').map(Number);
    const limit = asOf.slice(0, 7).split('-').map(Number);
    const months = (limit[0]! - start[0]!) * 12 + (limit[1]! - start[1]!);
    index = Math.max(0, Math.ceil(months / step) - 1);
  }

  const maxIndex = index + 2_000;
  for (; index <= maxIndex; index++) {
    const date = occurrenceDate(template, index);
    if (template.endDate && date > template.endDate) return null;
    if (!asOf || date > asOf) {
      if (!posted.has(date)) return date;
    }
  }
  return null;
}

/**
 * Post every due occurrence of every active recurring journal.
 *
 * Idempotent: an occurrence is a journal entry with `sourceType = 'recurring'`
 * and `sourceId = <template id>` dated on the occurrence date, so a date
 * already posted is recognised and skipped.
 *
 * Every due date's accounting period is checked before anything posts, so the
 * batch either completes or leaves nothing behind (issue #231). An occurrence
 * that cannot post — no period covers its date, or the period is locked or
 * closed — is reported as skipped with the reason rather than silently
 * repaired or moved.
 */
export function postDueRecurringJournals(
  db: AppDatabase,
  params: { companyId: string; upTo: IsoDate; actor?: string; requestId?: string },
): { posted: RecurringOccurrence[]; skipped: SkippedOccurrence[] } {
  return atomically(db, () => {
    const company = db.select().from(companies)
      .where(eq(companies.id, params.companyId)).get();
    if (!company) throw new RecurringJournalError(`Company ${params.companyId} not found.`);

    const templates = db.select().from(recurringJournals)
      .where(and(
        eq(recurringJournals.companyId, params.companyId),
        eq(recurringJournals.active, true),
      ))
      .orderBy(recurringJournals.startDate).all();

    const posted: RecurringOccurrence[] = [];
    const skipped: SkippedOccurrence[] = [];
    const due: Array<{
      template: typeof recurringJournals.$inferSelect;
      date: IsoDate;
      lines: Array<typeof recurringJournalLines.$inferSelect>;
    }> = [];

    for (const template of templates) {
      if (template.startDate > params.upTo) continue;

      const templateLines = db.select().from(recurringJournalLines)
        .where(eq(recurringJournalLines.recurringJournalId, template.id))
        .orderBy(recurringJournalLines.lineNumber).all();

      // Which dates already have a posted occurrence.
      const alreadyPosted = new Set(
        db.select({ entryDate: journalEntries.entryDate }).from(journalEntries)
          .where(and(
            eq(journalEntries.companyId, params.companyId),
            eq(journalEntries.sourceType, 'recurring'),
            eq(journalEntries.sourceId, template.id),
            eq(journalEntries.isPosted, true),
          )).all().map((row) => row.entryDate),
      );

      const schedule = {
        frequency: template.frequency,
        startDate: asIsoDate(template.startDate),
        endDate: template.endDate ? asIsoDate(template.endDate) : null,
      };
      for (const date of dueOccurrenceDates(schedule, params.upTo)) {
        if (alreadyPosted.has(date)) continue;

        try {
          assertAccountingPeriodOpen(db, params.companyId, date);
        } catch (error) {
          if (error instanceof NoPeriodError || error instanceof PeriodLockedError) {
            skipped.push({
              templateId: template.id, templateName: template.name, date,
              reason: error.message,
            });
            continue;
          }
          throw error;
        }

        due.push({ template, date, lines: templateLines });
      }
    }

    for (const { template, date, lines } of due) {
      const journal = postJournalEntry(db, {
        companyId: params.companyId,
        entryDate: date,
        narrative: `${template.name} (recurring)`,
        sourceType: 'recurring',
        sourceId: template.id,
        baseCurrency: company.baseCurrency,
        createdBy: params.actor ?? 'system',
        createdVia: 'system',
        requestId: params.requestId,
        notes: template.notes,
        lines: lines.map((line) => ({
          accountId: line.accountId,
          debitMinor: line.debitMinor,
          creditMinor: line.creditMinor,
          memo: line.memo ?? undefined,
        })),
      });

      posted.push({
        date,
        templateId: template.id,
        templateName: template.name,
        entryId: journal.id,
        entryNumber: journal.entryNumber,
      });
    }

    return { posted, skipped };
  });
}

export interface RecurringJournalSummary {
  id: string;
  name: string;
  frequency: RecurringFrequency;
  startDate: IsoDate;
  endDate: IsoDate | null;
  active: boolean;
  notes: string | null;
  createdBy: string;
  lines: Array<{
    accountId: string;
    accountCode: string;
    accountName: string;
    debitMinor: number;
    creditMinor: number;
    memo: string | null;
  }>;
  postedOccurrences: number;
  lastPostedDate: IsoDate | null;
  /** The next occurrence after `asOf` that has not been posted; null when none. */
  nextDueDate: IsoDate | null;
}

/** Every template with its lines and due state, for the recurring listing. */
export function listRecurringJournals(
  db: AppDatabase,
  params: { companyId: string; includeInactive?: boolean; asOf?: IsoDate },
): RecurringJournalSummary[] {
  const conditions = [eq(recurringJournals.companyId, params.companyId)];
  if (!params.includeInactive) conditions.push(eq(recurringJournals.active, true));

  const templates = db.select().from(recurringJournals)
    .where(and(...conditions))
    .orderBy(recurringJournals.startDate, recurringJournals.name).all();

  if (templates.length === 0) return [];

  const lines = db.select({ line: recurringJournalLines, account: accounts })
    .from(recurringJournalLines)
    .innerJoin(accounts, eq(recurringJournalLines.accountId, accounts.id))
    .where(inArray(recurringJournalLines.recurringJournalId, templates.map((t) => t.id)))
    .orderBy(recurringJournalLines.lineNumber).all();

  const occurrences = db.select({
    sourceId: journalEntries.sourceId,
    entryDate: journalEntries.entryDate,
  }).from(journalEntries)
    .where(and(
      eq(journalEntries.companyId, params.companyId),
      eq(journalEntries.sourceType, 'recurring'),
      eq(journalEntries.isPosted, true),
      inArray(journalEntries.sourceId, templates.map((t) => t.id)),
    )).all();

  const asOf = params.asOf ?? null;

  return templates.map((template) => {
    const templateLines = lines
      .filter((l) => l.line.recurringJournalId === template.id)
      .map(({ line, account }) => ({
        accountId: line.accountId,
        accountCode: account.code,
        accountName: account.name,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
        memo: line.memo,
      }));

    const postedDates = occurrences
      .filter((o) => o.sourceId === template.id)
      .map((o) => o.entryDate)
      .sort();

    const schedule = {
      frequency: template.frequency,
      startDate: asIsoDate(template.startDate),
      endDate: template.endDate ? asIsoDate(template.endDate) : null,
    };
    const next = template.active ? nextDue(schedule, postedDates, asOf) : null;

    return {
      id: template.id,
      name: template.name,
      frequency: template.frequency,
      startDate: asIsoDate(template.startDate),
      endDate: template.endDate ? asIsoDate(template.endDate) : null,
      active: template.active,
      notes: template.notes,
      createdBy: template.createdBy,
      lines: templateLines,
      postedOccurrences: postedDates.length,
      lastPostedDate: postedDates.length > 0
        ? asIsoDate(postedDates[postedDates.length - 1]!)
        : null,
      nextDueDate: next,
    };
  });
}

/** One template by id, scoped to the company. */
export function getRecurringJournal(
  db: AppDatabase,
  params: { companyId: string; recurringId: string; asOf?: IsoDate },
): RecurringJournalSummary | null {
  return listRecurringJournals(db, {
    companyId: params.companyId, includeInactive: true, asOf: params.asOf,
  }).find((t) => t.id === params.recurringId) ?? null;
}

/** Templates are never deleted: deactivate one and its history stays queryable. */
export function deactivateRecurringJournal(
  db: AppDatabase,
  params: { companyId: string; recurringId: string; reason: string; actor?: string; requestId?: string },
): void {
  if (!params.reason || params.reason.trim().length < 3) {
    throw new RecurringJournalError('Deactivating a recurring journal needs a reason.');
  }
  updateRecurringJournal(db, {
    companyId: params.companyId,
    recurringId: params.recurringId,
    changes: { active: false },
    actor: params.actor,
    requestId: params.requestId,
  });
  // The audit row above says what changed; this one says why.
  db.insert(auditEvents).values({
    id: ids.audit(),
    companyId: params.companyId,
    occurredAt: nowIso(),
    entityType: 'recurring_journal',
    entityId: params.recurringId,
    action: 'deactivated',
    source: 'user',
    actor: params.actor ?? 'user',
    reason: params.reason,
    requestId: params.requestId ?? null,
  }).run();
}

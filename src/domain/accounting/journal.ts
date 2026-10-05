import { and, eq, sql, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  journalEntries, journalLines, accounts, accountingPeriods, auditEvents,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asMinor, type Minor, multiplyRational } from '../money';
import { type IsoDate, nowIso } from '../dates';
import type { Source, ProvenanceStatus } from '@/db/schema/_shared';
import {
  UnbalancedJournalError, ImmutableEntryError, PeriodLockedError, NoPeriodError,
  InvalidLineError, MissingAccountError, CurrencyMismatchError,
} from './errors';

/** Map createdVia to the shared provenance source/status pair. */
function provenanceFromVia(via: NonNullable<Parameters<typeof postJournalEntry>[1]['createdVia']>): {
  source: Source; provenanceStatus: ProvenanceStatus;
} {
  switch (via) {
    case 'user': return { source: 'user', provenanceStatus: 'manually_entered' };
    case 'rule': return { source: 'rule', provenanceStatus: 'system_rule' };
    case 'ai': return { source: 'ai', provenanceStatus: 'ai_suggestion' };
    case 'import': return { source: 'import', provenanceStatus: 'imported' };
    case 'system': return { source: 'system', provenanceStatus: 'system_rule' };
  }
}

export interface JournalLineInput {
  accountId: string;
  /** Exactly one of debit/credit must be non-zero. */
  debitMinor?: number;
  creditMinor?: number;
  currency?: string;
  /** Required when currency differs from the company's base currency. */
  fxRate?: { numerator: number; denominator: number; source: string; date?: string };
  supplierId?: string | null;
  customerId?: string | null;
  officerId?: string | null;
  memo?: string | null;
}

export interface PostJournalInput {
  companyId: string;
  entryDate: IsoDate;
  narrative: string;
  sourceType: typeof journalEntries.$inferInsert['sourceType'];
  sourceId?: string | null;
  entryType?: typeof journalEntries.$inferInsert['entryType'];
  lines: JournalLineInput[];
  baseCurrency: string;
  createdBy?: string;
  createdVia?: typeof journalEntries.$inferInsert['createdVia'];
  confidence?: number | null;
  notes?: string | null;
  requestId?: string;
  /** Post into a locked period. Requires an explicit reason; audited. */
  overrideLock?: { reason: string };
}

/**
 * Converting each line of a foreign-currency entry on its own can leave the
 * base-currency totals a few minor units apart even though the entry balances
 * in its own currency (issue #639): net 10.01 + VAT 2.30 = 12.31 USD at 7/9
 * converts to 7.79 + 1.79 = 9.58 against 9.57. This returns the lines with
 * one extra base-currency line to `roundingAccountId` that absorbs that
 * difference, visibly and with a memo, or the lines unchanged when the
 * conversion already balances.
 *
 * It never covers a real imbalance: the entry must balance exactly in each
 * transaction currency, and the base difference must be no larger than the
 * rounding the conversions can produce (half a minor unit per converted
 * line). Anything else is returned unchanged for postJournalEntry to refuse.
 */
export function withFxRoundingLine(
  lines: JournalLineInput[],
  baseCurrency: string,
  roundingAccountId: string,
): JournalLineInput[] {
  const base = baseCurrency.toUpperCase();
  const netByCurrency = new Map<string, number>();
  let baseNet = 0;
  let converted = 0;
  for (const line of lines) {
    const currency = (line.currency ?? base).toUpperCase();
    const debit = line.debitMinor ?? 0;
    const credit = line.creditMinor ?? 0;
    netByCurrency.set(currency, (netByCurrency.get(currency) ?? 0) + debit - credit);
    if (currency === base) {
      baseNet += debit - credit;
      continue;
    }
    if (!line.fxRate) return lines;
    const { numerator, denominator } = line.fxRate;
    const toBase = (amount: number) => amount === 0 ? 0 : multiplyRational(amount, numerator, denominator);
    baseNet += toBase(debit) - toBase(credit);
    converted += 1;
  }
  if (converted === 0 || baseNet === 0) return lines;
  if ([...netByCurrency.values()].some((net) => net !== 0)) return lines;
  if (Math.abs(baseNet) * 2 > converted) return lines;
  return [...lines, {
    accountId: roundingAccountId,
    ...(baseNet > 0 ? { creditMinor: baseNet } : { debitMinor: -baseNet }),
    currency: base,
    memo: `Rounding on conversion to ${base}: each line is converted on its own, ` +
      `leaving ${Math.abs(baseNet)} minor unit(s) between debits and credits`,
  }];
}

export interface PostedJournal {
  id: string;
  entryNumber: number;
  lines: Array<typeof journalLines.$inferSelect>;
}

/**
 * Run a posting path's steps as one database transaction (issue #231). A path
 * that posts a journal, then VAT entries, then updates a row — or reverses one
 * entry and posts another — either completes or leaves nothing behind: a step
 * refused after an earlier one posted rolls the earlier one back. Nested calls
 * (a posting path calling another) become savepoints.
 */
export function atomically<T>(db: AppDatabase, steps: () => T): T {
  return db.transaction(() => steps());
}

/**
 * The accounting period covering `date`, refusing a date no period covers and
 * — unless `overrideLock` — a locked or closed period. The same rule
 * `postJournalEntry` applies at post time; call it up front on a path that
 * posts more than one entry, so a later step cannot be refused after an
 * earlier one has already posted (issue #231).
 */
export function assertAccountingPeriodOpen(
  db: Pick<AppDatabase, 'select'>, companyId: string, date: string,
  options: { overrideLock?: boolean } = {},
): typeof accountingPeriods.$inferSelect {
  const period = db.select().from(accountingPeriods).where(and(
    eq(accountingPeriods.companyId, companyId),
    eq(accountingPeriods.kind, 'financial_year'),
    sql`${accountingPeriods.startDate} <= ${date}`,
    sql`${accountingPeriods.endDate} >= ${date}`,
  )).get();

  if (!period) {
    throw new NoPeriodError(
      `No accounting period covers ${date}. Create the financial ` +
        'year before posting into it, rather than letting the entry fall outside the books.',
      { entryDate: date },
    );
  }

  if ((period.status === 'locked' || period.status === 'closed') && !options.overrideLock) {
    throw new PeriodLockedError(
      `Accounting period "${period.name}" is ${period.status}. ` +
        'Post a dated adjustment in an open period instead of altering a closed one.',
      { periodId: period.id, status: period.status, entryDate: date },
    );
  }
  return period;
}

/**
 * Post a journal entry.
 *
 * This is the only sanctioned way an accounting entry comes into existence.
 * Everything else in the system — bank classification, invoices, payments,
 * depreciation, adjustments — funnels through here, which means the balancing
 * rule is enforced in exactly one place and cannot be bypassed by a new caller.
 *
 * The whole operation runs in a single SQLite transaction, so a failed
 * validation leaves no partial entry, and the audit row cannot exist without
 * the entry it describes.
 */
export function postJournalEntry(db: AppDatabase, input: PostJournalInput): PostedJournal {
  return db.transaction((tx) => {
    const baseCurrency = input.baseCurrency.toUpperCase();

    if (input.lines.length < 2) {
      throw new InvalidLineError(
        `A journal entry needs at least two lines; received ${input.lines.length}.`,
        { narrative: input.narrative },
      );
    }

    // ---- Resolve and validate the period ----
    const period = assertAccountingPeriodOpen(tx, input.companyId, input.entryDate, {
      overrideLock: Boolean(input.overrideLock),
    });

    // ---- Validate each line ----
    const prepared = input.lines.map((line, index) => {
      const debit = asMinor(line.debitMinor ?? 0);
      const credit = asMinor(line.creditMinor ?? 0);

      if (debit !== 0 && credit !== 0) {
        throw new InvalidLineError(
          `Line ${index + 1} has both a debit and a credit. Split it into two lines.`,
          { line: index + 1 },
        );
      }
      if (debit === 0 && credit === 0) {
        throw new InvalidLineError(`Line ${index + 1} has no amount.`, { line: index + 1 });
      }
      if (debit < 0 || credit < 0) {
        throw new InvalidLineError(
          `Line ${index + 1} has a negative amount. Use the opposite side instead of a ` +
            'negative debit, so the trial balance reads correctly.',
          { line: index + 1 },
        );
      }

      const account = tx.select().from(accounts)
        .where(and(eq(accounts.id, line.accountId), eq(accounts.companyId, input.companyId)))
        .get();
      if (!account) {
        throw new MissingAccountError(`Account ${line.accountId} does not exist.`, {
          line: index + 1, accountId: line.accountId,
        });
      }
      if (!account.active) {
        throw new MissingAccountError(
          `Account ${account.code} "${account.name}" is inactive and cannot take new postings. ` +
            'Its history remains intact.',
          { line: index + 1, accountId: account.id },
        );
      }

      const currency = (line.currency ?? baseCurrency).toUpperCase();
      let baseDebit = debit;
      let baseCredit = credit;

      if (currency !== baseCurrency) {
        if (!line.fxRate) {
          throw new CurrencyMismatchError(
            `Line ${index + 1} is in ${currency} but no exchange rate to ${baseCurrency} ` +
              'was supplied. A missing rate is an exception, never an assumed 1.0.',
            { line: index + 1, currency },
          );
        }
        const { numerator, denominator } = line.fxRate;
        baseDebit = debit === 0 ? asMinor(0) : multiplyRational(debit, numerator, denominator);
        baseCredit = credit === 0 ? asMinor(0) : multiplyRational(credit, numerator, denominator);
      }

      return { line, index, debit, credit, currency, baseDebit, baseCredit,
        accountCode: account.code, accountName: account.name };
    });

    // ---- The balancing rule ----
    const totalDebit = prepared.reduce((sum, p) => sum + p.baseDebit, 0);
    const totalCredit = prepared.reduce((sum, p) => sum + p.baseCredit, 0);

    if (totalDebit !== totalCredit) {
      throw new UnbalancedJournalError(
        `Journal entry does not balance: debits ${totalDebit} vs credits ${totalCredit} ` +
          `(${baseCurrency} minor units), a difference of ${totalDebit - totalCredit}.`,
        {
          narrative: input.narrative,
          totalDebitMinor: totalDebit,
          totalCreditMinor: totalCredit,
          differenceMinor: totalDebit - totalCredit,
        },
      );
    }

    // ---- Allocate the next gapless entry number ----
    const last = tx.select({ n: journalEntries.entryNumber })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, input.companyId))
      .orderBy(desc(journalEntries.entryNumber))
      .limit(1).get();
    const entryNumber = (last?.n ?? 0) + 1;

    const entryId = ids.journalEntry();
    const postedAt = nowIso();
    const via = input.createdVia ?? 'system';
    const prov = provenanceFromVia(via);

    tx.insert(journalEntries).values({
      id: entryId,
      companyId: input.companyId,
      entryNumber,
      entryDate: input.entryDate,
      accountingPeriodId: period.id,
      narrative: input.narrative,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      entryType: input.entryType ?? 'standard',
      postedAt,
      isPosted: true,
      createdBy: input.createdBy ?? 'system',
      createdVia: via,
      confidence: input.confidence ?? null,
      provenanceStatus: prov.provenanceStatus,
      notes: input.notes ?? null,
    }).run();

    const inserted: Array<typeof journalLines.$inferSelect> = [];
    for (const p of prepared) {
      const row = {
        id: ids.journalLine(),
        journalEntryId: entryId,
        companyId: input.companyId,
        lineNumber: p.index + 1,
        accountId: p.line.accountId,
        // The account's identity at post time (issue #370). The line is
        // evidence: it keeps reading the same even if the account is renamed
        // later.
        accountCode: p.accountCode,
        accountName: p.accountName,
        debitMinor: p.debit,
        creditMinor: p.credit,
        currency: p.currency,
        baseDebitMinor: p.baseDebit,
        baseCreditMinor: p.baseCredit,
        baseCurrency,
        fxRateNumerator: p.line.fxRate?.numerator ?? null,
        fxRateDenominator: p.line.fxRate?.denominator ?? null,
        fxRateSource: p.line.fxRate?.source ?? null,
        fxRateDate: p.line.fxRate?.date ?? null,
        supplierId: p.line.supplierId ?? null,
        customerId: p.line.customerId ?? null,
        officerId: p.line.officerId ?? null,
        memo: p.line.memo ?? null,
        source: prov.source,
        confidence: input.confidence ?? null,
        provenanceStatus: prov.provenanceStatus,
      };
      const saved = tx.insert(journalLines).values(row).returning().get();
      inserted.push(saved);
    }

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: input.companyId,
      occurredAt: postedAt,
      entityType: 'journal_entry',
      entityId: entryId,
      action: 'created',
      newValue: JSON.stringify({
        entryNumber, entryDate: input.entryDate, narrative: input.narrative,
        totalDebitMinor: totalDebit, lines: prepared.length,
      }),
      source: input.createdVia === 'user' ? 'user' : 'system',
      actor: input.createdBy ?? 'system',
      reason: input.overrideLock?.reason ?? null,
      requestId: input.requestId ?? null,
    }).run();

    if (input.overrideLock) {
      tx.insert(auditEvents).values({
        id: ids.audit(),
        companyId: input.companyId,
        occurredAt: postedAt,
        entityType: 'accounting_period',
        entityId: period.id,
        action: 'period_unlocked',
        field: 'override',
        newValue: `Entry ${entryNumber} posted into ${period.status} period`,
        source: 'user',
        actor: input.createdBy ?? 'system',
        reason: input.overrideLock.reason,
        requestId: input.requestId ?? null,
      }).run();
    }

    return { id: entryId, entryNumber, lines: inserted };
  });
}

/**
 * Reverse a posted entry.
 *
 * Invariant #2: a posted entry is never edited or deleted. A correction is a
 * new entry with the debits and credits swapped, referencing the original. The
 * reversal is dated at the correction date rather than the original date, so
 * that reversing something in a closed period does not reach back into it.
 *
 * The whole path — read, post, mark — runs inside one transaction (issue
 * #481): if the marking step failed after the reversal had already posted,
 * the original would be left unmarked and a second call would double the
 * correction. Either the reversal exists and the original is marked, or
 * neither happened.
 */
export function reverseJournalEntry(
  db: AppDatabase,
  params: {
    companyId: string;
    entryId: string;
    reversalDate: IsoDate;
    reason: string;
    createdBy?: string;
    requestId?: string;
  },
): PostedJournal {
  return atomically(db, () => reverseJournalEntrySteps(db, params));
}

function reverseJournalEntrySteps(
  db: AppDatabase,
  params: {
    companyId: string;
    entryId: string;
    reversalDate: IsoDate;
    reason: string;
    createdBy?: string;
    requestId?: string;
  },
): PostedJournal {
  const original = db.select().from(journalEntries)
    .where(and(
      eq(journalEntries.id, params.entryId),
      eq(journalEntries.companyId, params.companyId),
    )).get();

  if (!original) {
    throw new ImmutableEntryError(`Journal entry ${params.entryId} not found.`);
  }
  if (original.reversedByEntryId) {
    throw new ImmutableEntryError(
      `Entry ${original.entryNumber} has already been reversed by entry ` +
        `${original.reversedByEntryId}. Reversing it twice would double the correction.`,
      { entryId: original.id },
    );
  }

  const lines = db.select().from(journalLines)
    .where(eq(journalLines.journalEntryId, params.entryId))
    .orderBy(journalLines.lineNumber).all();

  const reversal = postJournalEntry(db, {
    companyId: params.companyId,
    entryDate: params.reversalDate,
    narrative: `Reversal of entry ${original.entryNumber}: ${original.narrative}`,
    sourceType: 'reversal',
    sourceId: original.id,
    entryType: 'reversal',
    baseCurrency: lines[0]?.baseCurrency ?? 'EUR',
    createdBy: params.createdBy ?? 'user',
    createdVia: 'user',
    requestId: params.requestId,
    notes: params.reason,
    lines: lines.map((line) => ({
      accountId: line.accountId,
      // Swapped: the original's debit becomes the reversal's credit.
      debitMinor: line.creditMinor,
      creditMinor: line.debitMinor,
      currency: line.currency,
      fxRate: line.fxRateNumerator && line.fxRateDenominator
        ? {
            numerator: line.fxRateNumerator,
            denominator: line.fxRateDenominator,
            source: line.fxRateSource ?? 'original_entry',
            date: line.fxRateDate ?? undefined,
          }
        : undefined,
      supplierId: line.supplierId,
      customerId: line.customerId,
      officerId: line.officerId,
      memo: line.memo,
    })),
  });

  // Pointing the original at its reversal is bookkeeping metadata, not a
  // change to the accounting facts, so it does not violate immutability. It
  // runs in the same transaction as the posting above (issue #481).
  db.update(journalEntries)
    .set({ reversedByEntryId: reversal.id, reversalReason: params.reason })
    .where(eq(journalEntries.id, original.id)).run();

  db.update(journalEntries)
    .set({ reversalOfId: original.id })
    .where(eq(journalEntries.id, reversal.id)).run();

  db.insert(auditEvents).values({
    id: ids.audit(),
    companyId: params.companyId,
    occurredAt: nowIso(),
    entityType: 'journal_entry',
    entityId: original.id,
    action: 'reversal_posted',
    previousValue: `entry ${original.entryNumber}`,
    newValue: `reversed by entry ${reversal.entryNumber}`,
    source: 'user',
    actor: params.createdBy ?? 'user',
    reason: params.reason,
    requestId: params.requestId ?? null,
  }).run();

  return reversal;
}

/** Guard used by any code tempted to update a journal row directly. */
export function assertEntryMutable(entry: typeof journalEntries.$inferSelect): void {
  if (entry.isPosted) {
    throw new ImmutableEntryError(
      `Journal entry ${entry.entryNumber} is posted and cannot be edited. ` +
        'Post a reversing entry instead — that is what keeps the audit trail honest.',
      { entryId: entry.id },
    );
  }
}

export type { Minor };

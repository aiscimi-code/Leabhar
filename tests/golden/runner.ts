/**
 * Golden case runner — executes a single golden case and checks expectations.
 *
 * Usage in tests/golden/index.test.ts:
 *   import all JSON from './cases/*.json'
 *   for (const case of cases) → runGoldenCase(db, companyId, testCase)
 *
 * The runner seeds minimal state, runs the pipeline steps, and returns a
 * result object the test assertions can inspect. It does NOT throw on assertion
 * failure — it records the failure in the result so the test framework can
 * report it cleanly.
 */
import type { AppDatabase } from '@/db';
import { eq } from 'drizzle-orm';
import { journalEntries, journalLines, bankAccounts, vatEntries } from '@/db/schema';
import { lookupTransactionRules } from '@/domain/rules/transactionLookup';
import { postJournalEntry } from '@/domain/accounting/journal';
import { reconcileBankAccount } from '@/domain/banking/reconciliation';
import { addDays, asIsoDate } from '@/domain/dates';
import type { GoldenCase } from './types';
import type { TransactionContext } from '@/domain/rules/transactionLookup';
import type { PostJournalInput, JournalLineInput } from '@/domain/accounting/journal';

export interface GoldenCaseResult {
  case: GoldenCase;
  /** Whether all expected fields matched. */
  pass: boolean;
  /** Human-readable failure messages. */
  failures: string[];
  /** The actual lookup result, for debugging. */
  lookupResult?: ReturnType<typeof lookupTransactionRules>;
  /** IDs of journal entries created. */
  journalEntryIds: string[];
  /** IDs of VAT entries created. */
  vatEntryIds: string[];
  /** Reconciliation result. */
  reconciliation?: ReturnType<typeof reconcileBankAccount>;
}

/**
 * Resolve an account code reference to an account id. Accepts either:
 * - a raw account id prefixed with "acc_"
 * - a chart-of-accounts code like "6010", "4000", "bank_control"
 */
function resolveAccountId(
  ref: string,
  accountsByCode: Record<string, string>,
  accountsByKey?: Record<string, string>,
): string {
  if (ref.startsWith('acc_')) return ref;
  if (accountsByCode[ref]) return accountsByCode[ref];
  if (accountsByKey && accountsByKey[ref]) return accountsByKey[ref];
  return accountsByCode[ref] ?? ref;
}

/**
 * Run a single golden case.
 *
 * The case's `inputs.transaction` is fed to the deterministic rule lookup.
 * If `expected_journal.posted` is true, the case is also posted as a journal
 * entry. If `expected_vat` specifies entries, VAT entries are verified.
 * If `expected_reconciliation` is set, bank reconciliation is checked.
 */
export function runGoldenCase(
  db: AppDatabase,
  companyId: string,
  accountsByCode: Record<string, string>,
  accountsByKey: Record<string, string>,
  treatmentsByCode: Record<string, string>,
  testCase: GoldenCase,
): GoldenCaseResult {
  const failures: string[] = [];
  const journalEntryIds: string[] = [];
  const vatEntryIds: string[] = [];

  const { transaction } = testCase.inputs;
  const preJournalEntries = transaction.preJournalEntries;

  // --- Step 1: Run deterministic rule lookup ---
  let lookupResult: ReturnType<typeof lookupTransactionRules> | undefined;
  try {
    lookupResult = lookupTransactionRules(db, {
      companyId,
      transaction: transaction as TransactionContext,
    });
  } catch (e) {
    failures.push(`Rule lookup threw: ${e instanceof Error ? e.message : String(e)}`);
    return {
      case: testCase,
      pass: false,
      failures,
      journalEntryIds,
      vatEntryIds,
    };
  }

  // --- Step 2: Check expected classification ---
  if (testCase.expected_classification) {
    const ec = testCase.expected_classification;

    if (ec.applicableRuleKeys) {
      const actualKeys = lookupResult!.applicableRules.map((r) => r.ruleKey);
      for (const expected of ec.applicableRuleKeys) {
        if (!actualKeys.includes(expected)) {
          failures.push(`Expected rule "${expected}" in applicable rules, got: ${JSON.stringify(actualKeys)}`);
        }
      }
    }

    if (ec.notApplicableRuleKeys) {
      const actualKeys = lookupResult!.applicableRules.map((r) => r.ruleKey);
      for (const notExpected of ec.notApplicableRuleKeys) {
        if (actualKeys.includes(notExpected)) {
          failures.push(`Did not expect rule "${notExpected}" in applicable rules, got: ${JSON.stringify(actualKeys)}`);
        }
      }
    }

    if (ec.identifiedTopics) {
      for (const topic of ec.identifiedTopics) {
        if (!lookupResult!.identifiedTopics.includes(topic)) {
          failures.push(`Expected topic "${topic}" in identified topics, got: ${JSON.stringify(lookupResult!.identifiedTopics)}`);
        }
      }
    }

    if (ec.reviewRequired !== undefined) {
      if (lookupResult!.reviewRequired !== ec.reviewRequired) {
        failures.push(`Expected reviewRequired=${ec.reviewRequired}, got ${lookupResult!.reviewRequired} (reasons: ${lookupResult!.reviewReasons.join('; ')})`);
      }
    }
  }

  // --- Step 2b: Post pre-journal entries if any ---
  if (preJournalEntries && preJournalEntries.length > 0) {
    for (const entry of preJournalEntries) {
      const posted = postJournalEntry(db, {
        companyId,
        entryDate: asIsoDate(entry.entryDate ?? transaction.transactionDate),
        narrative: entry.narrative ?? `Pre-journal: ${testCase.description}`,
        sourceType: entry.sourceType ?? 'manual_adjustment',
        baseCurrency: transaction.currency ?? 'EUR',
        lines: entry.lines.map((l): JournalLineInput => ({
          accountId: resolveAccountId(l.accountId, accountsByCode, accountsByKey),
          debitMinor: l.debitMinor,
          creditMinor: l.creditMinor,
        })),
      });
      journalEntryIds.push(posted.id);
    }
  }

  // --- Step 3: Post journal if expected ---
  if (testCase.expected_journal?.posted) {
    const ej = testCase.expected_journal;
    const txDate = transaction.transactionDate;
    const baseCurrency = transaction.currency ?? 'EUR';

    const journalLinesInput = (ej.lines ?? []).map((l): JournalLineInput => ({
      accountId: resolveAccountId(l.accountCode ?? l.accountKey ?? '', accountsByCode, accountsByKey),
      debitMinor: l.debitMinor,
      creditMinor: l.creditMinor,
    }));

    if (journalLinesInput.length === 0) {
      failures.push(`Case ${testCase.id} expects a journal but no lines are specified`);
    } else {
      try {
        const posted = postJournalEntry(db, {
          companyId,
          entryDate: txDate as never,
          narrative: testCase.description,
          sourceType: 'purchase_invoice',
          baseCurrency,
          createdVia: 'rule',
          lines: journalLinesInput,
        });
        journalEntryIds.push(posted.id);
      } catch (e) {
        failures.push(`Journal posting failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // --- Step 3b: Check journal balance ---
    if (journalEntryIds.length > 0 && ej.balanced !== false) {
      for (const entryId of journalEntryIds) {
        const lines = db.select().from(journalLines).where(eq(journalLines.journalEntryId, entryId)).all();
        const totalDebit = lines.reduce((s, l) => s + (l.baseDebitMinor ?? 0), 0);
        const totalCredit = lines.reduce((s, l) => s + (l.baseCreditMinor ?? 0), 0);
        if (totalDebit !== totalCredit) {
          failures.push(`Journal entry ${entryId} unbalanced: debits=${totalDebit}, credits=${totalCredit}`);
        }
      }
    }
  }

  // --- Step 4: Verify VAT entries if expected ---
  if (testCase.expected_vat) {
    const ev = testCase.expected_vat;
    const allVatEntries = db.select().from(vatEntries).where(eq(vatEntries.companyId, companyId)).all();

    if (ev.entryCount !== undefined) {
      if (allVatEntries.length !== ev.entryCount) {
        failures.push(`Expected ${ev.entryCount} VAT entries, got ${allVatEntries.length}`);
      }
    }

    if (ev.totalNetMinor !== undefined || ev.totalVatMinor !== undefined || ev.totalGrossMinor !== undefined) {
      const totalNet = allVatEntries.reduce((s, e) => s + (e.baseNetMinor ?? 0), 0);
      const totalVat = allVatEntries.reduce((s, e) => s + (e.baseVatMinor ?? 0), 0);
      const totalGross = allVatEntries.reduce((s, e) => s + (e.baseGrossMinor ?? 0), 0);

      if (ev.totalNetMinor !== undefined && totalNet !== ev.totalNetMinor) {
        failures.push(`Expected total net ${ev.totalNetMinor}, got ${totalNet}`);
      }
      if (ev.totalVatMinor !== undefined && totalVat !== ev.totalVatMinor) {
        failures.push(`Expected total VAT ${ev.totalVatMinor}, got ${totalVat}`);
      }
      if (ev.totalGrossMinor !== undefined && totalGross !== ev.totalGrossMinor) {
        failures.push(`Expected total gross ${ev.totalGrossMinor}, got ${totalGross}`);
      }
    }

    if (ev.totalRecoverableMinor !== undefined) {
      const totalRecoverable = allVatEntries.reduce((s, e) => s + (e.baseRecoverableVatMinor ?? 0), 0);
      if (totalRecoverable !== ev.totalRecoverableMinor) {
        failures.push(`Expected total recoverable VAT ${ev.totalRecoverableMinor}, got ${totalRecoverable}`);
      }
    }

    if (ev.isReverseCharge !== undefined) {
      const anyReverseCharge = allVatEntries.some((e) => e.isReverseChargeLeg);
      if (anyReverseCharge !== ev.isReverseCharge) {
        failures.push(`Expected isReverseCharge=${ev.isReverseCharge}, got ${anyReverseCharge}`);
      }
    }

    if (ev.rateBasisPoints !== undefined) {
      const rates = [...new Set(allVatEntries.map((e) => e.rateBasisPoints))];
      if (!rates.includes(ev.rateBasisPoints)) {
        failures.push(`Expected rateBasisPoints ${ev.rateBasisPoints}, got rates: ${JSON.stringify(rates)}`);
      }
    }

    if (ev.vatBoxes) {
      const actualBoxes = [...new Set(allVatEntries.map((e) => e.vatBox).filter(Boolean))];
      for (const box of ev.vatBoxes) {
        if (!actualBoxes.includes(box)) {
          failures.push(`Expected VAT box ${box} in entries, got: ${JSON.stringify(actualBoxes)}`);
        }
      }
    }
  }

  // --- Step 5: Reconciliation check ---
  if (testCase.expected_reconciliation) {
    const er = testCase.expected_reconciliation;
    const bankAccount = db.select().from(bankAccounts).where(eq(bankAccounts.companyId, companyId)).get();
    if (bankAccount) {
      try {
        const result = reconcileBankAccount(db, {
          companyId,
          bankAccountId: bankAccount.id,
          periodStart: transaction.transactionDate as never,
          periodEnd: addDays(transaction.transactionDate as never, 30),
        });

        if (er.reconciled !== undefined && result.reconciled !== er.reconciled) {
          failures.push(`Expected reconciled=${er.reconciled}, got ${result.reconciled} (unexplained: ${result.unexplainedMinor})`);
        }
        if (er.statementBalanceMinor !== undefined && result.statementBalanceMinor !== er.statementBalanceMinor) {
          failures.push(`Expected statement balance ${er.statementBalanceMinor}, got ${result.statementBalanceMinor}`);
        }
        if (er.ledgerBalanceMinor !== undefined && result.ledgerBalanceMinor !== er.ledgerBalanceMinor) {
          failures.push(`Expected ledger balance ${er.ledgerBalanceMinor}, got ${result.ledgerBalanceMinor}`);
        }
        if (er.unexplainedMinor !== undefined && result.unexplainedMinor !== er.unexplainedMinor) {
          failures.push(`Expected unexplained ${er.unexplainedMinor}, got ${result.unexplainedMinor}`);
        }
      } catch (e) {
        if (er.reconciled === true) {
          failures.push(`Reconciliation threw unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  // --- Step 6: Review required (overall assertion) ---
  if (testCase.review_required !== undefined) {
    if (testCase.expected_classification?.reviewRequired === undefined) {
      if (lookupResult && lookupResult.reviewRequired !== testCase.review_required) {
        failures.push(`Expected review_required=${testCase.review_required}, got ${lookupResult.reviewRequired} (reasons: ${lookupResult.reviewReasons.join('; ')})`);
      }
    }
  }

  return {
    case: testCase,
    pass: failures.length === 0,
    failures,
    lookupResult,
    journalEntryIds,
    vatEntryIds,
  };
}

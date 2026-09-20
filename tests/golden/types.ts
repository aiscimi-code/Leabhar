/**
 * Golden accounting test case framework (docs/trust TRUST_MODEL.md, Work
 * Package 03).
 *
 * A "golden case" is a single accounting scenario with explicit, hand-verified
 * expected results across the full pipeline: extraction → AI suggestion →
 * deterministic rules → classification → journal → VAT → reconciliation.
 *
 * Each case is a plain JSON file so that adding a new case is a matter of
 * writing data, not code. The runner (`runGoldenCase`) loads a case, seeds a
 * fresh in-memory database with the minimal state the case needs, runs the
 * specified pipeline steps, and asserts each expected field.
 *
 * The framework is intentionally minimal: it does not invent assertions. Every
 * field in `expected_*` is compared exactly. A case that omits an expected
 * field is not checked on that dimension — useful while building a new case.
 *
 * All cases live under `tests/golden/cases/` as `.json` files. The runner is
 * `tests/golden/runner.ts`; the test file that exercises every case is
 * `tests/golden/index.test.ts`.
 */
import type { AppDatabase } from '@/db';
import { eq, and } from 'drizzle-orm';
import { journalEntries, journalLines, bankTransactions, vatEntries } from '@/db/schema';
import { sumExplained } from '@/domain/reports/explain';
import { lookupTransactionRules, type TransactionContext } from '@/domain/rules/transactionLookup';
import { trialBalance } from '@/domain/accounting/ledger';
import type { BankTransaction, JournalEntry, VatEntry } from './types';

/**
 * A single golden accounting case. Stored as JSON; this is the in-memory
 * shape after parsing.
 */
export interface GoldenCase {
  /** Stable, human-readable identifier, e.g. "ie-purchase-standard-rate". */
  id: string;
  /** One-line description of the scenario. */
  description: string;
  /**
   * The accounting treatment authority this case is grounded in.
   * "LEABHAR_RULE" — derived from the project's own rule KB (see
   * docs/RULES_KB.md). "IRISH_LEGISLATION" — states a statute that must be
   * independently verifiable in the rule KB. "PROFESSIONAL_PRACTICE" — a
   * standard accounting practice assertion. "REVIEW_REQUIRED" — the case
   * cannot yet be verified from an authoritative source.
   */
  authority: 'LEABHAR_RULE' | 'IRISH_LEGISLATION' | 'PROFESSIONAL_PRACTICE' | 'REVIEW_REQUIRED';
  /** The rule key(s) or section citation this case tests, for traceability. */
  references?: string[];
  /** Human-authored notes explaining the expected result and its source. */
  notes?: string;

  /** The transaction context fed to the deterministic rule lookup. */
  inputs: {
    transaction: TransactionContext;
    /** Optional bank statement line to seed before classification. */
    bankTransaction?: {
      amountMinor: number; // signed: negative = money out
      description: string;
      transactionDate?: string;
      currency?: string;
      bankReference?: string;
    };
    /** Optional journal entries to post before running the case (opening entries, etc.). Each entry must be a complete balanced pair/tuple. */
    preJournalEntries?: Array<{
      lines: Array<{
        accountId: string;
        debitMinor?: number;
        creditMinor?: number;
      }>;
      narrative?: string;
      entryDate?: string;
      sourceType?: string;
    }>;
  };

  /** What the rule lookup should return. */
  expected_classification?: {
    /** Rule keys that must be in the applicable set (subset check). */
    applicableRuleKeys?: string[];
    /** Rule keys that must NOT be in the applicable set. */
    notApplicableRuleKeys?: string[];
    /** Topics that must be identified. */
    identifiedTopics?: string[];
    /** Whether review is required (true if any rule is unapproved/has exceptions/...) */
    reviewRequired?: boolean;
  };

  /** Expected journal entry structure after classification. */
  expected_journal?: {
    /** Whether a journal entry should be posted at all. */
    posted?: boolean;
    /** Each line: account code, debit, or credit (one of debit/credit must be set). */
    lines?: Array<{ accountCode: string; debitMinor?: number; creditMinor?: number }>;
    /** Whether the journal must balance. */
    balanced?: boolean;
  };

  /** Expected VAT result. */
  expected_vat?: {
    /** Number of VAT entries. */
    entryCount?: number;
    /** Total net, vat, gross across all entries (base currency minor units). */
    totalNetMinor?: number;
    totalVatMinor?: number;
    totalGrossMinor?: number;
    /** Total recoverable VAT. */
    totalRecoverableMinor?: number;
    /** Whether the VAT treatment is reverse-charge. */
    isReverseCharge?: boolean;
    /** Expected VAT rate basis points (e.g. 2300 for 23%). */
    rateBasisPoints?: number;
    /** Expected VAT box codes (e.g. ["T1","T2"]). */
    vatBoxes?: string[];
  };

  /** Expected reconciliation outcome. */
  expected_reconciliation?: {
    /** Statement balance minor units. */
    statementBalanceMinor?: number;
    /** Ledger balance minor units. */
    ledgerBalanceMinor?: number;
    /** Whether the account reconciles. */
    reconciled?: boolean;
    /** Unexplained difference in minor units. */
    unexplainedMinor?: number;
  };

  /** Whether this case requires human review (by design). */
  review_required: boolean;
}

/**
 * Assert the journal for a transaction balances: SUM(debits) == SUM(credits)
 * in base currency. This is the integrity invariant (AGENTS.md invariant #3),
 * checked directly from the database rather than trusting the in-memory value.
 */
export function assertJournalBalanced(db: AppDatabase, journalEntryId: string): {
  balanced: boolean;
  totalDebit: number;
  totalCredit: number;
} {
  const lines = db.select().from(journalLines)
    .where(eq(journalLines.journalEntryId, journalEntryId)).all();
  const totalDebit = lines.reduce((s, l) => s + (l.baseDebitMinor ?? 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (l.baseCreditMinor ?? 0), 0);
  return { balanced: totalDebit === totalCredit, totalDebit, totalCredit };
}

/**
 * Assert that ALL posted journal entries in the company balance.
 * Fails if any entry has debits != credits in base currency.
 */
export function assertAllJournalsBalanced(db: AppDatabase, companyId: string): {
  balanced: boolean;
  failures: Array<{ entryNumber: number; totalDebit: number; totalCredit: number }>;
} {
  const entries = db.select().from(journalEntries)
    .where(eq(journalEntries.companyId, companyId)).all();
  const failures: Array<{ entryNumber: number; totalDebit: number; totalCredit: number }> = [];
  for (const entry of entries) {
    const lines = db.select().from(journalLines)
      .where(eq(journalLines.journalEntryId, entry.id)).all();
    const totalDebit = lines.reduce((s, l) => s + (l.baseDebitMinor ?? 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.baseCreditMinor ?? 0), 0);
    if (totalDebit !== totalCredit) {
      failures.push({ entryNumber: entry.entryNumber, totalDebit, totalCredit });
    }
  }
  return { balanced: failures.length === 0, failures };
}

/**
 * Load all golden cases from a directory. Each `.json` file is one case.
 */
export function loadGoldenCases(dir: string): GoldenCase[] {
  // Loaded by index.test.ts via glob; this function is for programmatic use.
  // The test file reads files directly using vitest's import.meta.glob.
  return [];
}

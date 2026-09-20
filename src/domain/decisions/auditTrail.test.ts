/**
 * Audit trail integrity verification tests (Work Package 07).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { postJournalEntry } from '@/domain/accounting/journal';
import { buildAccountingDecision } from '@/domain/decisions/explanation';
import { lookupTransactionRules } from '@/domain/rules/transactionLookup';
import {
  verifyAuditTrail,
  verifySerialization,
  verifyJournalBalance,
  verifyEvidenceChain,
} from '@/domain/decisions/auditTrail';
import { makeDate } from '@/domain/dates';
import type { AccountingDecision } from '@/domain/decisions/explanation';
import {
  ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH,
} from '@/domain/rules/irishRules';
import {
  ingestVatca2010, deriveVatcaRules, VATCA_2010_MD_PATH,
} from '@/domain/rules/vatcaIngestion';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules, VATCA_REVISED_S046_MD_PATH } from '@/domain/rules/vatcaRevisedIngestion';
import { readFileSync } from 'node:fs';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let byKey: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Audit Ltd',
    vatNumber: 'IE1234567T',
    vatRegistrationStatus: 'registered',
    seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  byKey = created.accountsByKey;

  const faMd = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
  ingestFinanceAct2024(db, { companyId, markdown: faMd, ingestVersion: 'v1' });
  deriveTaxRules(db, { companyId });

  const vatcaMd = readFileSync(VATCA_2010_MD_PATH, 'utf8');
  ingestVatca2010(db, { companyId, markdown: vatcaMd, ingestVersion: 'v1' });
  deriveVatcaRules(db, { companyId });

  const s46Md = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');
  ingestVatcaRevisedSection(db, { companyId, markdown: s46Md, ingestVersion: 'v1' });
  deriveVatcaRevisedRules(db, { companyId });
});

// Helper: build a complete, valid AccountingDecision.
function buildValidDecision(): AccountingDecision {
  const transaction = {
    transactionDate: '2025-06-15',
    amountMinor: 12300,
    currency: 'EUR',
    entityType: 'Irish_LTD',
    vatRegistered: true,
    transactionType: 'purchase_invoice',
    description: 'Purchase from Irish supplier',
    businessUsePercent: 100,
    invoiceAvailable: true,
  };

  const lookupResult = lookupTransactionRules(db, { companyId, transaction });

  const entry = postJournalEntry(db, {
    companyId,
    entryDate: makeDate(2025, 6, 15),
    narrative: 'Purchase invoice',
    sourceType: 'bank_transaction',
    sourceId: 'tx-001',
    baseCurrency: 'EUR',
    createdVia: 'rule',
    lines: [
      { accountId: byCode['6120']!, debitMinor: 10000 },
      { accountId: byKey['vat_on_purchases']!, debitMinor: 2300 },
      { accountId: byKey['bank_control']!, creditMinor: 12300 },
    ],
  });

  return buildAccountingDecision({
    transaction,
    lookupResult,
    journal: entry,
    vatEntries: [{
      rateBasisPoints: 2300,
      isReverseCharge: false,
      vatBox: 'T2',
      netMinor: 10000,
      vatMinor: 2300,
      grossMinor: 12300,
      recoverableMinor: 2300,
    }],
    evidence: [{ type: 'invoice', id: 'INV-001' }],
    extractedFacts: [
      { field: 'supplier', value: 'Supplier Ltd', source: 'deterministic' },
      { field: 'invoice_total', value: 123, source: 'deterministic' },
      { field: 'vat', value: 23, source: 'deterministic' },
    ],
    aiSuggestions: [
      { suggestion: 'software_expense', field: 'category', confidence: 85, disposition: 'accepted' },
    ],
    accounts: [
      { id: byCode['6120']!, code: '6120', name: 'Office expenses' },
      { id: byKey['vat_on_purchases']!, code: '1200', name: 'VAT recoverable' },
      { id: byKey['bank_control']!, code: '1000', name: 'Bank current account' },
    ],
    reconciled: true,
    decidedAt: '2025-06-15T12:00:00Z',
  });
}

describe('verifyAuditTrail — complete decision', () => {
  it('reports VERIFIED for a well-formed decision', () => {
    const decision = buildValidDecision();
    const result = verifyAuditTrail(decision);

    expect(result.verdict).toBe('VERIFIED');
    expect(result.passedChecks).toBe(result.totalChecks);
    expect(result.issues).toHaveLength(0);
    expect(result.checks.find((c) => c.name === 'journal_balanced')?.passed).toBe(true);
    expect(result.checks.find((c) => c.name === 'journal_has_evidence')?.passed).toBe(true);
  });

  it('detects journal posted without evidence (CONFLICT)', () => {
    const decision = buildValidDecision();
    decision.evidence = [];

    const result = verifyAuditTrail(decision);
    expect(result.verdict).toBe('CONFLICT');
    expect(result.checks.find((c) => c.name === 'journal_has_evidence')?.passed).toBe(false);
  });

  it('detects unbalanced journal (CONFLICT)', () => {
    const decision = buildValidDecision();
    decision.accountingResult.balanced = false;
    decision.accountingResult.totals.debitMinor = 12300;
    decision.accountingResult.totals.creditMinor = 11000;

    const result = verifyAuditTrail(decision);
    expect(result.verdict).toBe('CONFLICT');
    expect(result.checks.find((c) => c.name === 'journal_balanced')?.passed).toBe(false);
  });

  it('detects missing decision ID (CONFLICT)', () => {
    const decision = buildValidDecision();
    decision.decisionId = '';

    const result = verifyAuditTrail(decision);
    expect(result.verdict).toBe('CONFLICT');
  });

  it('warns when AI suggestions lack confidence/disposition', () => {
    const decision = buildValidDecision();
    // @ts-expect-error — intentionally corrupting for the test
    decision.aiSuggestions[0].confidence = undefined;

    const result = verifyAuditTrail(decision);
    expect(result.checks.find((c) => c.name === 'ai_suggestions_labelled')?.passed).toBe(false);
    // Warnings don't make verdict CONFLICT, but do make it INCOMPLETE
    expect(result.verdict).not.toBe('VERIFIED');
  });
});

describe('verifySerialization — round-trip integrity', () => {
  it('passes for a complete decision', () => {
    const decision = buildValidDecision();
    const result = verifySerialization(decision);

    expect(result.roundTrips).toBe(true);
    expect(result.detail).toContain('round-trips');
  });

  it('detects information loss in round-trip', () => {
    const decision = buildValidDecision();
    const originalResult = verifySerialization(decision);
    expect(originalResult.roundTrips).toBe(true);

    // Simulate a serialization that drops a field by removing it from the
    // decision before verifying. Setting decisionId via delete on the
    // parsed object simulates a corrupted or partial audit trail.
    const json = JSON.stringify(decision);
    const corrupted = JSON.parse(json) as Partial<AccountingDecision>;
    delete corrupted.decisionId;
    const result = verifySerialization(corrupted as AccountingDecision);
    expect(result.roundTrips).toBe(false);
    expect(result.detail).toContain('decisionId');
  });

  it('handles a decision without a journal', () => {
    const decision = buildValidDecision();
    decision.accountingResult.journal = undefined;
    decision.accountingResult.balanced = false;

    const result = verifySerialization(decision);
    expect(result.roundTrips).toBe(true);
  });
});

describe('verifyJournalBalance — standalone check', () => {
  it('returns balanced for a correct journal', () => {
    const journal = buildValidDecision().accountingResult.journal!;
    const result = verifyJournalBalance(journal);

    expect(result.balanced).toBe(true);
    expect(result.totalDebit).toBe(12300);
    expect(result.totalCredit).toBe(12300);
  });

  it('detects imbalance', () => {
    const journal = buildValidDecision().accountingResult.journal!;
    journal.lines[0].debitMinor = 15000;

    const result = verifyJournalBalance(journal);
    expect(result.balanced).toBe(false);
    expect(result.detail).toContain('Imbalanced');
  });
});

describe('verifyEvidenceChain — traceability', () => {
  it('reports complete chain when evidence is present', () => {
    const decision = buildValidDecision();
    const result = verifyEvidenceChain(decision);

    expect(result.complete).toBe(true);
    expect(result.linesTraced).toBe(3);
    expect(result.linesTotal).toBe(3);
    expect(result.missingEvidence).toHaveLength(0);
  });

  it('reports incomplete chain when evidence is absent', () => {
    const decision = buildValidDecision();
    decision.evidence = [];
    const result = verifyEvidenceChain(decision);

    expect(result.complete).toBe(false);
    expect(result.linesTraced).toBe(0);
    expect(result.missingEvidence).toHaveLength(3);
  });

  it('reports complete=false when no journal exists', () => {
    const decision = buildValidDecision();
    decision.accountingResult.journal = undefined;
    const result = verifyEvidenceChain(decision);

    expect(result.complete).toBe(false);
    expect(result.linesTotal).toBe(0);
  });
});

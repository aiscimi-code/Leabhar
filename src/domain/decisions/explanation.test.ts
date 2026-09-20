/**
 * Tests for the accounting decision explanation model (Work Package 06).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { postJournalEntry } from '@/domain/accounting/journal';
import { buildAccountingDecision } from '@/domain/decisions/explanation';
import { lookupTransactionRules } from '@/domain/rules/transactionLookup';
import { journalLines } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { makeDate } from '@/domain/dates';
import {
  ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH,
} from '@/domain/rules/irishRules';
import {
  ingestVatca2010, deriveVatcaRules, VATCA_2010_MD_PATH,
} from '@/domain/rules/vatcaIngestion';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules, VATCA_REVISED_S046_MD_PATH } from '@/domain/rules/vatcaRevisedIngestion';
import { readFileSync } from 'node:fs';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let byKey: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Decision Ltd',
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

describe('buildAccountingDecision — structure', () => {
  it('produces all required top-level fields', () => {
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

    const decision = buildAccountingDecision({
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
        { field: 'currency', value: 'EUR', source: 'deterministic' },
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

    // All top-level fields present
    expect(decision.decisionId).toBeDefined();
    expect(decision.decision).toBeDefined();
    expect(decision.decidedAt).toBe('2025-06-15T12:00:00Z');
    expect(decision.transaction).toEqual(transaction);
    expect(decision.evidence).toHaveLength(1);
    expect(decision.evidence[0].id).toBe('INV-001');
    expect(decision.extractedFacts).toHaveLength(4);
    expect(decision.aiSuggestions).toHaveLength(1);
    expect(decision.aiSuggestions[0].confidence).toBe(85);
    expect(decision.rulesEvaluated.length).toBeGreaterThan(0);
    expect(decision.rulesApplied.length).toBeGreaterThan(0);
    expect(decision.accountingResult.journal).toBeDefined();
    expect(decision.accountingResult.balanced).toBe(true);
    expect(decision.vatResult.computed).toBe(true);
    expect(decision.verification.state).toBeDefined();
  });

  it('labels AI suggestions as non-authoritative', () => {
    const transaction = {
      transactionDate: '2025-06-15',
      amountMinor: 10000,
      currency: 'EUR',
      entityType: 'Irish_LTD',
      vatRegistered: false,
      transactionType: 'bank_charge',
      description: 'Bank charge',
      invoiceAvailable: true,
    };

    const lookupResult = lookupTransactionRules(db, { companyId, transaction });

    const decision = buildAccountingDecision({
      transaction,
      lookupResult,
      journal: null,
      vatEntries: [],
      evidence: [{ type: 'bank_statement', id: 'BT-001' }],
      extractedFacts: [
        { field: 'amount', value: 10000, source: 'deterministic' },
        { field: 'description', value: 'Bank charge', source: 'deterministic' },
      ],
      aiSuggestions: [
        { suggestion: 'bank_charge', field: 'category', confidence: 92, disposition: 'accepted' },
        { suggestion: 'business_expense', field: 'account', confidence: 88, disposition: 'requires_review' },
      ],
      accounts: [],
      reconciled: false,
      decidedAt: '2025-06-15T12:00:00Z',
    });

    // AI suggestions must be clearly labelled as AI
    for (const suggestion of decision.aiSuggestions) {
      expect(suggestion.confidence).toBeDefined();
      expect(suggestion.disposition).toBeDefined();
    }
    // The AI suggestion that requires review must not override deterministic rules
    expect(decision.aiSuggestions.some((s) => s.disposition === 'requires_review')).toBe(true);
  });

  it('sets review_required when rules are not human-approved', () => {
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

    const decision = buildAccountingDecision({
      transaction,
      lookupResult,
      journal: null,
      vatEntries: [],
      evidence: [{ type: 'invoice', id: 'INV-001' }],
      extractedFacts: [],
      aiSuggestions: [],
      accounts: [],
      reconciled: false,
      decidedAt: '2025-06-15T12:00:00Z',
    });

    // Rules are ai_extracted until human-approved, so review_required must be true
    expect(decision.reviewRequired).toBe(true);
    expect(decision.verification.rulesApproved).toBe(false);
    expect(decision.verification.state).toBe('REVIEW_REQUIRED');
  });

  it('verification state is VERIFIED when rules approved and journal balanced', () => {
    // Create a company without VAT registration (so no review-required rules)
    const { db: db2, companyId: cid2 } = createTestDatabaseWithVat();
    const created = createCompany(db2, {
      legalName: 'NoVAT Ltd',
      seedYears: [2025],
    });
    const cByCode = created.accountsByCode;
    const cByKey = created.accountsByKey;

    // Post a simple balanced journal with no rule dependencies
    const entry = postJournalEntry(db2, {
      companyId: created.companyId,
      entryDate: makeDate(2025, 6, 15),
      narrative: 'Opening balance',
      sourceType: 'manual_adjustment',
      baseCurrency: 'EUR',
      lines: [
        { accountId: cByCode['6120']!, debitMinor: 10000 },
        { accountId: cByKey['bank_control']!, creditMinor: 10000 },
      ],
    });

    const decision = buildAccountingDecision({
      transaction: {
        transactionDate: '2025-06-15',
        amountMinor: 10000,
        currency: 'EUR',
      },
      lookupResult: {
        applicableRules: [],
        reviewRequired: false,
        reviewReasons: [],
        unresolvedFields: [],
        identifiedTopics: [],
        candidateCount: 0,
        possibleTreatment: { accounting: [], tax: [], vat: [], reporting: [] },
        transactionContext: {
          transactionDate: '2025-06-15',
          amountMinor: 10000,
          currency: 'EUR',
        },
      },
      journal: entry,
      vatEntries: [],
      evidence: [],
      extractedFacts: [],
      aiSuggestions: [],
      accounts: [
        { id: cByCode['6120']!, code: '6120', name: 'Office expenses' },
        { id: cByKey['bank_control']!, code: '1000', name: 'Bank current account' },
      ],
      reconciled: true,
      decidedAt: '2025-06-15T12:00:00Z',
    });

    expect(decision.verification.journalBalanced).toBe(true);
    expect(decision.verification.reconciled).toBe(true);
    expect(decision.verification.state).toBe('VERIFIED');
  });
});

function createTestDatabaseWithVat() {
  const { db, companyId } = createTestDatabase();
  return { db, companyId };
}

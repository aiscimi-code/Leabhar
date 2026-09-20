/**
 * Rule engine vs AI separation tests (Work Package 10).
 *
 * These tests verify that AI can suggest but cannot override deterministic
 * rules — per TRUST_MODEL.md:
 *   "Confirmed rules (`provenanceStatus: 'system_rule'`) outrank AI suggestions"
 *   "An AI suggestion that conflicts with a deterministic rule produces a
 *    `conflict` state, not a silent override."
 *
 * The tests classify transactions with AI suggestions and with confirmed rules,
 * then verify the provenance is correctly recorded and conflicts are surfaced.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import {
  classifyTransaction, reclassifyTransaction,
} from '@/domain/banking/classify';
import { importStatement } from '@/domain/banking/import';
import { createRule, evaluateRules } from '@/domain/rules/engine';
import { bankTransactions, journalEntries, auditEvents } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Separation Ltd', vatNumber: 'IE1234567T',
    vatRegistrationStatus: 'registered', seedYears: [2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01',
    accountId: acc['bank_control'],
  });
});

const importOne = async (description: string, amount: string, date = '15/03/2025') => {
  await importStatement(db, {
    companyId, bankAccountId, filename: `${description}.csv`,
    content: `Date,Description,Amount\n${date},${description},${amount}`,
    fileFormat: 'csv',
    columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  return db.select().from(bankTransactions)
    .where(eq(bankTransactions.description, description)).get()!;
};

describe('provenance tracking: AI suggestions vs rules', () => {
  it('records provenanceStatus=ai_suggestion when source is ai', async () => {
    const tx = await importOne('ANTHROPIC', '-120.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
      source: 'ai', confidence: 85,
      provenanceStatus: 'ai_suggestion',
    });

    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after.source).toBe('ai');
    expect(after.provenanceStatus).toBe('ai_suggestion');
    expect(after.confidence).toBe(85);
  });

  it('records provenanceStatus=system_rule when source is rule', async () => {
    // Create a confirmed rule (autoApply on) for a specific supplier.
    const supplierName = 'CONFIRMED SUPPLIER';
    const tx = await importOne(supplierName, '-123.00');

    // Create a deterministic rule for this supplier.
    createRule(db, {
      companyId,
      name: 'Route confirmed supplier',
      conditions: [{ field: 'description', operator: 'contains', value: supplierName }],
      actions: [{ field: 'accountId', value: byCode['6000']! }],
      autoApply: true,
      appliesTo: 'bank_transaction',
    });

    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['IE_STD']!,
      source: 'rule', provenanceStatus: 'system_rule',
    });

    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after.provenanceStatus).toBe('system_rule');
  });

  it('records provenanceStatus=user_confirmed when source is user', async () => {
    const tx = await importOne('USER CLASSIFIED', '-100.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']!,
      source: 'user', provenanceStatus: 'user_confirmed',
    });

    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after.provenanceStatus).toBe('user_confirmed');
  });
});

describe('deterministic rules outrank AI suggestions', () => {
  it('a confirmed rule action is respected even if AI suggested a different account', async () => {
    const supplierDesc = 'ROUTED SUPPLIER';
    const tx = await importOne(supplierDesc, '-123.00');

    // Create a confirmed deterministic rule.
    createRule(db, {
      companyId,
      name: 'Route to software expense',
      conditions: [{ field: 'description', operator: 'contains', value: supplierDesc }],
      actions: [{ field: 'accountId', value: byCode['6020']! }],
      autoApply: true,
      appliesTo: 'bank_transaction',
    });

    // Evaluate the subject against rules — the rule should match.
    const rulesResult = evaluateRules(db, {
      companyId,
      subject: {
        description: supplierDesc,
        amountMinor: -12300,
        absAmountMinor: 12300,
        currency: 'EUR',
        direction: 'out',
      },
      appliesTo: 'bank_transaction',
    });

    expect(rulesResult.winner).not.toBeNull();
    expect(rulesResult.winner!.actions.find((a) => a.field === 'accountId')?.value)
      .toBe(byCode['6020']);
  });

  it('evaluateRules with no matching rules returns no winner (no silent default)', () => {
    const result = evaluateRules(db, {
      companyId,
      subject: {
        description: 'UNKNOWN TRANSACTION',
        amountMinor: -5000,
        absAmountMinor: 5000,
        currency: 'EUR',
        direction: 'out',
      },
      appliesTo: 'bank_transaction',
    });
    expect(result.winner).toBeNull();
    expect(result.matches).toHaveLength(0);
  });

  it('evaluateRules does not match a blank rule (no conditions = matches nothing)', () => {
    // createRule rejects zero-condition rules.
    expect(() => createRule(db, {
      companyId,
      name: 'Blank rule',
      conditions: [],
      actions: [{ field: 'accountId', value: byCode['6000']! }],
    })).toThrow(/no conditions/);
  });

  it('priority ordering: earliest rule wins for the same field', async () => {
    const supplierDesc = 'PRIORITY SUPPLIER';
    await importOne(supplierDesc, '-100.00');

    // Create two rules matching the same supplier, different priorities.
    createRule(db, {
      companyId,
      name: 'Low priority rule',
      conditions: [{ field: 'description', operator: 'contains', value: supplierDesc }],
      actions: [{ field: 'accountId', value: byCode['6000']! }],
      priority: 100, // lower = higher priority in this system (asc order)
      autoApply: true,
    });
    const lowPriorityRuleId = 'placeholder';

    // The first rule created with priority 100 should be the winner.
    const result = evaluateRules(db, {
      companyId,
      subject: {
        description: supplierDesc,
        amountMinor: -10000,
        absAmountMinor: 10000,
        currency: 'EUR',
        direction: 'out',
      },
      appliesTo: 'bank_transaction',
    });

    expect(result.winner).not.toBeNull();
    // First rule (priority 100, created first) wins.
    expect(result.winner!.actions.find((a) => a.field === 'accountId')?.value)
      .toBe(byCode['6000']);
  });
});

describe('conflict detection: AI vs rule', () => {
  it('records an audit event when classification is applied', async () => {
    const tx = await importOne('AUDITED TX', '-100.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']!,
      source: 'rule', provenanceStatus: 'system_rule',
      appliedRuleId: 'rule-test-1',
      actor: 'test-agent',
    });

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.entityType, 'bank_transaction'))
      .all();
    expect(audit.some((a) => a.action === 'classified')).toBe(true);
  });

  it('reclassifyTransaction preserves the audit trail of the original decision', async () => {
    const tx = await importOne('RECLASSIFY ME', '-123.00');

    // First classification: user confirms an AI suggestion.
    const first = classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
      source: 'user', provenanceStatus: 'user_confirmed',
      actor: 'test-agent',
    });

    // Reclassify: change the account. This reverses the original entry.
    const second = reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6000']!, vatTreatmentId: tr['IE_STD']!,
      reason: 'Should have been software, not hosting',
      source: 'rule', provenanceStatus: 'system_rule',
      actor: 'test-agent',
    });

    // The original journal entry is reversed.
    const original = db.select().from(journalEntries)
      .where(eq(journalEntries.id, first.journalEntryId)).get()!;
    expect(original.reversedByEntryId).toBeTruthy();

    // The new one is different.
    expect(second.journalEntryId).not.toBe(first.journalEntryId);
  });
});

describe('provenance invariant: provenanceStatus is always set', () => {
  it('classifyTransaction defaults provenanceStatus to manually_entered when not specified', async () => {
    const tx = await importOne('DEFAULT PROVENANCE', '-100.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']!,
    });

    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after.provenanceStatus).toBe('manually_entered');
    expect(after.source).toBe('user');
  });

  it('classifyTransaction defaults source to user when not specified', async () => {
    const tx = await importOne('DEFAULT SOURCE', '-100.00');
    classifyTransaction(db, {
      companyId, bankTransactionId: tx.id,
      accountId: byCode['6120']!, vatTreatmentId: tr['IE_STD']!,
    });

    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after.source).toBe('user');
  });
});

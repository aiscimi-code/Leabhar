import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '@/domain/config/setup';
import { createRule } from '@/domain/rules/engine';
import { importStatement } from '@/domain/banking/import';
import { bankTransactions, rules as rulesTable } from '@/db/schema';
import { autoClassifyFromRules } from './classify';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;

const STATEMENT = [
  'Date,Description,Amount',
  '05/01/2025,OPENING TRANSFER,1000.00',
  '15/01/2025,VERCEL INC,-42.17',
  '20/01/2025,BYRNE ACCOUNTANCY,-615.00',
].join('\n');

const COLUMNS = {
  Date: 'transaction_date' as const,
  Description: 'description' as const,
  Amount: 'amount' as const,
};

beforeEach(async () => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd',
    vatRegistrationStatus: 'registered',
    seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current',
    openingDate: '2025-01-01', accountId: created.accountsByKey['bank_control'],
  });
  await importStatement(db, {
    companyId, bankAccountId, filename: 'jan.csv',
    content: STATEMENT, fileFormat: 'csv', columnMap: COLUMNS,
  });
});

describe('autoClassifyFromRules', () => {
  it('classifies transactions matched by an autoApply rule with account + VAT', () => {
    createRule(db, {
      companyId,
      name: 'Vercel is hosting',
      conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
      actions: [
        { field: 'accountId', value: byCode['6010']! },
        { field: 'vatTreatmentId', value: tr['OUT_OF_SCOPE']! },
      ],
      autoApply: true,
    });

    const result = autoClassifyFromRules(db, { companyId, bankAccountId });

    expect(result.examined).toBe(3);
    expect(result.classified).toBe(1);
    expect(result.unclassified).toBe(2);
    expect(result.errors).toHaveLength(0);

    const vercel = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'VERCEL INC')).get()!;
    expect(vercel.status).toBe('posted');
    expect(vercel.journalEntryId).not.toBeNull();
    expect(vercel.source).toBe('rule');
    expect(vercel.provenanceStatus).toBe('system_rule');
    expect(vercel.appliedRuleId).not.toBeNull();
  });

  it('records that the rule was applied', () => {
    const ruleId = createRule(db, {
      companyId,
      name: 'Vercel is hosting',
      conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
      actions: [
        { field: 'accountId', value: byCode['6010']! },
        { field: 'vatTreatmentId', value: tr['OUT_OF_SCOPE']! },
      ],
      autoApply: true,
    });

    autoClassifyFromRules(db, { companyId, bankAccountId });

    const rule = db.select().from(rulesTable).where(eq(rulesTable.id, ruleId)).get()!;
    expect(rule.timesApplied).toBe(1);
    expect(rule.lastAppliedAt).not.toBeNull();
  });

  it('skips transactions when the matching rule has autoApply off', () => {
    createRule(db, {
      companyId,
      name: 'Vercel is hosting',
      conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
      actions: [
        { field: 'accountId', value: byCode['6010']! },
        { field: 'vatTreatmentId', value: tr['OUT_OF_SCOPE']! },
      ],
      autoApply: false,
    });

    const result = autoClassifyFromRules(db, { companyId, bankAccountId });

    expect(result.classified).toBe(0);
    expect(result.unclassified).toBe(3);
    const vercel = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'VERCEL INC')).get()!;
    expect(vercel.status).toBe('unclassified');
  });

  it('skips a rule that provides an account but no VAT treatment', () => {
    createRule(db, {
      companyId,
      name: 'Account only',
      conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
      actions: [{ field: 'accountId', value: byCode['6010']! }],
      autoApply: true,
    });

    const result = autoClassifyFromRules(db, { companyId, bankAccountId });

    expect(result.classified).toBe(0);
    expect(result.unclassified).toBe(3);
  });

  it('leaves already-posted transactions alone', async () => {
    createRule(db, {
      companyId,
      name: 'Vercel is hosting',
      conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
      actions: [
        { field: 'accountId', value: byCode['6010']! },
        { field: 'vatTreatmentId', value: tr['OUT_OF_SCOPE']! },
      ],
      autoApply: true,
    });

    // Classify the opening transfer manually first.
    const opening = db.select().from(bankTransactions)
      .where(eq(bankTransactions.description, 'OPENING TRANSFER')).get()!;
    const { classifyTransaction } = await import('@/domain/banking/classify');
    classifyTransaction(db, {
      companyId, bankTransactionId: opening.id,
      accountId: byCode['4000']!, vatTreatmentId: tr['OUT_OF_SCOPE']!,
    });

    const result = autoClassifyFromRules(db, { companyId, bankAccountId });
    // Only 2 left unclassified to examine.
    expect(result.examined).toBe(2);
  });

  it('records an error without aborting the batch when one classification fails', () => {
    // A rule pointing at an account that does not exist makes classifyTransaction
    // throw, but the batch must continue.
    createRule(db, {
      companyId,
      name: 'Bad account',
      conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
      actions: [
        { field: 'accountId', value: 'acc_doesnotexist' },
        { field: 'vatTreatmentId', value: tr['OUT_OF_SCOPE']! },
      ],
      autoApply: true,
    });
    createRule(db, {
      companyId,
      name: 'Byrne is accountancy',
      conditions: [{ field: 'description', operator: 'contains', value: 'BYRNE' }],
      actions: [
        { field: 'accountId', value: byCode['6010']! },
        { field: 'vatTreatmentId', value: tr['OUT_OF_SCOPE']! },
      ],
      autoApply: true,
    });

    const result = autoClassifyFromRules(db, { companyId, bankAccountId });

    expect(result.classified).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.description).toBe('VERCEL INC');
  });

  it('reports nothing to do when there are no unclassified transactions', () => {
    // Mark all as ignored by classifying — simpler: delete them.
    const result = autoClassifyFromRules(db, { companyId, bankAccountId: 'ba_noexist' });
    expect(result.examined).toBe(0);
    expect(result.classified).toBe(0);
  });
});

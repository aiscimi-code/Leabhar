import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH } from './irishRules';
import { setRuleReviewStatus } from './review';
import { irishTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let ruleId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Review Ltd', seedYears: [2025] }));
  const markdown = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
  ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
  deriveTaxRules(db, { companyId });
  ruleId = db.select({ id: irishTaxRules.id }).from(irishTaxRules)
    .where(eq(irishTaxRules.ruleKey, 'usc.medical_card_2pct_threshold')).get()!.id;
});

describe('setRuleReviewStatus', () => {
  it('moves a rule through the review lifecycle and records who/when', () => {
    setRuleReviewStatus(db, { ruleId, status: 'human_review', reviewedBy: 'alice@example.com', notes: 'checking figure' });
    let row = db.select().from(irishTaxRules).where(eq(irishTaxRules.id, ruleId)).get()!;
    expect(row.reviewStatus).toBe('human_review');
    expect(row.reviewedBy).toBe('alice@example.com');
    expect(row.reviewNotes).toBe('checking figure');
    expect(row.humanReviewRequired).toBe(true); // not yet approved

    setRuleReviewStatus(db, { ruleId, status: 'active', reviewedBy: 'alice@example.com' });
    row = db.select().from(irishTaxRules).where(eq(irishTaxRules.id, ruleId)).get()!;
    expect(row.reviewStatus).toBe('active');
    expect(row.humanReviewRequired).toBe(false);
    expect(row.provenanceStatus).toBe('user_confirmed');
  });

  it('disables a rejected rule so it can never surface as a candidate again', () => {
    setRuleReviewStatus(db, { ruleId, status: 'rejected', reviewedBy: 'alice@example.com', notes: 'figure looks wrong' });
    const row = db.select().from(irishTaxRules).where(eq(irishTaxRules.id, ruleId)).get()!;
    expect(row.enabled).toBe(false);
    expect(row.active).toBe(false);
    expect(row.reviewStatus).toBe('rejected');
  });

  it('throws for an unknown rule id rather than silently doing nothing', () => {
    expect(() => setRuleReviewStatus(db, { ruleId: 'taxrule_doesnotexist', status: 'active', reviewedBy: 'x' }))
      .toThrow(/No rule/);
  });
});

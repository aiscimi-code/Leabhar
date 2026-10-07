import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { lookupTaxRule } from './irishRules';
import { setRuleReviewStatus } from './review';
import { effectiveRuleReview, ruleDecisionHistory } from './ruleDecisions';
import { visibleTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

const RULE_KEY = 'usc.medical_card_2pct_threshold';

let db: AppDatabase;
let companyId: string;
let rule: { id: string; ruleVersion: number; reviewStatus: string; effectiveFrom: string };

/** The store's row for the rule, as every reader sees it. */
const storeRow = () => db.select({
  id: visibleTaxRules.id, ruleVersion: visibleTaxRules.ruleVersion, reviewStatus: visibleTaxRules.reviewStatus, effectiveFrom: visibleTaxRules.effectiveFrom,
}).from(visibleTaxRules)
  .where(and(eq(visibleTaxRules.companyId, companyId), eq(visibleTaxRules.origin, 'store'), eq(visibleTaxRules.ruleKey, RULE_KEY), eq(visibleTaxRules.active, true)))
  .get()!;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Review Ltd', seedYears: [2025] }));
  rule = storeRow();
});

const lookup = () => lookupTaxRule(db, { companyId, ruleKey: RULE_KEY, asOfDate: rule.effectiveFrom });
const review = () => effectiveRuleReview(db, { companyId, ruleKey: RULE_KEY, ruleVersion: rule.ruleVersion });

describe('setRuleReviewStatus', () => {
  it('moves a rule through the review lifecycle and records who/when, as the book\'s own decision', () => {
    setRuleReviewStatus(db, { companyId, ruleId: rule.id, status: 'human_review', reviewedBy: 'alice@example.com', notes: 'checking figure' });
    expect(review()).toMatchObject({ from: 'book', status: 'human_review', by: 'alice@example.com', reason: 'checking figure' });
    expect(lookup()!.humanReviewRequired).toBe(true); // not yet approved

    setRuleReviewStatus(db, { companyId, ruleId: rule.id, status: 'active', reviewedBy: 'alice@example.com' });
    expect(review()).toMatchObject({ from: 'book', status: 'active', by: 'alice@example.com' });
    expect(lookup()).toMatchObject({ reviewStatus: 'active', reviewedIn: 'book', humanReviewRequired: false });

    // Each decision is appended, numbered as the catalogue numbers the version; the store row is never written (ADR-0021).
    expect(ruleDecisionHistory(db, { companyId, ruleKey: RULE_KEY, ruleVersion: rule.ruleVersion })
      .map((d) => [d.status, d.numbering])).toEqual([['active', 'catalogue'], ['human_review', 'catalogue']]);
    expect(storeRow().reviewStatus).toBe(rule.reviewStatus);
  });

  it('withdraws a rejected rule so it can never surface as a candidate again, keeping it on record', () => {
    expect(lookup()).not.toBeNull();
    setRuleReviewStatus(db, { companyId, ruleId: rule.id, status: 'rejected', reviewedBy: 'alice@example.com', notes: 'figure looks wrong' });
    expect(lookup()).toBeNull();
    expect(review()).toMatchObject({ from: 'book', status: 'rejected', reason: 'figure looks wrong' });
    expect(storeRow().id).toBe(rule.id);
  });

  it('throws for an unknown rule id rather than silently doing nothing', () => {
    expect(() => setRuleReviewStatus(db, { companyId, ruleId: 'taxrule_doesnotexist', status: 'active', reviewedBy: 'x' }))
      .toThrow(/No rule/);
  });
});

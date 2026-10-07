import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatca2010FromCatalogue, deriveVatcaRules } from './vatcaIngestion';
import { explainRule, ruleCitation, describeCondition } from './ruleInfo';
import { attachRulesStoreFromBook } from './rulesStore';
import { and, eq } from 'drizzle-orm';
import { visibleTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let otherCompanyId: string;
let ruleId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Rule Info Ltd', seedYears: [2025] }));
  ({ companyId: otherCompanyId } = createCompany(db, { legalName: 'Other Ltd', seedYears: [2025] }));
  ingestVatca2010FromCatalogue(db, { companyId });
  deriveVatcaRules(db, { companyId });
  attachRulesStoreFromBook(db, { companyId });
  ruleId = db.select({ id: visibleTaxRules.id }).from(visibleTaxRules)
    .where(and(eq(visibleTaxRules.companyId, companyId), eq(visibleTaxRules.origin, 'store'))).limit(1).all()[0]!.id;
});

describe('describeCondition', () => {
  it('renders every operator as a person reads it', () => {
    expect(describeCondition({ field: 'supplyType', operator: 'equals', value: 'services' }))
      .toBe('supplyType is "services"');
    expect(describeCondition({ field: 'amountMinor', operator: 'gte', value: 1000 }))
      .toBe('amountMinor is at least 1000');
    expect(describeCondition({ field: 'description', operator: 'contains', value: 'vat' }))
      .toBe('description contains "vat"');
    expect(describeCondition({ field: 'supplierCountry', operator: 'in', value: ['FR', 'DE'] }))
      .toBe('supplierCountry is one of "FR" or "DE"');
    expect(describeCondition({ field: 'supplyType', operator: 'is_null', value: null }))
      .toBe('supplyType is not stated');
  });
});

describe('ruleCitation', () => {
  it('returns the provision, the document and the authoritative URL', () => {
    const citation = ruleCitation(db, { companyId, ruleId });
    expect(citation).not.toBeNull();
    expect(citation!.ruleId).toBe(ruleId);
    expect(citation!.fullCitation).toMatch(/Act 31/);
    expect(citation!.fullCitation).toContain(citation!.sectionNumber);
    expect(citation!.sourceUrl).toMatch(/^https:/);
    expect(citation!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(citation!.provisionId).toBeTruthy();
  });

  it('returns null for an unknown rule, and cites a store rule the same for every company', () => {
    expect(ruleCitation(db, { companyId, ruleId: 'nope' })).toBeNull();
    // The store is the install's (ADR-0021): a rule in it is every company's. A
    // book's own retained versions stay with that book (visibleRules.test.ts).
    expect(ruleCitation(db, { companyId: otherCompanyId, ruleId })).toEqual(ruleCitation(db, { companyId, ruleId }));
  });
});

describe('explainRule', () => {
  it('assembles the rule, its conditions, effects, lifecycle and source in one explanation', () => {
    const explanation = explainRule(db, { companyId, ruleId });
    expect(explanation).not.toBeNull();
    expect(explanation!.ruleId).toBe(ruleId);
    expect(explanation!.explanation).toContain(explanation!.name);
    expect(explanation!.explanation).toContain(explanation!.citation.fullCitation);
    expect(explanation!.explanation).toContain(explanation!.citation.sourceUrl);
    // Conditions are rendered as the same sentences the API returns.
    for (const sentence of explanation!.conditions) {
      expect(explanation!.explanation).toContain(sentence);
    }
    // An AI-extracted rule never claims to be settled law.
    expect(explanation!.explanation).toContain(explanation!.reviewStatus.replace(/_/g, ' '));
    expect(explanation!.humanReviewRequired).toBe(true);
  });

  it('returns null for an unknown rule, and explains a store rule the same for every company', () => {
    expect(explainRule(db, { companyId, ruleId: 'nope' })).toBeNull();
    expect(explainRule(db, { companyId: otherCompanyId, ruleId })).toEqual(explainRule(db, { companyId, ruleId }));
  });
});

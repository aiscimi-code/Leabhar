import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { suggestFromFacts, type SuggestionFacts } from './vatSuggestion';
import type { AppDatabase } from '@/db';

/** Issue #208 part 2: the letting option to tax (s.97) and supplies of property (s.94). */

let db: AppDatabase;
let companyId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Tenant Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] }));
  loadStatutoryKnowledgeBase(db, { companyId });
});

const suggest = (description: string, direction: 'purchase' | 'sale', vatChargedMinor?: number) => {
  const facts: SuggestionFacts = {
    transactionDate: '2026-03-01', amountMinor: 500_000, currency: 'EUR', description, vatRegistered: true,
    direction, counterpartyCountry: 'IE', invoiceAvailable: true,
    ...(vatChargedMinor === undefined ? {} : { vatChargedMinor }),
  };
  return suggestFromFacts(db, { companyId, subjectId: 'line', facts, factSources: {}, bookedTreatmentId: null });
};

describe('rent paid', () => {
  it('without VAT: the exempt letting (Sch.1 para 11)', () => {
    const s = suggest('Office rent Q1 2026', 'purchase', 0);
    expect(s.decidingRule?.ruleKey).toBe('vat.exempt_letting_immovable_goods');
  });

  it('invoiced with VAT: the landlord opted to tax (s.97(1)(c)(ii)), standard rate', () => {
    const s = suggest('Office rent Q1 2026', 'purchase', 115_000);
    expect(s.decidingRule?.ruleKey).toBe('vat.letting_option_to_tax_exercised');
    expect(s.treatment?.code).toBe('IE_STD');
    expect(s.reviewRequired).toBe(true);
  });

  it('VAT charged on a residential letting: flagged, the option cannot apply (s.97(4))', () => {
    const s = suggest('Apartment rent March', 'purchase', 115_000);
    expect(s.decidingRule?.ruleKey).toBe('vat.letting_option_to_tax_residential');
    expect(s.treatment).toBeNull();
    expect(s.reviewReasons.join(' ')).toMatch(/cannot opt to tax a residential letting/);
  });
});

describe('rent received', () => {
  it('is exempt unless the company opted, and says so', () => {
    const s = suggest('Rent from tenant, unit 4', 'sale', 0);
    expect(s.reviewReasons.join(' ')).toMatch(/exempt unless the company has opted to tax the letting/);
  });
});

describe('supplies of property', () => {
  it('a purchase of property is flagged with the questions that decide it', () => {
    const s = suggest('Completion statement: purchase of premises at Unit 7', 'purchase');
    expect(s.decidingRule?.ruleKey).toBe('vat.supply_of_immovable_goods');
    expect(s.treatment).toBeNull();
    expect(s.reviewReasons.join(' ')).toMatch(/joint option for taxation/);
  });

  it('a joint option: the purchaser accounts, RC_CONSTRUCTION offered, nothing chosen', () => {
    const s = suggest('Purchase of premises under joint option for taxation', 'purchase');
    expect(s.decidingRule?.ruleKey).toBe('vat.joint_option_for_taxation');
    expect(s.treatment).toBeNull();
    expect(s.offeredTreatmentCodes).toEqual(['RC_CONSTRUCTION']);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { suggestFromFacts, type SuggestionFacts } from './vatSuggestion';
import { invoiceConflicts } from '../consolidation/invoiceConflicts';
import type { AppDatabase } from '@/db';

/** Issue #208 part 4: margin and auction schemes, flat-rate farmers and vouchers, from the buyer's side. */

let db: AppDatabase;
let companyId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Buyer Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] }));
  loadStatutoryKnowledgeBase(db, { companyId });
});

const suggest = (description: string, direction: 'purchase' | 'sale' = 'purchase') => {
  const facts: SuggestionFacts = {
    transactionDate: '2026-03-01', amountMinor: 50_000, currency: 'EUR', description, vatRegistered: true,
    direction, counterpartyCountry: 'IE', invoiceAvailable: true,
  };
  return suggestFromFacts(db, { companyId, subjectId: 'line', facts, factSources: {}, bookedTreatmentId: null });
};

describe('margin and auction schemes', () => {
  it('second-hand goods under the margin scheme: no VAT to deduct, OUT_OF_SCOPE offered, nothing chosen', () => {
    const s = suggest('Used forklift. Margin scheme - second-hand goods');
    expect(s.decidingRule?.ruleKey).toBe('vat.margin_scheme_goods_purchase');
    expect(s.treatment).toBeNull();
    expect(s.offeredTreatmentCodes).toEqual(['OUT_OF_SCOPE']);
    expect(s.reviewReasons.join(' ')).toMatch(/s\.87\(9\)/);
  });

  it('travel under the travel agents\' margin scheme (s.88)', () => {
    expect(suggest('Conference package. Margin scheme — travel agents').decidingRule?.ruleKey).toBe('vat.margin_scheme_travel_purchase');
  });

  it('goods at auction under the auction scheme (s.89)', () => {
    expect(suggest('Lot 42 office desks, auction scheme').decidingRule?.ruleKey).toBe('vat.auction_scheme_purchase');
  });

  it('a margin-scheme invoice that shows VAT is a conflict', () => {
    const codes = invoiceConflicts({
      direction: 'purchase', documentVatMinor: 2_300, lineVatMinor: [2_300], supplierVatNumber: 'IE9825613N', customerVatNumber: null,
      companyVatNumber: null, counterpartyCountry: 'IE', counterpartyEstablishment: null, customerVies: null,
      legends: ['Margin scheme - second-hand goods'],
    }).map((c) => c.code);
    expect(codes).toContain('margin_scheme_with_vat');
  });
});

describe('flat-rate farmers', () => {
  it('produce with a flat-rate addition is flagged with the 4.5% addition (s.86(1))', () => {
    const s = suggest('Silage, 40 bales. Flat-rate addition 4.5%');
    expect(s.decidingRule?.ruleKey).toBe('vat.flat_rate_farmer_purchase');
    expect(s.treatment).toBeNull();
    expect(s.reviewReasons.join(' ')).toMatch(/4\.5% of the consideration from 1 January 2026/);
  });
});

describe('vouchers (s.43)', () => {
  it('a gift voucher bought is outside the scope: its price is disregarded until it is redeemed', () => {
    const s = suggest('One4all gift vouchers for staff');
    expect(s.decidingRule?.ruleKey).toBe('vat.voucher_consideration_disregarded');
    expect(s.treatment?.code).toBe('OUT_OF_SCOPE');
  });
  it('a gift voucher sold likewise', () => {
    expect(suggest('Gift card sale', 'sale').treatment?.code).toBe('OUT_OF_SCOPE');
  });
});

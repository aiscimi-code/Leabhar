import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { deriveVatScopeRules } from './vatScopeIngestion';
import { lookupTransactionRules } from './transactionLookup';
import { suggestFromFacts, type SuggestionFacts } from './vatSuggestion';
import { irishTaxRules } from '@/db/schema';
import {
  TAXABLE_AMOUNT_GENERAL_RULE_KEY, OMV_CONNECTED_PARTY_RULE_KEY, TWO_THIRDS_RULE_KEY, FX_RATE_RULE_KEY,
  CREDIT_NOTE_ADJUSTMENT_RULE_KEY,
} from './taxableAmountCuration';
import { RETURN_DUE_RULE_KEY } from './returnsCuration';
import { DEPOSIT_RETURN_SCHEME_RULE_KEY } from './schemesCuration';
import type { AppDatabase } from '@/db';

/**
 * Issue #245 (taxable amount, VATCA ss.36–45) and the parts of #206/#278 that
 * needed new rules: works of art (s.48), contract work (s.49), the return
 * deadline (s.76), the deposit return scheme (s.92A) and grants. Every rule is
 * deterministic: a fixed description either matches its condition or does not.
 */

let db: AppDatabase;
let companyId: string;

beforeAll(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'VAT Engine Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] }));
  loadStatutoryKnowledgeBase(db, { companyId });
});

const rule = (ruleKey: string) => db.select().from(irishTaxRules)
  .where(eq(irishTaxRules.ruleKey, ruleKey)).all().filter((r) => r.companyId === companyId);

const suggest = (description: string, extra: Partial<SuggestionFacts> = {}) => {
  const facts: SuggestionFacts = {
    transactionDate: '2026-03-01', amountMinor: 50_000, currency: 'EUR', description, vatRegistered: true,
    direction: 'sale', counterpartyCountry: 'IE', invoiceAvailable: true,
    ...extra,
  };
  return suggestFromFacts(db, { companyId, subjectId: 'line', facts, factSources: {}, bookedTreatmentId: null });
};

describe('the new rules derive, quoting their provisions verbatim', () => {
  it('no rule is skipped for a missing provision or an excerpt the provision does not contain', () => {
    const result = deriveVatScopeRules(db, { companyId });
    expect(result.skippedNoProvision).toEqual([]);
    expect(result.skippedExcerptNotInProvision).toEqual([]);
  });

  it.each([
    TAXABLE_AMOUNT_GENERAL_RULE_KEY,
    OMV_CONNECTED_PARTY_RULE_KEY,
    TWO_THIRDS_RULE_KEY,
    CREDIT_NOTE_ADJUSTMENT_RULE_KEY,
    FX_RATE_RULE_KEY,
    RETURN_DUE_RULE_KEY,
    DEPOSIT_RETURN_SCHEME_RULE_KEY,
    'vat.rate_works_of_art_imported',
    'vat.rate_contract_work_follows_goods',
    'vat.outside_scope_grant_subsidy',
  ])('%s is derived', (ruleKey) => {
    expect(rule(ruleKey).length).toBeGreaterThan(0);
  });
});

describe('taxable amount (issue #245)', () => {
  it('s.37 applies where a document line states VAT, and states no treatment of its own', () => {
    const withVat = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-03-01', amountMinor: 50_000, currency: 'EUR', description: 'Consulting services',
        vatRegistered: true, vatChargedMinor: 7_265,
      },
    });
    expect(withVat.applicableRules.map((r) => r.ruleKey)).toContain(TAXABLE_AMOUNT_GENERAL_RULE_KEY);

    const withoutVat = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-03-01', amountMinor: 50_000, currency: 'EUR', description: 'Consulting services',
        vatRegistered: true,
      },
    });
    expect(withoutVat.applicableRules.map((r) => r.ruleKey)).not.toContain(TAXABLE_AMOUNT_GENERAL_RULE_KEY);
  });

  it('a sale naming a connected party flags the open market value question (s.38), deciding nothing itself', () => {
    const s = suggest('Invoice: equipment sold to a connected party at less than cost');
    expect(s.reviewReasons.join(' ')).toMatch(/open market value \(VATCA s\.38\)/);
    expect(s.decidingRule?.ruleKey).not.toBe(OMV_CONNECTED_PARTY_RULE_KEY);
  });

  it('an ordinary sale does not raise s.38', () => {
    const s = suggest('Invoice: equipment sold to Acme Ltd');
    expect(s.reviewReasons.join(' ')).not.toMatch(/s\.38/);
  });

  it('a supply-and-fit agreement flags the two-thirds rule (s.41)', () => {
    const s = suggest('Supply and install of laboratory equipment');
    expect(s.reviewReasons.join(' ')).toMatch(/two-thirds of the\s*total consideration/);
  });

  it('a credit note flags the s.45 adjustment and the never-edit rule', () => {
    const s = suggest('Credit note - goods returned under warranty');
    expect(s.reviewReasons.join(' ')).toMatch(/VATCA\s*s\.45/);
    expect(s.reviewReasons.join(' ')).toMatch(/never edited/);
  });
});

describe('works of art, collectors\' items and antiques (s.48, Schedule 5)', () => {
  it('a collector\'s item is flagged, never decided: the reduced rate turns on who supplies it', () => {
    const s = suggest('Occasional sale of a stamp collection, imported last year');
    expect(s.decidingRule?.ruleKey).not.toBe('vat.rate_works_of_art_imported');
    expect(s.reviewReasons.join(' ')).toMatch(/VATCA\s*s\.48/);
  });

  it('ordinary goods named with art words are not put at the reduced rate', () => {
    const s = suggest('Sale of ceramic mugs');
    expect(s.decidingRule?.ruleKey).not.toBe('vat.rate_works_of_art_imported');
    expect(s.treatment?.code).not.toBe('IE_RED');
  });

  it('a painting also meets the Schedule 3 para 23 rule at the same reduced rate', () => {
    const s = suggest('Sale of an original painting');
    expect(s.treatment?.code).toBe('IE_RED');
  });

  it('an ordinary good is not caught by the art rule', () => {
    const s = suggest('Sale of office desks');
    expect(s.decidingRule?.ruleKey).not.toBe('vat.rate_works_of_art_imported');
    expect(s.treatment?.code).not.toBe('IE_RED');
  });
});

describe('contract work (s.49)', () => {
  it('contract work flags the goods\' rate and decides nothing itself', () => {
    const s = suggest('Contract work: laboratory benches made to order');
    expect(s.reviewReasons.join(' ')).toMatch(/VATCA\s*s\.49/);
    expect(s.decidingRule?.ruleKey).not.toBe('vat.rate_contract_work_follows_goods');
  });
});

describe('the return deadline (s.76)', () => {
  it('is a return-level reporting rule that never appears in a transaction lookup', () => {
    const r = rule(RETURN_DUE_RULE_KEY)[0]!;
    expect(r.topic).toBe('vat_return');
    expect(r.ruleType).toBe('reporting');
    const lookup = lookupTransactionRules(db, {
      companyId,
      transaction: {
        transactionDate: '2026-03-01', amountMinor: 50_000, currency: 'EUR', description: 'Consulting services',
        vatRegistered: true,
      },
    });
    expect(lookup.applicableRules.map((x) => x.ruleKey)).not.toContain(RETURN_DUE_RULE_KEY);
  });
});

describe('the deposit return scheme (s.92A)', () => {
  it('a drinks deposit flags that the deposit is not in the taxable amount', () => {
    const s = suggest('Invoice line: deposit charge, ReTurn scheme aluminium cans');
    expect(s.reviewReasons.join(' ')).toMatch(/VATCA\s*s\.92A\(2\)/);
  });

  it('a security deposit for premises is not the scheme', () => {
    const s = suggest('Security deposit held against office damage');
    expect(s.reviewReasons.join(' ')).not.toMatch(/s\.92A/);
  });
});

describe('grants and subsidies (issue #206)', () => {
  it('a grant with no supply in return is outside the scope', () => {
    const s = suggest('Enterprise Ireland grant - research funding');
    expect(s.decidingRule?.ruleKey).toBe('vat.outside_scope_grant_subsidy');
    expect(s.treatment?.code).toBe('OUT_OF_SCOPE');
  });

  it('its exception names the service-for-fee case, so the line stays flagged for a person', () => {
    const r = rule('vat.outside_scope_grant_subsidy')[0]!;
    const exceptions = r.exceptions as Array<{ condition: string }>;
    expect(exceptions[0]!.condition).toMatch(/consideration for goods or services/);
  });
});

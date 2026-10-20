/**
 * The tightened rule versions (vatcaConditionTightening.ts): a released
 * version is never changed, only superseded by a new version that disables
 * it, and every case a line cannot evaluate is a named exception rather than
 * a guess.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatca2010FromCatalogue, deriveVatcaRules } from './vatcaIngestion';
import { ingestVatcaRevised } from './vatcaRevisedIngestion';
import { deriveConditionTightenedRules } from './vatcaConditionTightening';
import { lookupTransactionRules } from './transactionLookup';
import { attachRulesStoreFromBook } from './rulesStore';
import { declaredLinksFrom } from './ruleLinks';
import { irishTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

const REVERSE_CHARGE_KEY = 'vat.reverse_charge_services_from_abroad';
const PLACE_OF_SUPPLY_KEY = 'vat.place_of_supply_b2b_general';

let db: AppDatabase;
let companyId: string;

function rowsOf(ruleKey: string) {
  return db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, ruleKey))).all()
    .sort((a, b) => a.ruleVersion - b.ruleVersion);
}

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Tightening Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  // The released version 1 derives from the Act as enacted, as always.
  ingestVatca2010FromCatalogue(db, { companyId });
  deriveVatcaRules(db, { companyId });
  for (const section of ['012', '034']) {
    ingestVatcaRevised(db, { companyId, section });
  }
});

describe('deriveConditionTightenedRules — the s.12 reverse charge', () => {
  it('derives version 2 from the revised s.12 and chains it to version 1', () => {
    const result = deriveConditionTightenedRules(db, { companyId });
    expect(result.created).toBe(2);
    expect(result.disabled).toBe(2);
    expect(result.skippedNoProvision).toEqual([]);
    expect(result.skippedExcerptNotInProvision).toEqual([]);

    const [v1, v2] = rowsOf(REVERSE_CHARGE_KEY);
    expect(v1?.ruleVersion).toBe(1);
    expect(v2?.ruleVersion).toBe(2);
    expect(v2?.supersedesRuleId).toBe(v1?.id);
    expect(v2?.active).toBe(true);
    expect(v2?.enabled).toBe(true);
    // s.12(1)'s own words carry no LRC amendment, so the version starts with
    // the Act, not the revised page's date (AGENTS.md: a revised text does
    // not date its own figures).
    expect(v2?.effectiveFrom).toBe('2010-11-01');
    expect(v2?.effectiveTo).toBeNull();
    // The quote is the revised s.12's own words, the s.65(2) recipient limb
    // included.
    expect(v2?.statement).toContain('a person to whom a registration number has been assigned');
    expect(v2?.statement).toContain('section 34 (a) ');
    expect(v2?.requiresGuidance).toBe(true);
    expect(v2?.humanReviewRequired).toBe(true);
    expect(v2?.reviewStatus).toBe('ai_extracted');
    expect(v2?.provisionId).not.toBe(v1?.provisionId);
  });

  it('disables the released version 1 without changing a byte the release hashed', () => {
    deriveConditionTightenedRules(db, { companyId });
    const [v1] = rowsOf(REVERSE_CHARGE_KEY);
    // Not closed, not edited: its dates, quote, conditions and effects are
    // what catalogue/released-versions.json recorded.
    expect(v1?.active).toBe(false);
    expect(v1?.enabled).toBe(false);
    expect(v1?.effectiveFrom).toBe('2010-11-01');
    expect(v1?.effectiveTo).toBeNull();
    expect(v1?.statement).not.toContain('a person to whom a registration number has been assigned');
    expect(v1?.conditions).toEqual([
      { field: 'supplyType', operator: 'equals', value: 'services' },
      { field: 'supplierEstablishedOutsideStateResolved', operator: 'equals', value: 'true' },
      { field: 'vatRegistered', operator: 'equals', value: 'true' },
    ]);
    expect(v1?.exceptions).toEqual([]);
  });

  it('routes every case a line cannot evaluate to a named exception', () => {
    deriveConditionTightenedRules(db, { companyId });
    const v2 = rowsOf(REVERSE_CHARGE_KEY)[1]!;
    const conditions = v2.exceptions.map((e) => e.condition).join(' ');
    // s.34(a)(ii)-(iii) fallbacks, s.34's excepted paragraphs, the s.65(2)
    // recipient, s.12(2) public bodies and the s.33(2) exclusion
    // (Finance Act 2018 s.62, LRC F31), and s.12(3)-(6).
    expect(v2.exceptions.length).toBe(6);
    expect(conditions).toContain('s.34(a)(ii)-(iii)');
    expect(conditions).toContain('s.34(c), (d), (g), (i), (j) or (k)');
    expect(conditions).toContain('s.65(2)');
    expect(conditions).toContain('Finance Act 2018 (30/2018) s.62');
    expect(conditions).toContain('s.12(3)-(4)');
    expect(conditions).toContain('s.12(5)-(6)');
  });

  it('is idempotent: a second derive changes nothing', () => {
    const first = deriveConditionTightenedRules(db, { companyId });
    const second = deriveConditionTightenedRules(db, { companyId });
    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(second.disabled).toBe(0);
    expect(rowsOf(REVERSE_CHARGE_KEY)).toHaveLength(2);
  });

  it('skips nothing when the revised section is not ingested', () => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'No Revised Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    ingestVatca2010FromCatalogue(db, { companyId });
    deriveVatcaRules(db, { companyId });
    const result = deriveConditionTightenedRules(db, { companyId });
    expect(result.created).toBe(0);
    expect(result.skippedNoProvision).toEqual([REVERSE_CHARGE_KEY, PLACE_OF_SUPPLY_KEY]);
    // Version 1 still stands, untouched.
    const [v1] = rowsOf(REVERSE_CHARGE_KEY);
    expect(v1?.active).toBe(true);
    expect(v1?.ruleVersion).toBe(1);
  });

  it('declares the s.34(a) place-of-supply precondition as a uses_value link', () => {
    const links = declaredLinksFrom(REVERSE_CHARGE_KEY, { kinds: ['uses_value'] });
    expect(links).toHaveLength(1);
    expect(links[0]!.toKey).toBe('vat.place_of_supply_b2b_general');
    expect(links[0]!.note).toContain('s.12(1)(b)');
  });

  it('the lookup resolves version 2, and a reverse-charge match carries its named exceptions', () => {
    deriveConditionTightenedRules(db, { companyId });
    attachRulesStoreFromBook(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        direction: 'purchase',
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services',
        supplierEstablishedOutsideState: true, supplierCountry: 'US',
        supplierType: 'software_service', transactionType: 'AI_SaaS',
        description: 'US SaaS subscription',
        businessUsePercent: 100, invoiceAvailable: true,
      },
    });
    const applicable = result.applicableRules.find((r) => r.ruleKey === REVERSE_CHARGE_KEY);
    expect(applicable).toBeDefined();
    // The store holds only the enabled version, so what the lookup serves is
    // version 2: its quote is the revised s.12's, the s.65(2) limb included.
    expect(applicable?.statement).toContain('a person to whom a registration number has been assigned');
    expect(applicable?.exceptions.length).toBe(6);
    expect(result.reviewRequired).toBe(true);
    // The establishment test stays flagged: it is the caller's own
    // determination that resolved it, not a guess from the country code.
    const unresolved = lookupTransactionRules(db, {
      companyId,
      transaction: {
        direction: 'purchase',
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services', supplierCountry: 'US',
        supplierType: 'software_service', transactionType: 'AI_SaaS',
      },
    });
    expect(unresolved.applicableRules.map((r) => r.ruleKey)).not.toContain(REVERSE_CHARGE_KEY);
    expect(unresolved.unresolvedFields).toContain('supplierEstablishedOutsideStateResolved');
  });
});

describe('deriveConditionTightenedRules — the s.34 general B2B place of supply', () => {
  it('derives version 2 from the revised s.34 and chains it to version 1', () => {
    const result = deriveConditionTightenedRules(db, { companyId });
    expect(result.created).toBe(2);
    expect(result.disabled).toBe(2);
    expect(result.skippedNoProvision).toEqual([]);
    expect(result.skippedExcerptNotInProvision).toEqual([]);

    const [v1, v2] = rowsOf(PLACE_OF_SUPPLY_KEY);
    expect(v1?.ruleVersion).toBe(1);
    expect(v2?.ruleVersion).toBe(2);
    expect(v2?.supersedesRuleId).toBe(v1?.id);
    expect(v2?.active).toBe(true);
    expect(v2?.enabled).toBe(true);
    // The quote is the whole of s.34(a), its fallback subparagraphs included.
    expect(v2?.statement).toContain('a fixed establishment of the person');
    expect(v2?.statement).toContain('permanent address or usual place of residence');
    expect(v2?.effectiveFrom).toBe('2010-11-01');
    expect(v2?.reviewStatus).toBe('ai_extracted');
  });

  it('disables the released version 1 without changing a byte the release hashed', () => {
    deriveConditionTightenedRules(db, { companyId });
    const [v1] = rowsOf(PLACE_OF_SUPPLY_KEY);
    expect(v1?.active).toBe(false);
    expect(v1?.enabled).toBe(false);
    expect(v1?.effectiveFrom).toBe('2010-11-01');
    expect(v1?.effectiveTo).toBeNull();
    expect(v1?.conditions).toEqual([{ field: 'supplyType', operator: 'equals', value: 'services' }]);
  });

  it('routes each excepted paragraph and each fallback to a named exception', () => {
    deriveConditionTightenedRules(db, { companyId });
    const v2 = rowsOf(PLACE_OF_SUPPLY_KEY)[1]!;
    const conditions = v2.exceptions.map((e) => e.condition).join(' ');
    // (c), (d), (g), (i), (j), (k) and the (a)(ii)-(iii) fallbacks.
    expect(v2.exceptions.length).toBe(8);
    expect(conditions).toContain('s.34(c)');
    expect(conditions).toContain('s.34(d)');
    expect(conditions).toContain('s.34(g)');
    expect(conditions).toContain('s.34(i)');
    expect(conditions).toContain('s.34(j)');
    expect(conditions).toContain('s.34(k)');
    expect(conditions).toContain('s.34(a)(ii)');
    expect(conditions).toContain('s.34(a)(iii)');
    // Each excepted paragraph points at its own rule — the same keys the
    // reverse-charge suggestion lets decide before s.12 — except (j), which
    // no rule models and which is routed to review by name.
    const effects = v2.exceptions.map((e) => e.effect).join(' ');
    expect(effects).toContain('vat.place_of_supply_immovable_goods');
    expect(effects).toContain('vat.place_of_supply_passenger_transport');
    expect(effects).toContain('vat.place_of_supply_event_admission');
    expect(effects).toContain('vat.place_of_supply_restaurant_catering');
    expect(effects).toContain('vat.place_of_supply_short_term_hire');
    expect(effects).toContain('S.I. 725/2024 reg. 4');
    expect(effects).toContain('no rule models this paragraph');
  });

  it('is idempotent: a second derive changes nothing', () => {
    deriveConditionTightenedRules(db, { companyId });
    const second = deriveConditionTightenedRules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(2);
    expect(second.disabled).toBe(0);
    expect(rowsOf(PLACE_OF_SUPPLY_KEY)).toHaveLength(2);
  });

  it('the lookup still serves the general rule for a service to a business, with its exceptions named', () => {
    deriveConditionTightenedRules(db, { companyId });
    attachRulesStoreFromBook(db, { companyId });
    const result = lookupTransactionRules(db, {
      companyId,
      transaction: {
        direction: 'purchase',
        transactionDate: '2026-09-18', amountMinor: 123000, currency: 'EUR',
        vatRegistered: true, supplyType: 'services',
        supplierEstablishedOutsideState: true, supplierCountry: 'US',
        description: 'US software subscription',
      },
    });
    const applicable = result.applicableRules.find((r) => r.ruleKey === PLACE_OF_SUPPLY_KEY);
    expect(applicable).toBeDefined();
    expect(applicable?.statement).toContain('a fixed establishment of the person');
    expect(applicable?.exceptions.length).toBe(8);
    expect(result.reviewRequired).toBe(true);
  });
});

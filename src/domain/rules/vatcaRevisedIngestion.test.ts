import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules, VATCA_REVISED_S046_MD_PATH } from './vatcaRevisedIngestion';
import { ingestVatca2010, VATCA_2010_MD_PATH } from './vatcaIngestion';
import { lookupTaxRule } from './irishRules';
import { VATCA_REVISED_CURATED_RULES } from './vatcaRevisedCuration';
import { irishTaxRules, irishKnowledgeSources, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const s46Markdown = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Rates Ltd', seedYears: [2025] }));
});

describe('ingestVatcaRevisedSection', () => {
  it('ingests s.46 under its own citation and is idempotent by content', () => {
    const first = ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.sectionNumber).toBe('46');

    const second = ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('2010 Act 31 s.46');
    expect(source.sourceType).toBe('legislation');
  });

  it('never collides with the as-enacted whole-Act source, even though both cite "2010 Act 31"-family text', () => {
    ingestVatca2010(db, { companyId, markdown: readFileSync(VATCA_2010_MD_PATH, 'utf8'), ingestVersion: 'v1' });
    const revised = ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    expect(revised.ingested).toBe(true);

    const sources = db.select().from(irishKnowledgeSources).all();
    const citations = new Set(sources.map((s) => s.citation));
    expect(citations.has('2010 Act 31')).toBe(true);
    expect(citations.has('2010 Act 31 s.46')).toBe(true);
  });
});

describe('deriveVatcaRevisedRules', () => {
  beforeEach(() => {
    ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
  });

  it('creates one rule per curated revised rate', () => {
    const result = deriveVatcaRevisedRules(db, { companyId });
    expect(result.created).toBe(VATCA_REVISED_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('the standard-rate rule states 23%, never the stale as-enacted 21%', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.rate_standard_current' });
    expect(rule).not.toBeNull();
    expect(rule!.value).toBe(23);
    expect(rule!.unit).toBe('percent');
    expect(rule!.citation).toBe('2010 Act 31 s.46');
    expect(rule!.effectiveFrom).toBe('2021-03-01');
  });

  it('every rule starts unreviewed with ai_suggestion provenance, never automatically authoritative', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(VATCA_REVISED_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
      // vat.rate_hospitality_9pct_not_modelled deliberately states no figure
      // (issue #136 bug 8) — every rule that DOES claim to state a rate has one.
      if (row.ruleKey !== 'vat.rate_hospitality_9pct_not_modelled') {
        expect(row.numericValue).not.toBeNull();
      } else {
        expect(row.numericValue).toBeNull();
      }
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const second = deriveVatcaRevisedRules(db, { companyId });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(VATCA_REVISED_CURATED_RULES.length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(VATCA_REVISED_CURATED_RULES.length);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
  });

  describe('issue #129: the five date-boxed 9% second-reduced-rate carve-outs', () => {
    it('curates a real 9% figure for each carve-out, resolvable on its own effectiveFrom date', () => {
      deriveVatcaRevisedRules(db, { companyId });
      const keys = [
        'vat.rate_periodicals_9pct_current',
        'vat.rate_sporting_facilities_9pct_current',
        'vat.rate_heat_pump_installation_9pct_current',
        'vat.rate_gas_electricity_9pct_current',
        'vat.rate_social_housing_apartment_9pct_2025_narrow',
        'vat.rate_social_housing_apartment_9pct_current',
        'vat.rate_restaurant_catering_9pct_2020_2023',
        'vat.rate_printed_matter_9pct_2020_2023',
        'vat.rate_admission_9pct_2020_2023',
        'vat.rate_hotel_accommodation_9pct_2020_2023',
        'vat.rate_hairdressing_9pct_2020_2023',
      ];
      for (const key of keys) {
        const curated = VATCA_REVISED_CURATED_RULES.find((r) => r.ruleKey === key)!;
        // Each window's own opening day, not a shared date — the six windows
        // here span from 2020 to 2026 and do not all overlap.
        const rule = lookupTaxRule(db, { companyId, ruleKey: key, asOfDate: curated.effectiveFrom });
        expect(rule, `${key} should resolve on its own effectiveFrom (${curated.effectiveFrom})`).not.toBeNull();
        expect(rule!.value, key).toBe(9);
        expect(rule!.unit, key).toBe('percent');
      }
    });

    it('the restaurant/catering rate never has two rules claiming the same date (no overlap)', () => {
      // The three restaurant/catering periods (pre-9%-window, the verified
      // 9% window, post-window) must exactly tile 2010-11-01 onward with no
      // gap and no overlap — a gap would silently fall back to the 23%
      // standard rate (see vatcaRevisedCuration.ts's own header), and an
      // overlap would present two different rates for the same transaction.
      const restaurantRules = VATCA_REVISED_CURATED_RULES.filter(
        (r) => r.ruleKey.startsWith('vat.rate_restaurant_catering_') && r.ruleKey !== 'vat.rate_hospitality_9pct_not_modelled',
      ).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

      expect(restaurantRules.map((r) => r.ruleKey)).toEqual([
        'vat.rate_restaurant_catering_reduced_pre_9pct_window',
        'vat.rate_restaurant_catering_9pct_2020_2023',
        'vat.rate_restaurant_catering_reduced_current',
      ]);
      expect(restaurantRules[0]!.numericValue).toBe(13.5);
      expect(restaurantRules[1]!.numericValue).toBe(9);
      expect(restaurantRules[2]!.numericValue).toBe(13.5);

      for (let i = 0; i < restaurantRules.length - 1; i++) {
        // lookupTaxRule's own window test is `effectiveFrom <= asOf &&
        // (!effectiveTo || effectiveTo > asOf)` — a strict `>` — so a period's
        // effectiveTo must equal the NEXT period's effectiveFrom exactly
        // (not a day earlier) for the two to tile with no gap and no overlap.
        const closes = restaurantRules[i]!.effectiveTo;
        const nextOpens = restaurantRules[i + 1]!.effectiveFrom;
        expect(closes, `${restaurantRules[i]!.ruleKey} -> ${restaurantRules[i + 1]!.ruleKey}`).toBe(nextOpens);
      }
    });

    it('a 2021 restaurant transaction resolves to the verified 9% COVID-era rate, not the blanket 13.5%', () => {
      deriveVatcaRevisedRules(db, { companyId });
      const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.rate_restaurant_catering_9pct_2020_2023', asOfDate: '2021-06-01' });
      expect(rule).not.toBeNull();
      expect(rule!.value).toBe(9);

      // The pre-window and post-window rules must NOT resolve on this date.
      const pre = lookupTaxRule(db, { companyId, ruleKey: 'vat.rate_restaurant_catering_reduced_pre_9pct_window', asOfDate: '2021-06-01' });
      const post = lookupTaxRule(db, { companyId, ruleKey: 'vat.rate_restaurant_catering_reduced_current', asOfDate: '2021-06-01' });
      expect(pre).toBeNull();
      expect(post).toBeNull();
    });
  });
});

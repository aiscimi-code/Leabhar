import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules, VATCA_REVISED_S046_MD_PATH } from './vatcaRevisedIngestion';
import { ingestVatca2010, VATCA_2010_MD_PATH } from './vatcaIngestion';
import { lookupTaxRule, ingestFinanceAct2025, FINANCE_ACT_2025 } from './irishRules';
import { VATCA_REVISED_CURATED_RULES, S46_FAMILY_SCHEDULE_REF } from './vatcaRevisedCuration';
import { scheduleThreeRate } from './scheduleRates';
import { irishTaxRules, irishKnowledgeSources, irishActProvisions, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const s46Markdown = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');
const FA2025_PATH = new URL(`../../../${FINANCE_ACT_2025.localPath}`, import.meta.url).pathname;

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
    ingestFinanceAct2025(db, { companyId, markdown: readFileSync(FA2025_PATH, 'utf8'), ingestVersion: 'v1' });
  });

  const rowsFor = (ruleKey: string) => db.select().from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, ruleKey))).all()
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const rateOn = (ruleKey: string, asOfDate: string) => lookupTaxRule(db, { companyId, ruleKey, asOfDate })?.value ?? null;

  it('creates one row per curated version', () => {
    const result = deriveVatcaRevisedRules(db, { companyId });
    expect(result.created).toBe(VATCA_REVISED_CURATED_RULES.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('skips a whole family when one version\'s source is not ingested, rather than deriving part of it', () => {
    const { db: other } = createTestDatabase();
    const { companyId: otherCompany } = createCompany(other, { legalName: 'Other Ltd', seedYears: [2025] });
    ingestVatcaRevisedSection(other, { companyId: otherCompany, markdown: s46Markdown, ingestVersion: 'v1' });
    const result = deriveVatcaRevisedRules(other, { companyId: otherCompany });
    expect(result.skippedNoProvision.sort()).toEqual(['vat.rate_hairdressing', 'vat.rate_hospitality']);
  });

  it('the standard rate is one family: 23% from 2012, 21% for the s.46(1A) period, 23% from March 2021, chained', () => {
    deriveVatcaRevisedRules(db, { companyId });
    expect(rateOn('vat.rate_standard_current', '2011-06-01')).toBeNull(); // before F95: not in the repository
    expect(rateOn('vat.rate_standard_current', '2012-01-01')).toBe(23);
    expect(rateOn('vat.rate_standard_current', '2020-08-31')).toBe(23);
    expect(rateOn('vat.rate_standard_current', '2020-09-01')).toBe(21);
    expect(rateOn('vat.rate_standard_current', '2021-02-28')).toBe(21);
    expect(rateOn('vat.rate_standard_current', '2021-03-01')).toBe(23);
    const [v1, v2, v3] = rowsFor('vat.rate_standard_current');
    expect([v1!.ruleVersion, v2!.ruleVersion, v3!.ruleVersion]).toEqual([1, 2, 3]);
    expect(v1!.supersedesRuleId).toBeNull();
    expect(v2!.supersedesRuleId).toBe(v1!.id);
    expect(v3!.supersedesRuleId).toBe(v2!.id);
    expect([v1!.active, v2!.active, v3!.active]).toEqual([false, false, true]);
    expect(lookupTaxRule(db, { companyId, ruleKey: 'vat.rate_standard_current', asOfDate: '2026-01-01' })!.citation)
      .toBe('2010 Act 31 s.46');
  });

  it('hospitality: 9% (cb) 2020–2023, nothing 2023–2024, 13.5% 2025 to June 2026, 9% from July 2026 under Finance Act 2025 s.71', () => {
    deriveVatcaRevisedRules(db, { companyId });
    expect(rateOn('vat.rate_hospitality', '2019-06-01')).toBeNull();
    expect(rateOn('vat.rate_hospitality', '2021-06-01')).toBe(9);
    expect(rateOn('vat.rate_hospitality', '2024-06-01')).toBeNull();
    expect(rateOn('vat.rate_hospitality', '2025-06-01')).toBe(13.5);
    expect(rateOn('vat.rate_hospitality', '2026-06-30')).toBe(13.5);
    expect(rateOn('vat.rate_hospitality', '2026-07-01')).toBe(9);
    const july = lookupTaxRule(db, { companyId, ruleKey: 'vat.rate_hospitality', asOfDate: '2026-07-01' })!;
    expect(july.citation).toBe('2025 Act 18');
    expect(july.sectionNumber).toBe('71');
    expect(rateOn('vat.rate_hairdressing', '2026-07-01')).toBe(9);
    expect(rateOn('vat.rate_hairdressing', '2025-03-01')).toBe(13.5);
  });

  it('every family version agrees with scheduleThreeRate on its first and last day', () => {
    const bp = { IE_RED: 13.5, IE_SECOND_RED: 9 } as const;
    for (const [key, ref] of Object.entries(S46_FAMILY_SCHEDULE_REF)) {
      for (const v of VATCA_REVISED_CURATED_RULES.filter((r) => r.ruleKey === key)) {
        const last = v.effectiveTo ? new Date(Date.parse(v.effectiveTo) - 86_400_000).toISOString().slice(0, 10) : '2040-01-01';
        for (const d of [v.effectiveFrom, last]) {
          const code = scheduleThreeRate(ref, d).code;
          expect(code ? bp[code] : null, `${key} on ${d}`).toBe(v.numericValue);
        }
      }
    }
  });

  it('no family has two versions claiming the same date', () => {
    const byKey = new Map<string, typeof VATCA_REVISED_CURATED_RULES>();
    for (const r of VATCA_REVISED_CURATED_RULES) byKey.set(r.ruleKey, [...(byKey.get(r.ruleKey) ?? []), r]);
    for (const [key, versions] of byKey) {
      const sorted = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      for (let i = 0; i < sorted.length - 1; i++) {
        expect(sorted[i]!.effectiveTo, `${key} v${i + 1} must close`).not.toBeNull();
        expect(sorted[i]!.effectiveTo! <= sorted[i + 1]!.effectiveFrom, `${key} v${i + 1} overlaps v${i + 2}`).toBe(true);
      }
    }
  });

  it('every excerpt is verbatim from the provision it cites', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
    for (const row of db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all()) {
      const prov = db.select().from(irishActProvisions).where(eq(irishActProvisions.id, row.provisionId)).get()!;
      expect(norm(prov.provisionText ?? ''), row.name).toContain(norm(row.statement ?? ''));
    }
  });

  it('every rule starts unreviewed with ai_suggestion provenance and states a figure', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(VATCA_REVISED_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
      expect(row.numericValue, row.name).not.toBeNull();
    }
  });

  it('is idempotent: re-deriving unchanged curation creates, supersedes and retires nothing', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const second = deriveVatcaRevisedRules(db, { companyId });
    expect(second).toMatchObject({ created: 0, superseded: 0, unchanged: VATCA_REVISED_CURATED_RULES.length });
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(VATCA_REVISED_CURATED_RULES.length);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
  });

  it('on a database derived by an earlier release: retires the old keys and re-dates a wrongly dated rule, chained to it', () => {
    deriveVatcaRevisedRules(db, { companyId });
    const periodicals = rowsFor('vat.rate_periodicals_9pct_current')[0]!;
    // As an earlier release left it: the (ca) rule dated from the retrieval day, and a retired key still live.
    db.update(irishTaxRules).set({ effectiveFrom: '2026-09-20', active: true }).where(eq(irishTaxRules.id, periodicals.id)).run();
    const { id: _id, ...rest } = periodicals;
    db.insert(irishTaxRules).values({
      ...rest, id: 'rule_old_gap', ruleKey: 'vat.rate_hospitality_9pct_not_modelled', numericValue: null,
      effectiveFrom: '2026-07-01', effectiveTo: null, active: true,
    }).run();

    const again = deriveVatcaRevisedRules(db, { companyId });
    expect(again.created).toBe(1);
    expect(again.superseded).toBe(2);
    const old = db.select().from(irishTaxRules).where(eq(irishTaxRules.id, 'rule_old_gap')).get()!;
    expect(old).toMatchObject({ active: false, effectiveTo: '2026-07-01' }); // an empty window: never in force
    expect(lookupTaxRule(db, { companyId, ruleKey: 'vat.rate_hospitality_9pct_not_modelled', asOfDate: '2026-08-01' })).toBeNull();

    const [retired, current] = rowsFor('vat.rate_periodicals_9pct_current')
      .sort((a, b) => a.ruleVersion - b.ruleVersion);
    expect(retired).toMatchObject({ id: periodicals.id, active: false, effectiveTo: '2026-09-20' });
    expect(current).toMatchObject({ effectiveFrom: '2025-01-01', active: true, supersedesRuleId: periodicals.id, ruleVersion: 2 });
    expect(rateOn('vat.rate_periodicals_9pct_current', '2025-06-01')).toBe(9);
  });

  it('the (ca) categories are 9% from 1 January 2025 (F101), not from the retrieval date', () => {
    deriveVatcaRevisedRules(db, { companyId });
    for (const key of ['vat.rate_periodicals_9pct_current', 'vat.rate_sporting_facilities_9pct_current',
      'vat.rate_heat_pump_installation_9pct_current']) {
      expect(rateOn(key, '2025-01-01'), key).toBe(9);
      expect(rateOn(key, '2024-12-31'), key).toBeNull();
    }
    for (const key of ['vat.rate_printed_matter_9pct_2020_2023', 'vat.rate_admission_9pct_2020_2023',
      'vat.rate_hotel_accommodation_9pct_2020_2023', 'vat.rate_gas_electricity_9pct_current',
      'vat.rate_social_housing_apartment_9pct_2025_narrow', 'vat.rate_social_housing_apartment_9pct_current']) {
      const curated = VATCA_REVISED_CURATED_RULES.find((r) => r.ruleKey === key)!;
      expect(rateOn(key, curated.effectiveFrom), key).toBe(9);
    }
  });
});

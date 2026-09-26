import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestVatcaSchedule, deriveVatcaScheduleRules, VATCA_SCHEDULE_2_MD_PATH, VATCA_SCHEDULE_3_MD_PATH,
} from './vatcaScheduleIngestion';
import { ingestVatca2010, VATCA_2010_MD_PATH } from './vatcaIngestion';
import { lookupTaxRule } from './irishRules';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { irishTaxRules, irishKnowledgeSources, irishActProvisions, reviewItems } from '@/db/schema';
import { and } from 'drizzle-orm';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const sch2Markdown = readFileSync(VATCA_SCHEDULE_2_MD_PATH, 'utf8');
const sch3Markdown = readFileSync(VATCA_SCHEDULE_3_MD_PATH, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Schedule Ltd', seedYears: [2025] }));
});

describe('ingestVatcaSchedule', () => {
  it('ingests Schedule 2 under its own distinct citation and is idempotent by content', () => {
    const first = ingestVatcaSchedule(db, { companyId, scheduleNumber: '2', markdown: sch2Markdown, ingestVersion: 'v1' });
    expect(first.ingested).toBe(true);
    expect(first.paragraphCount).toBe(15); // 14 numbered paragraphs plus 9A

    const second = ingestVatcaSchedule(db, { companyId, scheduleNumber: '2', markdown: sch2Markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);
    expect(second.sourceId).toBe(first.sourceId);

    const source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.citation).toBe('2010 Act 31 Sch.2');
  });

  it('ingests Schedule 2 and Schedule 3 as separate source rows even though both contain a "paragraph 9"', () => {
    const sch2 = ingestVatcaSchedule(db, { companyId, scheduleNumber: '2', markdown: sch2Markdown, ingestVersion: 'v1' });
    const sch3 = ingestVatcaSchedule(db, { companyId, scheduleNumber: '3', markdown: sch3Markdown, ingestVersion: 'v1' });
    expect(sch2.sourceId).not.toBe(sch3.sourceId);

    const sch2Source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, sch2.sourceId)).get()!;
    const sch3Source = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.id, sch3.sourceId)).get()!;
    expect(sch2Source.citation).toBe('2010 Act 31 Sch.2');
    expect(sch3Source.citation).toBe('2010 Act 31 Sch.3');
  });

  it('never collides with the principal Act\'s own source, even though both are "2010 Act 31"-family citations', () => {
    ingestVatca2010(db, { companyId, markdown: readFileSync(VATCA_2010_MD_PATH, 'utf8'), ingestVersion: 'v1' });
    const sch2 = ingestVatcaSchedule(db, { companyId, scheduleNumber: '2', markdown: sch2Markdown, ingestVersion: 'v1' });
    expect(sch2.ingested).toBe(true);

    const sources = db.select().from(irishKnowledgeSources).all();
    const citations = new Set(sources.map((s) => s.citation));
    expect(citations.has('2010 Act 31')).toBe(true);
    expect(citations.has('2010 Act 31 Sch.2')).toBe(true);
  });
});

describe('ingestVatcaSchedule on a database ingested by an earlier parser (issue #205)', () => {
  it('adds the paragraphs the parser now finds and marks newly curated ones relevant, without rewriting stored text', () => {
    const first = ingestVatcaSchedule(db, { companyId, scheduleNumber: '3', markdown: sch3Markdown, ingestVersion: 'v1' });
    // As an earlier parser left it: no para 21, and para 13A not curated (so irrelevant).
    db.delete(irishActProvisions).where(and(eq(irishActProvisions.sourceId, first.sourceId), eq(irishActProvisions.sectionNumber, '21'))).run();
    db.update(irishActProvisions).set({ relevant: false, relevanceReason: 'old' })
      .where(and(eq(irishActProvisions.sourceId, first.sourceId), eq(irishActProvisions.sectionNumber, '13A'))).run();
    const para20 = () => db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, first.sourceId), eq(irishActProvisions.sectionNumber, '20'))).get()!;
    const before20 = para20();

    const again = ingestVatcaSchedule(db, { companyId, scheduleNumber: '3', markdown: sch3Markdown, ingestVersion: 'v2' });
    expect(again).toMatchObject({ ingested: false, sourceId: first.sourceId, paragraphCount: first.paragraphCount });
    const p21 = db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, first.sourceId), eq(irishActProvisions.sectionNumber, '21'))).get();
    expect(p21?.heading).toBe('Miscellaneous services.');
    const p13A = db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, first.sourceId), eq(irishActProvisions.sectionNumber, '13A'))).get()!;
    expect(p13A.relevant).toBe(true);
    expect(para20()).toEqual(before20);

    const derived = deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '3', sourceId: first.sourceId });
    expect(derived.skippedNoProvision).toEqual([]);
  });
});

describe('deriveVatcaScheduleRules', () => {
  beforeEach(() => {
    ingestVatcaSchedule(db, { companyId, scheduleNumber: '2', markdown: sch2Markdown, ingestVersion: 'v1' });
    ingestVatcaSchedule(db, { companyId, scheduleNumber: '3', markdown: sch3Markdown, ingestVersion: 'v1' });
  });

  it('creates one rule per curated Schedule 2 paragraph', () => {
    const sch2Curated = VATCA_SCHEDULE_CURATED_RULES.filter((r) => r.scheduleNumber === '2');
    const result = deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '2' });
    expect(result.created).toBe(sch2Curated.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('creates one rule per curated Schedule 3 paragraph', () => {
    const sch3Curated = VATCA_SCHEDULE_CURATED_RULES.filter((r) => r.scheduleNumber === '3');
    const result = deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '3' });
    expect(result.created).toBe(sch3Curated.length);
    expect(result.skippedNoProvision).toEqual([]);
  });

  it('every rule starts unreviewed with ai_suggestion provenance, never automatically authoritative', () => {
    deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '2' });
    deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '3' });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    expect(rows.length).toBe(VATCA_SCHEDULE_CURATED_RULES.length);
    for (const row of rows) {
      expect(row.humanReviewRequired).toBe(true);
      expect(row.reviewStatus).toBe('ai_extracted');
      expect(row.provenanceStatus).toBe('ai_suggestion');
      expect(row.requiresGuidance).toBe(true);
      expect(row.statement).toBeTruthy();
    }
  });

  it('is idempotent: re-deriving unchanged curation creates nothing new', () => {
    deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '2' });
    const second = deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '2' });
    expect(second.created).toBe(0);
    expect(second.unchanged).toBe(VATCA_SCHEDULE_CURATED_RULES.filter((r) => r.scheduleNumber === '2').length);
  });

  it('surfaces each new rule in the existing review inbox', () => {
    deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '2' });
    const items = db.select().from(reviewItems).where(eq(reviewItems.companyId, companyId)).all();
    expect(items.length).toBe(VATCA_SCHEDULE_CURATED_RULES.filter((r) => r.scheduleNumber === '2').length);
    expect(items.every((i) => i.entityType === 'irish_tax_rule')).toBe(true);
  });

  it('the zero-rate intra-Community rule is findable by its stable key with the Schedule\'s own citation', () => {
    deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '2' });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.zero_rate_intra_community_goods' });
    expect(rule).not.toBeNull();
    expect(rule!.sectionNumber).toBe('1');
    expect(rule!.citation).toBe('2010 Act 31 Sch.2');
    expect(rule!.provisionText).toContain('dispatched or transported from the State');
  });

  it('never matches a curated paragraph number against the OTHER Schedule\'s own paragraph 9', () => {
    deriveVatcaScheduleRules(db, { companyId, scheduleNumber: '3' });
    const rule = lookupTaxRule(db, { companyId, ruleKey: 'vat.reduced_rate_dwelling_services' });
    expect(rule).not.toBeNull();
    expect(rule!.citation).toBe('2010 Act 31 Sch.3'); // not Sch.2, whose paragraph 9 is unrelated (printed books)
    expect(rule!.provisionText).toContain('private dwellings');
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { parseNfgSections, extractNfgSection } from './tcaNfgParser';
import { ingestTcaNfgPart, deriveCorporationTaxRules, nfgPath } from './tcaNfgIngestion';
import {
  CORPORATION_TAX_CURATED_RULES, NFG_SECTIONS, corporationTaxRateBasisPoints,
  CT_RATE_TRADING_RULE_KEY, CT_RATE_HIGHER_RULE_KEY, nfgCitation,
} from './corporationTaxCuration';

const read = (part: string) => readFileSync(nfgPath(part), 'utf8');

describe('Notes for Guidance parser', () => {
  it('reads every section note of a part once, in order, skipping the contents list', () => {
    const numbers = parseNfgSections(read('part13')).map((s) => s.sectionNumber);
    expect(numbers).toEqual(['430', '431', '432', '433', '434', '435', '436', '436A', '437', '438', '438A', '439', '440', '441']);
  });

  it('joins a heading that wraps, and keeps a note that has no Summary', () => {
    expect(extractNfgSection(read('part41a'), '959AR').heading)
      .toBe('Date for payment of corporation tax: Companies other than with relevant accounting periods');
    const s292 = extractNfgSection(read('part09'), '292');
    expect(s292.heading).toBe('Meaning of “amount still unallowed”');
    expect(extractNfgSection(read('part09'), '291A').provisionText).not.toContain('amount still unallowed” in respect');
  });

  it('finds every in-scope section, and each slice is the file between its offsets', () => {
    for (const [part, sections] of Object.entries(NFG_SECTIONS)) {
      const md = read(part);
      for (const n of sections) {
        const s = extractNfgSection(md, n);
        expect(md.slice(s.sourceStart, s.sourceEnd)).toBe(s.provisionText);
      }
    }
  });
});

describe('corporation tax curation', () => {
  it('quotes each rule verbatim from its section note', () => {
    for (const rule of CORPORATION_TAX_CURATED_RULES) {
      expect(NFG_SECTIONS[rule.part], rule.ruleKey).toContain(rule.sectionNumber);
      expect(extractNfgSection(read(rule.part), rule.sectionNumber).provisionText, rule.ruleKey).toContain(rule.statementExcerpt);
    }
  });

  it('states the rates the computation uses', () => {
    expect(corporationTaxRateBasisPoints(CT_RATE_TRADING_RULE_KEY)).toBe(1250);
    expect(corporationTaxRateBasisPoints(CT_RATE_HIGHER_RULE_KEY)).toBe(2500);
    expect(nfgCitation('part41a')).toBe('Revenue NfG TCA 1997 (FA 2025 ed.) Part 41A');
  });

  it('derives the rules once, unapproved, and leaves them alone on a second run', () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'CT Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    for (const part of Object.keys(NFG_SECTIONS)) ingestTcaNfgPart(db, { companyId, part, markdown: read(part), ingestVersion: 'v1' });
    expect(deriveCorporationTaxRules(db, { companyId })).toMatchObject({ created: CORPORATION_TAX_CURATED_RULES.length, skippedNoProvision: [] });
    expect(deriveCorporationTaxRules(db, { companyId })).toMatchObject({ created: 0, unchanged: CORPORATION_TAX_CURATED_RULES.length });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.topic, 'corporation_tax')).all();
    expect(rows.every((r) => r.reviewStatus === 'ai_extracted' && r.conditions.length === 0)).toBe(true);
  });
});

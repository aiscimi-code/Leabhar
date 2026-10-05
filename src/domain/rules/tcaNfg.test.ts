import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { parseNfgSections, extractNfgSection, parseNfgContents, compareNfgContents } from './tcaNfgParser';
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

  it('reads Part 11 in order, taking its first notes with no Summary marker (issue #313)', () => {
    expect(parseNfgSections(read('part11')).map((s) => s.sectionNumber))
      .toEqual(['373', '374', '375', '376', '377', '378', '379', '380']);
    expect(extractNfgSection(read('part11'), '374').heading).toBe('Capital allowances for cars costing over certain amount');
  });

  it('finds a note for every section in each part\'s contents list, and no others (issue #287)', () => {
    const parts = readdirSync(dirname(nfgPath('part01'))).filter((f) => /^part.*\.md$/.test(f));
    expect(parts.length).toBeGreaterThanOrEqual(15);
    for (const file of parts) {
      const md = read(file.replace(/\.md$/, ''));
      const listed = parseNfgContents(md);
      expect(listed.length, file).toBeGreaterThan(0);
      expect(parseNfgSections(md).map((s) => s.sectionNumber), file).toEqual(listed);
      expect(compareNfgContents(md), file).toEqual({ missing: [], unlisted: [] });
    }
  });

  it('keeps the note of a repealed section apart from the one before it', () => {
    const part = read('part18d');
    expect(extractNfgSection(part, '531AP').provisionText).not.toContain('531AO');
    expect(extractNfgSection(part, '531AO').provisionText).not.toContain('531AP Record-keeping');
    expect(extractNfgSection(read('part02'), '22A').heading).toContain('Reduction of corporation tax liability');
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

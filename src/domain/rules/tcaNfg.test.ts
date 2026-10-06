import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { parseNfgSections, extractNfgSection, parseNfgContents, compareNfgContents } from './tcaNfgParser';
import { ingestTcaNfgFromCatalogue, deriveCorporationTaxRules, nfgCatalogueEntry, NFG_PARTS } from './tcaNfgIngestion';
import { readCatalogueEntry } from './catalogue';
import {
  CORPORATION_TAX_CURATED_RULES, NFG_SECTIONS, corporationTaxRateBasisPoints,
  CT_RATE_TRADING_RULE_KEY, CT_RATE_HIGHER_RULE_KEY, nfgCitation,
} from './corporationTaxCuration';

/** A part as `pdftotext -layout` converts its PDF: the parser's mechanics. */
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}.md`, import.meta.url), 'utf8');
const PART11 = fixture('tca-nfg-part11');
const PART18D = fixture('tca-nfg-part18d');
/** Part 2's conversion up to the end of s.22A's note. */
const PART02_TO_S22A = fixture('tca-nfg-part02-to-s22A');

/** A section's note as the catalogue extraction cut it from its part. */
const note = (part: string, n: string) => {
  const p = readCatalogueEntry(nfgCatalogueEntry(part)).provisions.find((x) => x.sectionNumber === n);
  if (!p) throw new Error(`${part} s.${n} is not in the catalogue entry`);
  return { heading: p.heading, provisionText: p.excerpt };
};

describe('Notes for Guidance parser', () => {
  it('reads Part 11 in order, skipping the contents list and taking its first notes with no Summary marker (issue #313)', () => {
    expect(parseNfgSections(PART11).map((s) => s.sectionNumber))
      .toEqual(['373', '374', '375', '376', '377', '378', '379', '380']);
    expect(extractNfgSection(PART11, '374').heading).toBe('Capital allowances for cars costing over certain amount');
  });

  it('finds a note for every section in a part\'s contents list, and no others (issue #287)', () => {
    // The catalogue extraction checks every part the same way before it writes the entry.
    for (const [name, md] of [['part11', PART11], ['part18d', PART18D]] as const) {
      const listed = parseNfgContents(md);
      expect(listed.length, name).toBeGreaterThan(0);
      expect(parseNfgSections(md).map((s) => s.sectionNumber), name).toEqual(listed);
      expect(compareNfgContents(md), name).toEqual({ missing: [], unlisted: [] });
    }
  });

  it('keeps the note of a repealed section apart from the one before it', () => {
    expect(extractNfgSection(PART18D, '531AP').provisionText).not.toContain('531AO');
    expect(extractNfgSection(PART18D, '531AO').provisionText).not.toContain('531AP Record-keeping');
    expect(extractNfgSection(PART02_TO_S22A, '22A').heading).toContain('Reduction of corporation tax liability');
  });

  it('each slice is the text between its offsets', () => {
    for (const s of parseNfgSections(PART11)) expect(PART11.slice(s.sourceStart, s.sourceEnd)).toBe(s.provisionText);
  });

  it('joins a heading that wraps, and keeps a note that has no Summary', () => {
    expect(note('part41a', '959AR').heading)
      .toBe('Date for payment of corporation tax: Companies other than with relevant accounting periods');
    expect(note('part09', '292').heading).toBe('Meaning of “amount still unallowed”');
    expect(note('part09', '291A').provisionText).not.toContain('amount still unallowed” in respect');
  });

  it('every part\'s catalogue entry holds each in-scope section, and no others', () => {
    expect(NFG_PARTS).toEqual(Object.keys(NFG_SECTIONS));
    for (const part of NFG_PARTS) {
      const entry = readCatalogueEntry(nfgCatalogueEntry(part));
      expect(entry.source.citation, part).toBe(nfgCitation(part));
      expect(entry.provisions.map((p) => p.sectionNumber), part).toEqual(NFG_SECTIONS[part]);
    }
  });
});

describe('corporation tax curation', () => {
  it('quotes each rule verbatim from its section note', () => {
    for (const rule of CORPORATION_TAX_CURATED_RULES) {
      expect(NFG_SECTIONS[rule.part], rule.ruleKey).toContain(rule.sectionNumber);
      expect(note(rule.part, rule.sectionNumber).provisionText, rule.ruleKey).toContain(rule.statementExcerpt);
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
    ingestTcaNfgFromCatalogue(db, { companyId });
    expect(deriveCorporationTaxRules(db, { companyId })).toMatchObject({ created: CORPORATION_TAX_CURATED_RULES.length, skippedNoProvision: [] });
    expect(deriveCorporationTaxRules(db, { companyId })).toMatchObject({ created: 0, unchanged: CORPORATION_TAX_CURATED_RULES.length });
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.topic, 'corporation_tax')).all();
    expect(rows.every((r) => r.reviewStatus === 'ai_extracted' && r.conditions.length === 0)).toBe(true);
  });
});

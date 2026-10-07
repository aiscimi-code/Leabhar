import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatca2010FromCatalogue, deriveVatcaRules } from '../rules/vatcaIngestion';
import { ingestVatcaScheduleFromCatalogue } from '../rules/vatcaScheduleIngestion';
import {
  searchProvisions, searchStatutoryRules, searchKnowledgeSources,
  semanticSearchProvisions, statuteSourceIndex, sourceProvisions, stem, tokenize,
} from './knowledgeBase';
import { irishActProvisions, irishKnowledgeSources, irishRuleVersionsRetained } from '@/db/schema';
import { attachRulesStoreFromBook } from '../rules/rulesStore';
import { ids } from '@/lib/ids';
import { search } from './search';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let otherCompanyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'KB Search Ltd', seedYears: [2025] }));
  ({ companyId: otherCompanyId } = createCompany(db, { legalName: 'Other Ltd', seedYears: [2025] }));
  ingestVatca2010FromCatalogue(db, { companyId });
  deriveVatcaRules(db, { companyId });
  ingestVatcaScheduleFromCatalogue(db, { companyId, scheduleNumber: '2' });
});

describe('tokenize/stem', () => {
  it('removes stopwords and stems plural endings the same way on both sides', () => {
    expect(tokenize('The supplies of services are rates')).toEqual(['supply', 'service', 'rate']);
  });

  it('stems the plural forms the statute prose varies on', () => {
    expect(stem('supplies')).toBe('supply');
    expect(stem('rates')).toBe('rate');
    expect(stem('taxes')).toBe('tax');
    expect(stem('classes')).toBe('class');
    expect(stem('services')).toBe('service');
    // Not everything ending in s is a plural.
    expect(stem('business')).toBe('business');
    expect(stem('status')).toBe('status');
  });
});

describe('searchProvisions', () => {
  it('finds a provision by a phrase from its own text', () => {
    const hits = searchProvisions(db, { companyId, query: 'reverse charge' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.citation).toMatch(/Act 31/);
    expect(hits[0]!.sourceUrl).toMatch(/^https:/);
    expect(hits.every((h) => h.provisionId && h.heading)).toBe(true);
  });

  it('reports which field matched', () => {
    const byHeading = searchProvisions(db, { companyId, query: 'rate of tax' });
    expect(byHeading.some((h) => h.matchedOn === 'Provision heading' || h.matchedOn === 'Provision text')).toBe(true);
  });

  it('finds the store\'s law for every company, and ignores a too-short query', () => {
    // The store is the install's (ADR-0021); what stays with one book is tested below.
    expect(searchProvisions(db, { companyId: otherCompanyId, query: 'reverse charge' }))
      .toEqual(searchProvisions(db, { companyId, query: 'reverse charge' }));
    expect(searchProvisions(db, { companyId, query: 'v' })).toEqual([]);
  });
});

describe('semanticSearchProvisions', () => {
  it('ranks provisions about the question above unrelated ones, deterministically', () => {
    const once = semanticSearchProvisions(db, { companyId, query: 'what VAT rate applies to hotel accommodation' });
    const twice = semanticSearchProvisions(db, { companyId, query: 'what VAT rate applies to hotel accommodation' });
    expect(once).toEqual(twice);
    expect(once.length).toBeGreaterThan(0);

    // Scores descend, stay within (0, 1], and each hit names the query terms
    // that connected it — never a treatment of any kind.
    for (let i = 1; i < once.length; i++) {
      expect(once[i]!.score).toBeLessThanOrEqual(once[i - 1]!.score);
    }
    const queryTerms = new Set(tokenize('what VAT rate applies to hotel accommodation'));
    for (const hit of once) {
      expect(hit.matchedTerms.length).toBeGreaterThan(0);
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThanOrEqual(1);
      expect(hit.matchedTerms.every((t) => queryTerms.has(t))).toBe(true);
    }
    // The provisions that speak about accommodation in hotels rank near the
    // top, not somewhere below provisions that share no term with the question.
    const distinctive = once.slice(0, 5).filter((h) =>
      h.matchedTerms.includes('hotel') || h.matchedTerms.includes('accommodation'));
    expect(distinctive.length).toBeGreaterThan(0);
  });

  it('returns nothing for a query with no meaningful terms', () => {
    expect(semanticSearchProvisions(db, { companyId, query: 'the of and' })).toEqual([]);
  });
});

describe('semanticSearchProvisions ranking on a controlled corpus', () => {
  // Three short provisions of one synthetic source, so the ranking itself is
  // asserted rather than the shape of a real statute's wording. A dedicated
  // company, so nothing else is in the corpus being ranked.
  let rankingCompanyId: string;
  beforeEach(() => {
    ({ companyId: rankingCompanyId } = createCompany(db, { legalName: 'Ranking Ltd', seedYears: [2026] }));
    const sourceId = ids.knowledgeSource();
    db.insert(irishKnowledgeSources).values({
      id: sourceId, companyId: rankingCompanyId, sourceType: 'legislation',
      title: 'Ranking Test Act', citation: '2026 Act 1',
      sourceUrl: 'https://example.test/2026/act/1', sha256: '0'.repeat(64),
      ingestVersion: 'v1', retrievedAt: '2026-01-01T00:00:00Z',
      effectiveFrom: '2026-01-01',
    }).run();
    const insert = (sectionNumber: string, heading: string, provisionText: string) => {
      db.insert(irishActProvisions).values({
        id: ids.provision(), companyId: rankingCompanyId, sourceId, sectionNumber,
        slug: `s${sectionNumber}`, heading, provisionText,
      }).run();
    };
    insert('1', 'Hotel accommodation',
      'A supply of accommodation in a hotel or guesthouse is a supply of services connected with immovable goods.');
    insert('2', 'Livestock',
      'The rate of value-added tax on supplies of livestock is the livestock rate.');
    insert('3', 'Appeals',
      'A person aggrieved by an assessment may appeal to the Appeal Commissioners within thirty days.');
    // Search reads the store (ADR-0021): one built from this corpus alone.
    attachRulesStoreFromBook(db, { companyId: rankingCompanyId });
  });

  it('ranks the provision that shares the question\'s subject first', () => {
    const hits = semanticSearchProvisions(db, { companyId: rankingCompanyId, query: 'supplies of hotel accommodation' });
    expect(hits[0]!.heading).toBe('Hotel accommodation');
    expect(hits[0]!.matchedTerms).toContain('hotel');
    // The unrelated provisions rank below it, and the appeal provision —
    // sharing no term with the question — is not retrieved at all.
    expect(hits.some((h) => h.heading === 'Appeals')).toBe(false);
    const livestock = hits.find((h) => h.heading === 'Livestock');
    expect(livestock).toBeDefined();
    expect(hits.findIndex((h) => h.heading === 'Livestock'))
      .toBeGreaterThan(hits.findIndex((h) => h.heading === 'Hotel accommodation'));
  });

  it('does not retrieve a provision that shares no term with the question', () => {
    const hits = semanticSearchProvisions(db, { companyId: rankingCompanyId, query: 'appeal commissioners assessment' });
    expect(hits.map((h) => h.heading)).toContain('Appeals');
    expect(hits.some((h) => h.heading === 'Hotel accommodation')).toBe(false);
  });
});

describe('searchStatutoryRules and searchKnowledgeSources', () => {
  it('finds derived rules by name or key', () => {
    const hits = searchStatutoryRules(db, { companyId, query: 'reverse charge' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.ruleKey && h.ruleId && h.reviewStatus)).toBe(true);
    // Each hit links back to the provision that carries it.
    expect(hits.every((h) => h.provisionId)).toBe(true);
  });

  it('finds a source by its citation', () => {
    const hits = searchKnowledgeSources(db, { companyId, query: '2010 Act 31' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.matchedOn).toBe('Citation');
  });

  it('finds the store\'s rules and sources for every company', () => {
    expect(searchStatutoryRules(db, { companyId: otherCompanyId, query: 'reverse charge' }))
      .toEqual(searchStatutoryRules(db, { companyId, query: 'reverse charge' }));
    expect(searchKnowledgeSources(db, { companyId: otherCompanyId, query: '2010 Act 31' }))
      .toEqual(searchKnowledgeSources(db, { companyId, query: '2010 Act 31' }));
  });
});

describe('source index', () => {
  it('lists the ingested sources with their provision counts', () => {
    const sources = statuteSourceIndex(db, { companyId });
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((s) => s.provisionCount > 0)).toBe(true);

    const provisions = sourceProvisions(db, { companyId, sourceId: sources[0]!.sourceId });
    expect(provisions.length).toBe(sources[0]!.provisionCount);
  });
});

describe('global search integration (issue #445)', () => {
  it('returns provisions, statutory rules and sources alongside everything else', () => {
    const response = search(db, { companyId, query: 'reverse charge' });
    const types = new Set(response.results.map((r) => r.type));
    expect(types.has('statutory_provision')).toBe(true);
    expect(types.has('statutory_rule')).toBe(true);

    const provision = response.results.find((r) => r.type === 'statutory_provision')!;
    expect(provision.href).toMatch(/^\/statutes\/provision\//);
    expect(provision.matchedOn).toBeTruthy();

    const rule = response.results.find((r) => r.type === 'statutory_rule')!;
    expect(rule.href).toMatch(/^\/statutes\/provision\/.+rule=/);
  });

  it('finds a source document by citation from the same box', () => {
    const response = search(db, { companyId, query: '2010 Act 31' });
    const source = response.results.find((r) => r.type === 'knowledge_source');
    expect(source).toBeDefined();
    expect(source!.href).toMatch(/^\/statutes\?source=/);
  });

  it('never leaks one book\'s own rule versions into another company\'s search', () => {
    // A version the move onto the store kept (ADR-0021) is the book's alone.
    db.insert(irishRuleVersionsRetained).values({
      id: ids.ruleVersionRetained(), companyId, ruleKey: 'vat.zanzibar_levy', ruleVersion: 1, bookRuleId: 'itr_old', reason: 'no_store_version',
      sourceCitation: 'Zanzibar Levy Act 1999', sourceSha256: 'f'.repeat(64), sectionNumber: '1',
      ruleType: 'rate', topic: 'vat', taxHeads: ['vat'], name: 'Zanzibar levy, as the book held it',
      statement: 'the zanzibar levy', numericValue: null, unit: null, conditions: [], exceptions: [],
      reviewStatus: 'ai_extracted', effectiveFrom: '2001-01-01', effectiveTo: null,
      sourceTitle: 'Zanzibar Levy Act 1999', sourceType: 'legislation', sourceUrl: 'https://example.ie/zanzibar',
      provisionHeading: 'Zanzibar levy', provisionText: 'A zanzibar levy is charged.', provisionCategory: 'vat',
    }).run();
    const statutory = (id: string) => search(db, { companyId: id, query: 'zanzibar' }).results
      .filter((r) => r.type.startsWith('statutory') || r.type === 'knowledge_source');
    expect(statutory(companyId).length).toBeGreaterThan(0);
    expect(statutory(otherCompanyId)).toEqual([]);
  });
});

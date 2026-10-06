/**
 * Ingestion of Council Implementing Regulation (EU) No 282/2011, Articles
 * 10-13b — the first `eu_source` in the knowledge base (issue #441, epic #310
 * "Sources: Other authoritative sources"). The document has been on disk
 * since issue #138 and the transaction lookup has always depended on its
 * tests — `supplierEstablishedOutsideState` exists because a country code is
 * never establishment — but no provision or rule ever cited it; the
 * traceability audit lists it as "REQUIRED, NOT INGESTED".
 *
 * The curated rules carry no transaction conditions: arts. 10-13b are a
 * multi-factor legal test a person applies, and the lookup already refuses to
 * infer establishment from a country code. These rules are the citation
 * behind that refusal — EU law ranking with legislation, and defining the
 * terms VATCA ss.12/34 rely on without defining themselves. The knowledge
 * base loads the articles from their rules catalogue entry, the EUR-Lex page
 * kept beside it (`ingestEu282FromCatalogue`, #556).
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { normaliseSpace } from '../vat/boxDefinitions';
import { upsertReviewItem } from '../extraction/service';
import type { IrishRuleType } from '@/db/schema';
import { taxHeadsFor } from './taxHeads';
import { ingestCatalogueFile, type CatalogueIngestResult } from './catalogue';

/** The articles' catalogue entry: the consolidated text on EUR-Lex, kept beside it. */
export const EU_282_2011_CATALOGUE_ENTRY = 'eu-282-2011/consolidated-2025-04-14.json';

export const EU_282_2011 = {
  citation: 'Council Implementing Regulation (EU) No 282/2011 arts. 10-13b',
  title: 'Implementing Regulation (EU) No 282/2011 — Articles 10-13b (establishment tests)',
  sourceUrl: 'https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02011R0282-20250414',
  // The consolidated regulation's own application provision: "It shall apply from 1 July 2011."
  effectiveFrom: '2011-07-01',
  effectiveClue: 'It shall apply from 1 July 2011.',
  citedActs: ['Directive 2006/112/EC'],
  relevanceReason: 'Curated: definition rules cite these articles (eu282Ingestion.ts).',
  note: 'Consolidated EUR-Lex text (CELEX 02011R0282, 14.04.2025) of the establishment tests. The '
    + 'Regulation\u2019s own application provision says it applies from 1 July 2011. EU implementing law ranks '
    + 'with legislation in the source hierarchy; these articles define "established" and "fixed establishment" '
    + 'for the VATCA ss.12/34 place-of-supply and reverse-charge rules, which do not define them themselves.',
};

/** The articles curated into rules, in the regulation's order. */
export const EU_282_2011_ARTICLES = ['10', '11', '12', '13', '13a', '13b'] as const;

/** Load the articles from their catalogue entry. */
export function ingestEu282FromCatalogue(
  db: AppDatabase,
  params: { companyId?: string | null; ingestVersion?: string; root?: string },
): CatalogueIngestResult {
  return ingestCatalogueFile(db, { ...params, entry: EU_282_2011_CATALOGUE_ENTRY });
}

export interface EuRule {
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  name: string;
  statementExcerpt: string;
  interpretationNote: string;
}

export const EU_282_2011_RULES: EuRule[] = [
  {
    sectionNumber: '10', ruleKey: 'eu.establishment_place_of_business', ruleType: 'definition',
    name: 'EU law: where the business of a taxable person is established',
    statementExcerpt: 'the place where the business of a taxable person is established shall be the place where the '
      + 'functions of the business\'s central administration are carried out',
    interpretationNote: 'Art. 10(1). Where essential decisions are taken, the registered office and where management '
      + 'meets are taken into account; where those do not decide it, the place essential decisions are taken '
      + 'takes precedence (art. 10(2)).',
  },
  {
    sectionNumber: '10', ruleKey: 'eu.establishment_postal_address_not_sufficient', ruleType: 'definition',
    name: 'EU law: a postal address alone is not an establishment',
    statementExcerpt: 'The mere presence of a postal address may not be taken to be the place of establishment of a '
      + 'business of a taxable person.',
    interpretationNote: 'Art. 10(3). Why a supplier\u2019s country code is never taken as establishment: the '
      + 'transaction lookup requires a person\u2019s confirmed determination instead.',
  },
  {
    sectionNumber: '11', ruleKey: 'eu.fixed_establishment_definition', ruleType: 'definition',
    name: 'EU law: what a fixed establishment is',
    statementExcerpt: "a 'fixed establishment' shall be any establishment, other than the place of "
      + 'establishment of a business referred to in Article 10 of this Regulation, characterised by a sufficient degree '
      + 'of permanence and a suitable structure in terms of human and technical resources to enable it to receive and '
      + 'use the services supplied to it for its own needs',
    interpretationNote: 'Art. 11(1), for services received (Directive art. 44); art. 11(2) states the same test for '
      + 'services supplied. A VAT identification number alone is not sufficient (art. 11(3)).',
  },
  {
    sectionNumber: '11', ruleKey: 'eu.fixed_establishment_vat_number_not_sufficient', ruleType: 'definition',
    name: 'EU law: a VAT number alone is not a fixed establishment',
    statementExcerpt: 'The fact of having a VAT identification number shall not in itself be sufficient to consider '
      + 'that a taxable person has a fixed establishment.',
    interpretationNote: 'Art. 11(3). A customer\u2019s VAT number says they are registered somewhere, not that they '
      + 'are fixedly established in the State.',
  },
  {
    sectionNumber: '12', ruleKey: 'eu.permanent_address_definition', ruleType: 'definition',
    name: 'EU law: what a natural person\u2019s permanent address is',
    statementExcerpt: "the 'permanent address' of a natural person, whether or not a taxable person, shall be "
      + 'the address entered in the population or similar register, or the address indicated by that person to the '
      + 'relevant tax authorities, unless there is evidence that this address does not reflect reality',
    interpretationNote: 'Art. 12. The test the place-of-supply rules for non-taxable persons turn on.',
  },
  {
    sectionNumber: '13', ruleKey: 'eu.usual_residence_definition', ruleType: 'definition',
    name: 'EU law: where a natural person usually resides',
    statementExcerpt: 'the place where that natural person usually lives as a result of personal and occupational ties',
    interpretationNote: 'Art. 13. Where occupational and personal ties are in different countries, the personal ties '
      + 'decide (art. 13, second paragraph).',
  },
  {
    sectionNumber: '13b', ruleKey: 'eu.immovable_property_definition', ruleType: 'definition',
    name: 'EU law: what counts as immovable property',
    statementExcerpt: "the following shall be regarded as 'immovable property': (a) any specific part of the earth, "
      + 'on or below its surface, over which title and possession can be created',
    interpretationNote: 'Art. 13b. Land, buildings fixed to or in the ground, integral installed items and machinery '
      + 'that cannot be moved without destroying or altering the building (arts. 13b(a)-(d)). VATCA ss.33/34 '
      + 'turn on this without defining it.',
  },
];

export interface EuIngestResult { sourceId: string; provisionCount: number; ingested: boolean }

export interface ParsedArticle {
  sectionNumber: string;
  provisionText: string;
  sourceStart: number;
  sourceEnd: number;
}

/**
 * The articles, one provision each, with offsets into the text: a Markdown
 * extract (the CLI's --file), or the EUR-Lex page as eurlex_html_to_text.py
 * converts it. Each starts at its "Article N" line.
 */
export function parseEuArticles(markdown: string): ParsedArticle[] {
  const frontMatterEnd = markdown.indexOf('---\n', 4) + 4;
  const starts = EU_282_2011_ARTICLES.flatMap((article) => {
    const m = new RegExp(`^Article ${article.replace(/([a-z])$/, '$1')}$`, 'm').exec(markdown);
    return m ? [{ article, index: m.index + m[0].length }] : [];
  }).sort((a, b) => a.index - b.index);
  return starts.map((start, i) => {
    const next = starts[i + 1]?.index ?? markdown.length;
    return {
      sectionNumber: start.article,
      provisionText: normaliseSpace(markdown.slice(start.index, next)),
      sourceStart: Math.max(start.index, frontMatterEnd),
      sourceEnd: next,
    };
  });
}

/** Ingest a Markdown extract (the CLI's --file): one eu_source row, one provision per article. */
export function ingestEu282Articles(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath: string },
): EuIngestResult {
  const digest = sha256Hex(params.markdown);
  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(eq(irishKnowledgeSources.citation, EU_282_2011.citation), eq(irishKnowledgeSources.sha256, digest))).get();
  if (existing) {
    const count = db.select({ id: irishActProvisions.id }).from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, existing.id)).all().length;
    return { sourceId: existing.id, provisionCount: count, ingested: false };
  }
  const articles = parseEuArticles(params.markdown);
  if (articles.length !== EU_282_2011_ARTICLES.length) {
    throw new Error(`Expected articles ${EU_282_2011_ARTICLES.join(', ')}; found ${articles.map((a) => a.sectionNumber).join(', ') || 'none'}.`);
  }
  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId,
      companyId: params.companyId ?? null,
      sourceType: 'eu_source',
      title: EU_282_2011.title,
      citation: EU_282_2011.citation,
      jurisdiction: 'EU',
      sourceUrl: EU_282_2011.sourceUrl,
      localPath: params.localPath,
      sha256: digest,
      ingestVersion: params.ingestVersion,
      publicationDate: null,
      retrievedAt: nowIso(),
      effectiveFrom: EU_282_2011.effectiveFrom,
      sourceNote: EU_282_2011.note,
      sourceDate: nowIso(),
    }).run();
    for (const article of articles) {
      tx.insert(irishActProvisions).values({
        id: ids.provision(),
        companyId: params.companyId ?? null,
        sourceId,
        sectionNumber: article.sectionNumber,
        slug: `eu-282-2011-art-${article.sectionNumber.toLowerCase()}`,
        heading: `Article ${article.sectionNumber}`,
        principalAct: null,
        provisionText: article.provisionText,
        sourceStart: article.sourceStart,
        sourceEnd: article.sourceEnd,
        locator: `art. ${article.sectionNumber}`,
        category: 'vat',
        amendsSection: null,
        effectiveClue: EU_282_2011.effectiveClue,
        citedActs: EU_282_2011.citedActs,
        relevant: true,
        relevanceReason: EU_282_2011.relevanceReason,
        source: 'import',
        provenanceStatus: 'imported',
      }).run();
    }
    return { sourceId, provisionCount: articles.length, ingested: true };
  });
}

export interface EuDeriveResult { created: number; superseded: number; unchanged: number; skippedNoProvision: string[] }

/** Derive the curated definition rules from the ingested articles. */
export function deriveEu282Rules(db: AppDatabase, params: { companyId: string }): EuDeriveResult {
  const result: EuDeriveResult = { created: 0, superseded: 0, unchanged: 0, skippedNoProvision: [] };
  const sourceId = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, EU_282_2011.citation)).get()?.id;
  for (const rule of EU_282_2011_RULES) {
    const prov = sourceId
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, rule.sectionNumber))).get()
      : undefined;
    if (!prov || !prov.provisionText?.includes(rule.statementExcerpt)) {
      result.skippedNoProvision.push(rule.ruleKey);
      continue;
    }
    const existing = db.select().from(irishTaxRules)
      .where(and(
        eq(irishTaxRules.companyId, params.companyId),
        eq(irishTaxRules.ruleKey, rule.ruleKey),
        eq(irishTaxRules.active, true),
      )).get();
    if (existing && existing.statement === rule.statementExcerpt && existing.provisionId === prov.id) {
      result.unchanged++;
      continue;
    }
    if (existing) {
      db.update(irishTaxRules)
        .set({ effectiveTo: EU_282_2011.effectiveFrom, active: false })
        .where(eq(irishTaxRules.id, existing.id)).run();
      result.superseded++;
    }
    const newRuleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: newRuleId,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: rule.ruleKey,
      ruleType: rule.ruleType,
      topic: 'place_of_supply',
      taxHeads: taxHeadsFor(rule.ruleKey, 'place_of_supply'),
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: null,
      humanExplanation: rule.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: null,
      conditions: [],
      exceptions: [],
      crossReferences: [
        'Value-Added Tax Consolidation Act 2010 s.12',
        'Value-Added Tax Consolidation Act 2010 s.34',
      ],
      accountingEffect: null,
      taxEffect: null,
      vatEffect: 'Defines "established" and "fixed establishment" for VATCA ss.12/34: a person\u2019s confirmed '
        + 'determination (supplierEstablishedOutsideState) applies this test; a country code alone never does.',
      reportingEffect: null,
      requiresGuidance: false,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: existing ? existing.ruleVersion + 1 : 1,
      supersedesRuleId: existing?.id ?? null,
      priority: 100,
      effectiveFrom: EU_282_2011.effectiveFrom,
      source: 'derived',
      confidence: 75,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${EU_282_2011.citation} art. ${rule.sectionNumber}; not yet human-reviewed. `
        + rule.interpretationNote,
      sourceDate: nowIso(),
    }).run();
    result.created++;
    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish rule extracted: ${rule.name}`,
      detail: `${EU_282_2011.citation} art. ${rule.sectionNumber}. ${rule.interpretationNote} Review against the `
        + 'source text and approve, or reject, before it is treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey },
    });
  }
  return result;
}

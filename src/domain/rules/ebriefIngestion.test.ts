import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestEbrief168_25, ingestEbriefFromCatalogue, deriveEbriefRules, ebriefNoticeText,
  EBRIEF_168_25_RULE, EBRIEF_168_25, EBRIEF_168_25_CATALOGUE_ENTRY,
} from './ebriefIngestion';
import { verifyStatuteFile } from './knowledgeBase';
import { resolveRuleDependencies } from './dependencies';
import { sourceAuthorityRank } from './sourceHierarchy';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
/** The Markdown transcript the knowledge base read before the port (the CLI's --file). */
const FIXTURE = 'src/domain/rules/__fixtures__/ebrief-168-25.md';
const markdown = readFileSync(FIXTURE, 'utf8');

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'eBrief Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
});

describe('ebriefNoticeText', () => {
  it('keeps the notice down to its Published line, and drops the page\'s feedback links', () => {
    const page = ['Revenue eBrief No. 168/25', 'Tax and Duty Manual', 'Part 38-01-03b',
      '- Guidelines for VAT Registration - has been updated as follows:', 'Section 10 - EU VAT SME scheme',
      'Published: 03 September 2025', 'Please rate how useful this page was to you', 'Print this page'].join('\n');
    expect(ebriefNoticeText(page)).toBe('Revenue eBrief No. 168/25 Tax and Duty Manual Part 38-01-03b - Guidelines for VAT '
      + 'Registration - has been updated as follows: Section 10 - EU VAT SME scheme Published: 03 September 2025');
  });

  it('refuses a page without the quoted passage or the Published line', () => {
    expect(() => ebriefNoticeText('Revenue eBrief\nPublished: 03 September 2025')).toThrow(/passage/);
    expect(() => ebriefNoticeText('Revenue eBrief')).toThrow(/Published/);
  });
});

describe('the first Revenue notice source (issue #440)', () => {
  it('loads the eBrief from its catalogue entry as a revenue_ebrief source, idempotently, with its own locator', () => {
    const first = ingestEbriefFromCatalogue(db, { companyId });
    expect(first).toMatchObject({ provisionCount: 1, ingested: true });
    expect(ingestEbriefFromCatalogue(db, { companyId }).ingested).toBe(false);

    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.sourceType).toBe('revenue_ebrief');
    expect(source.localPath).toBe(`catalogue/${EBRIEF_168_25_CATALOGUE_ENTRY}`);
    expect(source.effectiveFrom).toBe('2025-09-03'); // the notice's own published date, not its retrieval

    const provision = db.select().from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, source.id)).get()!;
    expect(provision).toMatchObject({ locator: 'notice 168/25', effectiveClue: 'Published: 03 September 2025', citedActs: ['S.I. 69/2025'] });
    expect(provision.provisionText).toContain(EBRIEF_168_25_RULE.statementExcerpt);
  });

  it('ingests a Markdown transcript (--file) as a revenue_ebrief source, idempotently', () => {
    const first = ingestEbrief168_25(db, { companyId, markdown, ingestVersion: 'v1', localPath: FIXTURE });
    expect(first).toMatchObject({ provisionCount: 1, ingested: true });
    const second = ingestEbrief168_25(db, { companyId, markdown, ingestVersion: 'v1', localPath: FIXTURE });
    expect(second.ingested).toBe(false);

    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.id, first.sourceId)).get()!;
    expect(source.sourceType).toBe('revenue_ebrief');
    expect(source.sourceUrl).toBe(EBRIEF_168_25.sourceUrl);
    expect(source.effectiveFrom).toBe('2025-09-03'); // the notice's own published date, not its retrieval

    const provision = db.select().from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, source.id)).get()!;
    expect(provision.locator).toBe('notice 168/25');
    expect(provision.provisionText).toContain(EBRIEF_168_25_RULE.statementExcerpt);

    // The passage re-checks against the transcript (AGENTS.md #5).
    const check = verifyStatuteFile(source.localPath, source.sha256, provision.sourceStart, provision.sourceEnd);
    expect(check.exists && check.sha256Matches).toBe(true);
    expect(check.slice).toContain(EBRIEF_168_25_RULE.statementExcerpt);
    expect(check.slice!.endsWith(EBRIEF_168_25.effectiveClue)).toBe(true);
  });

  it('ranks as guidance, below legislation', () => {
    ingestEbriefFromCatalogue(db, { companyId });
    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, EBRIEF_168_25.citation)).get()!;
    expect(sourceAuthorityRank(source.sourceType)).toBeGreaterThan(sourceAuthorityRank('legislation'));
  });

  it('derives the notice rule, unreviewed, quoting the notice verbatim', () => {
    ingestEbriefFromCatalogue(db, { companyId });
    const result = deriveEbriefRules(db, { companyId });
    expect(result).toMatchObject({ created: 1, skippedNoProvision: [] });
    const rule = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, EBRIEF_168_25_RULE.ruleKey))).get()!;
    expect(rule.statement).toBe(EBRIEF_168_25_RULE.statementExcerpt);
    expect(rule.reviewStatus).toBe('ai_extracted');
    expect(rule.effectiveFrom).toBe('2025-09-03');
    // Idempotent: nothing changes on a second derive.
    expect(deriveEbriefRules(db, { companyId })).toMatchObject({ created: 0, superseded: 0, unchanged: 1 });
  });

  it('its cross-references resolve to the SME scheme provisions this book already holds', () => {
    ingestEbriefFromCatalogue(db, { companyId });
    deriveEbriefRules(db, { companyId });
    const rule = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, EBRIEF_168_25_RULE.ruleKey), eq(irishTaxRules.active, true))).get()!;
    const deps = resolveRuleDependencies(db, { companyId, ruleId: `${rule.ruleKey}@${rule.ruleVersion}` });
    const reg7 = deps.find((d) => d.reference === 'S.I. 69/2025 reg.7')!;
    expect(reg7.resolved).toBe(true);
    const reg9 = deps.find((d) => d.reference === 'S.I. 69/2025 reg.9')!;
    expect(reg9.resolved).toBe(true);
    // The TDM reference cannot resolve to a section: this book ingests one
    // passage of that manual, not the sections the notice says were updated.
    const tdm = deps.find((d) => d.reference === 'Revenue TDM Part 38-01-03b')!;
    expect(tdm.resolved).toBe(false);
    expect(tdm.reason).toBeTruthy();
  });
});

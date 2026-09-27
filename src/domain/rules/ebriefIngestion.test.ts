import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestEbrief168_25, deriveEbriefRules, EBRIEF_168_25_MD_PATH, EBRIEF_168_25_RULE, EBRIEF_168_25 } from './ebriefIngestion';
import { loadStatutoryKnowledgeBase, verifyStatuteFile } from './knowledgeBase';
import { resolveRuleDependencies } from './dependencies';
import { sourceAuthorityRank } from './sourceHierarchy';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let markdown: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'eBrief Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  markdown = readFileSync(EBRIEF_168_25_MD_PATH, 'utf8');
});

describe('the first Revenue notice source (issue #440)', () => {
  it('ingests the eBrief as a revenue_ebrief source, idempotently, with its own locator', () => {
    const first = ingestEbrief168_25(db, { companyId, markdown, ingestVersion: 'v1' });
    expect(first).toMatchObject({ provisionCount: 1, ingested: true });
    const second = ingestEbrief168_25(db, { companyId, markdown, ingestVersion: 'v1' });
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

    // The passage re-checks against the committed transcript (AGENTS.md #5).
    const check = verifyStatuteFile(source.localPath, source.sha256, provision.sourceStart, provision.sourceEnd);
    expect(check.exists && check.sha256Matches).toBe(true);
  });

  it('ranks as guidance, below legislation', () => {
    ingestEbrief168_25(db, { companyId, markdown, ingestVersion: 'v1' });
    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, EBRIEF_168_25.citation)).get()!;
    expect(sourceAuthorityRank(source.sourceType)).toBeGreaterThan(sourceAuthorityRank('legislation'));
  });

  it('derives the notice rule, unreviewed, quoting the notice verbatim', () => {
    ingestEbrief168_25(db, { companyId, markdown, ingestVersion: 'v1' });
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
    ingestEbrief168_25(db, { companyId, markdown, ingestVersion: 'v1' });
    loadStatutoryKnowledgeBase(db, { companyId });
    deriveEbriefRules(db, { companyId });
    const rule = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, EBRIEF_168_25_RULE.ruleKey), eq(irishTaxRules.active, true))).get()!;
    const deps = resolveRuleDependencies(db, { ruleId: rule.id });
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

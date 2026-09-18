import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestFinanceAct2024, deriveTaxRules, FINANCE_ACT_2024_MD_PATH } from './irishRules';
import { generateAuditReport } from './audit';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Audit Ltd', seedYears: [2025] }));
  const markdown = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
  ingestFinanceAct2024(db, { companyId, markdown, ingestVersion: 'v1' });
  deriveTaxRules(db, { companyId });
});

describe('generateAuditReport', () => {
  it('counts sources, provisions and rules, and never claims completeness', () => {
    const report = generateAuditReport(db, { companyId });
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]!.citation).toBe('2024 Act 43');
    expect(report.provisionCount).toBe(118);
    expect(report.relevantProvisionCount).toBeGreaterThan(0);
    expect(report.relevantProvisionCount).toBeLessThan(report.provisionCount);
    expect(report.ruleCount).toBe(4);
    // Every rule starts unreviewed.
    expect(report.rulesRequiringHumanReview).toBe(report.ruleCount);
    expect(report.rulesByReviewStatus['ai_extracted']).toBe(4);
  });

  it('flags every curated section that has not yet produced a rule', () => {
    // Ingest only, no extraction — every curated section is outstanding.
    const { db: freshDb } = createTestDatabase();
    const { companyId: freshCompanyId } = createCompany(freshDb, { legalName: 'Fresh Ltd', seedYears: [2025] });
    const markdown = readFileSync(FINANCE_ACT_2024_MD_PATH, 'utf8');
    ingestFinanceAct2024(freshDb, { companyId: freshCompanyId, markdown, ingestVersion: 'v1' });

    const report = generateAuditReport(freshDb, { companyId: freshCompanyId });
    expect(report.ruleCount).toBe(0);
    expect(report.provisionsWithoutExtractedRule.length).toBe(4);
    expect(report.provisionsWithoutExtractedRule.map((p) => p.ruleKey)).toContain('usc.first_band_threshold');
  });

  it('finds no duplicate rule keys among active rules', () => {
    const report = generateAuditReport(db, { companyId });
    expect(report.duplicateRuleKeys).toEqual([]);
  });

  it('reports cross-references this KB cannot resolve (sections outside the ingested Act)', () => {
    const report = generateAuditReport(db, { companyId });
    // Finance Act 2024 amends the Taxes Consolidation Act 1997, which is not
    // itself ingested — almost every amendsSection reference is unresolved.
    expect(report.unresolvedCrossReferences.length).toBeGreaterThan(0);
  });
});

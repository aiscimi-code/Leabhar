import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  ingestVat3ReturnGuidance, ingestRtdTdm, deriveVat3RtdRules,
  VAT3_RETURN_GUIDANCE_MD_PATH, RTD_TDM_MD_PATH,
} from './vat3RtdIngestion';
import { VAT3_BOX_RULES, RTD_MANUAL_RULES } from './vat3RtdCuration';
import { parseVat3Boxes, parseRtdManualSections } from './vat3RtdParser';
import { resolveRuleDependencies } from './dependencies';
import { verifyStatuteFile } from './knowledgeBase';
import { irishActProvisions, irishKnowledgeSources, irishTaxRules, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let vat3Markdown: string;
let rtdMarkdown: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'VAT3 RTD Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  vat3Markdown = readFileSync(VAT3_RETURN_GUIDANCE_MD_PATH, 'utf8');
  rtdMarkdown = readFileSync(RTD_TDM_MD_PATH, 'utf8');
});

describe('the parsers', () => {
  it('finds every VAT3 box the reporting engine knows, in the page order, with offsets', () => {
    const boxes = parseVat3Boxes(vat3Markdown);
    expect(boxes.map((b) => b.sectionNumber)).toEqual(['T1', 'T2', 'T3', 'T4', 'E1', 'E2', 'ES1', 'ES2', 'PA1']);
    for (const box of boxes) {
      const slice = vat3Markdown.slice(box.sourceStart, box.sourceEnd);
      expect(slice.replace(/\s+/g, ' ').trim(), box.sectionNumber).toContain(box.provisionText.slice(0, 40));
    }
  });

  it('finds the curated RTD manual sections', () => {
    const sections = parseRtdManualSections(rtdMarkdown);
    expect(sections.map((s) => s.sectionNumber)).toEqual(['1', '2.2', '2.3', '2.4', '2.5', '2.6']);
    expect(sections[0]!.provisionText).toContain('This is an annual return which all VAT registered persons');
  });
});

describe('ingestion', () => {
  it('ingests both guidance documents as revenue_guidance sources, idempotently, with locators', () => {
    const first = ingestVat3ReturnGuidance(db, { companyId, markdown: vat3Markdown, ingestVersion: 'v1' });
    expect(first).toMatchObject({ provisionCount: 9, ingested: true });
    const second = ingestVat3ReturnGuidance(db, { companyId, markdown: vat3Markdown, ingestVersion: 'v1' });
    expect(second.ingested).toBe(false);

    const rtdFirst = ingestRtdTdm(db, { companyId, markdown: rtdMarkdown, ingestVersion: 'v1' });
    expect(rtdFirst).toMatchObject({ provisionCount: 6, ingested: true });

    const sources = db.select().from(irishKnowledgeSources).all();
    expect(sources.find((s) => s.citation === 'Revenue: How do you complete a VAT 3 return?')!.sourceUrl)
      .toContain('revenue.ie');
    expect(sources.find((s) => s.citation === 'Revenue TDM VAT-RTD-S76')!.sourceUrl).toContain('VAT-RTD-S76.pdf');

    const provision = db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sectionNumber, 'T1'), eq(irishActProvisions.companyId, companyId))).get()!;
    expect(provision.locator).toBe('box T1');
    const rtdProvision = db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sectionNumber, '2.2'), eq(irishActProvisions.companyId, companyId))).get()!;
    expect(rtdProvision.locator).toBe('page 6');
  });

  it('the stored offsets still slice the cited passage from the file (AGENTS.md #5)', () => {
    ingestVat3ReturnGuidance(db, { companyId, markdown: vat3Markdown, ingestVersion: 'v1' });
    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, 'Revenue: How do you complete a VAT 3 return?')).get()!;
    const provision = db.select().from(irishActProvisions)
      .where(and(eq(irishActProvisions.sourceId, source.id), eq(irishActProvisions.sectionNumber, 'T1'))).get()!;
    const check = verifyStatuteFile(source.localPath, source.sha256, provision.sourceStart, provision.sourceEnd);
    expect(check.exists && check.sha256Matches).toBe(true);
    expect(check.slice!.replace(/\s+/g, ' ')).toContain('This figure is the total VAT due on your');
  });
});

describe('deriveVat3RtdRules (issue #439)', () => {
  beforeEach(() => {
    ingestVat3ReturnGuidance(db, { companyId, markdown: vat3Markdown, ingestVersion: 'v1' });
    ingestRtdTdm(db, { companyId, markdown: rtdMarkdown, ingestVersion: 'v1' });
  });

  it('derives every curated form rule, each quoting its passage verbatim', () => {
    const result = deriveVat3RtdRules(db, { companyId });
    expect(result).toMatchObject({ created: VAT3_BOX_RULES.length + RTD_MANUAL_RULES.length, skippedNoProvision: [] });

    for (const curated of [...VAT3_BOX_RULES, ...RTD_MANUAL_RULES]) {
      const rule = db.select().from(irishTaxRules)
        .where(and(
          eq(irishTaxRules.companyId, companyId),
          eq(irishTaxRules.ruleKey, curated.ruleKey),
          eq(irishTaxRules.active, true),
        )).get();
      expect(rule, curated.ruleKey).toBeTruthy();
      expect(rule!.statement).toBe(curated.statementExcerpt);
      expect(rule!.ruleType).toBe(curated.ruleType);
      expect(rule!.reviewStatus).toBe('ai_extracted');
      expect(rule!.reportingEffect).toBeTruthy();
      // The quote is verbatim from the provision it cites.
      const provision = db.select().from(irishActProvisions)
        .where(eq(irishActProvisions.id, rule!.provisionId)).get()!;
      expect(provision.provisionText, curated.ruleKey).toContain(curated.statementExcerpt);
    }
  });

  it('is idempotent: a second derive changes nothing', () => {
    deriveVat3RtdRules(db, { companyId });
    const second = deriveVat3RtdRules(db, { companyId });
    expect(second).toMatchObject({ created: 0, superseded: 0, unchanged: VAT3_BOX_RULES.length + RTD_MANUAL_RULES.length });
  });

  it('each rule lands in the review queue, unreviewed', () => {
    deriveVat3RtdRules(db, { companyId });
    const queue = db.select().from(reviewItems)
      .where(and(eq(reviewItems.companyId, companyId), eq(reviewItems.entityType, 'irish_tax_rule'))).all();
    expect(queue.length).toBe(VAT3_BOX_RULES.length + RTD_MANUAL_RULES.length);
  });

  it('each rule cross-references the statute behind the form, and those references resolve', async () => {
    deriveVat3RtdRules(db, { companyId });
    // The VATCA s.76 and reg.24 provisions must be ingested for resolution; the KB load brings them.
    const { loadStatutoryKnowledgeBase } = await import('./knowledgeBase');
    loadStatutoryKnowledgeBase(db, { companyId });
    deriveVat3RtdRules(db, { companyId });
    const rule = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'rtd.annual_return_required'), eq(irishTaxRules.active, true))).get()!;
    expect(rule.crossReferences).toEqual(['Value-Added Tax Consolidation Act 2010 s.76', 'S.I. 639/2010 reg.24']);
    const deps = resolveRuleDependencies(db, { ruleId: rule.id });
    const s76 = deps.find((d) => d.reference === 'Value-Added Tax Consolidation Act 2010 s.76')!;
    expect(s76.resolved).toBe(true);
    expect(s76.provision!.sectionNumber).toBe('76');
    const reg24 = deps.find((d) => d.reference === 'S.I. 639/2010 reg.24')!;
    expect(reg24.resolved).toBe(true);
    expect(reg24.provision!.sectionNumber).toBe('24');
  });
});

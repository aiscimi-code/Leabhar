import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules, irishKnowledgeSources, irishActProvisions } from '@/db/schema';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { attachRulesStoreFromBook } from './rulesStore';
import { attachRulesStore } from './visibleRules';
import { generateAuditReport } from './audit';
import {
  resolveRuleDependencies, resolveAllRuleDependencies, crossReferencesFromProvision,
  referenceLocator, referenceInstrument,
} from './dependencies';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let sqlite: ReturnType<typeof createTestDatabase>['sqlite'];
let companyId: string;

beforeAll(() => {
  ({ db, sqlite } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Deps Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  deriveStatutoryKnowledgeBase(db, { companyId });
});

const activeRule = (ruleKey: string) => db.select().from(irishTaxRules)
  .where(and(
    eq(irishTaxRules.companyId, companyId),
    eq(irishTaxRules.ruleKey, ruleKey),
    eq(irishTaxRules.active, true),
  )).get()!;

/** The store's id for a version this book derived: the store numbers it `key@version` (ADR-0021). */
const storeId = (rule: { ruleKey: string; ruleVersion: number }) => `${rule.ruleKey}@${rule.ruleVersion}`;

/** Resolve a rule after a test edited its derived row: against a store built from this book, then back on the installed store. */
function resolveEdited(rule: typeof irishTaxRules.$inferSelect) {
  attachRulesStoreFromBook(db, { companyId });
  try {
    return resolveRuleDependencies(db, { companyId, ruleId: storeId(rule) });
  } finally {
    db.update(irishTaxRules).set({ crossReferences: crossReferencesFromProvision(
      db.select().from(irishActProvisions).where(eq(irishActProvisions.id, rule.provisionId)).get()!,
    ) }).where(eq(irishTaxRules.id, rule.id)).run();
    attachRulesStore(sqlite);
  }
}

describe('cross-reference parsing', () => {
  it('extracts the locator a reference carries', () => {
    expect(referenceLocator('Value-Added Tax Consolidation Act 2010 s.2')).toBe('2');
    expect(referenceLocator('Taxes Consolidation Act 1997 s.81(2)(a)')).toBe('81(2)');
    expect(referenceLocator('section 462B(3)')).toBe('462B(3)');
    expect(referenceLocator('S.I. 156/2012 reg.5')).toBe('5');
    expect(referenceLocator('Council Implementing Regulation (EU) No 282/2011 art.10')).toBe('10');
    expect(referenceLocator('472BB(3)')).toBe('472BB');
    expect(referenceLocator('No section named here')).toBeNull();
  });

  it('identifies the instrument a reference names', () => {
    expect(referenceInstrument('Value-Added Tax Consolidation Act 2010 s.2').citation!.test('VATCA 2010')).toBe(true);
    expect(referenceInstrument('Taxes Consolidation Act 1997 s.81').citation!.test('Revenue NfG TCA 1997 (FA 2025 ed.) Part 4')).toBe(true);
    expect(referenceInstrument('S.I. 156/2012 reg.5').citation!.test('S.I. 156/2012')).toBe(true);
    expect(referenceInstrument('Some Unknown Act 1999 s.1').matched).toBe(false);
  });

  it('qualifies a bare amended section with its principal Act', () => {
    expect(crossReferencesFromProvision({ amendsSection: '472BB(3)', citedActs: [], principalAct: 'Taxes Consolidation Act 1997' }))
      .toEqual(['Taxes Consolidation Act 1997 s.472BB(3)']);
    expect(crossReferencesFromProvision({ amendsSection: null, citedActs: ['Finance Act 2024'], principalAct: null }))
      .toEqual(['Finance Act 2024']);
  });
});

describe('rule dependency resolution (issue #438)', () => {
  it('resolves a cross-reference to the provision this book actually holds', () => {
    // The FA 2024 VAT registration threshold rules cite the VATCA s.2 definitions they rest on.
    const rule = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.registration_threshold_goods')))
      .get()!;
    expect(rule.crossReferences).toContain('Value-Added Tax Consolidation Act 2010 s.2');
    const deps = resolveRuleDependencies(db, { companyId, ruleId: storeId(rule) });
    const dep = deps.find((d) => d.reference === 'Value-Added Tax Consolidation Act 2010 s.2')!;
    expect(dep.resolved).toBe(true);
    // The current (LRC revised) text of s.2, not a Schedule paragraph that happens to be numbered 2.
    expect(dep.provision!.citation).toBe('2010 Act 31 s.2');
    expect(dep.provision!.sectionNumber).toBe('2');
    expect(dep.provision!.sourceType).toBe('legislation');
  });

  it('resolves the capacity exclusion to S.I. 156/2012 reg.5, now held (#705)', () => {
    const rule = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.mandatory_electronic_filing_capacity_exclusion')))
      .all().find((r) => r.crossReferences.includes('S.I. 156/2012 reg.5'))!;
    expect(rule.crossReferences).toContain('S.I. 156/2012 reg.5');
    const deps = resolveRuleDependencies(db, { companyId, ruleId: storeId(rule) });
    const dep = deps.find((d) => d.reference === 'S.I. 156/2012 reg.5')!;
    expect(dep.resolved).toBe(true);
    expect(dep.provision!.sectionNumber).toBe('5');
  });

  it('reports a cross-reference this book cannot resolve, with the reason, never silently', () => {
    const rule = activeRule('ct.rate_standard');
    // Force a cross-reference to a section this book does not hold.
    db.update(irishTaxRules).set({ crossReferences: ['Value-Added Tax Consolidation Act 2010 s.999'] })
      .where(eq(irishTaxRules.id, rule.id)).run();
    const deps = resolveEdited(rule);
    expect(deps[0]!.resolved).toBe(false);
    expect(deps[0]!.reason).toContain('no ingested provision is section 999');
  });

  it('reports an instrument this book has not ingested at all', () => {
    const rule = activeRule('ct.rate_standard');
    db.update(irishTaxRules).set({ crossReferences: ['Some Unheard Of Act 1900 s.1'] })
      .where(eq(irishTaxRules.id, rule.id)).run();
    const deps = resolveEdited(rule);
    expect(deps[0]!.resolved).toBe(false);
    expect(deps[0]!.reason).toContain('ingests no source for the instrument');
  });

  it('every active rule with a cross-reference is resolved or explained in the audit', () => {
    const all = resolveAllRuleDependencies(db, { companyId });
    expect(all.length).toBeGreaterThan(0);
    for (const d of all) {
      if (d.resolved) expect(d.reason).toBeNull();
      else expect(d.reason).toBeTruthy();
    }
    const report = generateAuditReport(db, { companyId });
    expect(report.ruleDependencies.total).toBe(all.length);
    expect(report.ruleDependencies.resolved).toBe(all.filter((d) => d.resolved).length);
    expect(report.ruleDependencies.unresolved.every((u) => u.reason)).toBe(true);
  });

  it('the knowledge base now holds rules whose cross-references actually resolve', () => {
    const all = resolveAllRuleDependencies(db, { companyId });
    expect(all.filter((d) => d.resolved).length).toBeGreaterThan(20);
    // A resolved dependency names the provision and the rules derived from it.
    const resolved = all.filter((d) => d.resolved);
    for (const d of resolved.slice(0, 5)) {
      const dep = resolveRuleDependencies(db, { companyId, ruleId: storeId(activeRule(d.ruleKey)) })
        .find((x) => x.reference === d.reference)!;
      expect(dep.provision!.sectionNumber).toBeTruthy();
      expect(typeof dep.provision!.sourceUrl).toBe('string');
    }
  });
});

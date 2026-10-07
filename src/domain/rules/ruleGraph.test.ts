import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { and, eq } from 'drizzle-orm';
import { irishRuleLinks, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { LINK_FROM_RULES } from './ruleLinks';
import { DECLARED_VERSION_GAPS, checkRuleGraph as checkStoredRuleGraph, uncoveredSpans } from './ruleGraph';
import { attachRulesStoreFromBook } from './rulesStore';
import type { AppDatabase } from '@/db';

/** Check the graph of a store built from the book's rows, which these tests edit (ADR-0021: the graph reads the store). */
function checkRuleGraph(db: AppDatabase, params: { companyId: string }) {
  attachRulesStoreFromBook(db, params);
  return checkStoredRuleGraph(db, params);
}

describe('the rule graph of a loaded book (ADR-0020 §5, issue #686 step 3)', () => {
  let db: AppDatabase;
  let companyId: string;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Graph Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    deriveStatutoryKnowledgeBase(db, { companyId });
  });

  it('has no dangling link, uncovered dependency, version gap or overlap, or cycle', () => {
    expect(checkRuleGraph(db, { companyId })).toEqual([]);
  });
});

describe('uncoveredSpans', () => {
  it('returns the parts of a span the others leave open', () => {
    expect(uncoveredSpans({ from: '2025-01-01', to: '2026-01-01' }, [])).toEqual([{ from: '2025-01-01', to: '2026-01-01' }]);
    expect(uncoveredSpans({ from: '2025-01-01', to: '2026-01-01' }, [
      { from: '2024-01-01', to: '2025-03-01' }, { from: '2025-06-01', to: '2025-09-01' }, { from: '2025-08-01', to: '2025-10-01' },
    ])).toEqual([{ from: '2025-03-01', to: '2025-06-01' }, { from: '2025-10-01', to: '2026-01-01' }]);
    expect(uncoveredSpans({ from: '2025-01-01', to: '2026-01-01' }, [{ from: '2020-01-01', to: '9999-12-31' }])).toEqual([]);
  });
});

describe('checkRuleGraph finds each kind of fault', () => {
  let db: AppDatabase;
  let companyId: string;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Faults Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    deriveStatutoryKnowledgeBase(db, { companyId });
  });

  const addLink = (fromKey: string, kind: 'uses_value' | 'excludes', toKey: string, effectiveFrom = LINK_FROM_RULES) => {
    db.insert(irishRuleLinks).values({
      id: ids.ruleLink(), companyId, fromKey, kind, toKey, effectiveFrom, source: 'user', provenanceStatus: 'manually_entered',
    }).run();
  };

  it('declares only gaps that exist', () => {
    // Every declared gap is a real gap between two versions in this book.
    const versions = (key: string) => db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, key))).all();
    for (const g of DECLARED_VERSION_GAPS) {
      const v = versions(g.ruleKey);
      expect(v.some((r) => r.effectiveTo === g.from), g.ruleKey).toBe(true);
      expect(v.some((r) => r.effectiveFrom === g.to), g.ruleKey).toBe(true);
    }
  });

  it('reports a dangling key, an uncovered dependency and a cycle', () => {
    addLink('vat.charge_general', 'uses_value', 'vat.no_such_rule');
    // The 9% hospitality rate has no version between September 2023 and 2025.
    addLink('vat.charge_general', 'uses_value', 'vat.rate_hospitality', '2024-01-01');
    addLink('vat.rate_standard_current', 'excludes', 'vat.charge_general');
    addLink('vat.charge_general', 'excludes', 'vat.rate_standard_current');
    const found = checkRuleGraph(db, { companyId });
    expect(found.map((f) => f.kind).sort()).toEqual(['cycle', 'dangling', 'uncovered']);
    expect(found.find((f) => f.kind === 'uncovered')!.detail).toMatch(/vat\.rate_hospitality .* 2024-01-01 to 2025-01-01/);
    expect(found.find((f) => f.kind === 'cycle')!.detail).toMatch(/vat\.rate_standard_current → vat\.charge_general\.$/);
  });

  it('reports a gap and an overlap between versions', () => {
    const v = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.rate_standard_current'))).all()
      .sort((a, b) => a.ruleVersion - b.ruleVersion);
    db.update(irishTaxRules).set({ effectiveTo: '2020-08-01' }).where(eq(irishTaxRules.id, v[0]!.id)).run();
    db.update(irishTaxRules).set({ effectiveTo: '2021-04-01' }).where(eq(irishTaxRules.id, v[1]!.id)).run();
    const found = checkRuleGraph(db, { companyId }).filter((f) => f.ruleKey === 'vat.rate_standard_current');
    expect(found.map((f) => f.kind).sort()).toEqual(['gap', 'overlap']);
  });
});

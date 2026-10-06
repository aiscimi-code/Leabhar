import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { fillTaxHeads, loadStatutoryKnowledgeBase } from './knowledgeBase';
import { listTaxRulesByHead } from './irishRules';
import { TAX_HEADS, taxHeadsFor } from './taxHeads';
import type { AppDatabase } from '@/db';

describe('tax heads (issue #686 step 9)', () => {
  let db: AppDatabase;
  let companyId: string;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Heads Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    loadStatutoryKnowledgeBase(db, { companyId });
  });

  const rows = () => db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();

  it('gives every rule in a loaded book at least one known head, as taxHeadsFor states', () => {
    for (const r of rows()) {
      expect(r.taxHeads.length, r.ruleKey).toBeGreaterThan(0);
      expect(r.taxHeads.every((h) => (TAX_HEADS as readonly string[]).includes(h)), r.ruleKey).toBe(true);
      expect(r.taxHeads, r.ruleKey).toEqual(taxHeadsFor(r.ruleKey, r.topic));
    }
  });

  it('lets one rule belong to more than one head, while topic still routes the lookup', () => {
    expect(rows().find((r) => r.ruleKey === 'ct.rate_standard')!.taxHeads).toEqual(['corporation_tax']);
    // s.284 wear and tear is given to a trade under either tax.
    expect(rows().find((r) => r.ruleKey === 'ct.wear_and_tear_rate')!.taxHeads).toEqual(['corporation_tax', 'income_tax']);
    const capitalAllowance = rows().find((r) => r.topic === 'capital_allowances')!;
    expect(capitalAllowance.taxHeads).toEqual(['corporation_tax', 'income_tax']);
    const imported = rows().find((r) => r.ruleKey === 'vat.zero_rate_import_transport')!;
    expect([imported.topic, imported.taxHeads]).toEqual(['vat', ['vat', 'customs']]);
    expect(taxHeadsFor('farm.stock_relief_rate', 'corporation_tax')).toEqual(['corporation_tax', 'income_tax']);
    expect(taxHeadsFor('x.unknown', 'unknown_topic')).toEqual([]);
  });

  it('lists the rules of a head in force on a date', () => {
    const customs = listTaxRulesByHead(db, { companyId, head: 'customs', asOfDate: '2025-06-30' }).map((r) => r.ruleKey);
    expect(customs).toContain('vat.zero_rate_import_transport');
    const it_ = listTaxRulesByHead(db, { companyId, head: 'income_tax', asOfDate: '2025-06-30' }).map((r) => r.ruleKey);
    expect(it_).toContain(capitalAllowanceKey());
    expect(listTaxRulesByHead(db, { companyId, head: 'vat', asOfDate: 'not a date' })).toEqual([]);
  });

  const capitalAllowanceKey = () => rows().find((r) => r.topic === 'capital_allowances')!.ruleKey;

  it('fills the heads of a rule stored before they were recorded, and never overwrites stated ones', () => {
    const [a, b] = rows();
    db.update(irishTaxRules).set({ taxHeads: [] }).where(eq(irishTaxRules.id, a!.id)).run();
    db.update(irishTaxRules).set({ taxHeads: ['customs'] }).where(eq(irishTaxRules.id, b!.id)).run();
    expect(fillTaxHeads(db, { companyId })).toBe(1);
    const after = new Map(rows().map((r) => [r.id, r.taxHeads]));
    expect(after.get(a!.id)).toEqual(taxHeadsFor(a!.ruleKey, a!.topic));
    expect(after.get(b!.id)).toEqual(['customs']);
  });
});

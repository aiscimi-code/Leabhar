import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { RULE_CONSUMERS, consumerId, isManifestRuleKey, type RuleConsumer } from './consumers';
import { resolveRuleFigure } from './ruleFigures';
import { ruleImpact } from './ruleImpact';
import { ruleLinksFrom } from './ruleLinks';
import type { AppDatabase } from '@/db';

describe('consumer manifests (ADR-0020 §4, issue #686 step 5)', () => {
  let db: AppDatabase;
  let companyId: string;
  let bookKeys: Set<string>;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Consumers Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    loadStatutoryKnowledgeBase(db, { companyId });
    bookKeys = new Set(db.select({ k: irishTaxRules.ruleKey }).from(irishTaxRules)
      .where(eq(irishTaxRules.companyId, companyId)).all().map((r) => r.k));
  });

  const consumers = Object.keys(RULE_CONSUMERS) as RuleConsumer[];

  it('declares only keys a loaded book holds', () => {
    for (const c of consumers) {
      expect(RULE_CONSUMERS[c].keys.filter((k) => !bookKeys.has(k)), c).toEqual([]);
    }
  });

  it('declares every rule key its source names', () => {
    for (const c of consumers) {
      const named = new Set<string>();
      for (const file of RULE_CONSUMERS[c].modules) {
        for (const m of readFileSync(file, 'utf8').matchAll(/'([a-z0-9_]+\.[a-z0-9_]+)'/g)) {
          if (bookKeys.has(m[1]!)) named.add(m[1]!);
        }
      }
      const declared = new Set<string>(RULE_CONSUMERS[c].keys);
      expect([...named].filter((k) => !declared.has(k)), c).toEqual([]);
    }
  });

  it('lets resolveRuleFigure take only a declared key', () => {
    expect(isManifestRuleKey('ct.rate_standard')).toBe(true);
    expect(isManifestRuleKey('vat.charge_general')).toBe(false);
    const curated = { ruleKey: 'vat.charge_general', numericValue: null };
    // @ts-expect-error -- a key no computation declares is refused by the type.
    expect(() => resolveRuleFigure(db, { companyId, ruleKey: 'vat.charge_general', asOfDate: '2025-06-30', curated })).not.toThrow();
  });

  it('loads each manifest as consumed_by links, so impact reaches the computations', () => {
    expect(ruleLinksFrom(db, { companyId, ruleKey: 'ct.rate_standard', kinds: ['consumed_by'] }).map((l) => l.toKey))
      .toEqual([consumerId('corporation_tax')]);
    const impact = ruleImpact(db, { companyId, target: { kind: 'rule', ruleKey: 'usc.band_2pct' } });
    expect(impact.consumers.map((c) => c.consumer).sort()).toEqual([consumerId('income_tax'), consumerId('payroll')]);
    expect(impact.affected.some((e) => e.ruleKey.startsWith('consumer:'))).toBe(false);
  });
});

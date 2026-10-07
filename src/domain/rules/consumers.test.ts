import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';
import { RULE_CONSUMERS, consumerId, isManifestRuleKey, type RuleConsumer } from './consumers';
import { resolveRuleFigure } from './ruleFigures';
import { ruleImpact } from './ruleImpact';
import { ruleLinksFrom } from './ruleLinks';
import { LOOKUP_TOPICS } from './transactionLookup';
import { RULE_TREATMENT_BINDINGS, VAT_SUGGESTION_RULE_KEYS } from './vatSuggestion';
import { BLOCKED_DEDUCTION_RULE_KEYS } from './inputRecoveryCuration';
import type { AppDatabase } from '@/db';

describe('consumer manifests (ADR-0020 §4, issue #686 step 5)', () => {
  let db: AppDatabase;
  let companyId: string;
  let bookKeys: Set<string>;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Consumers Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    deriveStatutoryKnowledgeBase(db, { companyId });
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
    // The lookup routes a payroll line to the usc topic, so it reads the band too (#694).
    expect(impact.consumers.map((c) => c.consumer).sort())
      .toEqual([consumerId('income_tax'), consumerId('payroll'), consumerId('transaction_lookup')]);
    expect(impact.affected.some((e) => e.ruleKey.startsWith('consumer:'))).toBe(false);
  });
});

describe('readers by topic (#694)', () => {
  let db: AppDatabase;
  let companyId: string;
  let held: Array<{ ruleKey: string; topic: string }>;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Topic Readers Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    deriveStatutoryKnowledgeBase(db, { companyId });
    held = db.select({ ruleKey: irishTaxRules.ruleKey, topic: irishTaxRules.topic, from: irishTaxRules.effectiveFrom, to: irishTaxRules.effectiveTo })
      .from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all()
      .filter((r) => r.to === null || r.to > r.from);
  });
  const readers = (ruleKey: string) => ruleLinksFrom(db, { companyId, ruleKey, kinds: ['consumed_by'] }).map((l) => l.toKey);

  it('impact reaches the suggestion and the lookup from a rule they read by topic, as the food block showed it did not', () => {
    const impact = ruleImpact(db, { companyId, target: { kind: 'rule', ruleKey: 'vat.blocked_food_drink_accommodation' } });
    expect(impact.consumers.map((c) => c.name).sort()).toEqual(['Transaction rule lookup', 'VAT treatment suggestion']);
  });

  it('links every rule of a topic the lookup routes to, and no other', () => {
    const topics = new Set(LOOKUP_TOPICS);
    for (const { ruleKey, topic } of held) {
      expect(readers(ruleKey).includes(consumerId('transaction_lookup')), `${ruleKey} (${topic})`)
        .toBe(held.some((r) => r.ruleKey === ruleKey && topics.has(r.topic)));
    }
  });

  it('declares every key the suggestion names in its source, and links each one the book holds', () => {
    const named = new Set([...readFileSync('src/domain/rules/vatSuggestion.ts', 'utf8').matchAll(/'([a-z0-9_]+\.[a-z0-9_]+)'/g)]
      .map((m) => m[1]!).filter((k) => held.some((r) => r.ruleKey === k)));
    expect([...named].filter((k) => !VAT_SUGGESTION_RULE_KEYS.includes(k))).toEqual([]);
    for (const key of VAT_SUGGESTION_RULE_KEYS.filter((k) => held.some((r) => r.ruleKey === k))) {
      expect(readers(key), key).toContain(consumerId('vat_suggestion'));
    }
  });

  it('includes every deduction block and every binding key', () => {
    for (const key of [...BLOCKED_DEDUCTION_RULE_KEYS, ...RULE_TREATMENT_BINDINGS.flatMap((b) => b.ruleKeys)]) {
      expect(VAT_SUGGESTION_RULE_KEYS, key).toContain(key);
    }
  });
});


import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { SUPERSESSIONS, retiredBy } from './supersessions';
import { ruleLinksFrom, ruleLinksTo } from './ruleLinks';
import { checkRuleGraph as checkStoredRuleGraph } from './ruleGraph';
import { attachRulesStoreFromBook } from './rulesStore';
import { RETIRED_S46_RULE_KEYS } from './vatcaRevisedCuration';
import { RETIRED_INPUT_RECOVERY_RULE_KEYS } from './inputRecoveryCuration';
import { RETIRED_FINANCE_ACT_2024_RULE_KEYS } from './irishRules';
import type { AppDatabase } from '@/db';

/** Check the graph of a store built from the book's rows, which this test edits (ADR-0021: the graph reads the store). */
function checkRuleGraph(db: AppDatabase, params: { companyId: string }) {
  attachRulesStoreFromBook(db, params);
  return checkStoredRuleGraph(db, params);
}

describe('supersession as links (ADR-0020 §3, issue #686 step 8)', () => {
  let db: AppDatabase;
  let companyId: string;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Supersede Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    loadStatutoryKnowledgeBase(db, { companyId });
  });

  const keysInBook = () => new Set(db.select({ k: irishTaxRules.ruleKey }).from(irishTaxRules)
    .where(eq(irishTaxRules.companyId, companyId)).all().map((r) => r.k));

  it('reads each derive step\'s retire list from the declared supersessions', () => {
    expect(RETIRED_S46_RULE_KEYS).toEqual([
      'vat.rate_restaurant_catering_reduced_current', 'vat.rate_restaurant_catering_reduced_pre_9pct_window',
      'vat.rate_hospitality_9pct_not_modelled', 'vat.rate_restaurant_catering_9pct_2020_2023',
      'vat.rate_hairdressing_9pct_2020_2023',
    ]);
    expect(RETIRED_INPUT_RECOVERY_RULE_KEYS).toEqual(['vat.input_deduction_general', 'vat.deduction_exclusions_entertainment']);
    expect(RETIRED_FINANCE_ACT_2024_RULE_KEYS).toEqual(['usc.first_band_threshold', 'income_tax.standard_rate_threshold']);
    // A carve-out retires nothing: the reduced rate stays in force for the other paragraphs.
    expect(retiredBy(['vat.rate_hospitality'])).not.toContain('vat.rate_reduced_current');
  });

  it('names new keys a loaded book holds, and old keys it no longer derives unless carved out', () => {
    const held = keysInBook();
    for (const s of SUPERSESSIONS) {
      expect(s.newKeys.filter((k) => !held.has(k)), s.note).toEqual([]);
      if (s.whole) expect(s.oldKeys.filter((k) => held.has(k)), s.note).toEqual([]);
      else expect(s.oldKeys.every((k) => held.has(k)), s.note).toBe(true);
    }
  });

  it('loads the 13.5% to 9% carve-out (issue #129) as a dated supersedes link', () => {
    const on = (d: string) => ruleLinksTo(db, { companyId, ruleKey: 'vat.rate_reduced_current', kinds: ['supersedes'], asOfDate: d })
      .map((l) => l.fromKey).sort();
    expect(on('2026-06-30')).toEqual([]);
    expect(on('2026-07-01')).toEqual(['vat.rate_hairdressing', 'vat.rate_hospitality']);
    expect(ruleLinksFrom(db, { companyId, ruleKey: 'vat.blocked_petrol', kinds: ['supersedes'] }).map((l) => l.toKey))
      .toEqual(['vat.deduction_exclusions_entertainment']);
  });

  it('agrees with supersedesRuleId: a row chained to another key has a supersedes link to it', () => {
    // An older book that still holds a key this curation retires.
    const current = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.rate_hairdressing'))).all()[0]!;
    db.insert(irishTaxRules).values({
      ...current, id: 'rule_old_hairdressing', ruleKey: 'vat.rate_hairdressing_9pct_2020_2023', ruleVersion: 1,
      supersedesRuleId: null, active: true,
    }).run();
    db.update(irishTaxRules).set({ supersedesRuleId: 'rule_old_hairdressing' }).where(eq(irishTaxRules.id, current.id)).run();
    loadStatutoryKnowledgeBase(db, { companyId });

    const old = db.select().from(irishTaxRules).where(eq(irishTaxRules.id, 'rule_old_hairdressing')).get()!;
    expect([old.active, old.effectiveTo]).toEqual([false, old.effectiveFrom]); // retired, not deleted

    expect(checkRuleGraph(db, { companyId }).filter((f) => f.kind === 'supersession')).toEqual([]);
    const rows = db.select().from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const crossKey = rows.filter((r) => r.supersedesRuleId && byId.get(r.supersedesRuleId)!.ruleKey !== r.ruleKey);
    expect(crossKey.length).toBeGreaterThan(0);
    for (const r of crossKey) {
      const oldKey = byId.get(r.supersedesRuleId!)!.ruleKey;
      expect(ruleLinksFrom(db, { companyId, ruleKey: r.ruleKey, kinds: ['supersedes'] }).map((l) => l.toKey), r.ruleKey)
        .toContain(oldKey);
    }
    // Chained to a key no link names: the graph check says so.
    db.update(irishTaxRules).set({ supersedesRuleId: 'rule_old_hairdressing' })
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.rate_standard_current'), eq(irishTaxRules.active, true))).run();
    expect(checkRuleGraph(db, { companyId }).filter((f) => f.kind === 'supersession').map((f) => f.ruleKey))
      .toEqual(['vat.rate_standard_current']);
  });
});

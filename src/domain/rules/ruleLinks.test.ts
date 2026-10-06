import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishRuleLinks, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import {
  CURATED_RULE_LINKS, LINK_FROM_RULES, syncRuleLinks, ruleLinksFrom, ruleLinksTo, type CuratedRuleLink,
} from './ruleLinks';
import { ADVISORY_RULES } from './advisoryRules';
import { VAT_GENERAL_DEDUCTION_RULE_KEY, VAT_DEDUCTION_EXCLUSION_RULE_KEYS } from './vatcaCuration';
import type { AppDatabase } from '@/db';

describe('curated rule links in a loaded book (ADR-0020, issue #686 step 1)', () => {
  let db: AppDatabase;
  let companyId: string;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Links Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    loadStatutoryKnowledgeBase(db, { companyId });
  });

  it('loads every curated link, once', () => {
    const rows = db.select().from(irishRuleLinks).where(eq(irishRuleLinks.companyId, companyId)).all();
    expect(rows).toHaveLength(CURATED_RULE_LINKS.length);
    expect(rows.every((r) => r.active && r.source === 'system' && r.provenanceStatus === 'system_rule')).toBe(true);
  });

  it('names only rule keys the book holds', () => {
    const keys = new Set(db.select({ k: irishTaxRules.ruleKey }).from(irishTaxRules)
      .where(eq(irishTaxRules.companyId, companyId)).all().map((r) => r.k));
    const missing = CURATED_RULE_LINKS.flatMap((l) => [l.fromKey, l.toKey]).filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it('states each silencedBy and each s.60 exclusion as a link', () => {
    for (const a of ADVISORY_RULES) {
      const silencers = ruleLinksFrom(db, { companyId, ruleKey: a.ruleKey, kinds: ['silenced_by'] }).map((l) => l.toKey);
      expect(silencers.sort(), a.ruleKey).toEqual([...a.silencedBy].sort());
    }
    const excluders = ruleLinksTo(db, { companyId, ruleKey: VAT_GENERAL_DEDUCTION_RULE_KEY, kinds: ['excludes'] })
      .map((l) => l.fromKey);
    expect(excluders.sort()).toEqual([...VAT_DEDUCTION_EXCLUSION_RULE_KEYS].sort());
  });

  it('is unchanged by loading the knowledge base again', () => {
    expect(syncRuleLinks(db, { companyId })).toEqual({ inserted: 0, withdrawn: 0, restored: 0 });
    loadStatutoryKnowledgeBase(db, { companyId });
    expect(db.select().from(irishRuleLinks).where(eq(irishRuleLinks.companyId, companyId)).all())
      .toHaveLength(CURATED_RULE_LINKS.length);
  });
});

describe('syncRuleLinks and the link queries', () => {
  let db: AppDatabase;
  let companyId: string;

  const link = (over: Partial<CuratedRuleLink> = {}): CuratedRuleLink => ({
    fromKey: 'vat.reduced_rate_hairdressing',
    kind: 'rate_from',
    toKey: 'vat.rate_reduced_current',
    effectiveFrom: LINK_FROM_RULES,
    effectiveTo: '2026-07-01',
    note: 'Schedule 3 para. 13(3) at 13.5%.',
    ...over,
  });
  const nineFromJuly = link({ toKey: 'vat.rate_hairdressing', effectiveFrom: '2026-07-01', effectiveTo: null, note: 'Para. 13(3) at 9% (FA 2025 s.71).' });

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Sync Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  });

  const rows = () => db.select().from(irishRuleLinks).where(eq(irishRuleLinks.companyId, companyId)).all();

  it('inserts, then leaves an unchanged set alone', () => {
    expect(syncRuleLinks(db, { companyId, links: [link(), nineFromJuly] })).toEqual({ inserted: 2, withdrawn: 0, restored: 0 });
    expect(syncRuleLinks(db, { companyId, links: [link(), nineFromJuly] })).toEqual({ inserted: 0, withdrawn: 0, restored: 0 });
    expect(rows()).toHaveLength(2);
  });

  it('answers by date: the end date is exclusive, like a rule version', () => {
    const on = (asOfDate: string) => ruleLinksFrom(db, { companyId, ruleKey: 'vat.reduced_rate_hairdressing', asOfDate })
      .map((l) => l.toKey);
    expect(on('2026-06-30')).toEqual(['vat.rate_reduced_current']);
    expect(on('2026-07-01')).toEqual(['vat.rate_hairdressing']);
    expect(ruleLinksFrom(db, { companyId, ruleKey: 'vat.reduced_rate_hairdressing' })).toHaveLength(2);
    expect(ruleLinksTo(db, { companyId, ruleKey: 'vat.rate_hairdressing', asOfDate: '2026-06-30' })).toEqual([]);
    expect(ruleLinksTo(db, { companyId, ruleKey: 'vat.rate_hairdressing', asOfDate: '2026-07-01' }).map((l) => l.fromKey))
      .toEqual(['vat.reduced_rate_hairdressing']);
  });

  it('never edits a link: a change withdraws the old row and adds a new one', () => {
    const changed = link({ effectiveTo: '2026-08-01' });
    expect(syncRuleLinks(db, { companyId, links: [changed, nineFromJuly] })).toEqual({ inserted: 1, withdrawn: 1, restored: 0 });
    const all = rows();
    expect(all).toHaveLength(3);
    expect(all.filter((r) => !r.active).map((r) => r.effectiveTo)).toEqual(['2026-07-01']);
    // A withdrawn link answers no query.
    expect(ruleLinksFrom(db, { companyId, ruleKey: 'vat.reduced_rate_hairdressing', asOfDate: '2026-06-30' })
      .map((l) => l.effectiveTo)).toEqual(['2026-08-01']);
  });

  it('restores a withdrawn link the curation states again, rather than duplicating it', () => {
    expect(syncRuleLinks(db, { companyId, links: [link(), nineFromJuly] })).toEqual({ inserted: 0, withdrawn: 1, restored: 1 });
    expect(rows()).toHaveLength(3);
  });

  it("leaves a person's own links alone", () => {
    db.insert(irishRuleLinks).values({
      id: ids.ruleLink(), companyId, fromKey: 'vat.reduced_rate_hairdressing', kind: 'cites', toKey: 'vat.charge_general',
      effectiveFrom: LINK_FROM_RULES, source: 'user', provenanceStatus: 'manually_entered',
    }).run();
    expect(syncRuleLinks(db, { companyId, links: [] })).toEqual({ inserted: 0, withdrawn: 2, restored: 0 });
    const userLinks = db.select().from(irishRuleLinks)
      .where(and(eq(irishRuleLinks.companyId, companyId), eq(irishRuleLinks.source, 'user'))).all();
    expect(userLinks.map((l) => l.active)).toEqual([true]);
  });

  it('rejects a duplicate curated link and an invalid as-of date', () => {
    expect(() => syncRuleLinks(db, { companyId, links: [link(), link()] })).toThrow(/duplicate/);
    expect(() => ruleLinksFrom(db, { companyId, ruleKey: 'x', asOfDate: '2026-13-01' })).toThrow(/Invalid as-of date/);
  });
});

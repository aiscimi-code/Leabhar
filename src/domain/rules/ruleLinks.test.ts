import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishRuleLinks, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import {
  CURATED_RULE_LINKS, HEADLINE_VAT_RATE_RULE_KEYS, LINK_FROM_RULES, bookDerivedLinks, declaredLinksFrom, declaredLinksTo,
  scheduleRuleRate, syncRuleLinks, ruleLinksFrom, ruleLinksTo, type CuratedRuleLink,
} from './ruleLinks';
import { advisoryReasons } from './advisoryRules';
import { VAT_GENERAL_DEDUCTION_RULE_KEY, VAT_DEDUCTION_EXCLUSION_RULE_KEYS } from './vatcaCuration';
import { DOMESTIC_RC_ADVISORY_RULE_KEYS, RC_CONSTRUCTION_RULE_KEY } from './domesticReverseChargeCuration';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { CA_LIST_KNOWN_FROM, SECOND_REDUCED_WINDOWS, scheduleThreeRate } from './scheduleRates';
import { resolveBookDependencies } from './dependencies';
import { addDays, asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';

describe('rule links in a loaded book (ADR-0020, issue #686)', () => {
  let db: AppDatabase;
  let companyId: string;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Links Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
    loadStatutoryKnowledgeBase(db, { companyId });
  });

  const bookLinks = () => db.select().from(irishRuleLinks).where(eq(irishRuleLinks.companyId, companyId)).all();

  it('loads every declared and derived link, once', () => {
    const rows = bookLinks();
    expect(rows).toHaveLength(CURATED_RULE_LINKS.length + bookDerivedLinks(db, { companyId }).length);
    expect(rows.every((r) => r.active && r.source === 'system' && r.provenanceStatus === 'system_rule')).toBe(true);
    for (const kind of ['silenced_by', 'excludes', 'rate_from', 'cites', 'consumed_by', 'supersedes'] as const) {
      expect(rows.some((r) => r.kind === kind), kind).toBe(true);
    }
  });

  it('names only rule keys the book holds', () => {
    const keys = new Set(db.select({ k: irishTaxRules.ruleKey }).from(irishTaxRules)
      .where(eq(irishTaxRules.companyId, companyId)).all().map((r) => r.k));
    // A consumer is not a rule; a superseded key may never have been derived in this book.
    const missing = bookLinks().flatMap((l) => [l.fromKey, l.kind === 'consumed_by' || l.kind === 'supersedes' ? null : l.toKey])
      .filter((k) => k !== null && !keys.has(k));
    expect(missing).toEqual([]);
  });

  it('silences each domestic reverse-charge advisory by the construction rule, and lets it speak otherwise', () => {
    for (const key of DOMESTIC_RC_ADVISORY_RULE_KEYS) {
      expect(declaredLinksFrom(key, { kinds: ['silenced_by'] }).map((l) => l.toKey)).toEqual([RC_CONSTRUCTION_RULE_KEY]);
      expect(advisoryReasons([key])).toHaveLength(1);
      expect(advisoryReasons([key, RC_CONSTRUCTION_RULE_KEY])).toEqual([]);
    }
    expect(ruleLinksTo(db, { companyId, ruleKey: RC_CONSTRUCTION_RULE_KEY, kinds: ['silenced_by'] }).map((l) => l.fromKey).sort())
      .toEqual([...DOMESTIC_RC_ADVISORY_RULE_KEYS].sort());
  });

  it('states each s.60 exclusion, and the standard-rate fallback over the reduced rate, as excludes', () => {
    const excluders = ruleLinksTo(db, { companyId, ruleKey: VAT_GENERAL_DEDUCTION_RULE_KEY, kinds: ['excludes'] })
      .map((l) => l.fromKey);
    expect(excluders.sort()).toEqual([...VAT_DEDUCTION_EXCLUSION_RULE_KEYS].sort());
    expect(declaredLinksTo('vat.rate_reduced_current', { kinds: ['excludes'] }).map((l) => l.fromKey))
      .toEqual(['vat.rate_standard_current']);
  });

  it('names every empty-condition VAT rate rule as a headline fact, so a new one needs a decision', () => {
    const headline = new Set(db.select({ k: irishTaxRules.ruleKey, c: irishTaxRules.conditions }).from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.active, true),
        eq(irishTaxRules.topic, 'vat'), eq(irishTaxRules.ruleType, 'rate'))).all()
      .filter((r) => r.c.length === 0).map((r) => r.k));
    expect([...headline].sort()).toEqual([...HEADLINE_VAT_RATE_RULE_KEYS].sort());
    // Every conditioned rate rule excludes each headline fact in the book.
    const conditionedOverHeadline = bookLinks().filter((l) => l.kind === 'excludes' && l.toKey && headline.has(l.toKey)
      && !headline.has(l.fromKey));
    expect(conditionedOverHeadline.length).toBeGreaterThan(50);
  });

  it('cites each resolved cross-reference, and only those', () => {
    const resolved = resolveBookDependencies(db, { companyId }).filter((d) => d.resolved);
    const cites = bookLinks().filter((l) => l.kind === 'cites');
    expect(cites.length).toBeGreaterThan(0);
    expect(cites.every((l) => l.toKey === null && l.toProvisionId !== null)).toBe(true);
    expect(new Set(cites.map((l) => `${l.fromKey}|${l.toProvisionId}|${l.note}`)))
      .toEqual(new Set(resolved.map((d) => `${d.ruleKey}|${d.provision!.id}|${d.reference}`)));
  });

  it('is unchanged by loading the knowledge base again', () => {
    const before = bookLinks().length;
    expect(syncRuleLinks(db, { companyId })).toEqual({ inserted: 0, withdrawn: 0, restored: 0 });
    loadStatutoryKnowledgeBase(db, { companyId });
    expect(bookLinks()).toHaveLength(before);
  });
});

describe('rate_from: a Schedule 3 rule takes its rate from an s.46 rule (issue #205)', () => {
  const scheduleThree = VATCA_SCHEDULE_CURATED_RULES.filter((r) => r.scheduleNumber === '3' && r.rateRefs?.length);
  const dates = [...new Set([
    '2010-11-01', '2019-06-30', CA_LIST_KNOWN_FROM, '2031-06-30',
    ...SECOND_REDUCED_WINDOWS.flatMap((w) => [w.from, w.to].filter((d): d is string => d !== null)
      .flatMap((d) => [-1, 0, 1].map((n) => addDays(asIsoDate(d), n) as string))),
  ])].sort();

  it('gives every Schedule 3 rule the rate s.46 gives its paragraph, on every date the rate can change', () => {
    for (const r of scheduleThree) {
      for (const d of dates) {
        expect(scheduleRuleRate(r.ruleKey, r.rateRefs![0]!, d), `${r.ruleKey} on ${d}`)
          .toEqual(scheduleThreeRate(r.rateRefs![0]!, d));
      }
    }
  });

  it('dates hairdressing: 13.5% to 30 June 2026, then 9% under Finance Act 2025 s.71', () => {
    const on = (d: string) => declaredLinksFrom('vat.reduced_rate_hairdressing', { kinds: ['rate_from'], asOfDate: d })
      .map((l) => `${l.toKey} ${l.note}`);
    expect(on('2026-06-30')).toEqual(['vat.rate_hairdressing VATCA 2010 s.46(1)(c)']);
    expect(on('2026-07-01')).toEqual(['vat.rate_hairdressing Finance Act 2025 s.71 (s.46(1)(cb) as substituted)']);
    expect(on('2024-06-30')).toEqual([]);
  });

  it('never overlaps two rate_from links for one rule', () => {
    for (const r of scheduleThree) {
      const links = declaredLinksFrom(r.ruleKey, { kinds: ['rate_from'] });
      for (let i = 1; i < links.length; i += 1) {
        expect(links[i]!.effectiveFrom >= links[i - 1]!.effectiveTo!, r.ruleKey).toBe(true);
      }
    }
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

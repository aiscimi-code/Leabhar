import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import {
  irishRuleBindings, irishRuleDecisions, irishRuleVersionMap, irishRuleVersionsRetained,
  visibleActProvisions, visibleKnowledgeSources, visibleTaxRules,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { createCompany } from '../config/setup';
import { lookupTaxRule } from './irishRules';
import { ruleReviewResolver } from './effectiveReview';
import { setRuleReviewStatus } from './review';
import { recordRuleDecision, ruleDecisionHistory } from './ruleDecisions';
import { syncTaxRatesFromIrishRules } from './taxRateSync';
import { attachRulesStore, attachedRulesStoreMeta, detachRulesStore, RulesStoreOpenError } from './visibleRules';

/**
 * The rules a book can see (ADR-0021 delivery step 3): the store attached
 * read-only, and one view per rule table over it and the book's frozen
 * versions.
 */

const STANDARD = 'vat.rate_standard_current';

function book() {
  const { db, sqlite } = createTestDatabase();
  const a = createCompany(db, { legalName: 'A Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
  const b = createCompany(db, { legalName: 'B Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
  return { db, sqlite, a, b };
}

/** A frozen version the move onto the store kept, as `retain` writes it. */
function retainVersion(db: ReturnType<typeof book>['db'], companyId: string, ruleVersion: number) {
  const id = ids.ruleVersionRetained();
  db.insert(irishRuleVersionsRetained).values({
    id, companyId, ruleKey: STANDARD, ruleVersion, bookRuleId: 'itr_old', reason: 'no_store_version',
    sourceCitation: 'VATCA 2010', sourceSha256: 'f'.repeat(64), sectionNumber: '46',
    ruleType: 'rate', topic: 'vat', taxHeads: ['vat'], name: 'Standard rate, as the book held it',
    statement: 'the old wording', numericValue: 2300, unit: 'percent', conditions: [], exceptions: [],
    reviewStatus: 'ai_extracted', effectiveFrom: '2021-03-01', effectiveTo: null,
    sourceTitle: 'Value-Added Tax Consolidation Act 2010', sourceType: 'legislation', sourceUrl: 'https://example.ie/vatca',
    provisionHeading: 'Rates of tax', provisionText: 'the old wording', provisionCategory: 'vat',
  }).run();
  return id;
}

describe('the attached store', () => {
  it('is read-only on the book connection', () => {
    const { sqlite } = book();
    expect(() => sqlite.exec('DELETE FROM rules.irish_tax_rules')).toThrow(/read-only/);
    expect(() => sqlite.exec("UPDATE rules.irish_tax_rules SET name = 'x'")).toThrow(/read-only/);
    expect(() => sqlite.exec('INSERT INTO rules.irish_rule_links (id) VALUES (1)')).toThrow(/read-only/);
  });

  it('fails loudly when the store is missing, and leaves no fallback attached', () => {
    const { sqlite } = book();
    detachRulesStore(sqlite);
    expect(() => attachRulesStore(sqlite, { path: '/nowhere/rules.db' })).toThrow(RulesStoreOpenError);
    expect(attachedRulesStoreMeta(sqlite)).toBeNull();
    expect(() => sqlite.prepare('SELECT 1 FROM visible_irish_tax_rules').get()).toThrow(/no such table/);
  });
});

describe('the visible rules', () => {
  it('show every store version once for each company, numbered as the catalogue numbers it', () => {
    const { db, sqlite, a, b } = book();
    const versions = attachedRulesStoreMeta(sqlite)!.versions;
    for (const companyId of [a.companyId, b.companyId]) {
      const rows = db.select({ id: visibleTaxRules.id, ruleKey: visibleTaxRules.ruleKey, ruleVersion: visibleTaxRules.ruleVersion })
        .from(visibleTaxRules).where(eq(visibleTaxRules.companyId, companyId)).all();
      expect(rows).toHaveLength(versions);
      for (const r of rows) expect(r.id).toBe(`${r.ruleKey}@${r.ruleVersion}`);
    }
  });

  it('join each rule to its provision and source once, whatever the number of companies', () => {
    const { db, a } = book();
    const joined = db.select({ id: visibleTaxRules.id }).from(visibleTaxRules)
      .innerJoin(visibleActProvisions, eq(visibleTaxRules.provisionId, visibleActProvisions.id))
      .innerJoin(visibleKnowledgeSources, eq(visibleActProvisions.sourceId, visibleKnowledgeSources.id))
      .where(eq(visibleTaxRules.companyId, a.companyId)).all();
    const rules = db.select({ id: visibleTaxRules.id }).from(visibleTaxRules).where(eq(visibleTaxRules.companyId, a.companyId)).all();
    expect(joined).toHaveLength(rules.length);
  });

  it('show a frozen version to its own company only, with its provision and source as the book held them', () => {
    const { db, a, b } = book();
    const id = retainVersion(db, a.companyId, 3);
    const row = db.select().from(visibleTaxRules)
      .innerJoin(visibleActProvisions, eq(visibleTaxRules.provisionId, visibleActProvisions.id))
      .innerJoin(visibleKnowledgeSources, eq(visibleActProvisions.sourceId, visibleKnowledgeSources.id))
      .where(and(eq(visibleTaxRules.companyId, a.companyId), eq(visibleTaxRules.id, id))).get()!;
    expect(row.visible_irish_tax_rules).toMatchObject({ origin: 'retained', ruleKey: STANDARD, ruleVersion: 3, statement: 'the old wording', active: false });
    expect(row.visible_irish_act_provisions).toMatchObject({ sectionNumber: '46', heading: 'Rates of tax', companyId: a.companyId });
    expect(row.visible_irish_knowledge_sources).toMatchObject({ citation: 'VATCA 2010', sha256: 'f'.repeat(64), sourceUrl: 'https://example.ie/vatca' });
    expect(db.select().from(visibleTaxRules).where(and(eq(visibleTaxRules.companyId, b.companyId), eq(visibleTaxRules.id, id))).all()).toEqual([]);
  });

  it('never apply a frozen version: the lookup reads the store version in force', () => {
    const { db, a } = book();
    const inForce = lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD, asOfDate: '2025-06-01' })!;
    retainVersion(db, a.companyId, 99);
    const after = lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD, asOfDate: '2025-06-01' })!;
    expect(after.origin).toBe('store');
    expect(after.id).toBe(inForce.id);
  });

  it('bind a rule version to the company that bound it, the latest binding first', () => {
    const { db, a, b } = book();
    const version = lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD, asOfDate: '2025-06-01' })!.ruleVersion;
    const bind = (taxRateId: string) => db.insert(irishRuleBindings).values({
      id: ids.ruleBinding(), companyId: a.companyId, ruleKey: STANDARD, ruleVersion: version, taxRateId,
      effectiveFrom: '2021-03-01', recordedBy: 'tax_rate_sync',
    }).run();
    bind(a.ratesByCode['VAT_RED']!);
    bind(a.ratesByCode['VAT_STD']!);
    const bound = (companyId: string) => db.select({ taxRateId: visibleTaxRules.taxRateId }).from(visibleTaxRules)
      .where(and(eq(visibleTaxRules.companyId, companyId), eq(visibleTaxRules.ruleKey, STANDARD), eq(visibleTaxRules.ruleVersion, version))).get()!.taxRateId;
    expect(bound(a.companyId)).toBe(a.ratesByCode['VAT_STD']);
    expect(bound(b.companyId)).toBeNull();
  });
});

describe('decisions on the visible rules', () => {
  it('record a store version in the catalogue numbering, and change no rule row', () => {
    const { db, sqlite, a } = book();
    const rule = lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD, asOfDate: '2025-06-01' })!;
    const storeRow = () => sqlite.prepare('SELECT review_status FROM rules.irish_tax_rules WHERE id = ?').get(rule.id);
    const before = storeRow();
    setRuleReviewStatus(db, { companyId: a.companyId, ruleId: rule.id, status: 'rejected', reviewedBy: 'Aoife', notes: 'wrong section' });
    expect(db.select().from(irishRuleDecisions).all()).toEqual([
      expect.objectContaining({ ruleKey: STANDARD, ruleVersion: rule.ruleVersion, numbering: 'catalogue', ruleId: rule.id, status: 'rejected' }),
    ]);
    expect(storeRow()).toEqual(before);
    // Withdrawn for this company only.
    expect(lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD, asOfDate: '2025-06-01' })).toBeNull();
  });

  it('read a decision the book took before the switch through the version map, never by its number alone', () => {
    const { db, a } = book();
    const rule = lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD, asOfDate: '2025-06-01' })!;
    // The book numbered this version one higher; its decision recorded the book's number.
    db.insert(irishRuleVersionMap).values({
      id: ids.ruleVersionMap(), companyId: a.companyId, ruleKey: STANDARD, bookVersion: rule.ruleVersion + 1,
      catalogueVersion: rule.ruleVersion, storeSignature: 'test',
    }).run();
    recordRuleDecision(db, {
      companyId: a.companyId, ruleKey: STANDARD, ruleVersion: rule.ruleVersion + 1, ruleId: 'itr_book_row', numbering: 'book',
      status: 'approved', decidedBy: 'Aoife', decidedAt: '2025-01-02T00:00:00.000Z',
    });
    const review = ruleReviewResolver(db, { companyId: a.companyId });
    expect(review({ ...rule, sourceSha256: rule.sourceSha256 })).toMatchObject({ from: 'book', status: 'approved', by: 'Aoife' });
    expect(review({ ...rule, ruleVersion: rule.ruleVersion + 1, sourceSha256: rule.sourceSha256 }).from).not.toBe('book');
    expect(ruleDecisionHistory(db, { companyId: a.companyId, ruleKey: STANDARD, ruleVersion: rule.ruleVersion })).toHaveLength(1);
  });

  it('read a book-numbered decision with no mapping as one on the frozen version, not the store version of that number', () => {
    const { db, a } = book();
    const rule = lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD, asOfDate: '2025-06-01' })!;
    retainVersion(db, a.companyId, rule.ruleVersion);
    recordRuleDecision(db, {
      companyId: a.companyId, ruleKey: STANDARD, ruleVersion: rule.ruleVersion, numbering: 'book',
      status: 'rejected', decidedBy: 'Aoife', decidedAt: '2025-01-02T00:00:00.000Z',
    });
    const review = ruleReviewResolver(db, { companyId: a.companyId });
    expect(review({ ...rule, origin: 'retained' })).toMatchObject({ from: 'book', status: 'rejected' });
    expect(review(rule).from).not.toBe('book');
    expect(lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD, asOfDate: '2025-06-01' })?.id).toBe(rule.id);
  });
});

describe('the rate sync', () => {
  it('binds the version to the rate in irish_rule_bindings once, and writes no rule row', () => {
    const { db, a } = book();
    const rule = lookupTaxRule(db, { companyId: a.companyId, ruleKey: STANDARD })!;
    setRuleReviewStatus(db, { companyId: a.companyId, ruleId: rule.id, status: 'approved', reviewedBy: 'Aoife' });
    syncTaxRatesFromIrishRules(db, { companyId: a.companyId });
    syncTaxRatesFromIrishRules(db, { companyId: a.companyId });
    const bindings = db.select().from(irishRuleBindings).where(eq(irishRuleBindings.ruleKey, STANDARD)).all();
    expect(bindings).toEqual([expect.objectContaining({ companyId: a.companyId, ruleVersion: rule.ruleVersion, recordedBy: 'tax_rate_sync' })]);
    const bound = db.select({ taxRateId: visibleTaxRules.taxRateId }).from(visibleTaxRules)
      .where(and(eq(visibleTaxRules.companyId, a.companyId), eq(visibleTaxRules.id, rule.id))).get()!;
    expect(bound.taxRateId).toBe(bindings[0]!.taxRateId);
  });
});

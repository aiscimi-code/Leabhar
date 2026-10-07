import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import {
  invoiceLines, irishRuleDecisions, irishRuleVersionMap, irishTaxRules, reviewItems, suppliers, visibleTaxRules,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { createInvoice } from '../invoicing/invoices';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';
import { readCatalogueEntry } from './catalogue';
import { setRuleReviewStatus } from './review';
import { catalogueRuleStore, checkCatalogueVersions, effectiveRuleReview, recordRuleDecision, ruleDecisionHistory } from './ruleDecisions';
import { deriveStatutoryKnowledgeBase } from './knowledgeBase';

/**
 * A book keeps its own decisions about rule versions; the expert review
 * ships in the catalogue (ADR-0020 §6, issue #686 step 11).
 */
let db: AppDatabase;
let sqlite: ReturnType<typeof createTestDatabase>['sqlite'];
let companyId: string;
let created: ReturnType<typeof createCompany>;

beforeAll(() => {
  ({ db, sqlite } = createTestDatabase());
  created = createCompany(db, { legalName: 'Decisions Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
  ({ companyId } = created);
});

const ruleRow = (ruleKey: string, ruleVersion = 1) => db.select().from(visibleTaxRules)
  .where(and(eq(visibleTaxRules.companyId, companyId), eq(visibleTaxRules.origin, 'store'),
    eq(visibleTaxRules.ruleKey, ruleKey), eq(visibleTaxRules.ruleVersion, ruleVersion))).get()!;

describe('catalogueRuleStore', () => {
  it('holds every catalogued rule version with the review it ships with', () => {
    const store = catalogueRuleStore();
    const s46 = readCatalogueEntry('vatca-2010-revised/s046.json');
    for (const rule of s46.rules) {
      expect(store.keys.has(rule.key)).toBe(true);
      for (const v of rule.versions) expect(store.versions.get(`${rule.key}@${v.version}`)!.review).toEqual(v.review);
    }
  });
});

describe('effectiveRuleReview', () => {
  it('reads the catalogue’s review while the book has taken no decision', () => {
    const review = effectiveRuleReview(db, { companyId, ruleKey: 'vat.rate_livestock_current', ruleVersion: 1 });
    expect(review).toMatchObject({ versionId: 'vat.rate_livestock_current@1', from: 'catalogue', status: 'ai_extracted' });
    expect(review.catalogue!.citation).toBe('2010 Act 31 s.46');
  });

  it('holds nothing for a rule the catalogue does not carry and the book has not decided', () => {
    expect(effectiveRuleReview(db, { companyId, ruleKey: 'no.such_rule', ruleVersion: 1 }))
      .toMatchObject({ from: 'none', status: null, catalogue: null });
  });

  it('follows the book’s latest decision, keeping every earlier one on record', () => {
    const row = ruleRow('vat.rate_reduced_current');
    setRuleReviewStatus(db, { companyId, ruleId: row.id, status: 'human_review', reviewedBy: 'Aoife', notes: 'checking the Schedule' });
    setRuleReviewStatus(db, { companyId, ruleId: row.id, status: 'approved', reviewedBy: 'Brian', notes: 'matches s.46(1)(c)' });

    const history = ruleDecisionHistory(db, { companyId, ruleKey: 'vat.rate_reduced_current', ruleVersion: 1 });
    expect(history.map((d) => [d.status, d.decidedBy, d.reason, d.ruleId])).toEqual([
      ['approved', 'Brian', 'matches s.46(1)(c)', row.id],
      ['human_review', 'Aoife', 'checking the Schedule', row.id],
    ]);
    const review = effectiveRuleReview(db, { companyId, ruleKey: 'vat.rate_reduced_current', ruleVersion: 1 });
    expect(review).toMatchObject({ from: 'book', status: 'approved', by: 'Brian', reason: 'matches s.46(1)(c)' });
    expect(review.catalogue!.review.status).toBe('ai_extracted');
    // The decision is the book's; the store's row is never written.
    expect(ruleRow('vat.rate_reduced_current').reviewStatus).toBe('ai_extracted');
  });
  it('follows the later of two decisions taken in the same millisecond', () => {
    const at = '2026-02-01T09:00:00.000Z';
    for (const [status, decidedBy] of [['human_review', 'Aoife'], ['rejected', 'Brian'], ['approved', 'Ciara']] as const) {
      recordRuleDecision(db, { companyId, ruleKey: 'vat.rate_hospitality', ruleVersion: 1, numbering: 'catalogue', status, decidedBy, decidedAt: at });
    }
    const params = { companyId, ruleKey: 'vat.rate_hospitality', ruleVersion: 1 };
    expect(ruleDecisionHistory(db, params).map((d) => d.decidedBy)).toEqual(['Ciara', 'Brian', 'Aoife']);
    expect(effectiveRuleReview(db, params)).toMatchObject({ from: 'book', status: 'approved', by: 'Ciara' });
  });
});

describe('migration 0058: the decisions a book took before step 11', () => {
  it('carries each reviewed rule’s decision into irish_rule_decisions, and no unreviewed one', () => {
    const { db: d, sqlite: s } = createTestDatabase();
    const { companyId: c } = createCompany(d, { legalName: 'Older Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    deriveStatutoryKnowledgeBase(d, { companyId: c });
    // A decision taken before the table existed lived only on the rule row.
    const row = d.select().from(irishTaxRules).where(and(eq(irishTaxRules.companyId, c), eq(irishTaxRules.ruleKey, 'vat.rate_standard_current'), eq(irishTaxRules.ruleVersion, 1))).get()!;
    d.update(irishTaxRules).set({ reviewStatus: 'rejected', reviewedBy: 'Ciara', reviewedAt: '2026-01-05T10:00:00.000Z', reviewNotes: 'wrong window' })
      .where(eq(irishTaxRules.id, row.id)).run();

    s.exec(readFileSync('drizzle/0058_rule_decisions_backfill.sql', 'utf8'));

    expect(d.select().from(irishRuleDecisions).where(eq(irishRuleDecisions.companyId, c)).all()).toEqual([
      expect.objectContaining({
        id: `rd_migrated_${row.id}`, ruleKey: 'vat.rate_standard_current', ruleVersion: 1, ruleId: row.id,
        status: 'rejected', decidedBy: 'Ciara', decidedAt: '2026-01-05T10:00:00.000Z', reason: 'wrong window',
      }),
    ]);
  });
});

describe('checkCatalogueVersions', () => {
  const missingItems = () => db.select().from(reviewItems)
    .where(and(eq(reviewItems.companyId, companyId), like(reviewItems.dedupeKey, 'rule_version_missing:%'))).all();

  it('finds nothing in a new book', () => {
    expect(checkCatalogueVersions(db, { companyId })).toEqual([]);
    expect(missingItems()).toEqual([]);
  });

  it('reads a decision in the book\'s numbering through the version map', () => {
    // The book numbered vat.rate_livestock_current@1 as 2 before it moved onto the store.
    db.insert(irishRuleVersionMap).values({
      id: ids.ruleVersionMap(), companyId, ruleKey: 'vat.rate_livestock_current', bookVersion: 2, catalogueVersion: 1, storeSignature: 'test',
    }).run();
    recordRuleDecision(db, {
      companyId, ruleKey: 'vat.rate_livestock_current', ruleVersion: 2, numbering: 'book',
      status: 'approved', decidedBy: 'Ciara', decidedAt: '2026-01-05T10:00:00.000Z',
    });
    expect(checkCatalogueVersions(db, { companyId })).toEqual([]);
  });

  it('raises a review item, once, for a version a posted line applied that the store does not hold', () => {
    const supplierId = ids.supplier();
    db.insert(suppliers).values({ id: supplierId, companyId, name: 'Byrne', matchKey: 'byrne', countryCode: 'IE' }).run();
    const { invoiceId } = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2025, 3, 10), invoiceNumber: 'V-9', supplierId,
      lines: [{ description: 'Stationery', netMinor: 10_000, accountId: created.accountsByCode['6070']!, vatTreatmentId: created.treatmentsByCode['IE_STD']!, vatRuleKeys: ['vat.rate_standard_current'] }],
    });
    // A version from a newer install than this one: the store attached here does not hold it.
    db.update(invoiceLines).set({ vatRuleVersions: ['vat.rate_standard_current@99'] }).where(eq(invoiceLines.invoiceId, invoiceId)).run();

    expect(checkCatalogueVersions(db, { companyId })).toEqual([
      { versionId: 'vat.rate_standard_current@99', numbering: 'catalogue', referencedBy: ['invoice_line'] },
    ]);
    checkCatalogueVersions(db, { companyId });
    const items = missingItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'warning', entityType: 'irish_rule_key', entityId: 'vat.rate_standard_current' });
    expect(items[0]!.detail).toContain('nothing has been switched to another version');
  });
});

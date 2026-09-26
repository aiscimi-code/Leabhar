import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules, VATCA_REVISED_S046_MD_PATH } from './vatcaRevisedIngestion';
import { setRuleReviewStatus } from './review';
import { syncTaxRatesFromIrishRules, TAX_RATE_SYNC_MAP } from './taxRateSync';
import { taxRates, irishTaxRules, auditEvents, reviewItems } from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
const s46Markdown = readFileSync(VATCA_REVISED_S046_MD_PATH, 'utf8');

/** Approve the version in force today (a rate is a family of dated versions, issue #205). */
function approve(ruleKey: string) {
  const row = db.select({ id: irishTaxRules.id }).from(irishTaxRules)
    .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, ruleKey), eq(irishTaxRules.active, true))).get()!;
  setRuleReviewStatus(db, { ruleId: row.id, status: 'approved', reviewedBy: 'tester' });
}

function currentTaxRate(code: string) {
  return db.select().from(taxRates)
    .where(and(
      eq(taxRates.companyId, companyId), eq(taxRates.code, code),
      eq(taxRates.active, true), isNull(taxRates.effectiveTo),
    )).get();
}

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Rates Sync Ltd', seedYears: [2025] }));
});

describe('syncTaxRatesFromIrishRules', () => {
  it('skips every mapping when nothing has been ingested/derived yet', () => {
    const results = syncTaxRatesFromIrishRules(db, { companyId });
    expect(results).toHaveLength(TAX_RATE_SYNC_MAP.length);
    expect(results.every((r) => r.outcome === 'skipped_no_curated_rule')).toBe(true);
  });

  it('skips an unapproved (ai_extracted) curated rule, never auto-applying it to live config', () => {
    ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    deriveVatcaRevisedRules(db, { companyId });

    const results = syncTaxRatesFromIrishRules(db, { companyId });
    const standard = results.find((r) => r.ruleKey === 'vat.rate_standard_current')!;
    expect(standard.outcome).toBe('skipped_not_reviewed');

    // The seeded default (23%) is untouched.
    const rate = currentTaxRate('VAT_STD')!;
    expect(rate.rateBasisPoints).toBe(2300);
  });

  it('links, without changing the rate, when the approved curated figure already matches the seeded default', () => {
    ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    deriveVatcaRevisedRules(db, { companyId });
    approve('vat.rate_standard_current');

    const before = currentTaxRate('VAT_STD')!;
    const results = syncTaxRatesFromIrishRules(db, { companyId });
    const standard = results.find((r) => r.ruleKey === 'vat.rate_standard_current')!;
    expect(standard.outcome).toBe('linked');
    expect(standard.taxRateId).toBe(before.id);

    const after = currentTaxRate('VAT_STD')!;
    expect(after.id).toBe(before.id);
    expect(after.rateBasisPoints).toBe(2300);

    const curatedRow = db.select({ taxRateId: irishTaxRules.taxRateId }).from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.rate_standard_current'),
        eq(irishTaxRules.active, true)))
      .get()!;
    expect(curatedRow.taxRateId).toBe(before.id);
  });

  it('is idempotent: a second run reports unchanged, not linked again', () => {
    ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    deriveVatcaRevisedRules(db, { companyId });
    approve('vat.rate_standard_current');

    syncTaxRatesFromIrishRules(db, { companyId });
    const second = syncTaxRatesFromIrishRules(db, { companyId });
    const standard = second.find((r) => r.ruleKey === 'vat.rate_standard_current')!;
    expect(standard.outcome).toBe('unchanged');
  });

  it('supersedes (never edits in place) when the approved curated figure genuinely differs, with a derived-source audit event', () => {
    ingestVatcaRevisedSection(db, { companyId, markdown: s46Markdown, ingestVersion: 'v1' });
    deriveVatcaRevisedRules(db, { companyId });
    approve('vat.rate_standard_current');

    // Simulate a rate change the curated source has since picked up: a later
    // (but already-in-force) effective date and a different figure than the
    // seeded default — lookupTaxRule only returns rules in force as of today,
    // so this must be in the past relative to the test run.
    db.update(irishTaxRules).set({ numericValue: 24, effectiveFrom: '2025-06-01' })
      .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, 'vat.rate_standard_current')))
      .run();

    const before = currentTaxRate('VAT_STD')!;
    const results = syncTaxRatesFromIrishRules(db, { companyId });
    const standard = results.find((r) => r.ruleKey === 'vat.rate_standard_current')!;
    expect(standard.outcome).toBe('superseded');
    expect(standard.taxRateId).not.toBe(before.id);

    const closed = db.select().from(taxRates).where(eq(taxRates.id, before.id)).get()!;
    expect(closed.active).toBe(true); // supersedeTaxRate only closes the effective window, never deactivates
    expect(closed.effectiveTo).toBe('2025-05-31');

    const after = currentTaxRate('VAT_STD')!;
    expect(after.rateBasisPoints).toBe(2400);
    expect(after.effectiveFrom).toBe('2025-06-01');

    const audit = db.select().from(auditEvents)
      .where(eq(auditEvents.entityId, standard.taxRateId!)).get()!;
    expect(audit.source).toBe('derived');

    const items = db.select().from(reviewItems)
      .where(eq(reviewItems.dedupeKey, `tax_rate_sync:${standard.taxRateId}`)).all();
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('info');
  });

  it('never syncs VAT_SECOND_RED or any non-mapped code — this KB curates no current fact for it', () => {
    expect(TAX_RATE_SYNC_MAP.some((m) => m.taxRateCode === 'VAT_SECOND_RED')).toBe(false);
  });
});

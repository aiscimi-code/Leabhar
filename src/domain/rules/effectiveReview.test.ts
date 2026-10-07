import { describe, it, expect, beforeAll, vi } from 'vitest';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishTaxRules } from '@/db/schema';
import type { AppDatabase } from '@/db';

/**
 * Every reader follows the review a book follows (issue #718): the book's own
 * latest decision, else the catalogue's review of the version that says the
 * same thing, else the status the row was derived with. The installed
 * catalogue is a copy here, so a test can ship a review in it.
 */
const root = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  return mkdtempSync(join(tmpdir(), 'leabhar-install-'));
});
vi.mock('@/lib/paths', async (original) => ({ ...(await original<typeof import('@/lib/paths')>()), appRoot: () => root }));

const { readCatalogueEntry, serialiseCatalogueEntry, UNREVIEWED } = await import('./catalogue');
const { loadStatutoryKnowledgeBase } = await import('./knowledgeBase');
const { lookupTaxRule, listTaxRulesByTopic } = await import('./irishRules');
const { resolveRuleFigure } = await import('./ruleFigures');
const { explainRule } = await import('./ruleInfo');
const { generateAuditReport } = await import('./audit');
const { syncTaxRatesFromIrishRules } = await import('./taxRateSync');
const { setRuleReviewStatus } = await import('./review');
const { effectiveRuleReview } = await import('./ruleDecisions');

const ENTRY = 'vatca-2010-revised/s046.json';
const KEY = 'vat.rate_reduced_current';
const ASOF = '2026-06-30';

let db: AppDatabase;
let companyId: string;

beforeAll(() => {
  cpSync('catalogue', join(root, 'catalogue'), { recursive: true });
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Shipped Review Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  loadStatutoryKnowledgeBase(db, { companyId });
});

/** The book's row in force for the key, as derived (whatever its review). */
const bookRow = () => db.select().from(irishTaxRules)
  .where(and(eq(irishTaxRules.companyId, companyId), eq(irishTaxRules.ruleKey, KEY))).all()
  .find((r) => r.effectiveFrom <= ASOF && (r.effectiveTo === null || r.effectiveTo > ASOF))!;

/** Ship a review of the catalogue version that says what the book's row says, renumbering the key's versions by `shift`. */
function shipReview(review: { status: 'approved' | 'rejected' | 'ai_extracted'; sourceSha256?: string }, shift = 0) {
  const row = bookRow();
  const entry = readCatalogueEntry(ENTRY);
  entry.rules = entry.rules.map((r) => (r.key !== KEY ? r : {
    ...r,
    versions: r.versions.map((v) => ({
      ...v,
      version: v.version + shift,
      review: v.effectiveFrom === row.effectiveFrom && v.quote === row.statement && review.status !== 'ai_extracted'
        ? { status: review.status, by: 'Dara (tax adviser)', at: '2026-09-01', sourceSha256: review.sourceSha256 ?? entry.source.sha256, note: 'read against s.46(1)(c)' }
        : UNREVIEWED,
    })),
  }));
  writeFileSync(join(root, 'catalogue', ENTRY), serialiseCatalogueEntry(entry));
}

const curated = { ruleKey: KEY, numericValue: 13.5, name: 'Reduced rate' };

describe('a review shipped in the catalogue', () => {
  it('leaves every reader on the derived status while the catalogue ships none', () => {
    shipReview({ status: 'ai_extracted' });
    expect(lookupTaxRule(db, { companyId, ruleKey: KEY, asOfDate: ASOF })).toMatchObject({ reviewStatus: 'ai_extracted', reviewedIn: 'derived' });
    expect(resolveRuleFigure(db, { companyId, ruleKey: KEY as never, asOfDate: ASOF, curated }).status).toBe('unreviewed');
  });

  it('reaches every reader when the catalogue approves the version the book holds', () => {
    shipReview({ status: 'approved' });
    expect(lookupTaxRule(db, { companyId, ruleKey: KEY, asOfDate: ASOF })).toMatchObject({ reviewStatus: 'approved', reviewedIn: 'catalogue' });
    const figure = resolveRuleFigure(db, { companyId, ruleKey: KEY as never, asOfDate: ASOF, curated });
    expect(figure).toMatchObject({ status: 'approved', reviewStatus: 'approved', finding: null });
    expect(explainRule(db, { companyId, ruleId: bookRow().id })!.explanation)
      .toContain('its review status is approved in the rules catalogue by Dara (tax adviser)');
    expect(generateAuditReport(db, { companyId }).rulesByReviewStatus.approved).toBe(1);
    expect(syncTaxRatesFromIrishRules(db, { companyId }).find((r) => r.ruleKey === KEY)!.outcome).not.toBe('skipped_not_reviewed');
    // The book's own row is not written: the review is read, not copied.
    expect(bookRow().reviewStatus).toBe('ai_extracted');
  });

  it('matches the version by what it says, whatever the catalogue numbered it', () => {
    shipReview({ status: 'approved' }, 1);
    expect(lookupTaxRule(db, { companyId, ruleKey: KEY, asOfDate: ASOF })).toMatchObject({ reviewStatus: 'approved', reviewedIn: 'catalogue' });
    const row = bookRow();
    expect(effectiveRuleReview(db, { companyId, ruleKey: KEY, ruleVersion: row.ruleVersion }))
      .toMatchObject({ from: 'catalogue', status: 'approved', by: 'Dara (tax adviser)' });
  });

  it('does not hold for a source other than the one the reviewer read', () => {
    shipReview({ status: 'approved', sourceSha256: 'f'.repeat(64) });
    expect(lookupTaxRule(db, { companyId, ruleKey: KEY, asOfDate: ASOF })).toMatchObject({ reviewStatus: 'ai_extracted', reviewedIn: 'derived' });
  });

  it('withdraws a version the catalogue rejected, and names who rejected it', () => {
    shipReview({ status: 'rejected' });
    expect(lookupTaxRule(db, { companyId, ruleKey: KEY, asOfDate: ASOF })).toBeNull();
    expect(listTaxRulesByTopic(db, { companyId, topic: bookRow().topic, asOfDate: ASOF }).map((r) => r.ruleKey)).not.toContain(KEY);
    const figure = resolveRuleFigure(db, { companyId, ruleKey: KEY as never, asOfDate: ASOF, curated });
    expect(figure).toMatchObject({ status: 'rejected', numericValue: null });
    expect(figure.finding).toBe('Rule "' + bookRow().name + '" (' + KEY + ') was rejected in the rules catalogue by Dara (tax adviser) (read against s.46(1)(c)).');
  });

  it('gives way to the book’s own decision', () => {
    shipReview({ status: 'rejected' });
    setRuleReviewStatus(db, { ruleId: bookRow().id, status: 'approved', reviewedBy: 'Eimear', notes: 'checked the Schedule myself' });
    expect(lookupTaxRule(db, { companyId, ruleKey: KEY, asOfDate: ASOF })).toMatchObject({ reviewStatus: 'approved', reviewedIn: 'book' });

    shipReview({ status: 'approved' });
    setRuleReviewStatus(db, { ruleId: bookRow().id, status: 'rejected', reviewedBy: 'Eimear', notes: 'not for this book' });
    expect(lookupTaxRule(db, { companyId, ruleKey: KEY, asOfDate: ASOF })).toBeNull();
    expect(effectiveRuleReview(db, { companyId, ruleKey: KEY, ruleVersion: bookRow().ruleVersion }))
      .toMatchObject({ from: 'book', status: 'rejected', by: 'Eimear' });
    expect(resolveRuleFigure(db, { companyId, ruleKey: KEY as never, asOfDate: ASOF, curated }).finding)
      .toContain('was rejected on the rule review screen by Eimear');
  });
});

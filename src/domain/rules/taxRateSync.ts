/**
 * Bridges the deterministically-curated, source-hash-verified VAT rate facts
 * in `irish_tax_rules` into the app's own live `tax_rates` configuration
 * (issue #133).
 *
 * `docs/statutes/vat-rates/rates.json` was the other candidate source this
 * issue considered — a hand-compiled, effective-dated administrative table,
 * cross-checked against the curated rules for accuracy but carrying no
 * source hash of its own (docs/statutes/SOURCE-REGISTER.md documents it as
 * reference-only, never read by application code). This module deliberately
 * never reads it: `irish_tax_rules` rows sourced from the LRC-revised VATCA
 * text (`vatcaRevisedCuration.ts`, source_html_sha256-backed) are the
 * actually-verified source, so `tax_rates` is synced from those, not from
 * a hand-transcribed cross-check file. `rates.json` stays exactly what its
 * own docs already say it is: human reference material.
 *
 * `tax_rates` is real, live financial configuration — the standard/reduced/
 * livestock rows here directly drive invoice VAT calculation — so this
 * follows the same supersede-never-overwrite discipline every other rate
 * change in this app uses (`src/domain/config/mutations.ts`'s own
 * `supersedeTaxRate`): a rate change is a new effective-dated row, never an
 * edit to an existing one, so a transaction dated before the change keeps
 * resolving what applied on its own date (README §6 / AGENTS.md invariant
 * #6). A curated rule is only trusted to drive this automatically once a
 * human has approved it (`reviewStatus: 'approved'` or `'active'`) — an
 * `ai_extracted` rule is exactly as unreviewed here as everywhere else in
 * this KB (RULES_KB.md: "never active-equivalent... until a human
 * approves it"), and live invoicing config is not the place to relax that.
 * Every sync-driven change is recorded as a `derived`-sourced audit event
 * and surfaced in the review queue, since even an approved, verified source
 * changing live financial config warrants a human's attention, not a
 * silent write (AGENTS.md invariant #7).
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { taxRates, irishTaxRules } from '@/db/schema';
import { lookupTaxRule } from './irishRules';
import { supersedeTaxRate, createTaxRate } from '../config/mutations';
import { upsertReviewItem } from '../extraction/service';
import { asIsoDate } from '../dates';

export interface TaxRateSyncMapping {
  /** A curated irish_tax_rules ruleKey stating a plain current percentage rate. */
  ruleKey: string;
  /** The matching tax_rates.code (from DEFAULT_TAX_RATES) this rule's figure backs. */
  taxRateCode: string;
}

/**
 * Only rate facts this KB has actually source-hash-verified against current
 * LRC-revised text (`vatcaRevisedCuration.ts`) are synced. `VAT_SECOND_RED`
 * (the 9% second-reduced rate), corporation tax and every other `tax_rates`
 * row are deliberately excluded: this KB does not yet curate a current,
 * unconditional fact for any of them — see
 * `vat.rate_hospitality_9pct_not_modelled`'s own "not modelled" note for why
 * the second-reduced rate specifically has none. Syncing from an absent
 * source would mean inventing one.
 */
export const TAX_RATE_SYNC_MAP: TaxRateSyncMapping[] = [
  { ruleKey: 'vat.rate_standard_current', taxRateCode: 'VAT_STD' },
  { ruleKey: 'vat.rate_reduced_current', taxRateCode: 'VAT_RED' },
  { ruleKey: 'vat.rate_livestock_current', taxRateCode: 'VAT_LIVESTOCK' },
];

export type TaxRateSyncOutcome =
  | 'unchanged' // tax_rates already matches the curated figure and date
  | 'linked' // unchanged, but the irish_tax_rules row's taxRateId back-link was set/corrected
  | 'superseded' // a new effective-dated tax_rates row was created, closing the old one
  | 'created' // no tax_rates row existed for this code yet; one was created
  | 'skipped_no_curated_rule' // the ruleKey has not been derived for this company
  | 'skipped_not_reviewed' // derived but not yet human-approved — never auto-applied to live config
  | 'skipped_not_a_percent'; // defensive: the curated rule doesn't state a plain percent (shouldn't happen for this map)

export interface TaxRateSyncResult {
  ruleKey: string;
  taxRateCode: string;
  outcome: TaxRateSyncOutcome;
  taxRateId?: string;
}

/**
 * Sync `tax_rates` VAT rows from the curated, human-approved `irish_tax_rules`
 * facts in `TAX_RATE_SYNC_MAP`. Idempotent: run it as often as you like — it
 * only writes when the curated source actually states something new and
 * approved.
 */
export function syncTaxRatesFromIrishRules(
  db: AppDatabase,
  params: { companyId: string; actor?: string },
): TaxRateSyncResult[] {
  return TAX_RATE_SYNC_MAP.map((mapping) => syncOne(db, params.companyId, mapping, params.actor));
}

const APPROVED_STATUSES = new Set(['approved', 'active']);

function syncOne(
  db: AppDatabase,
  companyId: string,
  mapping: TaxRateSyncMapping,
  actor: string | undefined,
): TaxRateSyncResult {
  const base = { ruleKey: mapping.ruleKey, taxRateCode: mapping.taxRateCode };
  const curated = lookupTaxRule(db, { companyId, ruleKey: mapping.ruleKey });
  if (!curated) return { ...base, outcome: 'skipped_no_curated_rule' };
  if (!APPROVED_STATUSES.has(curated.reviewStatus)) return { ...base, outcome: 'skipped_not_reviewed' };
  if (curated.unit !== 'percent' || curated.value === null) return { ...base, outcome: 'skipped_not_a_percent' };

  const newRateBasisPoints = Math.round(curated.value * 100);
  const current = db.select().from(taxRates)
    .where(and(
      eq(taxRates.companyId, companyId),
      eq(taxRates.code, mapping.taxRateCode),
      eq(taxRates.active, true),
      isNull(taxRates.effectiveTo),
    )).get();

  const sourceNote = `Verified against ${curated.citation} s.${curated.sectionNumber} `
    + `(LRC-revised text, source_html_sha256-backed — see docs/RULES_KB.md "VATCA 2010 current rates"). `
    + curated.sourceUrl;

  if (!current) {
    const taxRateId = createTaxRate(db, {
      companyId,
      code: mapping.taxRateCode,
      name: curated.name,
      rateBasisPoints: newRateBasisPoints,
      taxType: 'vat',
      effectiveFrom: asIsoDate(curated.effectiveFrom),
      sourceNote,
      actor: actor ?? 'irish-rules-kb-sync',
      source: 'derived',
    });
    linkAndReview(db, companyId, mapping, curated.id, taxRateId, 'created');
    return { ...base, outcome: 'created', taxRateId };
  }

  const alreadyCurrent = current.rateBasisPoints === newRateBasisPoints
    && current.effectiveFrom === curated.effectiveFrom;
  if (alreadyCurrent) {
    const linked = ensureLinked(db, curated.id, current.id);
    return { ...base, outcome: linked ? 'linked' : 'unchanged', taxRateId: current.id };
  }

  if (curated.effectiveFrom <= current.effectiveFrom) {
    // The curated source's own effective date isn't strictly after what's
    // already on file — supersedeTaxRate requires a strictly later date
    // (never rewrite history), and a date this old is not new information
    // worth acting on automatically; leave it for a human to reconcile.
    return { ...base, outcome: 'unchanged', taxRateId: current.id };
  }

  const { newRateId } = supersedeTaxRate(db, {
    companyId,
    taxRateId: current.id,
    newRateBasisPoints,
    effectiveFrom: asIsoDate(curated.effectiveFrom),
    sourceNote,
    actor: actor ?? 'irish-rules-kb-sync',
    source: 'derived',
  });
  linkAndReview(db, companyId, mapping, curated.id, newRateId, 'superseded');
  return { ...base, outcome: 'superseded', taxRateId: newRateId };
}

function ensureLinked(db: AppDatabase, curatedRuleId: string, taxRateId: string): boolean {
  const row = db.select({ taxRateId: irishTaxRules.taxRateId }).from(irishTaxRules)
    .where(eq(irishTaxRules.id, curatedRuleId)).get();
  if (row?.taxRateId === taxRateId) return false;
  db.update(irishTaxRules).set({ taxRateId }).where(eq(irishTaxRules.id, curatedRuleId)).run();
  return true;
}

function linkAndReview(
  db: AppDatabase, companyId: string, mapping: TaxRateSyncMapping,
  curatedRuleId: string, taxRateId: string, reason: 'created' | 'superseded',
): void {
  db.update(irishTaxRules).set({ taxRateId }).where(eq(irishTaxRules.id, curatedRuleId)).run();
  upsertReviewItem(db, {
    companyId,
    kind: 'other',
    severity: 'info',
    title: `Tax rate ${reason} from a verified source: ${mapping.taxRateCode}`,
    detail: `${mapping.taxRateCode} was ${reason} by syncing from the approved curated rule `
      + `${mapping.ruleKey} (source_html_sha256-verified LRC-revised VATCA text). Review the new rate `
      + 'and its effective date before relying on it for filing.',
    entityType: 'tax_rate',
    entityId: taxRateId,
    dedupeKey: `tax_rate_sync:${taxRateId}`,
    context: { ruleKey: mapping.ruleKey, taxRateCode: mapping.taxRateCode, reason },
  });
}

/**
 * S.I. No. 301 of 2024 (issue #555): ingest the Regulations as a sliced source
 * and derive the figures they replaced, and the s.280I election, one dated
 * version per row (`sizeCriteriaCuration.ts`).
 */
import type { AppDatabase } from '@/db';
import { deriveCuratedRuleFamilies, type IncomeTaxDeriveResult } from './incomeTaxIngestion';
import { ingestSlicedSource } from './slicedSourceIngestion';
import { SIZE_CRITERIA_SOURCES, SIZE_CRITERIA_CURATED_RULES } from './sizeCriteriaCuration';

export { SIZE_CRITERIA_SOURCES };

/** Ingest S.I. 301/2024. Idempotent by content. */
export function ingestSizeCriteriaSource(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath: string },
): { sourceId: string; ingested: boolean } {
  return ingestSlicedSource(db, SIZE_CRITERIA_SOURCES, 'Company size criteria: the figures S.I. 301/2024 replaced, and the '
    + 's.280I election on which financial years the new figures apply to (issue #555).', params);
}

export function deriveSizeCriteriaRules(db: AppDatabase, params: { companyId: string }): IncomeTaxDeriveResult {
  return deriveCuratedRuleFamilies(db, { companyId: params.companyId, rules: SIZE_CRITERIA_CURATED_RULES, label: 'company size' });
}

/**
 * S.I. No. 301 of 2024 (issue #555): derive the figures it replaced, and the
 * s.280I election, one dated version per row (`sizeCriteriaCuration.ts`). The
 * Regulations load from their rules catalogue entry (#556).
 */
import type { AppDatabase } from '@/db';
import { deriveCuratedRuleFamilies, type IncomeTaxDeriveResult } from './incomeTaxIngestion';
import { SIZE_CRITERIA_CURATED_RULES } from './sizeCriteriaCuration';

export function deriveSizeCriteriaRules(db: AppDatabase, params: { companyId: string }): IncomeTaxDeriveResult {
  return deriveCuratedRuleFamilies(db, { companyId: params.companyId, rules: SIZE_CRITERIA_CURATED_RULES, label: 'company size' });
}

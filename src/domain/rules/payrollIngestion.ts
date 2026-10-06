/**
 * The payroll sources (EPICs 20 and 21, issues #526, #532), and the derive
 * step for the curated payroll rules. Each provision is an exact slice of its
 * committed file (`slicedSourceIngestion.ts`).
 */
import type { AppDatabase } from '@/db';
import { deriveCuratedRuleFamilies, type IncomeTaxDeriveResult } from './incomeTaxIngestion';
import { PAYROLL_CURATED_RULES } from './payrollCuration';
import { ingestSlicedSource, sliceProvision, type SlicedSource } from './slicedSourceIngestion';

export { sliceProvision };

/** Ported to the catalogue (#556). The knowledge base loads these entries. */
export const PAYROLL_CATALOGUE_ENTRIES = [
  'swca-2005/s13.json',
  'swmpa-2024/s3.json',
  'swa-2024/s2.json',
  'swaerss-2025/s2.json',
  'ntf-2000/s4.json',
  'si-345-2018/2018-si-345.json',
  'si-1-2024/2024-si-1.json',
  'si-510-2018/2018-si-510.json',
  'tdm-38-03-33/38-03-33.json',
] as const;


export const PAYROLL_SOURCES: SlicedSource[] = [];

/** Ingest one payroll source file. Idempotent by content. */
export function ingestPayrollSource(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath: string },
): { sourceId: string; ingested: boolean } {
  return ingestSlicedSource(db, PAYROLL_SOURCES, 'Payroll: PAYE, USC and PRSI an employer deducts and pays, and the benefits it reports '
    + '(EPICs 20 and 21).', params);
}

/** Derive the curated payroll rules, one dated version per row, chained by `supersedesRuleId`. */
export function derivePayrollRules(db: AppDatabase, params: { companyId: string }): IncomeTaxDeriveResult {
  return deriveCuratedRuleFamilies(db, { companyId: params.companyId, rules: PAYROLL_CURATED_RULES, label: 'payroll' });
}

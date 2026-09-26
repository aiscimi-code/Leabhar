import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { DEFAULT_VAT_TREATMENTS } from '../config/vatTreatments';
import { irishTaxRules } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import {
  COVERAGE_MATRIX_PATH, expectedCoverageRows, producibleTreatments, validateCoverageMatrix,
  formatCoverageSummary, type CoverageMatrix, type CoverageRow,
} from './coverage';

/**
 * Issue #204: completeness is proved by a test, not asserted. The matrix has
 * a row for every provision, treatment and transaction type in scope, each
 * with exactly one status, and it agrees with the rules the knowledge base
 * actually derives.
 */

const matrix = JSON.parse(readFileSync(COVERAGE_MATRIX_PATH, 'utf8')) as CoverageMatrix;
const treatmentCodes = DEFAULT_VAT_TREATMENTS.map((t) => t.code);
let derivedRuleKeys: string[];

beforeAll(() => {
  const { db } = createTestDatabase();
  const { companyId } = createCompany(db, { legalName: 'Coverage Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
  loadStatutoryKnowledgeBase(db, { companyId });
  derivedRuleKeys = db.select({ key: irishTaxRules.ruleKey }).from(irishTaxRules)
    .where(eq(irishTaxRules.companyId, companyId)).all().map((r) => r.key);
});

const check = (m: CoverageMatrix) => validateCoverageMatrix({
  matrix: m,
  expected: expectedCoverageRows({ root: process.cwd(), treatmentCodes }),
  derivedRuleKeys,
  producible: producibleTreatments(),
});

describe('rule coverage matrix', () => {
  it('covers every provision, treatment and transaction type, and agrees with the derived rules', () => {
    const report = check(matrix);
    // Printed every run, so progress is measured the same way each time.
    console.log(`\nRule coverage (${matrix.rows.length} rows, ${derivedRuleKeys.length} derived rules)\n${formatCoverageSummary(report.summary)}\n`);
    expect(report.errors).toEqual([]);
  });

  it('reads its rows from the sources: every enacted VATCA section, the inserted ones and each schedule paragraph', () => {
    const expected = expectedCoverageRows({ root: process.cwd(), treatmentCodes });
    const sections = expected.filter((r) => r.area === 'vatca_section').map((r) => r.id);
    expect(sections).toContain('vatca:s1');
    expect(sections).toContain('vatca:s125');
    expect(sections).toEqual(expect.arrayContaining(['vatca:s91A', 'vatca:s92D', 'vatca:s108C']));
    expect(sections.filter((id) => /^vatca:s\d+$/.test(id))).toHaveLength(125);
    const schedules = expected.filter((r) => r.area === 'vatca_schedule').map((r) => r.id);
    expect(schedules).toEqual(expect.arrayContaining(['vatca:sch1:p2:14', 'vatca:sch3:p4:21', 'vatca:sch5:3', 'vatca:sch9:part3']));
  });

  describe('fails when', () => {
    const withRows = (edit: (rows: CoverageRow[]) => CoverageRow[]): CoverageMatrix => ({ ...matrix, rows: edit(structuredClone(matrix.rows)) });

    it('a row has no status', () => {
      const m = withRows((rows) => rows.map((r) => (r.id === 'vatca:s1' ? { ...r, status: undefined as never } : r)));
      expect(check(m).errors).toContain('vatca:s1: no status (got "undefined")');
    });

    it('a row the sources define is missing', () => {
      const m = withRows((rows) => rows.filter((r) => r.id !== 'vatca:sch2:p2:9A'));
      expect(check(m).errors.some((e) => e.startsWith('vatca:sch2:p2:9A: missing'))).toBe(true);
    });

    it('a rule row names a rule key that is not derived', () => {
      const m = withRows((rows) => rows.map((r) => (r.id === 'vatca:s46' ? { ...r, ruleKeys: [...r.ruleKeys!, 'vat.rate_invented'] } : r)));
      expect(check(m).errors).toContain('vatca:s46: ruleKey "vat.rate_invented" is not derived by the knowledge base');
    });

    it('a derived rule is in no row', () => {
      const m = withRows((rows) => rows.filter((r) => r.id !== 'fa2024:s48'));
      expect(check(m).errors).toContain('rule "film.tax_credit_rate" is derived but in no matrix row');
    });

    it('a treatment is marked covered but no rule can produce it', () => {
      const m = withRows((rows) => rows.map((r) => (r.id === 'treatment:RC_CONSTRUCTION'
        ? { ...r, status: 'rule' as const, ruleKeys: ['vat.rate_standard_current'], issue: undefined, reason: undefined } : r)));
      expect(check(m).errors).toContain('treatment:RC_CONSTRUCTION: marked "rule" but no rule binding can produce RC_CONSTRUCTION');
    });

    it('a deferred row names no issue, or a not_applicable row gives no reason', () => {
      const m = withRows((rows) => rows.map((r) => (r.id === 'vatca:s16' ? { ...r, issue: undefined }
        : r.id === 'vatca:s1' ? { ...r, reason: '' } : r)));
      const { errors } = check(m);
      expect(errors).toContain('vatca:s16: deferred without an issue number');
      expect(errors).toContain('vatca:s1: not_applicable without a reason');
    });
  });
});

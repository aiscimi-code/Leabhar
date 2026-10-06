import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { ingestVatca2010FromCatalogue } from './vatcaIngestion';
import { compareRuleVersions } from './versionCompare';
import { irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let provisionId: string;

const RULE_KEY = 'test.threshold_versioned';

beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Version Ltd', seedYears: [2025] }));
  ingestVatca2010FromCatalogue(db, { companyId });
  provisionId = db.select({ id: irishActProvisions.id }).from(irishActProvisions)
    .limit(1).all()[0]!.id;
});

/** A rule row, in the shape the ingestion pipeline writes. */
function insertRule(overrides: Partial<typeof irishTaxRules.$inferInsert> & { ruleVersion: number }) {
  const id = ids.taxRule();
  db.insert(irishTaxRules).values({
    id,
    companyId,
    provisionId,
    ruleKey: RULE_KEY,
    topic: 'vat',
    name: 'Versioned threshold',
    statement: 'The threshold is €75,000.',
    reviewStatus: 'superseded',
    effectiveFrom: '2010-01-01',
    ...overrides,
  }).run();
  return id;
}

describe('compareRuleVersions', () => {
  it('returns null for a key the company has no rule for', () => {
    expect(compareRuleVersions(db, { companyId, ruleKey: 'no.such_rule' })).toBeNull();
  });

  it('lists a single version with no changes', () => {
    insertRule({ ruleVersion: 1 });
    const comparison = compareRuleVersions(db, { companyId, ruleKey: RULE_KEY });
    expect(comparison!.versions).toHaveLength(1);
    expect(comparison!.versions[0]!.changes).toEqual([]);
    expect(comparison!.versions[0]!.ruleVersion).toBe(1);
  });

  it('diffs a superseded rule against its successor, oldest first', () => {
    const oldId = insertRule({
      ruleVersion: 1,
      statement: 'The threshold is €75,000.',
      numericValue: 7_500_000,
      unit: 'eur_minor',
      conditions: [{ field: 'supplyType', operator: 'equals', value: 'goods' }],
      effectiveFrom: '2010-01-01',
      effectiveTo: '2024-12-31',
      reviewStatus: 'superseded',
    });
    insertRule({
      ruleVersion: 2,
      supersedesRuleId: oldId,
      statement: 'The threshold is €85,000.',
      numericValue: 8_500_000,
      unit: 'eur_minor',
      conditions: [{ field: 'supplyType', operator: 'equals', value: 'goods' }],
      effectiveFrom: '2025-01-01',
      reviewStatus: 'ai_extracted',
    });

    const comparison = compareRuleVersions(db, { companyId, ruleKey: RULE_KEY });
    expect(comparison!.ruleKey).toBe(RULE_KEY);
    expect(comparison!.versions.map((v) => v.ruleVersion)).toEqual([1, 2]);

    const v1 = comparison!.versions[0]!;
    const v2 = comparison!.versions[1]!;
    expect(v1.supersededByRuleId).toBe(v2.ruleId);
    expect(v2.supersedesRuleId).toBe(v1.ruleId);
    expect(v2.supersededByRuleId).toBeNull();

    const changed = new Map(v2.changes.map((c) => [c.field, c]));
    expect(changed.get('statement')).toEqual({
      field: 'statement', from: 'The threshold is €75,000.', to: 'The threshold is €85,000.',
    });
    expect(changed.get('numericValue')).toEqual({
      field: 'numericValue', from: '7500000 eur_minor', to: '8500000 eur_minor',
    });
    expect(changed.get('effectiveFrom')).toEqual({
      field: 'effectiveFrom', from: '2010-01-01', to: '2025-01-01',
    });
    expect(changed.get('effectiveTo')).toEqual({
      field: 'effectiveTo', from: '2024-12-31', to: 'not stated',
    });
    expect(changed.get('reviewStatus')).toEqual({
      field: 'reviewStatus', from: 'superseded', to: 'ai_extracted',
    });
    // The condition list did not change, so it is not reported as a change.
    expect(changed.has('conditions')).toBe(false);
    expect(changed.has('name')).toBe(false);
  });

  it('reports added and removed conditions as changes', () => {
    const oldId = insertRule({
      ruleVersion: 1,
      conditions: [{ field: 'supplyType', operator: 'equals', value: 'goods' }],
    });
    insertRule({
      ruleVersion: 2,
      supersedesRuleId: oldId,
      conditions: [
        { field: 'supplyType', operator: 'equals', value: 'goods' },
        { field: 'description', operator: 'contains', value: 'hotel' },
      ],
    });

    const v2 = compareRuleVersions(db, { companyId, ruleKey: RULE_KEY })!.versions[1]!;
    const conditions = v2.changes.find((c) => c.field === 'conditions')!;
    expect(conditions.from).toBe('[{"field":"supplyType","operator":"equals","value":"goods"}]');
    expect(conditions.to).toContain('{"field":"description","operator":"contains","value":"hotel"}');
  });

  it('never crosses companies', () => {
    insertRule({ ruleVersion: 1 });
    const otherCompanyId = createCompany(db, { legalName: 'Elsewhere Ltd', seedYears: [2025] }).companyId;
    expect(compareRuleVersions(db, { companyId: otherCompanyId, ruleKey: RULE_KEY })).toBeNull();
  });
});

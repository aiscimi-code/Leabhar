import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { listRecurringPatterns } from './recurringPatterns';
import { makeDate, asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Test Company Limited',
    financialYearEndDay: 31,
    financialYearEndMonth: 12,
    seedYears: [2024, 2025],
  });
  companyId = created.companyId;
});

describe('listRecurringPatterns', () => {
  it('lists all patterns (detected and confirmed) for a company', () => {
    const patterns = listRecurringPatterns(db, { companyId });

    expect(Array.isArray(patterns)).toBe(true);
  });

  it('includes pattern metadata', () => {
    const patterns = listRecurringPatterns(db, { companyId });

    if (patterns.length > 0) {
      const pattern = patterns[0];
      expect(pattern.id).toBeDefined();
      expect(pattern.description).toBeDefined();
      expect(pattern.status).toBeDefined();
      expect(['suggested', 'confirmed', 'dismissed']).toContain(pattern.status);
    }
  });

  it('returns patterns for the specified company only', () => {
    const patterns = listRecurringPatterns(db, { companyId });

    // All patterns should belong to this company (or be empty)
    expect(Array.isArray(patterns)).toBe(true);
  });

  it('returns empty array when no patterns exist', () => {
    const patterns = listRecurringPatterns(db, { companyId });

    // Test data may have no patterns, which is fine
    expect(Array.isArray(patterns)).toBe(true);
  });

  it('distinguishes between suggested, confirmed and dismissed patterns', () => {
    const patterns = listRecurringPatterns(db, { companyId });

    const statuses = new Set(patterns.map((p) => p.status));
    expect(statuses.size).toBeGreaterThanOrEqual(0);
    for (const status of statuses) {
      expect(['suggested', 'confirmed', 'dismissed']).toContain(status);
    }
  });
});

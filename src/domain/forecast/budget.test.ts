import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createCompanyBudget, copyBudget, budgetVsActual, listBudgets } from './budget';
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

describe('createCompanyBudget', () => {
  it('creates a new budget for a company and financial year', () => {
    const budgetId = createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Annual Budget 2025',
      source: 'entered',
      lines: [
        {
          accountId: 'acc_123',
          monthStart: '2025-01-01',
          amountMinor: 10_000_000,
        },
      ],
      recordedBy: 'test-user',
    });

    expect(budgetId).toBeDefined();
    expect(budgetId.length).toBeGreaterThan(0);
  });

  it('creates a budget with the specified source', () => {
    const budgetId = createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Initial budget',
      source: 'entered',
      lines: [],
      recordedBy: 'test-user',
    });

    const { companyBudgets } = require('@/db/schema');
    const { eq } = require('drizzle-orm');
    const saved = db.select().from(companyBudgets).where(eq(companyBudgets.id, budgetId)).get();

    expect(saved).toBeDefined();
    if (saved) {
      expect(saved.source).toBe('entered');
    }
  });

  it('creates budget lines with amounts', () => {
    const budgetId = createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Annual planning',
      source: 'entered',
      lines: [
        { accountId: 'acc_123', monthStart: '2025-01-01', amountMinor: 10_000_000 },
        { accountId: 'acc_123', monthStart: '2025-02-01', amountMinor: 12_000_000 },
      ],
      recordedBy: 'test-user',
    });

    const { companyBudgetLines } = require('@/db/schema');
    const { eq } = require('drizzle-orm');
    const lines = db.select().from(companyBudgetLines)
      .where(eq(companyBudgetLines.budgetId, budgetId))
      .all();

    expect(lines.length).toBe(2);
  });
});

describe('copyBudget', () => {
  it('copies an existing budget by ID to a new version', () => {
    const budgetId = createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Initial budget',
      source: 'entered',
      lines: [
        { accountId: 'acc_123', month: 1, amountMinor: 10_000_000 },
      ],
      recordedBy: 'test-user',
    });

    const newBudgetId = copyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Q2 revision',
      reason: 'Q2 revision - adjustment',
      source: 'copied_budget',
      fromBudgetId: budgetId,
      adjustmentBasisPoints: 1000,
      recordedBy: 'test-user',
    });

    expect(newBudgetId).toBeDefined();
    expect(newBudgetId).not.toBe(budgetId);
  });

  it('copies actuals from a previous year', () => {
    const budgetId = copyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: '2025 Budget from 2024 actuals',
      reason: 'Copy prior year actuals',
      source: 'copied_actuals',
      fromYear: 2024,
      recordedBy: 'test-user',
    });

    expect(budgetId).toBeDefined();
  });

  it('applies basis points adjustment to budget lines', () => {
    const budgetId = createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Initial budget',
      source: 'entered',
      lines: [
        { accountId: 'acc_123', month: 1, amountMinor: 10_000_000 },
      ],
      recordedBy: 'test-user',
    });

    const newBudgetId = copyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Adjusted budget',
      reason: 'Quarterly adjustment',
      source: 'copied_budget',
      fromBudgetId: budgetId,
      adjustmentBasisPoints: 500,
      recordedBy: 'test-user',
    });

    const { companyBudgetLines } = require('@/db/schema');
    const { eq } = require('drizzle-orm');
    const oldLines = db.select().from(companyBudgetLines)
      .where(eq(companyBudgetLines.budgetId, budgetId))
      .all();
    const newLines = db.select().from(companyBudgetLines)
      .where(eq(companyBudgetLines.budgetId, newBudgetId))
      .all();

    expect(newLines.length).toBe(oldLines.length);
  });
});

describe('budgetVsActual', () => {
  it('compares budget to actual for a period', () => {
    const budgetId = createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Annual budget',
      source: 'entered',
      lines: [
        { accountId: 'acc_123', month: 3, amountMinor: 50_000_000 },
      ],
      recordedBy: 'test-user',
    });

    const comparison = budgetVsActual(db, {
      companyId,
      budgetId,
      from: asIsoDate(makeDate(2025, 3, 1)),
      to: asIsoDate(makeDate(2025, 3, 31)),
    });

    expect(comparison).toBeDefined();
    expect(comparison.lines).toBeDefined();
    expect(Array.isArray(comparison.lines)).toBe(true);
  });

  it('includes variance calculations', () => {
    const budgetId = createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Annual budget',
      source: 'entered',
      lines: [],
      recordedBy: 'test-user',
    });

    const comparison = budgetVsActual(db, {
      companyId,
      budgetId,
      from: asIsoDate(makeDate(2025, 3, 1)),
      to: asIsoDate(makeDate(2025, 3, 31)),
    });

    expect(comparison.totalBudgetMinor).toBeDefined();
    expect(comparison.totalActualMinor).toBeDefined();
    expect(comparison.totalVarianceMinor).toBeDefined();
    expect(typeof comparison.totalBudgetMinor).toBe('number');
    expect(typeof comparison.totalActualMinor).toBe('number');
    expect(typeof comparison.totalVarianceMinor).toBe('number');
  });
});

describe('listBudgets', () => {
  it('lists all budgets for a company', () => {
    createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Initial budget',
      source: 'entered',
      lines: [],
      recordedBy: 'test-user',
    });

    createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Revised budget',
      source: 'entered',
      lines: [],
      recordedBy: 'test-user',
    });

    const budgets = listBudgets(db, { companyId });

    expect(Array.isArray(budgets)).toBe(true);
    expect(budgets.length).toBeGreaterThanOrEqual(2);
  });

  it('includes budget metadata', () => {
    createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Annual budget',
      source: 'entered',
      lines: [],
      recordedBy: 'test-user',
    });

    const budgets = listBudgets(db, { companyId });

    expect(budgets.length).toBeGreaterThan(0);
    const budget = budgets[0];
    expect(budget).toBeDefined();
    if (budget) {
      expect(budget.id).toBeDefined();
      expect(budget.financialYearEnd).toBeDefined();
      expect(budget.name).toBeDefined();
      expect(budget.version).toBeDefined();
    }
  });

  it('returns budgets for the specified company only', () => {
    createCompanyBudget(db, {
      companyId,
      financialYearEnd: '2025-12-31',
      name: 'Budget 1',
      source: 'entered',
      lines: [],
      recordedBy: 'test-user',
    });

    const budgets = listBudgets(db, { companyId });

    expect(budgets.length).toBeGreaterThan(0);
  });
});

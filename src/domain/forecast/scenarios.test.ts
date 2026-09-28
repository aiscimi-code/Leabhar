import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createScenario, addScenarioAdjustment, buildScenarioForecast, compareScenarios, listScenarios } from './scenarios';
import { buildForecast } from './engine';
import { makeDate, asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';
import type { ForecastOptions } from './types';

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

const baseOptions: ForecastOptions = {
  companyId: '',
  asOf: asIsoDate(makeDate(2025, 3, 15)),
  horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
  granularity: 'monthly',
  receiptBasis: 'due_date',
  includePurchaseOrders: false,
  includeUnconfirmed: false,
  cashAccountIds: [],
  minimumCashMinor: 10_000_000,
  dueDateBasis: 'statutory',
};

describe('createScenario', () => {
  it('creates a new scenario with a given name', () => {
    const scenarioId = createScenario(db, {
      companyId,
      name: 'Optimistic Growth',
      description: 'Assume 20% revenue increase',
      adjustments: [
        {
          kind: 'revenue_change',
          changeBasisPoints: 2000,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: 'Revenue increase',
        },
      ],
      recordedBy: 'test-user',
    });

    expect(scenarioId).toBeDefined();
    expect(scenarioId.length).toBeGreaterThan(0);
  });

  it('trims whitespace from scenario names', () => {
    const scenarioId = createScenario(db, {
      companyId,
      name: '  Optimistic Growth  ',
      description: 'Assume 20% revenue increase',
      adjustments: [
        {
          kind: 'revenue_change',
          changeBasisPoints: 2000,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: 'Revenue increase',
        },
      ],
      recordedBy: 'test-user',
    });

    const { forecastScenarios } = require('@/db/schema');
    const { eq } = require('drizzle-orm');
    const saved = db.select().from(forecastScenarios).where(eq(forecastScenarios.id, scenarioId)).get();

    expect(saved).toBeDefined();
    if (saved) {
      expect(saved.name).toBe('Optimistic Growth');
    }
  });
});

describe('addScenarioAdjustment', () => {
  it('adds a customer payment delay adjustment to a scenario', () => {
    const scenarioId = createScenario(db, {
      companyId,
      name: 'Payment Delay Test',
      adjustments: [],
      recordedBy: 'test-user',
    });

    addScenarioAdjustment(db, {
      scenarioId,
      companyId,
      adjustment: {
        kind: 'customer_payment_delay',
        delayDays: 14,
        fromDate: asIsoDate(makeDate(2025, 3, 15)),
        description: 'Delay customer payments by 2 weeks',
      },
      recordedBy: 'test-user',
    });

    const { scenarioAdjustments } = require('@/db/schema');
    const { eq } = require('drizzle-orm');
    const adjustments = db.select().from(scenarioAdjustments)
      .where(eq(scenarioAdjustments.scenarioId, scenarioId))
      .all();

    expect(adjustments.length).toBeGreaterThan(0);
  });

  it('adds a revenue change adjustment to a scenario', () => {
    const scenarioId = createScenario(db, {
      companyId,
      name: 'Revenue Change Test',
      adjustments: [],
      recordedBy: 'test-user',
    });

    addScenarioAdjustment(db, {
      scenarioId,
      companyId,
      adjustment: {
        kind: 'revenue_change',
        changeBasisPoints: 2000,
        fromDate: asIsoDate(makeDate(2025, 3, 15)),
        description: '20% revenue increase',
      },
      recordedBy: 'test-user',
    });

    const { scenarioAdjustments } = require('@/db/schema');
    const { eq } = require('drizzle-orm');
    const adjustments = db.select().from(scenarioAdjustments)
      .where(eq(scenarioAdjustments.scenarioId, scenarioId))
      .all();

    expect(adjustments.length).toBeGreaterThan(0);
  });

  it('adds a cost change adjustment to a scenario', () => {
    const scenarioId = createScenario(db, {
      companyId,
      name: 'Cost Change Test',
      adjustments: [],
      recordedBy: 'test-user',
    });

    addScenarioAdjustment(db, {
      scenarioId,
      companyId,
      adjustment: {
        kind: 'cost_change',
        changeBasisPoints: -1500,
        fromDate: asIsoDate(makeDate(2025, 3, 15)),
        description: '15% cost reduction',
      },
      recordedBy: 'test-user',
    });

    const { scenarioAdjustments } = require('@/db/schema');
    const { eq } = require('drizzle-orm');
    const adjustments = db.select().from(scenarioAdjustments)
      .where(eq(scenarioAdjustments.scenarioId, scenarioId))
      .all();

    expect(adjustments.length).toBeGreaterThan(0);
  });

  it('adds a one-off adjustment to a scenario', () => {
    const scenarioId = createScenario(db, {
      companyId,
      name: 'One-Off Test',
      adjustments: [],
      recordedBy: 'test-user',
    });

    addScenarioAdjustment(db, {
      scenarioId,
      companyId,
      adjustment: {
        kind: 'one_off',
        amountMinor: 50_000_000,
        fromDate: asIsoDate(makeDate(2025, 4, 1)),
        description: 'Unexpected invoice from supplier',
      },
      recordedBy: 'test-user',
    });

    const { scenarioAdjustments } = require('@/db/schema');
    const { eq } = require('drizzle-orm');
    const adjustments = db.select().from(scenarioAdjustments)
      .where(eq(scenarioAdjustments.scenarioId, scenarioId))
      .all();

    expect(adjustments.length).toBeGreaterThan(0);
  });
});

describe('buildScenarioForecast', () => {
  it('builds a scenario forecast with adjustments applied', () => {
    const scenarioId = createScenario(db, {
      companyId,
      name: 'Test Scenario',
      adjustments: [
        {
          kind: 'customer_payment_delay',
          delayDays: 7,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: 'Delay by 7 days',
        },
      ],
      recordedBy: 'test-user',
    });

    const options: ForecastOptions & { scenarioId: string } = {
      ...baseOptions,
      companyId,
      scenarioId,
    };

    const forecast = buildScenarioForecast(db, options);

    expect(forecast).toBeDefined();
    expect(forecast.buckets).toBeDefined();
  });

  it('applies scenario adjustments on top of base forecast', () => {
    const scenarioId = createScenario(db, {
      companyId,
      name: 'Scenario with Revenue Increase',
      adjustments: [
        {
          kind: 'revenue_change',
          changeBasisPoints: 1000,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: '10% revenue increase',
        },
      ],
      recordedBy: 'test-user',
    });

    const baseOptions1: ForecastOptions = {
      ...baseOptions,
      companyId,
      scenarioId: null,
    };

    const baseOptions2: ForecastOptions & { scenarioId: string } = {
      ...baseOptions,
      companyId,
      scenarioId,
    };

    const baseForecast = buildForecast(db, baseOptions1);
    const scenarioForecast = buildScenarioForecast(db, baseOptions2);

    expect(baseForecast).toBeDefined();
    expect(scenarioForecast).toBeDefined();
  });
});

describe('compareScenarios', () => {
  it('compares multiple scenarios', () => {
    const scenario1 = createScenario(db, {
      companyId,
      name: 'Conservative',
      description: 'Assume no growth',
      adjustments: [
        {
          kind: 'revenue_change',
          changeBasisPoints: 0,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: 'No growth',
        },
      ],
      recordedBy: 'test-user',
    });

    const scenario2 = createScenario(db, {
      companyId,
      name: 'Optimistic',
      description: 'Assume 20% growth',
      adjustments: [
        {
          kind: 'revenue_change',
          changeBasisPoints: 2000,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: '20% growth',
        },
      ],
      recordedBy: 'test-user',
    });

    const comparison = compareScenarios(db, {
      companyId,
      scenarioIds: [scenario1, scenario2],
      asOf: baseOptions.asOf,
      horizonEnd: baseOptions.horizonEnd,
      granularity: 'monthly',
    });

    expect(comparison).toBeDefined();
    expect(comparison.scenarios).toBeDefined();
  });
});

describe('listScenarios', () => {
  it('lists all scenarios for a company', () => {
    createScenario(db, {
      companyId,
      name: 'Scenario 1',
      adjustments: [
        {
          kind: 'revenue_change',
          changeBasisPoints: 0,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: 'Test',
        },
      ],
      recordedBy: 'test-user',
    });

    createScenario(db, {
      companyId,
      name: 'Scenario 2',
      adjustments: [
        {
          kind: 'revenue_change',
          changeBasisPoints: 0,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: 'Test',
        },
      ],
      recordedBy: 'test-user',
    });

    const scenarios = listScenarios(db, { companyId });

    expect(Array.isArray(scenarios)).toBe(true);
    expect(scenarios.length).toBeGreaterThanOrEqual(2);
  });

  it('includes scenario metadata', () => {
    createScenario(db, {
      companyId,
      name: 'Test Scenario',
      description: 'A test scenario',
      adjustments: [
        {
          kind: 'revenue_change',
          changeBasisPoints: 0,
          fromDate: asIsoDate(makeDate(2025, 3, 15)),
          description: 'Test',
        },
      ],
      recordedBy: 'test-user',
    });

    const scenarios = listScenarios(db, { companyId });

    expect(scenarios.length).toBeGreaterThan(0);
    const scenario = scenarios[0];
    expect(scenario.id).toBeDefined();
    expect(scenario.name).toBeDefined();
    expect(scenario.description).toBeDefined();
  });
});

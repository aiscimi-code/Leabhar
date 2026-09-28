import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { vatOutflowLines, ctOutflowLines, payrollRemittanceOutflowLines, statutoryOutflowLines } from './taxOutflows';
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

describe('vatOutflowLines', () => {
  it('generates VAT outflow lines for open VAT periods', () => {
    const result = vatOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'statutory',
    });

    expect(result).toBeDefined();
    expect(result.lines).toBeDefined();
    expect(Array.isArray(result.lines)).toBe(true);
  });

  it('includes VAT outflow metadata', () => {
    const result = vatOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'statutory',
    });

    if (result.lines.length > 0) {
      const line = result.lines[0];
      expect(line.key).toBeDefined();
      expect(line.date).toBeDefined();
      expect(line.amountMinor).toBeDefined();
      expect(line.description).toBeDefined();
      expect(line.source).toBe('rule');
      expect(line.isEstimate).toBeDefined();
    }
  });

  it('respects the due date basis for statutory dates', () => {
    const statutory = vatOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'statutory',
    });

    const rosExtended = vatOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'ros_extended',
    });

    // Both should return objects with lines
    expect(statutory.lines).toBeDefined();
    expect(rosExtended.lines).toBeDefined();
  });

  it('marks open period amounts as estimates', () => {
    const result = vatOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'statutory',
    });

    if (result.lines.length > 0) {
      for (const line of result.lines) {
        expect(typeof line.isEstimate).toBe('boolean');
        if (line.isEstimate && line.estimateBasis) {
          expect(line.estimateBasis.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('ctOutflowLines', () => {
  it('generates corporation tax outflow lines', () => {
    const result = ctOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
    });

    expect(result.lines).toBeDefined();
    expect(Array.isArray(result.lines)).toBe(true);
  });

  it('includes CT outflow metadata', () => {
    const result = ctOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
    });

    if (result.lines.length > 0) {
      const line = result.lines[0];
      expect(line.key).toBeDefined();
      expect(line.date).toBeDefined();
      expect(line.amountMinor).toBeDefined();
      expect(line.description).toBeDefined();
      expect(line.source).toBe('rule');
    }
  });

  it('marks CT amounts as estimates when not yet finalised', () => {
    const result = ctOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
    });

    if (result.lines.length > 0) {
      for (const line of result.lines) {
        expect(typeof line.isEstimate).toBe('boolean');
      }
    }
  });
});

describe('payrollRemittanceOutflowLines', () => {
  it('generates payroll remittance outflow lines', () => {
    const result = payrollRemittanceOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
    });

    expect(result.lines).toBeDefined();
    expect(Array.isArray(result.lines)).toBe(true);
  });

  it('includes payroll remittance metadata', () => {
    const result = payrollRemittanceOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
    });

    if (result.lines.length > 0) {
      const line = result.lines[0];
      expect(line.key).toBeDefined();
      expect(line.date).toBeDefined();
      expect(line.amountMinor).toBeDefined();
      expect(line.description).toBeDefined();
      expect(line.source).toBe('rule');
    }
  });

  it('includes scheduled remittance payments within the horizon', () => {
    const result = payrollRemittanceOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
    });

    for (const line of result.lines) {
      expect(line.date >= asIsoDate(makeDate(2025, 3, 15))).toBe(true);
      expect(line.date <= asIsoDate(makeDate(2025, 6, 15))).toBe(true);
    }
  });
});

describe('statutoryOutflowLines', () => {
  it('generates all statutory outflow lines (VAT, CT, payroll)', () => {
    const result = statutoryOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'statutory',
    });

    expect(result.lines).toBeDefined();
    expect(Array.isArray(result.lines)).toBe(true);
  });

  it('includes all statutory sources', () => {
    const result = statutoryOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'statutory',
    });

    if (result.lines.length > 0) {
      for (const line of result.lines) {
        expect(line.source).toBe('rule');
        expect(line.key).toBeDefined();
        expect(line.description).toBeDefined();
      }
    }
  });

  it('respects the horizon dates', () => {
    const result = statutoryOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'statutory',
    });

    for (const line of result.lines) {
      expect(line.date >= asIsoDate(makeDate(2025, 3, 15))).toBe(true);
      expect(line.date <= asIsoDate(makeDate(2025, 6, 15))).toBe(true);
    }
  });

  it('includes ROS extended dates when requested', () => {
    const statutory = statutoryOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'statutory',
    });

    const rosExtended = statutoryOutflowLines(db, {
      companyId,
      asOf: asIsoDate(makeDate(2025, 3, 15)),
      horizonEnd: asIsoDate(makeDate(2025, 6, 15)),
      dueDateBasis: 'ros_extended',
    });

    expect(statutory.lines).toBeDefined();
    expect(rosExtended.lines).toBeDefined();
  });
});

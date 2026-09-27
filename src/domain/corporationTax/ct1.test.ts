import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { postJournalEntry } from '../accounting/journal';
import { computeCorporationTax } from './computation';
import { buildCt1Worksheet, ct1Reconciliation } from './ct1';
import { asIsoDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let byKey: Record<string, string>;
const from = asIsoDate('2025-01-01');
const to = asIsoDate('2025-12-31');

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'CT1 Ltd', croNumber: '123456', taxReferenceNumber: '1234567X',
    vatRegistrationStatus: 'registered', seedYears: [2025, 2026],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  byKey = created.accountsByKey;
});

const post = (code: string, amountMinor: number, narrative: string, date = '2025-06-15') => postJournalEntry(db, {
  companyId, entryDate: asIsoDate(date), narrative, sourceType: 'bank_transaction', sourceId: `t-${narrative}`,
  baseCurrency: 'EUR',
  lines: code.startsWith('4')
    ? [{ accountId: byKey['bank_control']!, debitMinor: amountMinor }, { accountId: byCode[code]!, creditMinor: amountMinor }]
    : [{ accountId: byCode[code]!, debitMinor: amountMinor, memo: narrative }, { accountId: byKey['bank_control']!, creditMinor: amountMinor }],
});

const step = (label: string) => (steps: ReturnType<typeof ct1Reconciliation>) =>
  steps.find((s) => s.label === label);

describe('ct1Reconciliation', () => {
  it('runs from accounting profit through every adjustment to the total liability, tied to the computation', () => {
    post('4020', 1_000_000, 'Consulting');
    post('6070', 200_000, 'Accountancy fees');
    post('6170', 100_000, 'Depreciation charge');
    const c = computeCorporationTax(db, { companyId, from, to });
    const steps = ct1Reconciliation(c);

    const at = step('Accounting profit for the period')(steps)!;
    expect(at.amountMinor).toBe(700_000);
    expect(at.kind).toBe('total');

    // Every adjustment the computation made appears as its own step, cited.
    const depreciation = steps.find((s) => s.label.includes('Depreciation'))!;
    expect(depreciation.amountMinor).toBe(100_000);
    expect(depreciation.kind).toBe('adjustment');
    expect(depreciation.citations[0]!.section).toBe('TCA 1997 s.81');

    // The steps tie: accounting profit plus the adjustments equals the adjusted result.
    const adjusted = step('Trading profit after adjustments')(steps)!;
    expect(adjusted.amountMinor).toBe(700_000 + steps.filter((s) => s.kind === 'adjustment' || s.kind === 'deduction')
      .filter((s) => s.label.includes('Add back') || s.label.includes('Deduct'))
      .reduce((s, x) => s + x.amountMinor, 0));
    expect(adjusted.amountMinor).toBe(c.adjustedTradingResultMinor);
    expect(step('Taxable trading profit (charged at the standard rate)')(steps)!.amountMinor).toBe(c.tradingProfitMinor);
    expect(step('Non-trading income charged at the higher rate')(steps)!.amountMinor).toBe(c.nonTradingIncomeMinor);
    expect(step('Tax at the standard rate')(steps)!.amountMinor).toBe(c.taxAtStandardRateMinor);
    expect(step('Tax at the higher rate')(steps)!.amountMinor).toBe(c.taxAtHigherRateMinor);
    expect(step('Corporation tax for the period')(steps)!.amountMinor).toBe(c.corporationTaxMinor);
    expect(step('Total liability for the period')(steps)!.amountMinor)
      .toBe(c.corporationTaxMinor + c.surcharge.surchargeMinor);
  });

  it('carries the loss relief steps when losses are relieved, and the surcharge step only when one arises', () => {
    post('6070', 700_000, 'Setup costs');
    post('4020', 500_000, 'Consulting');
    const withLoss = computeCorporationTax(db, { companyId, from: asIsoDate('2025-01-01'), to: asIsoDate('2025-12-31') });
    const lossCarried = ct1Reconciliation(withLoss);
    expect(lossCarried.some((s) => s.label.includes('Trading loss after adjustments'))).toBe(true);

    // Next year's profit absorbs the loss brought forward (s.396(1)).
    post('4020', 800_000, 'Consulting 2026', '2026-06-15');
    const next = computeCorporationTax(db, { companyId, from: asIsoDate('2026-01-01'), to: asIsoDate('2026-12-31') });
    const steps = ct1Reconciliation(next);
    expect(step('Deduct: trading losses relieved against this period')(steps)!.amountMinor).toBe(-200_000);
    expect(step('Taxable trading profit (charged at the standard rate)')(steps)!.amountMinor).toBe(next.tradingProfitMinor);
    expect(steps.some((s) => s.label.startsWith('Close company surcharge'))).toBe(true);
  });
});

describe('buildCt1Worksheet', () => {
  it('states the company, the period, the open decisions and that nothing is filed', () => {
    post('4020', 1_000_000, 'Consulting');
    const w = buildCt1Worksheet(db, { companyId, from, to });
    expect(w).toMatchObject({
      companyName: 'CT1 Ltd', companyNumber: '123456', taxReferenceNumber: '1234567X',
      from: '2025-01-01', to: '2025-12-31', currency: 'EUR',
    });
    expect(w.payment.returnDueDate).toBe(w.computation.dates.returnDueDate);
    expect(w.openDecisions.some((d) => d.subjectType === 'company_status')).toBe(true);
    expect(w.findings).toBe(w.computation.findings);
    expect(w.disclaimer).toContain('not a filed return');
    // The worksheet and the computation cannot disagree: the reconciliation is the computation's own figures.
    expect(w.reconciliation).toHaveLength(ct1Reconciliation(w.computation).length);
  });

  it('refuses to prepare a CT1 for a sole trader', () => {
    const sole = createCompany(db, { legalName: 'Sole', entityType: 'sole_trader', vatRegistrationStatus: 'not_registered', seedYears: [2025] });
    expect(() => buildCt1Worksheet(db, { companyId: sole.companyId, from, to }))
      .toThrow('not a company: no CT1 is prepared for it.');
  });
});

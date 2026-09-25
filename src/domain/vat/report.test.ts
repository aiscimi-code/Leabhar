import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createVatEntries } from './engine';
import { buildVat3Return, drillIntoBox, vatPositionSummary } from './report';
import { validateVatPeriod, transitionVatPeriod } from './periodClose';
import { vatPeriods, bankTransactions, reviewItems } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let tr: Record<string, string>;
let periodId: string;
let bankAccountId: string;

const MAR_APR = makeDate(2025, 3, 15);

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Test Ltd', vatRegistrationStatus: 'registered', seedYears: [2025],
  });
  companyId = created.companyId;
  tr = created.treatmentsByCode;
  periodId = db.select().from(vatPeriods)
    .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01',
  });
});

const addVat = (treatmentCode: string, opts: Record<string, unknown> = {}) =>
  createVatEntries(db, {
    companyId,
    sourceType: 'purchase_invoice',
    direction: 'purchases',
    treatmentId: tr[treatmentCode]!,
    taxPointDate: MAR_APR,
    currency: 'EUR',
    baseCurrency: 'EUR',
    netMinor: 10_000,
    ...opts,
  });

describe('buildVat3Return', () => {
  it('puts sales VAT in T1 and purchase VAT in T2', () => {
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 100_000 });
    addVat('IE_STD', { netMinor: 40_000 });

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(23_000);
    expect(report.T2.amountMinor).toBe(9_200);
    expect(report.T3.amountMinor).toBe(13_800);
    expect(report.T4.amountMinor).toBe(0);
    expect(report.netPositionMinor).toBe(13_800);
  });

  it('reports a repayment position in T4, leaving T3 at zero', () => {
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 10_000 });
    addVat('IE_STD', { netMinor: 100_000 });

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T3.amountMinor).toBe(0);
    expect(report.T4.amountMinor).toBe(20_700);
    expect(report.netPositionMinor).toBe(-20_700);
  });

  it('nets a reverse charge to zero across T1 and T2', () => {
    addVat('NON_EU_SERVICES_RCV', { netMinor: 12_000 });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(2_760);
    expect(report.T2.amountMinor).toBe(2_760);
    expect(report.netPositionMinor).toBe(0);
    expect(report.reverseChargeVatMinor).toBe(2_760);
  });

  // T2 must sum RECOVERABLE VAT, not VAT charged.
  it('excludes non-recoverable VAT from T2', () => {
    addVat('IE_STD', { netMinor: 10_000 });        // 2300 recoverable
    addVat('NON_DEDUCTIBLE', { netMinor: 10_000 }); // 2300 charged, 0 recoverable

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.amountMinor).toBe(2_300);
    expect(report.nonRecoverableVatMinor).toBe(2_300);
  });

  it('populates the statistical net boxes', () => {
    addVat('EU_SERVICES_RCV', { netMinor: 50_000 });
    addVat('EU_GOODS_ACQ', { netMinor: 30_000 });
    addVat('IMPORT_PA', { netMinor: 20_000 });
    addVat('EU_GOODS_SUPPLY', {
      direction: 'sales', sourceType: 'sales_invoice', netMinor: 70_000,
    });
    addVat('EU_SERVICES_SUPPLY', {
      direction: 'sales', sourceType: 'sales_invoice', netMinor: 60_000,
    });

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.ES2.amountMinor).toBe(50_000);
    expect(report.E2.amountMinor).toBe(30_000);
    expect(report.PA1.amountMinor).toBe(20_000);
    expect(report.E1.amountMinor).toBe(70_000);
    expect(report.ES1.amountMinor).toBe(60_000);
  });

  it('excludes exempt and outside-scope transactions from every box', () => {
    addVat('IE_EXEMPT', { netMinor: 50_000 });
    addVat('OUT_OF_SCOPE', { netMinor: 90_000 });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(0);
    expect(report.T2.amountMinor).toBe(0);
    expect(report.E1.amountMinor).toBe(0);
    expect(report.E2.amountMinor).toBe(0);
  });

  it('includes zero-rated purchases in T2 at zero, unlike exempt', () => {
    addVat('IE_ZERO', { netMinor: 50_000 });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.amountMinor).toBe(0);
    // ...but the entry IS in the box, which is what distinguishes it from exempt.
    expect(report.T2.entryCount).toBe(1);
  });

  it('excludes entries from other periods', () => {
    addVat('IE_STD', { netMinor: 10_000 });
    addVat('IE_STD', { netMinor: 99_999, taxPointDate: makeDate(2025, 7, 15) });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.amountMinor).toBe(2_300);
    expect(report.entryCount).toBe(1);
  });

  it('sums in base currency for foreign-currency entries', () => {
    addVat('IE_STD', {
      netMinor: 10_000, currency: 'USD', fxRate: { numerator: 92, denominator: 100 },
    });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.amountMinor).toBe(2_116);
  });
});

describe('drill-down', () => {
  it('drills from a box to the entries that make it up', () => {
    addVat('IE_STD', { netMinor: 10_000 });
    addVat('IE_STD', { netMinor: 20_000 });
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 50_000 });

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.entryCount).toBe(2);

    const rows = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T2' });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.baseRecoverableVatMinor, 0)).toBe(report.T2.amountMinor);
    expect(rows[0]!.treatmentCode).toBe('IE_STD');
  });

  it('drills into T3 through everything behind T1 and T2', () => {
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 100_000 });
    addVat('IE_STD', { netMinor: 10_000 });
    const rows = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T3' });
    expect(rows).toHaveLength(2);
  });

  it('shows both legs of a reverse charge separately', () => {
    addVat('EU_SERVICES_RCV', { netMinor: 10_000 });
    const t1 = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T1' });
    const t2 = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T2' });
    expect(t1).toHaveLength(1);
    expect(t2).toHaveLength(1);
    expect(t1[0]!.isReverseChargeLeg).toBe(true);
    expect(t1[0]!.entryId).not.toBe(t2[0]!.entryId);
  });

  it('returns nothing for an empty box rather than failing', () => {
    expect(drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'E1' })).toEqual([]);
  });

  it('summarises every period for the dashboard', () => {
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 100_000 });
    const summary = vatPositionSummary(db, companyId);
    expect(summary).toHaveLength(6);
    const marApr = summary.find((s) => s.name === 'Mar–Apr 2025')!;
    expect(marApr.netPositionMinor).toBe(23_000);
    expect(summary.find((s) => s.name === 'Jan–Feb 2025')!.netPositionMinor).toBe(0);
  });
});

describe('period validation', () => {
  it('says NOT READY, never that a filing is compliant', () => {
    db.insert(bankTransactions).values({
      id: 'btx_1', companyId, bankAccountId, transactionDate: '2025-03-15',
      description: 'UNKNOWN', amountMinor: -1000, currency: 'EUR',
      fingerprint: 'f1', status: 'unclassified',
    } as never).run();

    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    expect(validation.verdict).toBe('NOT READY');
    expect(validation.ready).toBe(false);
    // README §48: never claim compliance. The verdict is one of two fixed
    // strings, and neither the verdict nor the summary asserts correctness.
    expect(['Internal checks passed', 'NOT READY']).toContain(validation.verdict);
    expect(validation.summary.toLowerCase()).not.toContain('compliant');
    expect(validation.summary.toLowerCase()).not.toContain('correct');
    // The disclaimer mentions compliance only to disclaim it.
    expect(validation.disclaimer).toContain('not a statement that your VAT return is correct');
    expect(validation.disclaimer).toMatch(/not a statement.*compliant/s);
  });

  it('says "Internal checks passed" when nothing blocks', () => {
    addVat('IE_STD', { netMinor: 10_000 });
    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    expect(validation.verdict).toBe('Internal checks passed');
    expect(validation.ready).toBe(true);
  });

  it('blocks on unclassified transactions', () => {
    db.insert(bankTransactions).values({
      id: 'btx_2', companyId, bankAccountId, transactionDate: '2025-04-01',
      description: 'MYSTERY', amountMinor: -5000, currency: 'EUR',
      fingerprint: 'f2', status: 'unclassified',
    } as never).run();

    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    const finding = validation.findings.find((f) => f.code === 'unclassified_transactions')!;
    expect(finding.severity).toBe('blocking');
    expect(finding.entityIds).toContain('btx_2');
  });

  it('blocks on unconfirmed AI suggestions', () => {
    db.insert(bankTransactions).values({
      id: 'btx_3', companyId, bankAccountId, transactionDate: '2025-03-20',
      description: 'AI GUESS', amountMinor: -5000, currency: 'EUR',
      fingerprint: 'f3', status: 'suggested', source: 'ai',
      provenanceStatus: 'ai_suggestion',
    } as never).run();

    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    expect(validation.findings.some((f) => f.code === 'unresolved_ai_suggestions')).toBe(true);
    expect(validation.ready).toBe(false);
  });

  it('flags a repayment position for a deliberate look', () => {
    addVat('IE_STD', { netMinor: 100_000 });
    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    const finding = validation.findings.find((f) => f.code === 'repayment_position')!;
    expect(finding.severity).toBe('info');
    // Informational findings do not block.
    expect(validation.ready).toBe(true);
  });

  it('warns on an empty period rather than silently filing a nil return', () => {
    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    expect(validation.findings.some((f) => f.code === 'no_entries')).toBe(true);
  });
});

describe('period lifecycle', () => {
  beforeEach(() => { addVat('IE_STD', { netMinor: 10_000 }); });

  it('moves open -> review -> ready -> locked -> submitted', () => {
    expect(transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' }).status)
      .toBe('review');
    expect(transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' }).status)
      .toBe('ready');
    expect(transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'locked' }).status)
      .toBe('locked');
    expect(transitionVatPeriod(db, {
      companyId, vatPeriodId: periodId, to: 'submitted', submissionReference: 'ROS-123',
    }).status).toBe('submitted');
  });

  it('refuses to skip straight from open to locked', () => {
    expect(() => transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'locked' }))
      .toThrow(/cannot go from "open" to "locked"/);
  });

  it('refuses to mark ready while a blocking issue stands', () => {
    db.insert(bankTransactions).values({
      id: 'btx_4', companyId, bankAccountId, transactionDate: '2025-03-15',
      description: 'UNCLASSIFIED', amountMinor: -1000, currency: 'EUR',
      fingerprint: 'f4', status: 'unclassified',
    } as never).run();

    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' });
    expect(() => transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' }))
      .toThrow(/NOT READY/);
    expect(db.select().from(vatPeriods).where(eq(vatPeriods.id, periodId)).get()!.status)
      .toBe('review');
  });

  it('writes blocking findings into the review queue', () => {
    db.insert(bankTransactions).values({
      id: 'btx_5', companyId, bankAccountId, transactionDate: '2025-03-15',
      description: 'UNCLASSIFIED', amountMinor: -1000, currency: 'EUR',
      fingerprint: 'f5', status: 'unclassified',
    } as never).run();

    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' });
    try { transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' }); } catch { /* expected */ }

    const items = db.select().from(reviewItems).all();
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.title.includes('unclassified'))).toBe(true);
  });

  it('snapshots the figures as filed on submission', () => {
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'locked' });
    transitionVatPeriod(db, {
      companyId, vatPeriodId: periodId, to: 'submitted', submissionReference: 'ROS-1',
    });

    const period = db.select().from(vatPeriods).where(eq(vatPeriods.id, periodId)).get()!;
    expect(period.filedT2Minor).toBe(2_300);
    expect(period.submissionReference).toBe('ROS-1');

    // A later entry into the filed period is refused (issue #226): the live
    // return stays equal to what was filed.
    expect(() => addVat('IE_STD', { netMinor: 50_000 })).toThrow(/submitted/);
    const after = db.select().from(vatPeriods).where(eq(vatPeriods.id, periodId)).get()!;
    expect(after.filedT2Minor).toBe(2_300);
    expect(buildVat3Return(db, { companyId, vatPeriodId: periodId }).T2.amountMinor)
      .toBe(2_300);
  });

  it('refuses any transition out of submitted', () => {
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'locked' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'submitted' });
    expect(() => transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'open' }))
      .toThrow(/cannot go from "submitted"/);
  });
});

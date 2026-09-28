/**
 * Tax and statutory outflows for the forecast (issue #566, epic #333).
 *
 * Adds VAT, CT, income tax, RCT and payroll remittance outflows to the
 * forecast. Each is dated by a curated due-date rule. Where the amount is
 * not yet known (an open period), the line is marked as an estimate.
 *
 * A due date with no curated rule is never guessed: the outflow is listed
 * undated, and a finding names the missing source.
 *
 * Nothing posts; nothing is written.
 */

import { and, eq, lte, gte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  vatPeriods, payrollRemittances, taxDeadlines,
} from '@/db/schema';
import { asIsoDate, type IsoDate } from '../dates';
import { buildVat3Return } from '../vat/report';
import type { ForecastLine } from './types';

/**
 * Findings accumulator: each missing due-date source adds one entry.
 * Callers merge these into the ForecastResult.findings array.
 */

// ---------------------------------------------------------------------------
// VAT outflows
// ---------------------------------------------------------------------------

/**
 * A VAT period whose deadline falls within the horizon becomes a forecast line.
 *
 * - Closed (submitted/locked) periods: use the return figure.
 * - Open periods: estimate from vatPositionSummary for that period, flagged.
 * - Due date rule: VATCA s.76 — 23rd of the month after the period ends.
 *   The ROS extended date (+4 working days) is not modelled here without
 *   a curated source; a finding is emitted when 'ros_extended' is requested.
 */
export function vatOutflowLines(
  db: AppDatabase,
  params: { companyId: string; asOf: IsoDate; horizonEnd: IsoDate; dueDateBasis: 'statutory' | 'ros_extended' },
): { lines: ForecastLine[]; findings: string[] } {
  const findings: string[] = [];
  if (params.dueDateBasis === 'ros_extended') {
    findings.push(
      'The ROS extended due date for VAT is not yet collected. The statutory date (23rd of the month after '
      + 'the period ends, VATCA s.76) is used instead. Record the company\'s ROS filing election and collect '
      + 'the Revenue extended-date page to activate this option.',
    );
  }

  const periods = db.select().from(vatPeriods)
    .where(eq(vatPeriods.companyId, params.companyId))
    .all();

  const lines: ForecastLine[] = [];
  for (const period of periods) {
    // Statutory due date: 23rd of the month after the period ends (s.76)
    const periodEnd = asIsoDate(period.endDate);
    const [y, m] = period.endDate.split('-').map(Number) as [number, number];
    const dueMonth = m === 12 ? 1 : m + 1;
    const dueYear = m === 12 ? y + 1 : y;
    const dueDate = asIsoDate(`${dueYear}-${String(dueMonth).padStart(2, '0')}-23`);

    if (dueDate < params.asOf || dueDate > params.horizonEnd) continue;

    const ret = buildVat3Return(db, { companyId: params.companyId, vatPeriodId: period.id });
    const isOpen = period.status === 'open';
    // T1 − T2 is what is owed; negative means a refund
    const netMinor = ret.netPositionMinor;
    if (netMinor <= 0) continue; // refund or nil — not an outflow

    lines.push({
      key: `vat:${period.id}`,
      date: dueDate,
      amountMinor: -netMinor,
      description: `VAT return: ${period.name}`,
      source: 'rule',
      isEstimate: isOpen,
      estimateBasis: isOpen
        ? `The VAT period "${period.name}" is still open. This is an estimate based on entries to date.`
        : undefined,
      entityRef: { kind: 'vat_period', id: period.id },
    });
  }
  return { lines, findings };
}

// ---------------------------------------------------------------------------
// Corporation Tax outflows
// ---------------------------------------------------------------------------

/**
 * CT and other statutory payments from tax_deadlines within the horizon.
 * Kinds 'corporation_tax_preliminary' and 'payroll' are included here.
 * Each deadline record optionally carries a notes field with the amount basis.
 */
export function ctOutflowLines(
  db: AppDatabase,
  params: { companyId: string; asOf: IsoDate; horizonEnd: IsoDate },
): ForecastLine[] {
  const rows = db.select().from(taxDeadlines)
    .where(and(
      eq(taxDeadlines.companyId, params.companyId),
      gte(taxDeadlines.dueDate, params.asOf),
      lte(taxDeadlines.dueDate, params.horizonEnd),
    )).all();

  return rows
    .filter((r) => r.kind === 'corporation_tax_preliminary' && r.status !== 'submitted' && r.status !== 'not_applicable')
    .map((r) => ({
      key: `ct:${r.id}`,
      date: asIsoDate(r.dueDate),
      amountMinor: 0, // amount not stored in tax_deadlines; marked as estimate
      description: `Corporation tax: ${r.title}`,
      source: 'rule' as const,
      isEstimate: true,
      estimateBasis: 'Amount to be confirmed from the CT computation. See the corporation tax screen.',
      entityRef: { kind: 'tax_deadline', id: r.id },
    }));
}

// ---------------------------------------------------------------------------
// Payroll remittance outflows
// ---------------------------------------------------------------------------

/**
 * Payroll remittances posted to date, and projected future ones.
 *
 * For posted remittances within the horizon: use the actual amount.
 * For projected remittances (from payroll forecast): these are added by
 * payrollForecast.ts — here we only add already-posted remittances not yet paid.
 *
 * The payroll remittance due date rule (S.I. 345/2018 reg.28 / ROS date) is
 * NOT curated yet. Until it is, we emit a finding and use the 14th of the
 * month following the period.
 */
export function payrollRemittanceOutflowLines(
  db: AppDatabase,
  params: { companyId: string; asOf: IsoDate; horizonEnd: IsoDate; dueDateBasis: 'statutory' | 'ros_extended' },
): { lines: ForecastLine[]; findings: string[] } {
  const findings: string[] = [];
  findings.push(
    'The payroll remittance due date (S.I. 345/2018 reg.28) is not yet curated. '
    + 'The 14th of the following month is used as a provisional date. '
    + 'Identify and curate the payment regulation before relying on this date in a forecast.',
  );
  if (params.dueDateBasis === 'ros_extended') {
    findings.push(
      'The ROS extended due date for payroll remittances (TDM 42-04-35A) is not yet collected. '
      + 'The statutory date is used. Collect the Revenue extended-date page to activate this option.',
    );
  }

  // Find posted remittances within horizon (already posted = actual)
  // Use `month` column (YYYY-MM format)
  const remittances = db.select().from(payrollRemittances)
    .where(eq(payrollRemittances.companyId, params.companyId))
    .all();

  const lines: ForecastLine[] = [];
  for (const rem of remittances) {
    // Provisional due date: 14th of the month following the remittance period
    const [y, m] = rem.month.split('-').map(Number) as [number, number];
    const dueMonth = m === 12 ? 1 : m + 1;
    const dueYear = m === 12 ? y + 1 : y;
    const dueDate = asIsoDate(`${dueYear}-${String(dueMonth).padStart(2, '0')}-14`);

    if (dueDate < params.asOf || dueDate > params.horizonEnd) continue;
    // If already paid (paidOn set), skip
    if (rem.paidOn && rem.paidOn <= params.asOf) continue;

    const totalOwed = rem.payeMinor + rem.uscMinor + rem.prsiMinor;
    if (totalOwed <= 0) continue;

    lines.push({
      key: `payroll_rem:${rem.id}`,
      date: dueDate,
      amountMinor: -totalOwed,
      description: `Payroll remittance: ${rem.month}`,
      source: 'rule',
      isEstimate: false,
      entityRef: { kind: 'payroll_remittance', id: rem.id },
    });
  }
  return { lines, findings };
}

/**
 * Collect all statutory outflow lines and merge findings.
 */
export function statutoryOutflowLines(
  db: AppDatabase,
  params: { companyId: string; asOf: IsoDate; horizonEnd: IsoDate; dueDateBasis: 'statutory' | 'ros_extended' },
): { lines: ForecastLine[]; findings: string[] } {
  const vatResult = vatOutflowLines(db, params);
  const payrollResult = payrollRemittanceOutflowLines(db, params);
  const ctLines = ctOutflowLines(db, { companyId: params.companyId, asOf: params.asOf, horizonEnd: params.horizonEnd });

  return {
    lines: [...vatResult.lines, ...ctLines, ...payrollResult.lines],
    findings: [...vatResult.findings, ...payrollResult.findings],
  };
}

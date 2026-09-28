/**
 * Tax and statutory payments in the forecast (issue #566, epic #333).
 *
 * Each payment is dated by a curated due-date rule and the line names it. The
 * company chooses the statutory dates or, where it files and pays on ROS, the
 * later ROS dates (decisions on #333). The ROS date is used only where it has
 * a source; otherwise the statutory date is used and a finding says so.
 *
 * - VAT: VATCA s.76(1), 9 days after the 10th of the month following the
 *   period (the 19th); s.78(2) substitutes 13 days for an electronic return
 *   and remittance (the 23rd).
 * - Corporation tax: the preliminary tax instalments and the balance, from the
 *   corporation tax computation. Its dates are the ROS dates (the 23rd, TDM
 *   47-06-01); the statutory day is the 21st.
 * - Income tax (sole traders, when the owner's tax is included): preliminary
 *   tax for the year and the balance for the year before, on 31 October
 *   (s.959AO). The ROS extension has no recorded source.
 * - RCT: 14 days after the return period, or 23 days where the return and the
 *   payment are both electronic (TCA s.530, "due date").
 *
 * Payroll remittances are in payrollForecast.ts. Nothing is written.
 */

import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accountingPeriods, companies, rctPayments, rctReturns, vatPeriods } from '@/db/schema';
import { addDays, addMonths, asIsoDate, endOfMonth, makeDate, parts, type IsoDate } from '../dates';
import { buildVat3Return } from '../vat/report';
import { computeCorporationTax } from '../corporationTax/computation';
import { computeIncomeTax } from '../incomeTax/computation';
import { rctPeriod } from '../construction/rct';
import { CORPORATION_TAX_CURATED_RULES } from '../rules/corporationTaxCuration';
import { RETURN_DUE_RULE_KEY } from '../rules/returnsCuration';
import { resolveRuleFigure } from '../rules/ruleFigures';
import type { ForecastLine, ForecastOptions } from './types';

export interface StatutoryOutflows {
  lines: ForecastLine[];
  findings: string[];
}

const eur = (minor: number) => (minor / 100).toFixed(2);

/**
 * VATCA s.76(1): "within 9 days immediately after the 10th day of the month
 * immediately following a taxable period"; s.78(2): "13 days" for an
 * electronic return and remittance.
 */
const VAT_DAY_STATUTORY = 10 + 9;
const VAT_DAY_ELECTRONIC = 10 + 13;

/** The VAT return and payment date for a period ending on `end`. */
export function vatDueDate(end: IsoDate, basis: ForecastOptions['dueDateBasis']): IsoDate {
  const next = addMonths(makeDate(parts(end).year, parts(end).month, 1), 1);
  return makeDate(parts(next).year, parts(next).month, basis === 'ros' ? VAT_DAY_ELECTRONIC : VAT_DAY_STATUTORY);
}

/** A ROS date (the 23rd) moved to the statutory 21st, for corporation tax (TCA s.959AS; ROS per TDM 47-06-01). */
export function ctStatutoryDate(rosDate: IsoDate): IsoDate {
  return Number(rosDate.slice(8)) > 21 ? asIsoDate(`${rosDate.slice(0, 8)}21`) : rosDate;
}

function inHorizon(o: ForecastOptions, date: IsoDate): boolean {
  return date >= o.asOf && date <= o.horizonEnd;
}

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

function vatLines(db: AppDatabase, o: ForecastOptions, out: StatutoryOutflows): void {
  const periods = db.select().from(vatPeriods).where(eq(vatPeriods.companyId, o.companyId)).orderBy(vatPeriods.endDate).all();
  if (periods.length === 0) return;
  const day = o.dueDateBasis === 'ros' ? VAT_DAY_ELECTRONIC : VAT_DAY_STATUTORY;
  const rule = o.dueDateBasis === 'ros'
    ? `VATCA s.76(1) with s.78(2): the ${day}rd of the month after the period, for an electronic return and payment.`
    : `VATCA s.76(1): the ${day}th of the month after the period.`;
  let refunds = 0;
  for (const p of periods) {
    const due = vatDueDate(p.endDate as IsoDate, o.dueDateBasis);
    if (due > o.horizonEnd) continue;
    const filed = p.status === 'submitted';
    // A filed return is taken to have been paid with it when its date has passed.
    if (due < o.asOf && filed) continue;
    let net: number;
    let basis: string;
    if (filed && p.filedT3Minor !== null && p.filedT4Minor !== null) {
      net = p.filedT3Minor - p.filedT4Minor;
      basis = `As filed: T3 ${eur(p.filedT3Minor)}, T4 ${eur(p.filedT4Minor)}. ${rule}`;
    } else {
      net = buildVat3Return(db, { companyId: o.companyId, vatPeriodId: p.id }).netPositionMinor;
      basis = `${p.endDate >= o.asOf ? 'The period has not ended: the VAT posted so far' : 'The VAT posted for the period, not yet filed'}. ${rule}`;
    }
    if (net < 0) { refunds += -net; continue; }
    if (net === 0) continue;
    const line: ForecastLine = {
      key: `vat:${p.id}`, date: due, amountMinor: -net, description: `VAT: ${p.name}`,
      category: 'tax', source: 'rule', isEstimate: !filed, estimateBasis: basis, ruleKey: RETURN_DUE_RULE_KEY,
      entityRef: { kind: 'vat_period', id: p.id },
    };
    out.lines.push(due < o.asOf ? { ...line, date: o.asOf, overdue: true, dueDate: due } : line);
  }
  if (refunds) {
    out.findings.push(`VAT repayments of ${eur(refunds)} are not forecast as cash in: when Revenue repays is not known.`);
  }
  const last = periods[periods.length - 1]!;
  if (vatDueDate(last.endDate as IsoDate, o.dueDateBasis) < o.horizonEnd) {
    out.findings.push(`No VAT period after ${last.endDate} is set up, so VAT for later periods falling due by ${o.horizonEnd} is not forecast.`);
  }
}

// ---------------------------------------------------------------------------
// Corporation tax
// ---------------------------------------------------------------------------

function corporationTaxLines(db: AppDatabase, o: ForecastOptions, out: StatutoryOutflows): void {
  const years = db.select().from(accountingPeriods).where(and(
    eq(accountingPeriods.companyId, o.companyId), eq(accountingPeriods.kind, 'financial_year'),
  )).orderBy(accountingPeriods.startDate).all();
  if (years.length === 0) {
    out.findings.push('No financial year is set up, so corporation tax is not forecast.');
    return;
  }
  const date = (rosDate: string) => (o.dueDateBasis === 'ros' ? rosDate as IsoDate : ctStatutoryDate(rosDate as IsoDate));
  const dayNote = o.dueDateBasis === 'ros' ? 'the ROS date (the 23rd, TDM 47-06-01)' : 'the statutory date (the 21st)';
  let pastDue = false;
  for (const fy of years) {
    if (fy.startDate > o.horizonEnd || addMonths(fy.endDate as IsoDate, 9) < o.asOf) continue;
    let ct;
    try {
      ct = computeCorporationTax(db, { companyId: o.companyId, from: fy.startDate as IsoDate, to: fy.endDate as IsoDate });
    } catch (e) {
      out.findings.push(`Corporation tax for ${fy.name} is not forecast: ${(e as Error).message}`);
      continue;
    }
    const before = out.lines.length;
    const ended = fy.endDate < o.asOf;
    const onBooks = ended ? 'the computation on the books' : 'the computation on the books so far (the year has not ended)';
    const prelimKey = ct.dates.citations.find((c) => c.ruleKey.startsWith('ct.preliminary'))?.ruleKey;
    let prelimTotal = 0;
    ct.dates.preliminaryTax.forEach((p, i) => {
      prelimTotal += p.amountMinor;
      const due = date(p.dueDate);
      if (p.amountMinor <= 0) return;
      if (due < o.asOf) { pastDue = true; return; }
      if (!inHorizon(o, due)) return;
      out.lines.push({
        key: `ct_prelim:${fy.id}:${i}`, date: due, amountMinor: -p.amountMinor,
        description: `Corporation tax: preliminary tax for ${fy.name}`, category: 'tax', source: 'rule', isEstimate: true,
        estimateBasis: `${p.basis}; from ${onBooks}, on ${dayNote}.`, ruleKey: prelimKey,
        entityRef: { kind: 'accounting_period', id: fy.id },
      });
    });
    const balance = ct.corporationTaxMinor - prelimTotal;
    const due = date(ct.dates.returnDueDate);
    if (balance > 0 && due < o.asOf) pastDue = true;
    if (balance > 0 && inHorizon(o, due)) out.lines.push({
      key: `ct_balance:${fy.id}`, date: due, amountMinor: -balance,
      description: `Corporation tax: balance for ${fy.name}`, category: 'tax', source: 'rule', isEstimate: true,
      estimateBasis: `Tax of ${eur(ct.corporationTaxMinor)} less preliminary tax of ${eur(prelimTotal)}, from ${onBooks}, on ${dayNote}.`,
      ruleKey: 'ct.return_filing_date', entityRef: { kind: 'accounting_period', id: fy.id },
    });
    if (out.lines.length > before && (ct.findings.length || ct.decisions.length)) {
      out.findings.push(`Corporation tax for ${fy.name} comes from a computation with ${ct.findings.length} finding(s) and `
        + `${ct.decisions.length} decision(s) pending: see the corporation tax screen before relying on it.`);
    }
  }
  if (pastDue) {
    out.findings.push('Corporation tax payments are not recorded against their due dates, so amounts due before the forecast date '
      + 'are taken as paid. Add any that are not as a scenario payment.');
  }
}

// ---------------------------------------------------------------------------
// Income tax (sole traders)
// ---------------------------------------------------------------------------

function incomeTaxLines(db: AppDatabase, o: ForecastOptions, out: StatutoryOutflows): void {
  if (o.dueDateBasis === 'ros') {
    out.findings.push('The ROS extension to the income tax date is not recorded with a source, so income tax uses the statutory 31 October.');
  }
  const cache = new Map<number, ReturnType<typeof computeIncomeTax> | null>();
  const compute = (year: number) => {
    if (!cache.has(year)) {
      try {
        cache.set(year, computeIncomeTax(db, { companyId: o.companyId, year }));
      } catch (e) {
        out.findings.push(`Income tax for ${year} is not forecast: ${(e as Error).message}`);
        cache.set(year, null);
      }
    }
    return cache.get(year)!;
  };
  for (let year = parts(o.asOf).year; year <= parts(o.horizonEnd).year; year++) {
    const due = asIsoDate(`${year}-10-31`);
    if (!inHorizon(o, due)) continue;
    const current = compute(year);
    if (current && current.dates.preliminaryTaxMinor > 0) {
      out.lines.push({
        key: `it_prelim:${year}`, date: due, amountMinor: -current.dates.preliminaryTaxMinor,
        description: `Income tax: preliminary tax for ${year}`, category: 'tax', source: 'rule', isEstimate: true,
        estimateBasis: `Preliminary tax is ${current.dates.basis}; due 31 October.`, ruleKey: 'income_tax.preliminary_tax_date',
      });
    }
    const prior = compute(year - 1);
    if (prior) {
      const total = prior.individuals.reduce((s, i) => s + i.totalMinor, 0);
      const balance = total - prior.dates.preliminaryTaxMinor;
      if (balance > 0) {
        out.lines.push({
          key: `it_balance:${year - 1}`, date: due, amountMinor: -balance,
          description: `Income tax: balance for ${year - 1}`, category: 'tax', source: 'rule', isEstimate: true,
          estimateBasis: `The ${year - 1} liability of ${eur(total)} less the preliminary tax of ${eur(prior.dates.preliminaryTaxMinor)} `
            + 'computed for it, assuming that was paid; due with the return on 31 October.',
          ruleKey: 'income_tax.return_date',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RCT
// ---------------------------------------------------------------------------

function rctDays(db: AppDatabase, o: ForecastOptions, on: IsoDate, out: StatutoryOutflows): { days: number; ruleKey: string } | null {
  const ruleKey = o.dueDateBasis === 'ros' ? 'rct.return_due_date_electronic' : 'rct.return_due_date';
  const curated = CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === ruleKey)!;
  const f = resolveRuleFigure(db, { companyId: o.companyId, ruleKey, asOfDate: on, curated });
  const days = f.numericValue ?? (f.status === 'curation_only' && f.curatedInForce ? f.curatedValue : null);
  if (f.finding && !out.findings.includes(f.finding)) out.findings.push(f.finding);
  return days === null ? null : { days, ruleKey };
}

function rctLines(db: AppDatabase, o: ForecastOptions, out: StatutoryOutflows): void {
  const periods = new Set([
    ...db.select({ p: rctPayments.returnPeriod }).from(rctPayments).where(eq(rctPayments.companyId, o.companyId)).all()
      .flatMap((r) => (r.p ? [r.p] : [])),
    ...db.select({ p: rctReturns.period }).from(rctReturns).where(eq(rctReturns.companyId, o.companyId)).all().map((r) => r.p),
  ]);
  for (const period of [...periods].sort()) {
    const end = endOfMonth(asIsoDate(`${period}-01`));
    if (end > o.horizonEnd) continue;
    const r = rctPeriod(db, { companyId: o.companyId, period });
    if (r.return?.paidOn) continue;
    const amount = r.return ? r.return.summaryLiabilityMinor : r.liabilityMinor;
    if (amount <= 0) continue;
    const rule = rctDays(db, o, end, out);
    const description = `RCT: return period ${period}`;
    const base = {
      key: `rct:${period}`, amountMinor: -amount, description, category: 'tax' as const, source: 'rule' as const,
      entityRef: r.return ? { kind: 'rct_return', id: r.return.id } : undefined,
    };
    if (!rule) {
      out.lines.push({ ...base, date: null, isEstimate: true, estimateBasis: 'The RCT due-date rule was rejected, so no date is given.' });
      continue;
    }
    const due = addDays(end, rule.days);
    if (due > o.horizonEnd) continue;
    const line: ForecastLine = {
      ...base, date: due, ruleKey: rule.ruleKey, isEstimate: !r.return,
      estimateBasis: `${r.return ? 'The return\'s liability' : `The tax on the payments recorded so far${end >= o.asOf ? ' (the period has not ended)' : ''}`}; `
        + `due ${rule.days} days after the period (TCA s.530).`,
    };
    out.lines.push(due < o.asOf ? { ...line, date: o.asOf, overdue: true, dueDate: due } : line);
  }
}

/** The tax and statutory payments falling in the forecast (#566). */
export function statutoryOutflowLines(db: AppDatabase, o: ForecastOptions): StatutoryOutflows {
  const out: StatutoryOutflows = { lines: [], findings: [] };
  const company = db.select().from(companies).where(eq(companies.id, o.companyId)).get();
  if (!company) return out;
  vatLines(db, o, out);
  if (company.entityType === 'company') corporationTaxLines(db, o, out);
  if (company.entityType === 'sole_trader' && o.includeOwnerTax) incomeTaxLines(db, o, out);
  if (company.entityType === 'partnership' && o.includeOwnerTax) {
    out.findings.push('Partners pay their own income tax on their shares of the profit, so it is not in the partnership\'s forecast.');
  }
  rctLines(db, o, out);
  return out;
}

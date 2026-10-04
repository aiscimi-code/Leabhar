import { and, eq, gt, gte, isNotNull, lte, notInArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { bankTransactions, companies, invoices, invoiceLines, vatEntries, vatTreatments } from '@/db/schema';
import { multiplyRational } from '../money';
import { addDays, addYears, asIsoDate, makeDate } from '../dates';

/**
 * Apportionment of VAT on dual-use inputs (VATCA s.61, S.I. 639/2010 reg.17;
 * issue #209). A company that makes both deductible supplies (taxable,
 * zero-rated, supplies abroad) and exempt ones may deduct VAT on costs used
 * for both only in proportion to its deductible supplies. The default basis
 * is turnover (s.61(4)): deductible turnover over total turnover, VAT-
 * exclusive, for the accounting year in which the period ends. Outside-the-
 * scope amounts are in neither figure.
 *
 * Which purchases are dual-use is a person's judgement, as is whether the
 * turnover basis reflects use (s.61(5)); both are flagged, never decided.
 */

export interface TurnoverProportion {
  yearStart: string;
  yearEnd: string;
  deductibleMinor: number;
  exemptMinor: number;
  totalMinor: number;
  /** Deductible share in basis points, rounded half away from zero; null with no turnover. */
  proportionBp: number | null;
}

/** The company's accounting year containing a date. */
export function accountingYearContaining(db: AppDatabase, companyId: string, date: string): { start: string; end: string } {
  const c = db.select().from(companies).where(eq(companies.id, companyId)).get()!;
  const year = Number(date.slice(0, 4));
  const endIn = (y: number) => makeDate(y, c.financialYearEndMonth, Math.min(c.financialYearEndDay, new Date(Date.UTC(y, c.financialYearEndMonth, 0)).getUTCDate()));
  const end = endIn(year) >= date ? endIn(year) : endIn(year + 1);
  return { start: addDays(addYears(asIsoDate(end), -1), 1), end };
}

export function turnoverProportion(db: AppDatabase, params: { companyId: string; yearStart: string; yearEnd: string }): TurnoverProportion {
  const rows = db.select({
    lineNet: invoiceLines.netMinor, invNet: invoices.netMinor, invBaseNet: invoices.baseNetMinor, code: vatTreatments.code,
  }).from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .leftJoin(vatTreatments, eq(invoiceLines.vatTreatmentId, vatTreatments.id))
    .where(and(
      eq(invoices.companyId, params.companyId), eq(invoices.direction, 'sales'),
      gte(invoices.invoiceDate, params.yearStart), lte(invoices.invoiceDate, params.yearEnd),
      notInArray(invoices.status, ['draft', 'void']),
    )).all();
  let deductible = 0;
  let exempt = 0;
  const add = (code: string | null, base: number) => {
    if (code === 'OUT_OF_SCOPE') return;
    if (code === 'IE_EXEMPT') exempt += base; else deductible += base;
  };
  for (const r of rows) {
    // In base currency: the line's share of the invoice's base net.
    add(r.code, r.invNet ? multiplyRational(r.lineNet, r.invBaseNet, r.invNet) : r.lineNet);
  }

  // Sales recorded from the bank, with no invoice (issue #637). A rated sale
  // always has a VAT entry, which carries its base net; a reversed
  // classification's entries are negated, so they net out.
  const bankEntries = db.select({ baseNet: vatEntries.baseNetMinor, code: vatTreatments.code }).from(vatEntries)
    .leftJoin(vatTreatments, eq(vatEntries.vatTreatmentId, vatTreatments.id))
    .where(and(
      eq(vatEntries.companyId, params.companyId), eq(vatEntries.sourceType, 'bank_transaction'),
      eq(vatEntries.direction, 'sales'), eq(vatEntries.isReverseChargeLeg, false),
      gte(vatEntries.taxPointDate, params.yearStart), lte(vatEntries.taxPointDate, params.yearEnd),
    )).all();
  for (const e of bankEntries) add(e.code, e.baseNet);
  // A receipt classified under a treatment that charges no rate (an exempt
  // sale) writes no VAT entry: its whole amount is the net. A receipt that
  // settles an invoice carries no treatment, and is counted with the invoice.
  const unrated = db.select({
    amount: bankTransactions.amountMinor, baseAmount: bankTransactions.baseAmountMinor, code: vatTreatments.code,
  }).from(bankTransactions)
    .innerJoin(vatTreatments, eq(bankTransactions.vatTreatmentId, vatTreatments.id))
    .where(and(
      eq(bankTransactions.companyId, params.companyId), eq(bankTransactions.status, 'posted'),
      isNotNull(bankTransactions.journalEntryId), gt(bankTransactions.amountMinor, 0),
      eq(vatTreatments.appliesRate, false),
      gte(bankTransactions.transactionDate, params.yearStart), lte(bankTransactions.transactionDate, params.yearEnd),
    )).all();
  for (const t of unrated) add(t.code, t.baseAmount ?? t.amount);
  const total = deductible + exempt;
  return {
    yearStart: params.yearStart, yearEnd: params.yearEnd, deductibleMinor: deductible, exemptMinor: exempt, totalMinor: total,
    proportionBp: total > 0 ? multiplyRational(deductible, 10_000, total) : null,
  };
}

/**
 * The turnover proportion for the review period before the one containing a
 * date: the accounting year that ends the day before it starts (S.I. 639/2010
 * reg.17(1)). It is the figure for basis (ii) of reg.17(2)(a), where the
 * preceding review period's proportion was calculated on turnover (s.61(4));
 * whether turnover reflects use is the person's call (s.61(5)). Like
 * `turnoverProportion`, it counts posted sales, invoiced or recorded from the
 * bank, and does not exclude incidental transactions under s.61(6)(b).
 */
export function precedingReviewPeriodProportion(db: AppDatabase, params: { companyId: string; date: string }): TurnoverProportion {
  const current = accountingYearContaining(db, params.companyId, params.date);
  const previous = accountingYearContaining(db, params.companyId, addDays(asIsoDate(current.start), -1));
  return turnoverProportion(db, { companyId: params.companyId, yearStart: previous.start, yearEnd: previous.end });
}

export interface ApportionmentFinding { code: 'dual_use_apportionment'; title: string; detail: string }

/** For a VAT period: when the company makes both exempt and deductible supplies, the proportion and what to do. */
export function apportionmentFindings(db: AppDatabase, params: { companyId: string; periodEnd: string }): ApportionmentFinding[] {
  const year = accountingYearContaining(db, params.companyId, params.periodEnd);
  const t = turnoverProportion(db, { companyId: params.companyId, yearStart: year.start, yearEnd: params.periodEnd });
  if (t.exemptMinor === 0 || t.deductibleMinor === 0 || t.proportionBp === null) return [];
  const pct = `${(t.proportionBp / 100).toFixed(2)}%`;
  const reviewDue = params.periodEnd === year.end;
  return [{
    code: 'dual_use_apportionment',
    title: `Exempt and taxable supplies: VAT on dual-use costs is deductible at ${pct}`,
    detail: `Sales ${year.start} to ${params.periodEnd}: deductible €${(t.deductibleMinor / 100).toFixed(2)}, exempt `
      + `€${(t.exemptMinor / 100).toFixed(2)}. On the turnover basis (VATCA s.61(4)) only ${pct} of the VAT on costs used for `
      + 'both kinds of supply is deductible; VAT on costs used only for exempt supplies is not deductible at all. Check the '
      + 'purchase lines used for both, and use another basis if turnover does not reflect their use (s.61(5)).'
      + (reviewDue ? ' This period ends the accounting year: recalculate the proportion for the whole year and adjust the '
        + 'VAT deducted in the next period (S.I. 639/2010 reg.17(3)).' : ''),
  }];
}

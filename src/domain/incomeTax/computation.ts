import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, journalEntries } from '@/db/schema';
import { multiplyRational } from '../money';
import { accountingYearContaining } from '../vat/apportionment';
import { computeBase, currentDecision, type CtBase, type CtPendingDecision } from '../corporationTax/computation';
import { INCOME_TAX_CURATED_RULES } from '../rules/incomeTaxCuration';
import { shareSegments, partnershipFindings } from '../config/partners';

/**
 * Income tax on a sole trader's or partnership's trading profits for a year
 * of assessment (issue #212; PAYE is out of scope).
 *
 * The trade's tax-adjusted profit per accounting period is the same
 * computation as for a company (add-backs, capital allowances: `computeBase`),
 * then the basis rules pick the profits of the year (TCA ss.65-67), a
 * partnership's are apportioned to its partners by their shares (s.1008),
 * and each individual's income tax, USC and PRSI Class S is computed at the
 * rates and bands of the year from the statutory rules.
 *
 * Each figure is an individual's liability only if the trade is all their
 * income: other income, a spouse's income and other credits are not known
 * here, and the findings say so.
 */

export type PersonalStatus = 'single' | 'single_parent' | 'married_one_income' | 'married_two_incomes';
export const PERSONAL_STATUSES: Record<PersonalStatus, string> = {
  single: 'Single, widowed without children, or assessed as single (band €44,000; credit €2,000)',
  single_parent: 'Qualifies for the single person child carer credit (band €48,000)',
  married_one_income: 'Married or civil partners, jointly assessed, one income (band €53,000; credit €4,000)',
  married_two_incomes: 'Married or civil partners, jointly assessed, two incomes (band up to €88,000)',
};

export interface IncomeTaxLine { label: string; amountMinor: number; ruleKeys: string[] }

export interface IndividualLiability {
  name: string;
  partnerId: string | null;
  /** The individual's share of the assessable profit. */
  profitMinor: number;
  status: PersonalStatus;
  incomeTax: IncomeTaxLine[];
  incomeTaxMinor: number;
  usc: IncomeTaxLine[];
  uscMinor: number;
  prsiMinor: number | null;
  totalMinor: number;
}

export interface IncomeTaxComputation {
  companyId: string;
  year: number;
  basis: { from: string; to: string; rule: string; ruleKeys: string[] };
  /** The trade's assessable profit for the year, after the basis rules. */
  assessableProfitMinor: number;
  thirdYearReliefMinor: number;
  individuals: IndividualLiability[];
  dates: { preliminaryTaxDue: string; returnDue: string; preliminaryTaxMinor: number; basis: string };
  decisions: CtPendingDecision[];
  findings: string[];
}

export class IncomeTaxError extends Error {}

const day = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * day).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / day) + 1;
const eur = (minor: number) => (minor / 100).toFixed(2);

/** The rule version in force on a date. */
function ruleOn(ruleKey: string, date: string) {
  return INCOME_TAX_CURATED_RULES.filter((r) => r.ruleKey === ruleKey
    && r.effectiveFrom <= date && (r.effectiveTo === null || r.effectiveTo > date))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

interface Period { from: string; to: string }

export function computeIncomeTax(db: AppDatabase, params: { companyId: string; year: number }): IncomeTaxComputation {
  return new IncomeTaxRun(db, params.companyId).year(params.year);
}

class IncomeTaxRun {
  private readonly company: typeof companies.$inferSelect;
  private readonly commenced: string;
  private readonly bases = new Map<string, CtBase>();
  private readonly years = new Map<number, IncomeTaxComputation>();
  private readonly baseFindings: string[] = [];
  private findings: string[] = [];

  constructor(private readonly db: AppDatabase, private readonly companyId: string) {
    const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
    if (!company) throw new IncomeTaxError(`Company ${companyId} not found.`);
    if (company.entityType === 'company') {
      throw new IncomeTaxError('These books are for a company: its profits are charged to corporation tax, not income tax.');
    }
    this.company = company;
    const earliest = db.select({ d: journalEntries.entryDate }).from(journalEntries)
      .where(eq(journalEntries.companyId, companyId)).orderBy(journalEntries.entryDate).limit(1).get()?.d;
    this.commenced = company.tradeCommencedOn ?? earliest ?? `${new Date().getUTCFullYear()}-01-01`;
    if (!company.tradeCommencedOn) {
      this.baseFindings.push(`The date the trade commenced is not recorded; ${this.commenced} (the first entry) is used. `
        + 'The first three years are taxed on special bases (s.66): record the real date.');
    }
  }

  /** The accounting periods: from commencement to the first year end, then yearly. */
  private periods(until: string): Period[] {
    const out: Period[] = [];
    let start = this.commenced;
    while (start <= until) {
      const end = accountingYearContaining(this.db, this.companyId, start).end;
      const ceased = this.company.tradeCeasedOn;
      out.push({ from: start, to: ceased && ceased < end ? ceased : end });
      if (ceased && ceased <= end) break;
      start = addDays(end, 1);
    }
    return out;
  }

  private adjusted(p: Period): number {
    const key = `${p.from}|${p.to}`;
    if (!this.bases.has(key)) this.bases.set(key, computeBase(this.db, { companyId: this.companyId, from: p.from, to: p.to }));
    return this.bases.get(key)!.adjustedMinor;
  }

  /** Profits of [from, to], time-apportioned from the accounting periods overlapping it. */
  private profitOf(from: string, to: string): number {
    let total = 0;
    for (const p of this.periods(to)) {
      const a = p.from > from ? p.from : from;
      const b = p.to < to ? p.to : to;
      if (a > b) continue;
      total += multiplyRational(this.adjusted(p), days(a, b), days(p.from, p.to));
    }
    return total;
  }

  /** The basis period for a year and the profit assessed on it (ss.65-67). */
  private assessed(year: number): { from: string; to: string; rule: string; ruleKeys: string[]; profit: number } {
    const jan1 = `${year}-01-01`;
    const dec31 = `${year}-12-31`;
    const firstYear = Number(this.commenced.slice(0, 4));
    const ceased = this.company.tradeCeasedOn;
    const pick = (from: string, to: string, rule: string, ruleKeys: string[]) => ({ from, to, rule, ruleKeys, profit: this.profitOf(from, to) });
    if (ceased && ceased.startsWith(String(year))) {
      return pick(jan1, ceased, 'Year of cessation: 1 January to the date the trade ceased (s.67(1)(a)(i)).', ['income_tax.basis_cessation']);
    }
    if (year === firstYear) {
      return pick(this.commenced, dec31, 'First year: commencement to 31 December (s.66(1)).', ['income_tax.basis_first_year']);
    }
    const ending = this.periods(dec31).filter((p) => p.to >= jan1 && p.to <= dec31);
    const twelveTo = (end: string) => addDays(`${Number(end.slice(0, 4)) - 1}${end.slice(4)}`, 1);
    if (year === firstYear + 1) {
      const only = ending.length === 1 ? ending[0]! : null;
      if (only && days(only.from, only.to) >= 365) {
        return pick(twelveTo(only.to), only.to, 'Second year: the 12 months to the one account date in the year (s.66(2)).', ['income_tax.basis_second_year']);
      }
      return pick(jan1, dec31, 'Second year: the actual year, as no single account of 12 months or more ends in it (s.66(2)).', ['income_tax.basis_second_year']);
    }
    const last = ending.at(-1);
    if (!last) {
      this.findings.push(`No account ends in ${year}: it is taxed on its actual profits, which may not be the basis Revenue applies (s.65(3)).`);
      return pick(jan1, dec31, 'No account ends in the year: the actual year.', ['income_tax.basis_accounting_period']);
    }
    return pick(twelveTo(last.to), last.to, 'The 12 months to the account date in the year (s.65(2)).', ['income_tax.basis_accounting_period']);
  }

  private liability(name: string, partnerId: string | null, profit: number, year: number, decisions: CtPendingDecision[]): IndividualLiability {
    const dec31 = `${year}-12-31`;
    const subjectId = partnerId ?? this.companyId;
    const decided = currentDecision(this.db, this.companyId, 'personal_status', subjectId, dec31)?.choice as PersonalStatus | undefined;
    const status = decided ?? 'single';
    decisions.push({
      subjectType: 'personal_status', subjectId, description: `${name}: personal status for ${year}`, amountMinor: 0,
      suggested: 'single', decided: decided ?? null,
      options: (Object.keys(PERSONAL_STATUSES) as PersonalStatus[]).map((c) => ({ choice: c, label: PERSONAL_STATUSES[c] })),
      reason: 'The standard rate band and personal credit depend on it (s.15 Table, s.461).',
    });
    const need = (key: string) => {
      const r = ruleOn(key, dec31);
      if (!r) this.findings.push(`No ${key} rule is in force for ${year}: that part of ${name}'s liability is not computed.`);
      return r;
    };
    const p = Math.max(profit, 0);

    // Income tax (s.15 Table; credits s.461, s.472AB).
    const band = need(status === 'single' ? 'income_tax.band_single' : status === 'single_parent' ? 'income_tax.band_single_parent' : 'income_tax.band_married');
    const higher = need('income_tax.rate_higher');
    const credit = need(status.startsWith('married') ? 'income_tax.personal_credit_married' : 'income_tax.personal_credit_single');
    const eic = need('income_tax.earned_income_credit');
    const eicPct = need('income_tax.earned_income_credit_percentage');
    const incomeTax: IncomeTaxLine[] = [];
    let incomeTaxMinor = 0;
    if (band && higher && credit && eic && eicPct) {
      const atStandard = Math.min(p, band.numericValue!);
      const atHigher = p - atStandard;
      const eicMinor = Math.min(eic.numericValue!, multiplyRational(p, eicPct.numericValue!, 10_000));
      incomeTax.push(
        { label: `${eur(atStandard)} at ${band.rateBasisPoints! / 100}%`, amountMinor: multiplyRational(atStandard, band.rateBasisPoints!, 10_000), ruleKeys: [band.ruleKey] },
        { label: `${eur(atHigher)} at ${higher.numericValue! / 100}%`, amountMinor: multiplyRational(atHigher, higher.numericValue!, 10_000), ruleKeys: [higher.ruleKey] },
        { label: 'Less personal tax credit', amountMinor: -credit.numericValue!, ruleKeys: [credit.ruleKey] },
        { label: 'Less earned income tax credit', amountMinor: -eicMinor, ruleKeys: [eic.ruleKey, eicPct.ruleKey] },
      );
      incomeTaxMinor = Math.max(incomeTax.reduce((s, l) => s + l.amountMinor, 0), 0);
    }
    if (status === 'married_two_incomes') {
      this.findings.push(`${name}: a second income raises the band by up to €35,000 (s.15(3)); the spouse's income is not known here, so the €53,000 band is used.`);
    }

    // USC (s.531AN).
    const usc: IncomeTaxLine[] = [];
    const exemption = need('usc.exemption_threshold');
    const bands = ['usc.band_05pct', 'usc.band_2pct', 'usc.band_3pct'].map(need);
    const top = need('usc.rate_top');
    const surcharge = need('usc.surcharge_non_paye');
    if (exemption && top && surcharge && bands.every(Boolean) && p > exemption.numericValue!) {
      let left = p;
      for (const b of bands) {
        const part = Math.min(left, b!.numericValue!);
        usc.push({ label: `${eur(part)} at ${b!.rateBasisPoints! / 100}%`, amountMinor: multiplyRational(part, b!.rateBasisPoints!, 10_000), ruleKeys: [b!.ruleKey] });
        left -= part;
      }
      usc.push({ label: `${eur(left)} at ${top.numericValue! / 100}%`, amountMinor: multiplyRational(left, top.numericValue!, 10_000), ruleKeys: [top.ruleKey] });
      const over = Math.max(p - 10_000_000, 0);
      if (over) usc.push({ label: `Surcharge: ${eur(over)} over €100,000 at ${surcharge.numericValue! / 100}%`, amountMinor: multiplyRational(over, surcharge.numericValue!, 10_000), ruleKeys: [surcharge.ruleKey] });
    }
    const uscMinor = usc.reduce((s, l) => s + l.amountMinor, 0);

    // PRSI Class S (SWCA 2005 s.21(1)(a)).
    const prsiRule = ruleOn('prsi.class_s_rate', dec31);
    let prsiMinor: number | null = null;
    if (!prsiRule) {
      this.findings.push(`No PRSI Class S rate is recorded as in force for ${year} (the revised s.21 text is dated from 2026-09-25): PRSI is not computed for that year.`);
    } else if (p > 0) {
      prsiMinor = Math.max(multiplyRational(p, prsiRule.numericValue!, 10_000), 65_000);
      this.findings.push(`${name}: PRSI Class S at ${prsiRule.numericValue! / 100}% with the €650 minimum. No Class S is payable on reckonable income under €5,000; that threshold is not in the collected SWCA sections, so check it where income is low.`);
    }
    return {
      name, partnerId, profitMinor: profit, status, incomeTax, incomeTaxMinor, usc, uscMinor, prsiMinor,
      totalMinor: incomeTaxMinor + uscMinor + (prsiMinor ?? 0),
    };
  }

  year(year: number): IncomeTaxComputation {
    const cached = this.years.get(year);
    if (cached) return cached;
    const firstYear = Number(this.commenced.slice(0, 4));
    if (year < firstYear) throw new IncomeTaxError(`The trade commenced in ${firstYear}; there is no ${year} assessment.`);
    const saved = this.findings;
    this.findings = [...this.baseFindings];
    const decisions: CtPendingDecision[] = [];
    const basis = this.assessed(year);

    // s.66(3): the second year's excess over its actual profits reduces the third year's (an election).
    let thirdYearReliefMinor = 0;
    if (year === firstYear + 2) {
      const second = this.assessed(firstYear + 1);
      const actual = this.profitOf(`${firstYear + 1}-01-01`, `${firstYear + 1}-12-31`);
      thirdYearReliefMinor = Math.min(Math.max(second.profit - actual, 0), Math.max(basis.profit, 0));
      if (thirdYearReliefMinor) {
        this.findings.push(`The second year was assessed on ${eur(second.profit)} against actual profits of ${eur(actual)}: the `
          + `excess of ${eur(thirdYearReliefMinor)} reduces this year's profit if the election is made (s.66(3)). It is applied here.`);
      }
    }
    if (this.company.tradeCeasedOn?.startsWith(String(year)) && year > firstYear) {
      const prior = this.assessed(year - 1);
      const actual = this.profitOf(`${year - 1}-01-01`, `${year - 1}-12-31`);
      if (actual > prior.profit) {
        this.findings.push(`The trade ceased in ${year}: ${year - 1} was assessed on ${eur(prior.profit)} but its actual profits `
          + `were ${eur(actual)}, so ${year - 1} is revised up by ${eur(actual - prior.profit)} (s.67(1)(a)(ii)).`);
      }
    }
    const assessableProfitMinor = basis.profit - thirdYearReliefMinor;
    if (assessableProfitMinor < 0) {
      this.findings.push(`The trade made a loss of ${eur(-assessableProfitMinor)} for ${year}. Loss relief against other income `
        + '(s.381) or later profits (s.382) is not computed here.');
    }

    // Who is taxed on it: the owner, or each partner by their share (s.1008).
    const individuals: IndividualLiability[] = [];
    if (this.company.entityType === 'sole_trader') {
      individuals.push(this.liability(this.company.legalName, null, assessableProfitMinor, year, decisions));
    } else {
      this.findings.push(...partnershipFindings(this.db, this.companyId, basis.from, basis.to));
      const byPartner = new Map<string, { name: string; profit: number }>();
      const total = days(basis.from, basis.to);
      for (const seg of shareSegments(this.db, this.companyId, basis.from, basis.to)) {
        const segProfit = multiplyRational(assessableProfitMinor, days(seg.from, seg.to), total);
        for (const s of seg.shares) {
          const cur = byPartner.get(s.partner.id) ?? { name: s.partner.name, profit: 0 };
          cur.profit += multiplyRational(segProfit, s.shareBasisPoints, 10_000);
          byPartner.set(s.partner.id, cur);
        }
      }
      for (const [partnerId, p] of byPartner) individuals.push(this.liability(p.name, partnerId, p.profit, year, decisions));
    }

    // Preliminary tax for the year (s.959AO): the least of 90% of this year, 100% of the last (105% of the one before, by direct debit).
    const liabilityNow = individuals.reduce((s, i) => s + i.incomeTaxMinor + i.uscMinor + (i.prsiMinor ?? 0), 0);
    const priorLiability = year > firstYear ? this.year(year - 1).individuals.reduce((s, i) => s + i.totalMinor, 0) : 0;
    const ninety = multiplyRational(liabilityNow, 9000, 10_000);
    const preliminaryTaxMinor = Math.min(ninety, priorLiability);
    const dates = {
      preliminaryTaxDue: `${year}-10-31`, returnDue: `${year + 1}-10-31`, preliminaryTaxMinor,
      basis: year > firstYear ? 'the lower of 90% of this year\'s liability and 100% of the last year\'s (s.959AO)'
        : 'nil: there was no liability for a prior year (s.959AO)',
    };
    this.findings.push('Each liability assumes the trade is the individual\'s only income and the credits shown are their only ones.');

    const result: IncomeTaxComputation = {
      companyId: this.companyId, year,
      basis: { from: basis.from, to: basis.to, rule: basis.rule, ruleKeys: basis.ruleKeys },
      assessableProfitMinor, thirdYearReliefMinor, individuals, dates, decisions,
      findings: [...new Set(this.findings)],
    };
    this.findings = saved;
    this.years.set(year, result);
    return result;
  }
}

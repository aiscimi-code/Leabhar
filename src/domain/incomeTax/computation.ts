import { classSPrsiMinor } from './classSPrsi';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { partners, companies, journalEntries } from '@/db/schema';
import { multiplyRational } from '../money';
import { asIsoDate } from '../dates';
import { accountingYearContaining } from '../vat/apportionment';
import {
  computeBase, currentDecision, capitalAllowances, INCOME_TAX_LOSS_CLAIMS, BASIS_ELECTIONS,
  ALLOWANCE_LOSS_ELECTIONS, type BasisElection, type AllowanceLossElection,
  type AssetClaimsMade, type CtBase, type CtLine, type CtPendingDecision, type IncomeTaxLossClaim,
} from '../corporationTax/computation';
import { INCOME_TAX_CURATED_RULES } from '../rules/incomeTaxCuration';
import { resolveRuleFigure, type ResolvedRuleFigure } from '../rules/ruleFigures';
import { allocateByShares, partnershipFindings } from '../config/partners';
import { partnerLoanInterestForPeriod } from '../partnerships/interest';
import { FARM_INCOME_AVERAGING, FARM_STOCK_RELIEF_CLAIMS, type FarmIncomeAveraging, type FarmStockReliefClaim } from '../corporationTax/subjects';
import {
  averagedProfit, farmFigure, isFarmingTrade, stockRelief, type AveragingResult, type StockReliefResult,
} from '../farmTax/reliefs';

/**
 * Income tax on a sole trader's or partnership's trading profits for a year
 * of assessment (issue #212; PAYE is out of scope).
 *
 * The trade's tax-adjusted profit per accounting period is the same
 * computation as for a company (add-backs: `computeBase`), but its capital
 * allowances are not apportioned with the profits: they are given for the
 * year of assessment, from the assets in use at the end of its basis period
 * (s.284(1), (2)(b); issue #285). The basis rules pick the profits of the
 * year (TCA ss.65-67), a partnership's are apportioned to its partners by
 * their shares (s.1008), and each individual's income tax, USC and PRSI
 * Class S is computed at the rates and bands of the year from the statutory
 * rules.
 *
 * A trading loss is carried forward against later profits of the same trade
 * (s.382), automatically. Relief against the individual's other income
 * (s.381) must be claimed: it is a decision, with the amount the person is
 * setting against income that is not in these books.
 *
 * Each figure is an individual's liability only if the trade is all their
 * income: other income, a spouse's income and other credits are not known
 * here, and the findings say so.
 */

export type PersonalStatus = 'single' | 'single_parent' | 'married_one_income' | 'married_two_incomes';
/**
 * Descriptions only: the band and credit figures are the rules' to state, so
 * they are appended from the resolved rules at decision time (issue #490)
 * rather than frozen into a label that would silently lie when a rule changes.
 */
export const PERSONAL_STATUSES: Record<PersonalStatus, string> = {
  single: 'Single, widowed without children, or assessed as single',
  single_parent: 'Qualifies for the single person child carer credit',
  married_one_income: 'Married or civil partners, jointly assessed, one income',
  married_two_incomes: 'Married or civil partners, jointly assessed, two incomes',
};

export interface IncomeTaxLine { label: string; amountMinor: number; ruleKeys: string[] }

export interface IndividualLiability {
  name: string;
  partnerId: string | null;
  /** The individual's share of the trade's result for the year: their share of the assessable profit, or of the loss, negative. */
  profitMinor: number;
  /** Losses of earlier years set against that share (s.382), applied automatically, earliest first. */
  broughtForwardLossUsedMinor: number;
  /** The loss this year the person records as claimed against their other income (s.381). Never assumed. */
  claimedAgainstOtherIncomeMinor: number;
  /** The loss left to carry forward against later profits of the same trade (s.382). */
  lossCarriedForwardMinor: number;
  /**
   * Capital allowances of earlier years that created a loss without the s.392
   * election, set against this share before any loss (s.304): unused
   * allowances are carried forward as allowances, not lost (issue #467).
   */
  allowancesBroughtForwardUsedMinor: number;
  /** Unused capital allowances left to carry forward as allowances (s.304). */
  allowancesCarriedForwardMinor: number;
  /** The individual's own preliminary tax for the year (s.959AO): the lower of 90% of this year's liability and 100% of the last year's. */
  preliminaryTaxMinor: number;
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
  /** The trade's profits of the basis period, before capital allowances: the basis rules' figure. */
  basisProfitMinor: number;
  thirdYearReliefMinor: number;
  /** Capital allowances for the year of assessment (s.284(1)): net, so a deduction is negative. */
  capitalAllowancesMinor: number;
  capitalAllowanceLines: CtLine[];
  /** The trade's assessable profit for the year, after the basis rules and the year's capital allowances; negative is a loss. */
  assessableProfitMinor: number;
  /** The trade's loss for the year, before loss relief. */
  tradingLossMinor: number;
  /** The part of the year's loss that predates capital allowances: what s.381 can reach without the s.392 election (issue #467). */
  lossBeforeAllowancesMinor: number;
  /** The part of the year's loss the capital allowances create: a trading loss only under the s.392 election (issue #467). */
  allowanceLossMinor: number;
  individuals: IndividualLiability[];
  dates: { preliminaryTaxDue: string; returnDue: string; preliminaryTaxMinor: number; basis: string };
  /**
   * A farming trade's reliefs (EPIC 25, issue #544): stock relief taken off
   * the year's profit, and income averaging where elected. `chargedBasisMinor`
   * is the profit before capital allowances that is charged after them.
   */
  farm: FarmReliefs | null;
  decisions: CtPendingDecision[];
  findings: string[];
}

export interface FarmReliefs {
  stockRelief: StockReliefResult | null;
  averaging: (AveragingResult & { applied: boolean }) | null;
  chargedBasisMinor: number;
}

export class IncomeTaxError extends Error {}

const day = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * day).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / day) + 1;
const eur = (minor: number) => (minor / 100).toFixed(2);

/** The figure a rule states on a date: the stored rule a person can review, not the shipped constant (issue #282). */
function ruleOn(db: AppDatabase, companyId: string, ruleKey: string, date: string): ResolvedRuleFigure | null {
  const curatedVersion = INCOME_TAX_CURATED_RULES.filter((r) => r.ruleKey === ruleKey
    && r.effectiveFrom <= date && (r.effectiveTo === null || r.effectiveTo > date))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (!curatedVersion) return null;
  return resolveRuleFigure(db, { companyId, ruleKey, asOfDate: date, curated: curatedVersion });
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
  /** The allowances made for each asset in the years of assessment computed so far (s.292). */
  private readonly assetClaims = new Map<string, AssetClaimsMade>();
  /** Losses carried forward against later profits of the same trade, per individual (s.382). */
  private readonly lossPools = new Map<string, number>();
  /** Unused capital allowances carried forward as allowances, per individual (s.304; issue #467). */
  private readonly allowancePools = new Map<string, number>();
  /** A farming trade's profit for each year after stock relief, before averaging and allowances (s.657). */
  private readonly farmProfits = new Map<number, number>();
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

  /** The period's tax-adjusted profit before capital allowances: those are given for the year of assessment (s.284). */
  private adjusted(p: Period): number {
    const key = `${p.from}|${p.to}`;
    if (!this.bases.has(key)) this.bases.set(key, computeBase(this.db, {
      companyId: this.companyId, from: p.from, to: p.to, excludeCapitalAllowances: true,
    }));
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

  /**
   * Capital allowances for this year of assessment: the assets in use at the
   * end of its basis period, at their rates, with the claims already made in
   * earlier years of assessment (issue #285). Allowances are never
   * apportioned with the profits.
   */
  private allowancesFor(from: string, to: string): { netMinor: number; lines: CtLine[]; findings: string[] } {
    const result = capitalAllowances(this.db, {
      companyId: this.companyId, from, to,
      claimsBefore: (asset) => this.assetClaims.get(asset.id) ?? { claims: 0, made: 0 },
    });
    // What this year's assessment claims: each asset's allowance counts, at
    // the amount actually made, so a short basis period's scaled claim (s.284(2)(b))
    // is not read later as a full year's.
    for (const line of result.lines) {
      for (const source of line.sources) {
        if (source.entityType !== 'fixed_asset') continue;
        const made = this.assetClaims.get(source.entityId) ?? { claims: 0, made: 0 };
        made.claims += 1;
        made.made += line.kind === 'add_back' ? -source.amountMinor : source.amountMinor;
        this.assetClaims.set(source.entityId, made);
      }
    }
    return {
      netMinor: result.lines.reduce((sum, line) => sum + line.amountMinor, 0),
      lines: result.lines, findings: result.findings,
    };
  }

  /**
   * Who is taxed on the result: the owner, or each partner by their shares,
   * day by day through changes (s.1008) — the one allocation the year-end
   * close and Form 1 (Firms) also use (`allocateByShares`).
   */
  private sharesOf(result: number, from: string, to: string): Array<{ name: string; partnerId: string | null; share: number }> {
    if (this.company.entityType === 'sole_trader') {
      return [{ name: this.company.legalName, partnerId: null, share: result }];
    }
    this.findings.push(...partnershipFindings(this.db, this.companyId, from, to));
    // Interest credited to a partner's loan account over the period (issue
    // #464): it is the partner's own income, not part of their profit share,
    // and it is not assessed here — their own Form 11 declares it.
    for (const interest of partnerLoanInterestForPeriod(this.db, { companyId: this.companyId, from: asIsoDate(from), to: asIsoDate(to) })) {
      this.findings.push(
        `${interest.partner.name}: ${eur(interest.amountMinor)} of interest was credited to their loan account in this `
          + 'period. It is the partner\u2019s own income, not part of their profit share, so it is not assessed here: their '
          + 'Form 11 declares it as other income, and these books hold only the loan account it was credited to (#458).',
      );
    }
    return allocateByShares(this.db, this.companyId, { from, to, amountMinor: result })
      .map((a) => ({ name: a.partner.name, partnerId: a.partner.id, share: a.amountMinor }));
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

  private liability(params: {
    name: string; partnerId: string | null; shareMinor: number; taxableMinor: number; year: number;
    losses: { broughtForwardUsedMinor: number; claimedAgainstOtherIncomeMinor: number; carriedForwardMinor: number;
      allowancesUsedMinor: number; allowancesCarriedForwardMinor: number };
    decisions: CtPendingDecision[];
  }): IndividualLiability {
    const { name, partnerId, shareMinor, taxableMinor, year, losses, decisions } = params;
    const dec31 = `${year}-12-31`;
    const subjectId = partnerId ?? this.companyId;
    const decided = currentDecision(this.db, this.companyId, 'personal_status', subjectId, dec31)?.choice as PersonalStatus | undefined;
    const status = decided ?? 'single';
    decisions.push({
      subjectType: 'personal_status', subjectId, description: `${name}: personal status for ${year}`, amountMinor: 0,
      suggested: 'single', decided: decided ?? null,
      options: (Object.keys(PERSONAL_STATUSES) as PersonalStatus[]).map((c) => ({ choice: c, label: PERSONAL_STATUSES[c] })),
      reason: 'The standard rate band and personal credit depend on it (s.15 Table, s.461). '
        + 'The band and credit in force are shown on the computation lines, from the rules that state them.',
    });
    const need = (key: string) => {
      const r = ruleOn(this.db, this.companyId, key, dec31);
      if (!r) {
        this.findings.push(`No ${key} rule is in force for ${year}: that part of ${name}'s liability is not computed.`);
        return null;
      }
      if (r.finding) this.findings.push(r.finding);
      if (r.numericValue === null) {
        const why = r.status === 'rejected' ? 'rejected on the review screen'
          : r.status === 'retired' ? 'retired on the review screen' : 'no figure stated';
        this.findings.push(`No ${key} rule is available for ${year} (${why}): `
          + `that part of ${name}'s liability is not computed.`);
        return null;
      }
      return { ruleKey: key, name: r.name, numericValue: r.numericValue, rateBasisPoints: r.rateBasisPoints };
    };
    const p = Math.max(taxableMinor, 0);

    // The earned income credit needs earned income (issue #493). A sole
    // trader's profit is earned income; a partner's share is only if the
    // partner is active in the firm — a sleeping partner's share is not
    // (TCA s.1008(5)). Where the status is unrecorded the credit is given and
    // the claim flagged, never silently either way.
    const partner = partnerId
      ? this.db.select().from(partners).where(eq(partners.id, partnerId)).get()
      : null;
    const sleeping = partner?.activityStatus === 'sleeping';
    if (partner && !partner.activityStatus) {
      this.findings.push(`${name}: this partner's active or sleeping status is not recorded, so the earned income credit is `
        + 'given on the assumption their share is earned income. A sleeping partner’s share is not (TCA s.1008(5)): '
        + 'record the status on the partner.');
    } else if (sleeping) {
      this.findings.push(`${name}: a sleeping partner's share is not earned income (TCA s.1008(5)), so no earned income `
        + 'credit is given on it.');
    }

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
      incomeTax.push(
        { label: `${eur(atStandard)} of the ${eur(band.numericValue!)} band at ${band.rateBasisPoints! / 100}%`, amountMinor: multiplyRational(atStandard, band.rateBasisPoints!, 10_000), ruleKeys: [band.ruleKey] },
        { label: `${eur(atHigher)} at ${higher.numericValue! / 100}%`, amountMinor: multiplyRational(atHigher, higher.numericValue!, 10_000), ruleKeys: [higher.ruleKey] },
        { label: 'Less personal tax credit', amountMinor: -credit.numericValue!, ruleKeys: [credit.ruleKey] },
      );
      if (!sleeping) {
        const eicMinor = Math.min(eic.numericValue!, multiplyRational(p, eicPct.numericValue!, 10_000));
        incomeTax.push(
          { label: 'Less earned income tax credit', amountMinor: -eicMinor, ruleKeys: [eic.ruleKey, eicPct.ruleKey] },
        );
      }
      incomeTaxMinor = Math.max(incomeTax.reduce((s, l) => s + l.amountMinor, 0), 0);
    }
    if (status === 'married_two_incomes') {
      this.findings.push(`${name}: a second income can raise the band (s.15(3)); the spouse's income is not `
        + 'known here, so the married one-income band is used.');
    }

    // USC (s.531AN).
    const usc: IncomeTaxLine[] = [];
    const exemption = need('usc.exemption_threshold');
    const bands = ['usc.band_05pct', 'usc.band_2pct', 'usc.band_3pct'].map(need);
    const top = need('usc.rate_top');
    const surcharge = need('usc.surcharge_non_paye');
    const surchargeThreshold = need('usc.surcharge_threshold');
    if (exemption && top && surcharge && bands.every(Boolean) && p > exemption.numericValue!) {
      let left = p;
      for (const b of bands) {
        const part = Math.min(left, b!.numericValue!);
        usc.push({ label: `${eur(part)} at ${b!.rateBasisPoints! / 100}%`, amountMinor: multiplyRational(part, b!.rateBasisPoints!, 10_000), ruleKeys: [b!.ruleKey] });
        left -= part;
      }
      usc.push({ label: `${eur(left)} at ${top.numericValue! / 100}%`, amountMinor: multiplyRational(left, top.numericValue!, 10_000), ruleKeys: [top.ruleKey] });
      const over = surchargeThreshold ? Math.max(p - surchargeThreshold.numericValue!, 0) : 0;
      if (surchargeThreshold && over) {
        usc.push({ label: `Surcharge: ${eur(over)} over ${eur(surchargeThreshold.numericValue!)} at ${surcharge.numericValue! / 100}%`, amountMinor: multiplyRational(over, surcharge.numericValue!, 10_000), ruleKeys: [surcharge.ruleKey, surchargeThreshold.ruleKey] });
      } else if (!surchargeThreshold) {
        this.findings.push(`No usc.surcharge_threshold rule is available for ${year}: the 3% surcharge's threshold is not applied.`);
      }
    }
    const uscMinor = usc.reduce((s, l) => s + l.amountMinor, 0);

    // PRSI Class S (SWCA 2005 s.21(1)(a)): the rate and the minimum are rule
    // figures like every other (#487), as is the €5,000 prescribed amount
    // below which no Class S is payable (S.I. 312/1996 art. 92).
    const prsiRule = ruleOn(this.db, this.companyId, 'prsi.class_s_rate', dec31);
    if (prsiRule?.finding) this.findings.push(prsiRule.finding);
    const prsiRate = prsiRule?.numericValue ?? null;
    const prsiMinimum = need('prsi.class_s_minimum');
    const prsiDisregard = need('prsi.class_s_disregard');
    let prsiMinor: number | null = null;
    if (!prsiRate) {
      const why = prsiRule?.status === 'rejected' ? 'the rule was rejected on the review screen'
        : prsiRule?.status === 'retired' ? 'the rule was retired on the review screen'
        : 'the revised s.21 text is dated from 2026-09-25';
      this.findings.push(`No PRSI Class S rate is available for ${year} (${why}): PRSI is not computed for that year.`);
    } else if (!prsiMinimum) {
      this.findings.push(`No PRSI Class S minimum (prsi.class_s_minimum) is available for ${year}: PRSI is not computed for that year.`);
    } else if (!prsiDisregard) {
      this.findings.push(`No PRSI Class S prescribed amount (prsi.class_s_disregard) is available for ${year}: PRSI is not computed for that year.`);
    } else if (p > 0) {
      prsiMinor = classSPrsiMinor(p, prsiRate, prsiMinimum.numericValue!, prsiDisregard.numericValue!);
      this.findings.push(prsiMinor === 0
        ? `${name}: no PRSI Class S, reckonable income is under the ${eur(prsiDisregard.numericValue!)} prescribed amount.`
        : `${name}: PRSI Class S at ${prsiRate / 100}% with the ${eur(prsiMinimum.numericValue!)} minimum.`);
    }
    return {
      name, partnerId,
      profitMinor: shareMinor,
      broughtForwardLossUsedMinor: losses.broughtForwardUsedMinor,
      claimedAgainstOtherIncomeMinor: losses.claimedAgainstOtherIncomeMinor,
      lossCarriedForwardMinor: losses.carriedForwardMinor,
      allowancesBroughtForwardUsedMinor: losses.allowancesUsedMinor,
      allowancesCarriedForwardMinor: losses.allowancesCarriedForwardMinor,
      status, incomeTax, incomeTaxMinor, usc, uscMinor, prsiMinor,
      preliminaryTaxMinor: 0,
      totalMinor: incomeTaxMinor + uscMinor + (prsiMinor ?? 0),
    };
  }

  /**
   * A farming trade's reliefs for a year (EPIC 25, issue #544). Stock relief
   * (ss.666, 667B, 667C) comes off the year's profit, limited so it creates
   * no loss; averaging (s.657) then charges one fifth of that profit and the
   * 4 years' before it. Both are the person's claims, offered as pending
   * decisions and applied only when recorded.
   */
  private farmReliefs(
    year: number, basis: { from: string; to: string }, basisProfitMinor: number, allowancesNetMinor: number,
    decisions: CtPendingDecision[],
  ): FarmReliefs | null {
    if (!isFarmingTrade(this.db, this.companyId, basis.from, basis.to)) return null;
    const dec31 = `${year}-12-31`;
    const claim = currentDecision(this.db, this.companyId, 'farm_stock_relief', this.companyId, dec31)?.choice as FarmStockReliefClaim | undefined;
    let relief: StockReliefResult | null = null;
    const priorYoungTrained = [1, 2, 3, 4, 5, 6].map((n) => year - n)
      .filter((y) => currentDecision(this.db, this.companyId, 'farm_stock_relief', this.companyId, `${y}-12-31`)?.choice === 'young_trained').length;
    const preview = stockRelief(this.db, {
      companyId: this.companyId, from: basis.from, to: basis.to, category: claim && claim !== 'none' ? claim : 'general',
      profitAfterAllowancesMinor: basisProfitMinor + allowancesNetMinor, priorYoungTrainedYears: priorYoungTrained,
    });
    decisions.push({
      subjectType: 'farm_stock_relief', subjectId: this.companyId, description: `Stock relief for ${year}`,
      amountMinor: preview.reliefMinor, suggested: 'none', decided: claim ?? null,
      options: (Object.keys(FARM_STOCK_RELIEF_CLAIMS) as FarmStockReliefClaim[]).map((c) => ({ choice: c, label: FARM_STOCK_RELIEF_CLAIMS[c] })),
      reason: `Trading stock went from ${eur(preview.openingStockMinor)} to ${eur(preview.closingStockMinor)}. Stock relief is a claim `
        + '(s.666(5)), and the higher rates depend on facts only the person can state (s.667B, s.667C): nothing is claimed until recorded.',
    });
    if (claim && claim !== 'none') {
      relief = preview;
      this.findings.push(...relief.findings);
      if (relief.reliefMinor > 0) {
        this.findings.push(`Stock relief of ${eur(relief.reliefMinor)} (${relief.rateBasisPoints / 100}% of the ${eur(relief.increaseMinor)} `
          + 'increase in trading stock) is deducted from the farming profit.');
      }
    }
    const afterRelief = basisProfitMinor - (relief?.reliefMinor ?? 0);
    this.farmProfits.set(year, afterRelief);

    const averagingChoice = currentDecision(this.db, this.companyId, 'farm_income_averaging', this.companyId, dec31)?.choice as FarmIncomeAveraging | undefined;
    const lastChoice = currentDecision(this.db, this.companyId, 'farm_income_averaging', this.companyId, `${year - 1}-12-31`)?.choice;
    decisions.push({
      subjectType: 'farm_income_averaging', subjectId: this.companyId, description: `Income averaging for ${year}`, amountMinor: afterRelief,
      suggested: lastChoice === 'averaging' || lastChoice === 'step_out' ? 'averaging' : 'normal', decided: averagingChoice ?? null,
      options: (Object.keys(FARM_INCOME_AVERAGING) as FarmIncomeAveraging[]).map((c) => ({ choice: c, label: FARM_INCOME_AVERAGING[c] })),
      reason: 'A farmer may elect to be charged on the average of five years\' farming profits (s.657). The election, and a '
        + 'single-year step-out (s.657(6A)), are the person\'s: nothing is assumed.',
    });
    let averaging: FarmReliefs['averaging'] = null;
    let charged = afterRelief;
    if (averagingChoice === 'averaging' || averagingChoice === 'step_out') {
      if (this.company.entityType !== 'sole_trader') {
        this.findings.push('Income averaging is each partner\'s own election on their share (s.657): it is not applied to the firm\'s profit here.');
      } else {
        const firstYear = Number(this.commenced.slice(0, 4));
        const result = averagedProfit(this.db, {
          companyId: this.companyId, year,
          profitOf: (y) => {
            if (y >= firstYear && this.farmProfits.has(y)) return { profitMinor: this.farmProfits.get(y)!, source: 'books' };
            const recorded = currentDecision(this.db, this.companyId, 'farm_prior_profit', this.companyId, `${y}-12-31`);
            return recorded?.amountMinor !== null && recorded?.amountMinor !== undefined ? { profitMinor: recorded.amountMinor, source: 'recorded' } : null;
          },
        });
        if ('missing' in result) {
          this.findings.push(`Income averaging needs the farming profits of ${result.missing.join(', ')}, which are not in these books: `
            + 'record each year\'s profit before capital allowances, from its return. Until then the year is charged on its own profit.');
        } else {
          let stepOut = averagingChoice === 'step_out';
          if (stepOut) {
            const interval = farmFigure(this.db, this.companyId, 'farm.averaging_step_out_interval', dec31);
            const earlier = Array.from({ length: interval - 1 }, (_, i) => year - 1 - i)
              .find((y) => currentDecision(this.db, this.companyId, 'farm_income_averaging', this.companyId, `${y}-12-31`)?.choice === 'step_out');
            if (earlier) {
              this.findings.push(`A step-out from averaging is allowed once every ${interval} years (s.657(6A)); there was one in ${earlier}, `
                + 'so averaging applies.');
              stepOut = false;
            } else {
              this.findings.push('Stepping out of averaging for this year: the tax deferred (the averaged tax less this year\'s) is payable '
                + 'in instalments over the next 4 years (s.657(6A)). These books do not compute it.');
            }
          }
          averaging = { ...result, applied: !stepOut };
          if (!stepOut) {
            charged = result.averageMinor;
            this.findings.push(`Income averaging: charged on ${eur(result.averageMinor)}, one fifth of the farming profits of `
              + `${result.years[0]!.year} to ${year} (s.657(5)), before capital allowances.`);
          }
        }
      }
    } else if (lastChoice === 'averaging' || lastChoice === 'step_out') {
      this.findings.push('Averaging applied last year and no choice is recorded for this one: an election continues until the farmer '
        + 'leaves it (s.657(6)), and leaving reviews the 4 years before (s.657(7)). Record the choice.');
    }
    return { stockRelief: relief, averaging, chargedBasisMinor: charged };
  }

  year(year: number): IncomeTaxComputation {
    const firstYear = Number(this.commenced.slice(0, 4));
    if (year < firstYear) throw new IncomeTaxError(`The trade commenced in ${firstYear}; there is no ${year} assessment.`);
    // Losses carried forward (s.382) and allowances claimed (s.292) run from
    // year of assessment to year of assessment: compute the earlier ones first.
    for (let y = firstYear; y < year; y++) this.year(y);
    const cached = this.years.get(year);
    if (cached) return cached;
    const saved = this.findings;
    this.findings = [...this.baseFindings];
    const decisions: CtPendingDecision[] = [];
    const basis = this.assessed(year);

    // s.66(3): the second year's excess over its actual profits can reduce the
    // third year's — but only if the taxpayer elects. The election is a
    // person's to make: it is offered as a pending decision and applied only
    // when recorded (issue #485). Until then the statutory default holds and
    // the third year is assessed without the reduction.
    let thirdYearReliefMinor = 0;
    if (year === firstYear + 2) {
      const second = this.assessed(firstYear + 1);
      const actual = this.profitOf(`${firstYear + 1}-01-01`, `${firstYear + 1}-12-31`);
      const excessMinor = Math.min(Math.max(second.profit - actual, 0), Math.max(basis.profit, 0));
      if (excessMinor) {
        const dec31 = `${year}-12-31`;
        const decided = currentDecision(this.db, this.companyId, 'basis_election', this.companyId, dec31)?.choice as BasisElection | undefined;
        decisions.push({
          subjectType: 'basis_election', subjectId: this.companyId,
          description: `s.66(3) election: reduce the ${year} assessment by the second year's excess`,
          amountMinor: excessMinor, suggested: 'elect', decided: decided ?? null,
          options: (Object.keys(BASIS_ELECTIONS) as BasisElection[]).map((c) => ({ choice: c, label: BASIS_ELECTIONS[c] })),
          reason: `The second year was assessed on ${eur(second.profit)} against actual profits of ${eur(actual)}, so `
            + `the excess of ${eur(excessMinor)} can reduce this year's profit — if the taxpayer elects (s.66(3)). `
            + 'Nothing is assumed: without a recorded election the third year is assessed without the reduction.',
        });
        if (decided === 'elect') {
          thirdYearReliefMinor = excessMinor;
          this.findings.push(`The s.66(3) election is recorded: the second year's excess of ${eur(excessMinor)} reduces this year's profit.`);
        } else {
          this.findings.push(`The second year was assessed on ${eur(second.profit)} against actual profits of ${eur(actual)}: the excess of `
            + `${eur(excessMinor)} reduces this year's profit only if the taxpayer elects (s.66(3)). `
            + (decided === 'decline' ? 'The election is declined, so the reduction is not applied.' : 'No election is recorded, so the reduction is not applied.'));
        }
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
    const basisProfitMinor = basis.profit - thirdYearReliefMinor;

    // Capital allowances are given for this year of assessment by reference to
    // its basis period (s.284(1), (2)(b)), not apportioned with the profits
    // (issue #285).
    const allowances = this.allowancesFor(basis.from, basis.to);
    this.findings.push(...allowances.findings);
    const farm = this.farmReliefs(year, basis, basisProfitMinor, allowances.netMinor, decisions);
    const chargedBasisMinor = farm ? farm.chargedBasisMinor : basisProfitMinor;
    const assessableProfitMinor = chargedBasisMinor + allowances.netMinor;
    const tradingLossMinor = Math.max(-assessableProfitMinor, 0);
    // The loss splits into the part before capital allowances and the part the
    // allowances create (issue #467). Only the election under s.392 treats the
    // allowance part as a trading loss; without it, the unused allowances are
    // carried forward as allowances (s.304(2)) and an s.381 claim can reach
    // only the pre-allowance loss. The election is a person's decision,
    // recorded per individual — never assumed.
    const lossBeforeAllowancesMinor = Math.max(-chargedBasisMinor, 0);
    const allowanceLossMinor = tradingLossMinor - lossBeforeAllowancesMinor;

    // Who is taxed on the result, and the losses set against it (ss.381, 382).
    const individuals: IndividualLiability[] = [];
    const preAllowanceShares = new Map(
      this.sharesOf(chargedBasisMinor, basis.from, basis.to).map((x) => [x.partnerId ?? this.companyId, x]),
    );
    for (const s of this.sharesOf(assessableProfitMinor, basis.from, basis.to)) {
      const subjectId = s.partnerId ?? this.companyId;
      const dec31 = `${year}-12-31`;
      let pool = this.lossPools.get(subjectId) ?? 0;
      // Unused allowances carried forward as allowances come off the profits
      // first (s.304), then losses brought forward (s.382).
      let allowancePool = this.allowancePools.get(subjectId) ?? 0;
      const allowancesUsedMinor = s.share > 0 ? Math.min(allowancePool, s.share) : 0;
      allowancePool -= allowancesUsedMinor;
      const broughtForwardUsedMinor = s.share > 0 ? Math.min(pool, s.share - allowancesUsedMinor) : 0;
      pool -= broughtForwardUsedMinor;
      let claimedAgainstOtherIncomeMinor = 0;
      if (s.share < 0) {
        const totalLossShare = -s.share;
        const preAllowanceLossShare = Math.max(-(preAllowanceShares.get(subjectId)?.share ?? 0), 0);
        const allowanceLossShare = Math.max(totalLossShare - preAllowanceLossShare, 0);
        // The s.392 election, per individual (issue #467): recorded, never assumed.
        const election = currentDecision(this.db, this.companyId, 'allowance_loss_election', subjectId, dec31);
        const elected = (election?.choice as AllowanceLossElection | undefined) === 'elect';
        if (allowanceLossShare) {
          decisions.push({
            subjectType: 'allowance_loss_election', subjectId,
            description: `${s.name}: treat the allowances creating this year's loss as a trading loss (s.392)`,
            amountMinor: allowanceLossShare, suggested: 'elect', decided: election?.choice ?? null,
            options: (Object.keys(ALLOWANCE_LOSS_ELECTIONS) as AllowanceLossElection[])
              .map((c) => ({ choice: c, label: ALLOWANCE_LOSS_ELECTIONS[c] })),
            reason: `Capital allowances contribute ${eur(allowanceLossShare)} of ${s.name}'s ${year} loss of `
              + `${eur(totalLossShare)}. Without the s.392 election that part is not a trading loss: the unused allowances are `
              + 'carried forward as allowances (s.304(2)), and only the loss before allowances can be set against other income (s.381). '
              + 'For carry-forward against the same trade (s.382) the two routes give largely the same result.',
          });
        }
        // What is a trading loss, and what an s.381 claim can reach.
        const tradingLossShare = elected ? totalLossShare : preAllowanceLossShare;
        const claimableAgainstOtherIncome = elected ? totalLossShare : preAllowanceLossShare;
        if (allowanceLossShare && !elected) {
          this.findings.push(`${s.name}: ${eur(allowanceLossShare)} of the ${year} loss is created by capital allowances. No s.392 `
            + 'election is recorded, so it is not treated as a trading loss: the unused allowances are carried forward as '
            + `allowances (s.304(2)), and ${eur(preAllowanceLossShare)} is the loss carried forward (s.382). Elect on the `
            + 'decisions list to treat the allowances as a trading loss.');
        }
        // s.382: carried forward against later profits of the same trade, automatically.
        pool += tradingLossShare;
        // Without the election the allowance-created part is not lost: the
        // unused allowances are carried forward as allowances (s.304).
        if (!elected) allowancePool += allowanceLossShare;
        const decision = currentDecision(this.db, this.companyId, 'income_tax_loss_claim', subjectId, dec31);
        const choice = (decision?.choice as IncomeTaxLossClaim | undefined) ?? 'carry_forward';
        const decidedAmount = decision?.amountMinor ?? null;
        if (choice === 'claim_381') {
          // s.381 relieves this year's loss only: losses brought forward from
          // earlier years stay against later profits of the trade (s.382).
          // Without the s.392 election the claim is capped at the loss before
          // allowances (issue #467).
          const wanted = Math.max(decidedAmount ?? 0, 0);
          claimedAgainstOtherIncomeMinor = Math.min(wanted, claimableAgainstOtherIncome);
          if (allowanceLossShare && !elected && wanted > claimableAgainstOtherIncome) {
            this.findings.push(`${s.name}: the s.381 claim of ${eur(wanted)} is capped at `
              + `${eur(claimableAgainstOtherIncome)}, the loss before capital allowances: without the s.392 election the `
              + 'allowance-created part cannot be set against other income.');
          }
          if (!decidedAmount || decidedAmount <= 0) {
            this.findings.push(`${s.name}: the s.381 claim for ${year} records no amount, so the whole loss is carried forward (s.382).`);
          } else {
            pool -= claimedAgainstOtherIncomeMinor;
            this.findings.push(`${s.name}: ${eur(claimedAgainstOtherIncomeMinor)} of the ${year} loss is claimed against other income of `
              + 'the same year (s.381). That income is not in these books, so the tax it saves is computed on the person\'s own '
              + 'return, not here.');
          }
        }
        decisions.push({
          subjectType: 'income_tax_loss_claim', subjectId, description: `${s.name}: trading loss for ${year}`,
          amountMinor: tradingLossShare, suggested: 'carry_forward', decided: decision?.choice ?? null, decidedAmountMinor: decidedAmount,
          options: (Object.keys(INCOME_TAX_LOSS_CLAIMS) as IncomeTaxLossClaim[]).map((c) => ({ choice: c, label: INCOME_TAX_LOSS_CLAIMS[c] })),
          reason: 'Carry-forward against the same trade (s.382) is automatic. Relief against other income (s.381) must be claimed '
            + '(the four years after the end of the year of assessment, s.865), and needs the amount set against income the books do not hold.',
        });
      }
      this.lossPools.set(subjectId, pool);
      this.allowancePools.set(subjectId, allowancePool);
      individuals.push(this.liability({
        name: s.name, partnerId: s.partnerId, shareMinor: s.share,
        taxableMinor: Math.max(s.share - allowancesUsedMinor - broughtForwardUsedMinor, 0), year, decisions,
        losses: {
          broughtForwardUsedMinor, claimedAgainstOtherIncomeMinor, carriedForwardMinor: pool,
          allowancesUsedMinor, allowancesCarriedForwardMinor: allowancePool,
        },
      }));
    }

    // Preliminary tax for the year (s.959AO): the least of 90% of this year,
    // 100% of the last. The percentages are the rules' to state, read like
    // every other figure (issue #486): an edited or re-derived rule changes the
    // computation, a rejected one stops the part.
    const dec31 = `${year}-12-31`;
    const pct = (key: string): number | null => {
      const r = ruleOn(this.db, this.companyId, key, dec31);
      if (r?.finding) this.findings.push(r.finding);
      if (!r || r.numericValue === null) {
        const why = !r ? 'no rule is in force' : r.status === 'rejected' ? 'the rule was rejected on the review screen'
          : r.status === 'retired' ? 'the rule was retired on the review screen' : 'no figure stated';
        this.findings.push(`No ${key} rule is available for ${year} (${why}): that preliminary tax test is not applied.`);
        return null;
      }
      return r.numericValue;
    };
    const currentYearPct = pct('income_tax.preliminary_tax_current_year');
    const priorYearPct = pct('income_tax.preliminary_tax_prior_year');
    const liabilityNow = individuals.reduce((s, i) => s + i.incomeTaxMinor + i.uscMinor + (i.prsiMinor ?? 0), 0);
    const priorLiability = year > firstYear ? this.year(year - 1).individuals.reduce((s, i) => s + i.totalMinor, 0) : 0;
    const atCurrent = currentYearPct !== null ? multiplyRational(liabilityNow, currentYearPct, 10_000) : null;
    const atPrior = priorYearPct !== null ? multiplyRational(priorLiability, priorYearPct, 10_000) : null;
    const candidates = [atCurrent, atPrior].filter((c): c is NonNullable<typeof c> => c !== null);
    const preliminaryTaxMinor = candidates.length ? Math.min(...candidates) : 0;
    // s.959AO is each individual's own, against their own prior liability: the
    // Form 11's self-assessment panel asks for it per person.
    const priorTotals = year > firstYear
      ? new Map(this.year(year - 1).individuals.map((i) => [i.partnerId ?? this.companyId, i.totalMinor]))
      : null;
    for (const i of individuals) {
      const ownCurrent = currentYearPct !== null ? multiplyRational(i.totalMinor, currentYearPct, 10_000) : null;
      const ownPrior = priorTotals && priorYearPct !== null
        ? multiplyRational(priorTotals.get(i.partnerId ?? this.companyId) ?? 0, priorYearPct, 10_000)
        : null;
      const own = [ownCurrent, ownPrior].filter((c): c is NonNullable<typeof c> => c !== null);
      i.preliminaryTaxMinor = own.length ? Math.min(...own) : 0;
    }
    const pctText = (value: number) => `${value / 100}%`;
    const basisParts = [
      currentYearPct !== null ? `${pctText(currentYearPct)} of this year's liability` : null,
      priorYearPct !== null ? `${pctText(priorYearPct)} of the last year's` : null,
    ].filter((part): part is string => part !== null);
    const dates = {
      preliminaryTaxDue: `${year}-10-31`, returnDue: `${year + 1}-10-31`, preliminaryTaxMinor,
      basis: year > firstYear
        ? basisParts.length
          ? `the lower of ${basisParts.join(' and ')} (s.959AO)`
          : 'not computed: no preliminary tax rule is available (s.959AO)'
        : 'nil: there was no liability for a prior year (s.959AO)',
    };
    this.findings.push('Each liability assumes the trade is the individual\'s only income and the credits shown are their only ones.');

    const result: IncomeTaxComputation = {
      companyId: this.companyId, year,
      basis: { from: basis.from, to: basis.to, rule: basis.rule, ruleKeys: basis.ruleKeys },
      basisProfitMinor, thirdYearReliefMinor,
      capitalAllowancesMinor: allowances.netMinor, capitalAllowanceLines: allowances.lines,
      assessableProfitMinor, tradingLossMinor, lossBeforeAllowancesMinor, allowanceLossMinor,
      individuals, dates, farm, decisions,
      findings: [...new Set(this.findings)],
    };
    this.findings = saved;
    this.years.set(year, result);
    return result;
  }
}

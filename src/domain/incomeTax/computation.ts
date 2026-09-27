import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, journalEntries } from '@/db/schema';
import { multiplyRational } from '../money';
import { accountingYearContaining } from '../vat/apportionment';
import {
  computeBase, currentDecision, capitalAllowances, INCOME_TAX_LOSS_CLAIMS,
  type AssetClaimsMade, type CtBase, type CtLine, type CtPendingDecision, type IncomeTaxLossClaim,
} from '../corporationTax/computation';
import { INCOME_TAX_CURATED_RULES } from '../rules/incomeTaxCuration';
import { resolveRuleFigure, type ResolvedRuleFigure } from '../rules/ruleFigures';
import { allocateByShares, partnershipFindings } from '../config/partners';

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
  /** The individual's share of the trade's result for the year: their share of the assessable profit, or of the loss, negative. */
  profitMinor: number;
  /** Losses of earlier years set against that share (s.382), applied automatically, earliest first. */
  broughtForwardLossUsedMinor: number;
  /** The loss this year the person records as claimed against their other income (s.381). Never assumed. */
  claimedAgainstOtherIncomeMinor: number;
  /** The loss left to carry forward against later profits of the same trade (s.382). */
  lossCarriedForwardMinor: number;
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
    losses: { broughtForwardUsedMinor: number; claimedAgainstOtherIncomeMinor: number; carriedForwardMinor: number };
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
      reason: 'The standard rate band and personal credit depend on it (s.15 Table, s.461).',
    });
    const need = (key: string) => {
      const r = ruleOn(this.db, this.companyId, key, dec31);
      if (!r) {
        this.findings.push(`No ${key} rule is in force for ${year}: that part of ${name}'s liability is not computed.`);
        return null;
      }
      if (r.finding) this.findings.push(r.finding);
      if (r.numericValue === null) {
        this.findings.push(`No ${key} rule is available for ${year} (${r.status === 'rejected' ? 'rejected on the review screen' : 'no figure stated'}): `
          + `that part of ${name}'s liability is not computed.`);
        return null;
      }
      return { ruleKey: key, name: r.name, numericValue: r.numericValue, rateBasisPoints: r.rateBasisPoints };
    };
    const p = Math.max(taxableMinor, 0);

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
    const prsiRule = ruleOn(this.db, this.companyId, 'prsi.class_s_rate', dec31);
    if (prsiRule?.finding) this.findings.push(prsiRule.finding);
    const prsiRate = prsiRule?.numericValue ?? null;
    let prsiMinor: number | null = null;
    if (!prsiRate) {
      this.findings.push(`No PRSI Class S rate is available for ${year} (${prsiRule?.status === 'rejected'
        ? 'the rule was rejected on the review screen' : 'the revised s.21 text is dated from 2026-09-25'}): PRSI is not computed for that year.`);
    } else if (p > 0) {
      prsiMinor = Math.max(multiplyRational(p, prsiRate, 10_000), 65_000);
      this.findings.push(`${name}: PRSI Class S at ${prsiRate / 100}% with the €650 minimum. No Class S is payable on reckonable income under €5,000; that threshold is not in the collected SWCA sections, so check it where income is low.`);
    }
    return {
      name, partnerId,
      profitMinor: shareMinor,
      broughtForwardLossUsedMinor: losses.broughtForwardUsedMinor,
      claimedAgainstOtherIncomeMinor: losses.claimedAgainstOtherIncomeMinor,
      lossCarriedForwardMinor: losses.carriedForwardMinor,
      status, incomeTax, incomeTaxMinor, usc, uscMinor, prsiMinor,
      preliminaryTaxMinor: 0,
      totalMinor: incomeTaxMinor + uscMinor + (prsiMinor ?? 0),
    };
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
    const basisProfitMinor = basis.profit - thirdYearReliefMinor;

    // Capital allowances are given for this year of assessment by reference to
    // its basis period (s.284(1), (2)(b)), not apportioned with the profits
    // (issue #285).
    const allowances = this.allowancesFor(basis.from, basis.to);
    this.findings.push(...allowances.findings);
    const assessableProfitMinor = basisProfitMinor + allowances.netMinor;
    const tradingLossMinor = Math.max(-assessableProfitMinor, 0);
    if (basisProfitMinor >= 0 && assessableProfitMinor < 0) {
      this.findings.push('Capital allowances turned this year\'s profits into a loss. To use that loss against other income (s.381) '
        + 'the allowances must be treated as a trading loss by election (s.392); without the election the unused allowances are '
        + 'carried forward as allowances instead (s.304(2)). The loss here assumes the election is made.');
    }

    // Who is taxed on the result, and the losses set against it (ss.381, 382).
    const individuals: IndividualLiability[] = [];
    for (const s of this.sharesOf(assessableProfitMinor, basis.from, basis.to)) {
      const subjectId = s.partnerId ?? this.companyId;
      const dec31 = `${year}-12-31`;
      let pool = this.lossPools.get(subjectId) ?? 0;
      const broughtForwardUsedMinor = s.share > 0 ? Math.min(pool, s.share) : 0;
      pool -= broughtForwardUsedMinor;
      let claimedAgainstOtherIncomeMinor = 0;
      if (s.share < 0) {
        // s.382: carried forward against later profits of the same trade, automatically.
        pool += -s.share;
        const decision = currentDecision(this.db, this.companyId, 'income_tax_loss_claim', subjectId, dec31);
        const choice = (decision?.choice as IncomeTaxLossClaim | undefined) ?? 'carry_forward';
        const decidedAmount = decision?.amountMinor ?? null;
        if (choice === 'claim_381') {
          // s.381 relieves this year's loss only: losses brought forward from
          // earlier years stay against later profits of the trade (s.382).
          claimedAgainstOtherIncomeMinor = Math.min(Math.max(decidedAmount ?? 0, 0), -s.share);
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
          amountMinor: -s.share, suggested: 'carry_forward', decided: decision?.choice ?? null, decidedAmountMinor: decidedAmount,
          options: (Object.keys(INCOME_TAX_LOSS_CLAIMS) as IncomeTaxLossClaim[]).map((c) => ({ choice: c, label: INCOME_TAX_LOSS_CLAIMS[c] })),
          reason: 'Carry-forward against the same trade (s.382) is automatic. Relief against other income (s.381) must be claimed '
            + '(the four years after the end of the year of assessment, s.865), and needs the amount set against income the books do not hold.',
        });
      }
      this.lossPools.set(subjectId, pool);
      individuals.push(this.liability({
        name: s.name, partnerId: s.partnerId, shareMinor: s.share,
        taxableMinor: Math.max(s.share - broughtForwardUsedMinor, 0), year, decisions,
        losses: { broughtForwardUsedMinor, claimedAgainstOtherIncomeMinor, carriedForwardMinor: pool },
      }));
    }

    // Preliminary tax for the year (s.959AO): the least of 90% of this year, 100% of the last (105% of the one before, by direct debit).
    const liabilityNow = individuals.reduce((s, i) => s + i.incomeTaxMinor + i.uscMinor + (i.prsiMinor ?? 0), 0);
    const priorLiability = year > firstYear ? this.year(year - 1).individuals.reduce((s, i) => s + i.totalMinor, 0) : 0;
    const ninety = multiplyRational(liabilityNow, 9000, 10_000);
    const preliminaryTaxMinor = Math.min(ninety, priorLiability);
    // s.959AO is each individual's own, against their own prior liability: the
    // Form 11's self-assessment panel asks for it per person.
    const priorTotals = year > firstYear
      ? new Map(this.year(year - 1).individuals.map((i) => [i.partnerId ?? this.companyId, i.totalMinor]))
      : null;
    for (const i of individuals) {
      i.preliminaryTaxMinor = priorTotals
        ? Math.min(multiplyRational(i.totalMinor, 9000, 10_000), priorTotals.get(i.partnerId ?? this.companyId) ?? 0)
        : 0;
    }
    const dates = {
      preliminaryTaxDue: `${year}-10-31`, returnDue: `${year + 1}-10-31`, preliminaryTaxMinor,
      basis: year > firstYear ? 'the lower of 90% of this year\'s liability and 100% of the last year\'s (s.959AO)'
        : 'nil: there was no liability for a prior year (s.959AO)',
    };
    this.findings.push('Each liability assumes the trade is the individual\'s only income and the credits shown are their only ones.');

    const result: IncomeTaxComputation = {
      companyId: this.companyId, year,
      basis: { from: basis.from, to: basis.to, rule: basis.rule, ruleKeys: basis.ruleKeys },
      basisProfitMinor, thirdYearReliefMinor,
      capitalAllowancesMinor: allowances.netMinor, capitalAllowanceLines: allowances.lines,
      assessableProfitMinor, tradingLossMinor, individuals, dates, decisions,
      findings: [...new Set(this.findings)],
    };
    this.findings = saved;
    this.years.set(year, result);
    return result;
  }
}

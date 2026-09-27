import { and, eq, gte, lte, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, journalLines, journalEntries, fixedAssets, companies } from '@/db/schema';
import { trialBalance } from '../accounting/ledger';
import { multiplyRational } from '../money';
import { systemAccountId } from '../config/setup';
import { asIsoDate, type IsoDate } from '../dates';
import { accountingYearContaining } from '../vat/apportionment';
import {
  CT_RATE_TRADING_RULE_KEY, CT_RATE_HIGHER_RULE_KEY, CORPORATION_TAX_CURATED_RULES,
  nfgCitation, carSpecifiedAmountRuleKey,
} from '../rules/corporationTaxCuration';
import { auditRuleFigures, RejectedRuleError } from '../rules/ruleFigures';
import { CAR_EMISSIONS_CURATED_RULES } from '../rules/carEmissionsCuration';
import { capitalGrantsReceivedFor } from '../farmTax/grants';
import { isFarmingTrade, stockRelief, type StockReliefResult } from '../farmTax/reliefs';
import {
  EXPENSE_CHOICES, INCOME_CASES, LOSS_CLAIMS, COMPANY_STATUSES, TRADING_COMPANY_STATUSES, FARM_STOCK_RELIEF_CLAIMS, currentDecision,
  type FarmStockReliefClaim, type IncomeCase, type ExpenseChoice, type LossClaim, type CompanyStatus, type TradingCompanyStatus,
  type CtPendingDecision,
} from './subjects';

// The decision subjects, their choices and recording live in subjects.ts (one
// definition, so the year-end action and the computations cannot disagree);
// re-exported here for the modules that import them from the computation.
export * from './subjects';

/** A computation's figure audit (see ruleFigures.ts); shared by the functions one computation calls. */
type FigureAudit = ReturnType<typeof auditRuleFigures>;

/**
 * A figure for the computation. A rule a person rejected stops the
 * computation (issue #451): a figure someone said is wrong is never used. A
 * rule this book has never ingested falls back on the shipped curation
 * constant, flagged in the audit's findings.
 */
function figureWithCurationFallback(audit: FigureAudit, ruleKey: string): number {
  const f = audit.figure(ruleKey);
  // A figure a person rejected or retired on the review screen stops the
  // computation (issues #451, #484): it is never quietly substituted.
  if (f.status === 'rejected' || f.status === 'retired') throw new RejectedRuleError(f);
  if (f.numericValue !== null) return f.numericValue;
  if (f.curatedValue !== null && f.curatedInForce) return f.curatedValue;
  // The shipped curation constant either does not exist or its own effective
  // window does not cover the period (issue #492): fail closed rather than
  // charge a figure the curation itself says did not apply.
  throw new Error(`No figure for rule "${ruleKey}" from the knowledge base or the shipped curation`
    + `${f.curatedValue !== null ? ' (the shipped curation constant does not cover the period)' : ''}.`);
}

/**
 * The corporation tax computation for an accounting period (issue #211).
 *
 * Accounting profit, adjusted line by line to taxable profit, then charged at
 * the rates the statutory rules state: 12.5% on trading income (s.21), 25% on
 * Case III, IV and V income (s.21A). Every adjustment names the rule and
 * section behind it and the ledger entries it is made of.
 *
 * Where the books cannot settle a treatment (an expense that reads like
 * entertainment, a fine or a private cost; income that may not be trading
 * income) the computation takes a suggested treatment, says so, and offers
 * the alternatives. A person's choice is recorded with `recordCtDecision` and
 * replaces the suggestion. Nothing here is a filed figure: the findings say
 * what is not yet computed.
 */

/** Words that suggest an expense line may not be deductible, with the treatment suggested and the options offered. */
const LINE_PATTERNS: Array<{ pattern: RegExp; suggested: ExpenseChoice; options: ExpenseChoice[]; why: string }> = [
  {
    pattern: /\b(entertain\w*|hospitality|dinner|lunch|restaurant|drinks|hamper|gifts?|christmas party|tickets?)\b/i,
    suggested: 'add_back_entertainment', options: ['add_back_entertainment', 'staff_entertainment', 'deductible'],
    why: 'reads like entertainment or a gift',
  },
  {
    pattern: /\b(fines?|penalt(y|ies)|parking|clamp\w*|speeding)\b/i,
    suggested: 'add_back_not_wholly_exclusively', options: ['add_back_not_wholly_exclusively', 'deductible'],
    why: 'reads like a fine or penalty',
  },
  {
    pattern: /\b(personal|private|domestic)\b/i,
    suggested: 'add_back_private', options: ['add_back_private', 'deductible'],
    why: 'reads like a private or domestic cost',
  },
];

export interface CtSource { entityType: 'account' | 'journal_line' | 'fixed_asset'; entityId: string; label: string; amountMinor: number }
export interface CtCitation { ruleKey: string; citation: string; section: string }

export interface CtLine {
  kind: 'add_back' | 'deduction' | 'income_excluded';
  label: string;
  amountMinor: number;
  citations: CtCitation[];
  sources: CtSource[];
  explanation: string;
}

export interface CtComputation {
  companyId: string;
  from: IsoDate;
  to: IsoDate;
  accountingProfitMinor: number;
  lines: CtLine[];
  /** The trading result after adjustments, before loss relief; negative for a loss. */
  adjustedTradingResultMinor: number;
  /** Case I: trading profit after adjustments and capital allowances. */
  tradingProfitMinor: number;
  /** A trading loss, when the result is negative (not relieved here). */
  tradingLossMinor: number;
  nonTradingIncome: Array<{ incomeCase: IncomeCase; amountMinor: number; sources: CtSource[] }>;
  nonTradingIncomeMinor: number;
  taxAtStandardRateMinor: number;
  taxAtHigherRateMinor: number;
  /** Corporation tax for the period, after loss relief (surcharges are separate). */
  corporationTaxMinor: number;
  rates: { standardBasisPoints: number; higherBasisPoints: number; citations: CtCitation[] };
  losses: CtLosses;
  surcharge: CtSurcharge;
  dates: CtDates;
  decisions: CtPendingDecision[];
  findings: string[];
}

export interface CtLosses {
  /** Losses of earlier periods set against this period's trading profit (s.396(1)). */
  broughtForwardUsedMinor: number;
  /** A later period's loss set back against this period's trading profit (s.396A). */
  carriedBackInMinor: number;
  /** This period's own loss set back against the preceding period (s.396A). */
  setBackMinor: number;
  /** Tax on this period's other income reduced by 12.5% of the loss (s.396B). */
  valueBasisCreditMinor: number;
  /** Losses left to carry forward at the end of the period. */
  carriedForwardMinor: number;
  citations: CtCitation[];
}

export interface CtSurcharge {
  status: CompanyStatus;
  distributableInvestmentIncomeMinor: number;
  distributableTradingIncomeMinor: number;
  distributionsMinor: number;
  surchargeMinor: number;
  working: string;
  citations: CtCitation[];
  /** What the computation could not settle from the books alone (issue #489). */
  findings: string[];
}

export interface CtDates {
  /** CT1 return and balance of tax (s.959A; 23rd on ROS). */
  returnDueDate: string;
  smallCompany: boolean;
  /** Tax for the preceding period, which decides small or large (s.959AM). */
  precedingPeriodTaxMinor: number | null;
  preliminaryTax: Array<{ dueDate: string; amountMinor: number; basis: string }>;
  citations: CtCitation[];
}

const cite = (ruleKey: string): CtCitation => {
  const rule = CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === ruleKey);
  if (rule) return { ruleKey, citation: nfgCitation(rule.part), section: `TCA 1997 s.${rule.sectionNumber}` };
  // Capital allowances are cited from the as-enacted s.284 and FA 2003 s.23 rules.
  return { ruleKey, citation: ruleKey.startsWith('income_tax.wear') ? '1997 Act 39 s.284; 2003 Act 3 s.23' : ruleKey, section: '' };
};

const eur = (minor: number) => (minor / 100).toFixed(2);


export interface CapitalAllowancesResult {
  lines: CtLine[];
  findings: string[];
  /**
   * The claims reconstructed from the purchase date for assets whose caller
   * returned null from `claimsBefore` — bought before the periods the caller
   * has walked (issue #488). A caller accumulating claims starts each such
   * asset from here, not from nothing.
   */
  openingClaims: Map<string, AssetClaimsMade>;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The allowances already made for an asset before this period: how many claims, and their total. */
export interface AssetClaimsMade { claims: number; made: number }

/**
 * The Part 11 position of a fixed asset (TCA ss.373, 374). A motor car
 * costing over the specified amount for the accounting period its
 * expenditure was incurred in is given its allowances, and its balancing
 * adjustments, as if it had cost the specified amount; on disposal its sale,
 * insurance, salvage or compensation moneys are scaled down in the proportion
 * the specified amount bears to its cost (s.374(3)). Commercial-type vehicles
 * are excluded (s.373(1)), and the register does not record which a vehicle
 * is, so one that reads like a van is left unrestricted and flagged. Null for
 * an asset that is not a road vehicle. `ruleKey` null: a commercial vehicle,
 * or a car bought in a period ending before 2001, whose dated, condition-
 * specific specified amounts are not applied.
 */
function motorCarBasis(
  db: AppDatabase, companyId: string, asset: typeof fixedAssets.$inferSelect, figures: FigureAudit,
): { specifiedAmountMinor: number | null; ruleKey: string | null; commercial: boolean; purchasePeriodEnd: string } | null {
  const text = `${asset.name} ${asset.description ?? ''}`;
  if (asset.assetCategory !== 'motor_vehicles' && !/\b(car|van|vehicle|motor)\b/i.test(text)) return null;
  const purchasePeriodEnd = accountingYearContaining(db, companyId, asset.purchaseDate).end;
  const commercial = /\b(van|lorry|truck|bus|coach|minibus|pickup)\b/i.test(text);
  const ruleKey = commercial ? null : carSpecifiedAmountRuleKey(purchasePeriodEnd);
  return {
    specifiedAmountMinor: ruleKey ? figureWithCurationFallback(figures, ruleKey) : null,
    ruleKey,
    commercial,
    purchasePeriodEnd,
  };
}

/**
 * The Part 11C position of a car bought on or after 1 July 2008 whose CO2
 * emissions are recorded (TCA ss.380K, 380L; issue #466). Its group, by the
 * scheme in force when the expenditure was incurred, decides the amount its
 * wear and tear and balancing adjustments are computed on:
 * - group 1: the specified amount, whatever the car cost;
 * - group 2: the lesser of half the specified amount and half the cost;
 * - group 3: nothing.
 *
 * On disposal the proceeds are modified in the same proportion (s.380L(3)).
 * Null when Part 11C does not decide the car (bought before July 2008, a
 * commercial vehicle, or no emissions recorded).
 */
function part11cBasis(
  db: AppDatabase, companyId: string, asset: typeof fixedAssets.$inferSelect,
): { group: 1 | 2 | 3; basisMinor: number; proceeds: (recorded: number) => number; citations: CtCitation[]; findings: string[]; label: string } | null {
  if (asset.co2EmissionsGramsPerKm === null || asset.purchaseDate < '2008-07-01') return null;
  // The versions in force when the expenditure was incurred: a rule family's
  // shipped fallback is the one dated for that day, never the first listed.
  const inForce = CAR_EMISSIONS_CURATED_RULES.filter((r) => r.effectiveFrom <= asset.purchaseDate
    && (r.effectiveTo === null || asset.purchaseDate < r.effectiveTo));
  const audit = auditRuleFigures(db, { companyId, asOfDate: asset.purchaseDate, curated: inForce });
  const specified = figureWithCurationFallback(audit, 'car.specified_amount');
  const group1Max = figureWithCurationFallback(audit, 'car.co2_group1_max');
  const group2Max = figureWithCurationFallback(audit, 'car.co2_group2_max');
  const fraction = figureWithCurationFallback(audit, 'car.group2_fraction');
  const g = asset.co2EmissionsGramsPerKm;
  const cost = asset.baseCostMinor;
  // Cited as the version in force when the expenditure was incurred: the 2008 scheme from Revenue's TDM, later
  // ones from the Notes for Guidance on the sections themselves.
  const citeInForce = (ruleKey: string): CtCitation => {
    const r = inForce.find((x) => x.ruleKey === ruleKey)!;
    return { ruleKey, citation: r.citation, section: /^\d{3}/.test(r.sectionNumber) ? `TCA 1997 s.${r.sectionNumber}` : `§${r.sectionNumber}` };
  };
  const ruleKeys = ['car.specified_amount', 'car.co2_group1_max', 'car.co2_group2_max'];
  if (g <= group1Max) {
    return {
      group: 1, basisMinor: specified, citations: ruleKeys.map(citeInForce), findings: audit.findings(),
      proceeds: (recorded) => multiplyRational(recorded, specified, cost),
      label: `${g}g/km, up to ${group1Max}g/km: allowed the specified amount of ${eur(specified)} whatever it cost (s.380L)`,
    };
  }
  if (g <= group2Max) {
    const half = Math.min(multiplyRational(specified, fraction, 10_000), multiplyRational(cost, fraction, 10_000));
    return {
      group: 2, basisMinor: half, citations: [...ruleKeys, 'car.group2_fraction'].map(citeInForce), findings: audit.findings(),
      proceeds: (recorded) => (cost < specified
        ? multiplyRational(recorded, fraction, 10_000)
        : multiplyRational(recorded, multiplyRational(specified, fraction, 10_000), cost)),
      label: `${g}g/km, over ${group1Max} and up to ${group2Max}g/km: allowed the lesser of half the specified amount or half its `
        + `cost, ${eur(half)} (s.380L)`,
    };
  }
  return {
    group: 3, basisMinor: 0, citations: ruleKeys.map(citeInForce), findings: audit.findings(), proceeds: () => 0,
    label: `${g}g/km, over ${group2Max}g/km: allowed nothing (s.380L)`,
  };
}

/**
 * The rate and term for a farm building or slurry storage asset (EPIC 25,
 * issue #545), from the rules: s.658 writes farm buildings off at 15% a year
 * with the 10% balance in year 7; s.658A accelerates qualifying slurry
 * storage to 50% over 2 years for expenditure in its relevant period, and
 * outside it the asset is a farm building.
 */
function farmBuildingBasis(asset: typeof fixedAssets.$inferSelect, audit: FigureAudit): {
  rate: number; years: number; ruleKeys: string[]; finding: string | null;
} | null {
  if (asset.assetCategory !== 'farm_buildings' && asset.assetCategory !== 'slurry_storage') return null;
  const buildings = {
    rate: figureWithCurationFallback(audit, 'farm.buildings_rate'), years: figureWithCurationFallback(audit, 'farm.buildings_years'),
    ruleKeys: ['farm.buildings_rate', 'farm.buildings_years', 'farm.buildings_net_of_grants'], finding: null as string | null,
  };
  if (asset.assetCategory === 'farm_buildings') return buildings;
  const year = Number(asset.purchaseDate.slice(0, 4));
  const last = figureWithCurationFallback(audit, 'farm.slurry_last_year');
  if (asset.purchaseDate < '2023-01-01' || year > last) {
    return { ...buildings, finding: `slurry storage bought on ${asset.purchaseDate}, outside the s.658A period (2023 to ${last}): `
      + 'it gets the ordinary farm buildings allowance.' };
  }
  const rate = figureWithCurationFallback(audit, 'farm.slurry_rate');
  return {
    rate, years: Math.ceil(10_000 / rate), ruleKeys: ['farm.slurry_rate', 'farm.slurry_last_year', 'farm.buildings_net_of_grants'],
    finding: `accelerated at ${rate / 100}% a year (s.658A). The tax saved by the acceleration is limited to `
      + `${eur(figureWithCurationFallback(audit, 'farm.slurry_relief_cap'))} for the undertaking (s.658A(5)), which these books `
      + 'do not measure: check it once the claims come near it.',
  };
}

/**
 * Wear and tear (s.284), balancing allowances and charges (s.288) from the
 * fixed asset register. An asset's configured rate is used; a rate other
 * than the s.284 standard is flagged, and 100% in one year is treated as a
 * s.285A claim that needs the SEAI list confirmed.
 *
 * Claims are counted in accounting periods, which is how corporation tax
 * works. Income tax, whose allowances are given for each year of assessment
 * against its basis period (s.284(1), (2)(b)), passes `claimsBefore` instead:
 * the allowances actually made in earlier years of assessment, which can
 * differ from the accounting-period count in a commencement, cessation or
 * account-date-change year. A caller returns null for an asset it holds no
 * claims for because the asset predates the periods it walked: those earlier
 * claims are counted from the purchase date, as a standalone call counts them.
 */
export function capitalAllowances(
  db: AppDatabase,
  params: { companyId: string; from: string; to: string; claimsBefore?: (asset: typeof fixedAssets.$inferSelect) => AssetClaimsMade | null },
  figures?: FigureAudit,
): CapitalAllowancesResult {
  const { companyId, from, to } = params;
  // The audit is shared with the computation calling this, so its findings are
  // reported once, by the caller; standalone callers get their own audit.
  const ownsAudit = !figures;
  const audit = figures ?? auditRuleFigures(db, { companyId, asOfDate: to, curated: CORPORATION_TAX_CURATED_RULES });
  const lines: CtLine[] = [];
  const openingClaims = new Map<string, AssetClaimsMade>();
  const findings: string[] = [];
  const standardRate = figureWithCurationFallback(audit, 'ct.wear_and_tear_rate');
  // The straight-line term follows the rule's rate (issue #490): 12.5% a year
  // is 8 years, and an edited rule changes both together. A rate that does not
  // divide 100% evenly still runs a whole number of years (15%: into a seventh).
  const standardYears = Math.ceil(10_000 / standardRate);
  const smallProceeds = figureWithCurationFallback(audit, 'ct.balancing_charge_small_proceeds');
  // s.284(2)(b): a period of less than a year gets that fraction of a year's allowance.
  const yearDays = daysBetween(`${Number(to.slice(0, 4)) - 1}${to.slice(4)}`, to);
  const periodDays = daysBetween(from, to) + 1;
  const scale = periodDays < yearDays ? { num: periodDays, den: yearDays } : null;
  if (scale) findings.push(`The period is ${periodDays} days: wear and tear is scaled by ${periodDays}/${yearDays} (s.284(2)(b)).`);

  const wearAndTear: CtSource[] = [];
  const balancingAllowances: CtSource[] = [];
  const balancingCharges: CtSource[] = [];
  let accelerated = false;
  let grantCitations = false;
  const farmCitations = new Set<string>();
  const carCitations = new Set<string>();
  const part11cCitations = new Map<string, CtCitation>();
  const assets = db.select().from(fixedAssets).where(and(eq(fixedAssets.companyId, companyId), lte(fixedAssets.purchaseDate, to))).all();
  for (const asset of assets) {
    if (asset.disposalDate && asset.disposalDate < from) continue;
    if (asset.assetCategory === 'intangible') {
      findings.push(`${asset.name} is an intangible asset: relief is under s.291A, not wear and tear, and is not computed here.`);
      continue;
    }
    // s.317(2), s.658(13): allowances are computed on the expenditure net of grants received towards it.
    const grant = capitalGrantsReceivedFor(db, asset.id, to);
    const cost = asset.baseCostMinor - Math.min(grant.receivedMinor, asset.baseCostMinor);
    if (grant.receivedMinor > 0) {
      grantCitations = true;
      findings.push(`${asset.name}: ${eur(grant.receivedMinor)} of capital grants received is taken off its cost of `
        + `${eur(asset.baseCostMinor)}: allowances are computed on ${eur(cost)} (s.317(2)).`);
    }
    if (grant.awardedMinor > grant.receivedMinor) {
      findings.push(`${asset.name}: ${eur(grant.awardedMinor - grant.receivedMinor)} of capital grants awarded is not yet received. `
        + 'When it is, link the receipt to the grant: it reduces the expenditure too, and later allowances follow.');
    }
    // Farm buildings (s.658) and slurry storage (s.658A) have their own rates and terms, from the rules.
    const farm = farmBuildingBasis(asset, audit);
    const rate = farm ? farm.rate : asset.capitalAllowanceRateBasisPoints;
    const years = farm ? farm.years : asset.capitalAllowanceYears;
    if (farm) {
      farm.ruleKeys.forEach((k) => farmCitations.add(k));
      if (farm.finding) findings.push(`${asset.name}: ${farm.finding}`);
    }
    // TCA s.374(1): a motor car over the specified amount gets its allowances
    // as if it cost the specified amount.
    const car = motorCarBasis(db, companyId, asset, audit);
    // Part 11C (from July 2008) decides a car whose emissions are recorded; Part 11's cost limit does not apply to it.
    const p11c = car && !car.commercial ? part11cBasis(db, companyId, asset) : null;
    const restrictedBy = !p11c && car?.ruleKey && car.specifiedAmountMinor !== null && cost > car.specifiedAmountMinor
      ? car.specifiedAmountMinor : null;
    const basisMinor = p11c ? p11c.basisMinor : restrictedBy ?? cost;
    const annual = multiplyRational(basisMinor, rate, 10_000);
    // Claims made in earlier periods (s.292: the amount still unallowed is cost less these).
    // Income tax supplies its own count, in years of assessment (s.284(2)(b)).
    const madeBeforeIn = params.claimsBefore ? params.claimsBefore(asset) : null;
    const claimsBefore = madeBeforeIn ? Math.max(madeBeforeIn.claims, 0) : Math.max(claimIndex(db, companyId, asset.purchaseDate, to), 0);
    const madeBefore = madeBeforeIn
      ? Math.min(basisMinor, Math.max(madeBeforeIn.made, 0))
      : Math.min(basisMinor, annual * Math.min(claimsBefore, years));
    if (params.claimsBefore && !madeBeforeIn) openingClaims.set(asset.id, { claims: claimsBefore, made: madeBefore });

    if (car && restrictedBy !== null) {
      carCitations.add('ct.car_allowances_restricted_to_specified_amount');
      carCitations.add(car.ruleKey!);
      findings.push(`${asset.name} cost ${eur(cost)}, over the ${eur(restrictedBy)} specified amount for expenditure `
        + `incurred in the period to ${car.purchasePeriodEnd}: its allowances and its balancing adjustments are `
        + `computed on ${eur(basisMinor)} (ss.373(2), 374(1) and (2)).`);
    } else if (car?.commercial) {
      findings.push(`${asset.name} reads like a commercial vehicle, which s.373(1) excludes from the car restrictions: `
        + 'its allowances are computed on its full cost. Confirm it is not a motor car.');
    } else if (car && car.ruleKey === null) {
      findings.push(`${asset.name} was bought in an accounting period ending on or before 31 December 2000: the `
        + 'specified amounts for those periods are the dated, condition-specific ones of s.373(2), which are not '
        + 'applied here. Check the claim against the amount for its period.');
    }
    if (p11c) {
      for (const c of p11c.citations) part11cCitations.set(`${c.ruleKey}|${c.citation}`, c);
      findings.push(`${asset.name} (${eur(cost)}): ${p11c.label}.`, ...p11c.findings);
      if (p11c.group === 3) {
        findings.push(`${asset.name} is in the group allowed nothing: no wear and tear, and no balancing allowance or charge on its disposal.`);
        continue;
      }
    } else if (car && !car.commercial && asset.purchaseDate >= '2008-07-01') {
      // Part 11C (ss.380K-380P, Finance Act 2008) decides a car bought from
      // July 2008 by its CO2 emissions, which are not recorded for this one:
      // the restriction is not applied, flagged, never assumed away.
      findings.push(`${asset.name}: allowances on a car bought from July 2008 depend on its CO2 emissions (TCA Part 11C, `
        + 'ss.380K-380P), which can halve them or deny them. The emissions are not recorded, so that restriction is not '
        + 'applied: record the g/km from the registration certificate. Without documentation Revenue treats the car as '
        + 'allowed nothing (s.380K(3)).');
    }

    if (asset.disposalDate && asset.disposalDate <= to) {
      // s.288: a balancing event in this period, and no wear and tear for it (s.284(1)).
      if (madeBefore === 0) {
        findings.push(`${asset.name} was bought and disposed of before any allowance was made: no balancing adjustment arises (s.288(1)).`);
        continue;
      }
      if (asset.disposalProceedsMinor === null) {
        findings.push(`${asset.name} was disposed of on ${asset.disposalDate} but no proceeds are recorded. Record them (nil if `
          + 'scrapped): the balancing allowance or charge (s.288) cannot be computed without them.');
        continue;
      }
      // s.374(3): a restricted car's sale, insurance, salvage or compensation moneys are
      // reduced in the proportion the specified amount bears to its cost.
      const recordedProceeds = asset.disposalProceedsMinor;
      const proceeds = p11c ? p11c.proceeds(recordedProceeds)
        : restrictedBy !== null ? multiplyRational(recordedProceeds, restrictedBy, cost) : recordedProceeds;
      if (restrictedBy !== null && proceeds !== recordedProceeds) carCitations.add('ct.car_disposal_proceeds_scaled_down');
      const unallowed = basisMinor - madeBefore;
      if (proceeds < unallowed) {
        balancingAllowances.push({ entityType: 'fixed_asset', entityId: asset.id, amountMinor: unallowed - proceeds,
          label: `${asset.name}: unallowed ${eur(unallowed)} less proceeds ${eur(proceeds)}${proceeds !== recordedProceeds ? ` (proceeds ${eur(recordedProceeds)} scaled down, s.374(3))` : ''}` });
      } else if (proceeds > unallowed) {
        if (proceeds < smallProceeds) {
          findings.push(`${asset.name}: proceeds of ${eur(proceeds)} are under ${eur(smallProceeds)}, so no balancing charge (s.288(3B)), unless `
            + 'the buyer is connected with the company. Confirm who bought it.');
        } else {
          const charge = Math.min(proceeds - unallowed, madeBefore);
          balancingCharges.push({ entityType: 'fixed_asset', entityId: asset.id, amountMinor: charge,
            label: `${asset.name}: proceeds ${eur(proceeds)} less unallowed ${eur(unallowed)}${charge < proceeds - unallowed ? ', limited to allowances made (s.288(4))' : ''}` });
        }
      }
      continue;
    }

    if (claimsBefore >= years || madeBefore >= basisMinor) continue;
    let claim = Math.min(annual, basisMinor - madeBefore);
    if (scale) claim = multiplyRational(claim, scale.num, scale.den);
    if (claim <= 0) continue;
    wearAndTear.push({ entityType: 'fixed_asset', entityId: asset.id, amountMinor: claim,
      label: `${asset.name} (year ${claimsBefore + 1} of ${years}, ${rate / 100}% of ${eur(basisMinor)}${restrictedBy !== null ? `, the s.374(1) basis: cost ${eur(cost)}` : ''})` });

    if (rate === 10_000 && years === 1) {
      accelerated = true;
      findings.push(`${asset.name} is claimed at 100% in one year: an accelerated allowance (s.285A) is due only for new `
        + 'equipment named on the SEAI energy-efficient list, bought by 31 December 2030. Confirm it is on the list.');
    } else if (!farm && (rate !== standardRate || years !== standardYears)) {
      findings.push(`${asset.name} is claimed at ${rate / 100}% over ${years} years, not the ${standardRate / 100}% over ${standardYears} years of s.284(2)(ad). `
        + 'Check the basis for the different rate.');
    }
  }

  const total = (xs: CtSource[]) => xs.reduce((s, x) => s + x.amountMinor, 0);
  if (wearAndTear.length) {
    lines.push({
      kind: 'deduction', label: 'Deduct: capital allowances (wear and tear)', amountMinor: -total(wearAndTear),
      citations: [cite('ct.wear_and_tear_rate'), cite('ct.wear_and_tear_in_use_at_period_end'), cite('ct.allowances_not_exceed_cost'),
        ...(scale ? [cite('ct.wear_and_tear_short_period')] : []), ...(accelerated ? [cite('ct.accelerated_energy_efficient')] : []),
        ...[...carCitations].map(cite), ...part11cCitations.values(), ...[...farmCitations].map(cite),
        ...(grantCitations ? [cite('ct.allowances_net_of_grants')] : [])],
      sources: wearAndTear,
      explanation: 'Each asset in use at the end of the period, at its rate, for the years it has left, never beyond its cost '
        + '(a motor car over the specified amount, on that amount: s.374(1)).',
    });
  }
  if (balancingAllowances.length) {
    lines.push({
      kind: 'deduction', label: 'Deduct: balancing allowances', amountMinor: -total(balancingAllowances),
      citations: [cite('ct.balancing_allowance'), cite('ct.amount_still_unallowed'), ...[...carCitations].map(cite), ...part11cCitations.values()], sources: balancingAllowances,
      explanation: 'Assets disposed of for less than their unallowed cost (a restricted car, on its scaled-down proceeds: s.374(3)).',
    });
  }
  if (balancingCharges.length) {
    lines.push({
      kind: 'add_back', label: 'Add: balancing charges', amountMinor: total(balancingCharges),
      citations: [cite('ct.balancing_charge'), cite('ct.balancing_charge_limit'), cite('ct.amount_still_unallowed'),
        ...[...carCitations].map(cite), ...part11cCitations.values()],
      sources: balancingCharges,
      explanation: 'Assets disposed of for more than their unallowed cost, limited to the allowances made.',
    });
  }
  if (ownsAudit) findings.push(...audit.findings());
  return { lines, findings, openingClaims };
}

/**
 * Whole accounting years from the end of the year an asset was bought to `to`
 * (0 in the year of purchase). The comparison is against the anniversary of
 * the purchase period's end in `to`'s year, as an actual date — a 29 February
 * year end ends on 28 February in a common year, and comparing the raw
 * month-day strings miscounts such a book by a full year, claiming the
 * purchase-year allowance twice (issue #491).
 */
function claimIndex(db: AppDatabase, companyId: string, purchaseDate: string, to: string): number {
  const firstEnd = accountingYearContaining(db, companyId, purchaseDate).end;
  const years = Number(to.slice(0, 4)) - Number(firstEnd.slice(0, 4));
  const toYear = to.slice(0, 4);
  const leap = Number(toYear) % 4 === 0 && (Number(toYear) % 100 !== 0 || Number(toYear) % 400 === 0);
  const monthDay = firstEnd.slice(5) === '02-29' && !leap ? '02-28' : firstEnd.slice(5);
  return to >= `${toYear}-${monthDay}` ? years : years - 1;
}

export interface CtBase {
  accountingProfitMinor: number;
  lines: CtLine[];
  /** Trading result after adjustments and capital allowances; negative for a loss. */
  adjustedMinor: number;
  nonTradingIncome: CtComputation['nonTradingIncome'];
  nonTradingIncomeMinor: number;
  decisions: CtPendingDecision[];
  findings: string[];
}

/**
 * Everything before loss relief, rates and surcharges: one period on its own.
 *
 * Income tax excludes the capital allowances here (`excludeCapitalAllowances`):
 * its allowances are given for each year of assessment against its basis
 * period (s.284(1)), not apportioned with the accounting periods' profits, so
 * the run deducts them itself after the basis rules have picked the profits.
 */
export function computeBase(
  db: AppDatabase,
  params: {
    companyId: string; from: string; to: string; excludeCapitalAllowances?: boolean;
    /**
     * The allowances already made for each asset, as actually claimed — a
     * caller walking several periods in time order passes its accumulation in
     * and gets the period's own claims back (issue #488), the way the income
     * tax run does across years of assessment.
     */
    claimsBefore?: (asset: typeof fixedAssets.$inferSelect) => AssetClaimsMade | null;
    claimsMade?: Map<string, AssetClaimsMade>;
  },
  figures?: FigureAudit,
): CtBase {
  const { companyId, from, to } = params;
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new Error(`Company ${companyId} not found.`);
  const tb = trialBalance(db, {
    companyId, asOf: asIsoDate(to), from: asIsoDate(from), baseCurrency: company.baseCurrency,
    excludeYearEndClose: true,
  });
  const pl = tb.rows.filter((r) => r.type === 'income' || r.type === 'expense');
  const accountingProfitMinor = pl.reduce((s, r) => s + (r.type === 'income' ? r.signedMinor : -r.signedMinor), 0);
  const accountRows = new Map(db.select().from(accounts).where(eq(accounts.companyId, companyId)).all().map((a) => [a.id, a]));

  const lines: CtLine[] = [];
  const decisions: CtPendingDecision[] = [];
  const findings: string[] = [];
  const accountSource = (r: (typeof pl)[number]): CtSource => ({ entityType: 'account', entityId: r.accountId, label: `${r.code} ${r.name}`, amountMinor: r.signedMinor });

  // ---- Income: trading, or taxed at the higher rate ----
  const nonTrading = new Map<IncomeCase, { amountMinor: number; sources: CtSource[] }>();
  for (const r of pl.filter((x) => x.type === 'income' && x.signedMinor !== 0)) {
    const account = accountRows.get(r.accountId)!;
    if (r.subtype === 'trading_income' || account.systemKey === 'rounding_difference') continue;
    const text = `${r.name} ${account.description ?? ''}`;
    const suggested: IncomeCase = account.systemKey === 'fx_gain_loss' || /exchange/i.test(r.name) ? 'case_i'
      : /interest|deposit/i.test(text) ? 'case_iii' : /rent/i.test(text) ? 'case_v' : 'case_iv';
    const decided = currentDecision(db, companyId, 'income_account', r.accountId, to)?.choice as IncomeCase | undefined;
    const incomeCase = decided ?? suggested;
    decisions.push({
      subjectType: 'income_account', subjectId: r.accountId, description: `${r.code} ${r.name}`, amountMinor: r.signedMinor,
      suggested, decided: decided ?? null,
      options: (Object.keys(INCOME_CASES) as IncomeCase[]).map((c) => ({ choice: c, label: INCOME_CASES[c] })),
      reason: 'Income outside the trading income accounts: it is trading income only if it arises from '
        + 'the trade; interest, other miscellaneous income and Irish rents are charged at the higher rate (s.21A). '
        + 'The rates print on the computation lines from the rules that state them.',
    });
    if (incomeCase === 'case_i') continue;
    const bucket = nonTrading.get(incomeCase) ?? { amountMinor: 0, sources: [] };
    bucket.amountMinor += r.signedMinor;
    bucket.sources.push(accountSource(r));
    nonTrading.set(incomeCase, bucket);
    lines.push({
      kind: 'income_excluded', label: `Deduct: ${r.code} ${r.name}, taxed separately under ${incomeCase.replace('_', ' ').toUpperCase()}`,
      amountMinor: -r.signedMinor, citations: [cite(CT_RATE_HIGHER_RULE_KEY), cite('ct.income_tax_principles')],
      sources: [accountSource(r)],
      explanation: 'Taken out of trading profit and charged at the higher rate below. Expenses of earning it are not '
        + 'deducted from it here; check them (for rents, Case V allows certain deductions).',
    });
  }

  // ---- Whole accounts added back ----
  for (const r of pl.filter((x) => x.type === 'expense' && x.signedMinor !== 0)) {
    const account = accountRows.get(r.accountId)!;
    if (account.systemKey === 'depreciation_expense' || /depreciation|amortisation/i.test(r.name)) {
      lines.push({
        kind: 'add_back', label: `Add back: ${r.code} ${r.name}`, amountMinor: r.signedMinor,
        citations: [cite('ct.deduction_only_if_authorised')], sources: [accountSource(r)],
        explanation: 'Depreciation is not a deduction the Tax Acts allow (s.81(1)); capital allowances are given instead.',
      });
    } else if (account.systemKey === 'disposal_of_assets' || /disposal of fixed assets/i.test(r.name)) {
      lines.push({
        kind: 'add_back', label: `Add back: ${r.code} ${r.name}`, amountMinor: r.signedMinor,
        citations: [cite('ct.capital_expenditure_not_deductible')], sources: [accountSource(r)],
        explanation: 'A loss on disposing of a fixed asset is capital (s.81(2)(f)); the tax adjustment on the disposal is '
          + 'the balancing allowance or charge below (s.288).',
      });
    } else if (/corporation tax|income tax/i.test(r.name)) {
      lines.push({
        kind: 'add_back', label: `Add back: ${r.code} ${r.name}`, amountMinor: r.signedMinor,
        citations: [cite('ct.taxes_on_income_not_deductible')], sources: [accountSource(r)],
        explanation: 'Taxes on income are not deductible (s.81(2)(p)).',
      });
    } else if (/below capitalisation threshold/i.test(r.name)) {
      findings.push(`${r.code} ${r.name} (${eur(r.signedMinor)}) is deducted as revenue expenditure. An item of capital `
        + 'is not deductible however small (s.81(2)(f)); it may qualify for capital allowances instead. Check the items.');
    }
  }

  // ---- Expense lines that may not be deductible ----
  const wholeAccountKeys = new Set(lines.flatMap((l) => l.sources.filter((s) => s.entityType === 'account').map((s) => s.entityId)));
  const expenseLines = db.select({ line: journalLines, entry: journalEntries, account: accounts })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.companyId, companyId), eq(accounts.type, 'expense'),
      gte(journalEntries.entryDate, from), lte(journalEntries.entryDate, to)))
    .all();
  const byChoice = new Map<ExpenseChoice, { amountMinor: number; sources: CtSource[] }>();
  for (const { line, entry, account } of expenseLines) {
    if (wholeAccountKeys.has(account.id)) continue;
    const amount = line.baseDebitMinor - line.baseCreditMinor;
    if (amount === 0) continue;
    const text = `${entry.narrative} ${line.memo ?? ''}`;
    // Interest charged on a loan from a partner (issue #464): which of the two
    // treatments applies is a fact about the loan the books cannot know, so
    // the line always raises the decision - unlike the patterns below, it is
    // never matched by wording alone.
    const partnerInterest = entry.sourceType === 'partner_loan_interest';
    const match = partnerInterest
      ? {
        suggested: 'partner_interest_add_back' as ExpenseChoice,
        options: ['partner_interest_add_back', 'partner_interest_deductible'] as ExpenseChoice[],
        why: '',
      }
      : LINE_PATTERNS.find((p) => p.pattern.test(text));
    const decided = currentDecision(db, companyId, 'journal_line', line.id)?.choice as ExpenseChoice | undefined;
    if (!match && !decided) continue;
    const choice = decided ?? match!.suggested;
    const options = match?.options ?? (Object.keys(EXPENSE_CHOICES) as ExpenseChoice[]);
    decisions.push({
      subjectType: 'journal_line', subjectId: line.id, description: `${entry.entryDate} ${account.code} ${account.name}: ${text.trim()}`,
      amountMinor: amount, suggested: match?.suggested ?? 'deductible', decided: decided ?? null,
      options: options.map((c) => ({ choice: c, label: EXPENSE_CHOICES[c].label })),
      reason: partnerInterest
        ? 'Interest paid to a partner. On a genuine loan, used wholly and exclusively for the trade, it is a '
          + 'trading expense; on the partner\u2019s capital or current account it is an allocation of profit, not an '
          + 'expense of earning it. The books cannot tell which (issue #464).'
        : match ? `The description ${match.why}.` : 'Decided by a person.',
    });
    if (partnerInterest && !decided) {
      findings.push(`${eur(amount)} of interest paid to a partner is added back until the decision is recorded. `
        + 'Neither s.81 in full nor the partnership provisions are in the collected sources yet, so the treatment '
        + 'rests on the decision alone: record "deductible" only for a genuine loan used wholly and exclusively '
        + 'for the trade (issue #464).');
    }
    if (!EXPENSE_CHOICES[choice].addBack) continue;
    const bucket = byChoice.get(choice) ?? { amountMinor: 0, sources: [] };
    bucket.amountMinor += amount;
    bucket.sources.push({ entityType: 'journal_line', entityId: line.id, label: `${entry.entryDate} ${text.trim()}`, amountMinor: amount });
    byChoice.set(choice, bucket);
  }
  for (const [choice, bucket] of byChoice) {
    const c = EXPENSE_CHOICES[choice];
    lines.push({
      kind: 'add_back', label: `Add back: ${c.label.replace(/: add back.*$/, '')}`, amountMinor: bucket.amountMinor,
      citations: c.ruleKey ? [cite(c.ruleKey)] : [], sources: bucket.sources,
      explanation: 'The lines listed, as suggested or as decided. Each can be changed on the decisions list.',
    });
  }

  // ---- Capital allowances (Part 9) ----
  if (!params.excludeCapitalAllowances) {
    const ca = capitalAllowances(db, {
      companyId, from, to,
      ...(params.claimsBefore ? { claimsBefore: params.claimsBefore } : {}),
    }, figures);
    lines.push(...ca.lines);
    findings.push(...ca.findings);
    // What this period claims, at the amount actually made: a short first
    // period's scaled claim (s.284(2)(b)) must not be read later as a full
    // year's (issue #488).
    if (params.claimsMade) {
      for (const line of ca.lines) {
        for (const source of line.sources) {
          if (source.entityType !== 'fixed_asset') continue;
          const opening = ca.openingClaims.get(source.entityId);
          const made = params.claimsMade.get(source.entityId)
            ?? (opening ? { ...opening } : { claims: 0, made: 0 });
          made.claims += 1;
          made.made += line.kind === 'add_back' ? -source.amountMinor : source.amountMinor;
          params.claimsMade.set(source.entityId, made);
        }
      }
    }
  }

  const adjustedMinor = accountingProfitMinor + lines.reduce((sum, l) => sum + l.amountMinor, 0);
  const nonTradingIncome = [...nonTrading].map(([incomeCase, b]) => ({ incomeCase, ...b }));
  const nonTradingIncomeMinor = nonTradingIncome.reduce((sum, x) => sum + x.amountMinor, 0);
  return { accountingProfitMinor, lines, adjustedMinor, nonTradingIncome, nonTradingIncomeMinor, decisions, findings };
}

const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
const addMonths = (date: string, months: number) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
/** Revenue's "but the 21st of the month if it would be later", with ROS's 23rd (TDM 47-06-01). */
const byThe23rd = (date: string) => (Number(date.slice(8)) > 23 ? `${date.slice(0, 8)}23` : date);

interface PeriodRun { from: string; to: string; base: CtBase; claim: LossClaim; taxableTradingMinor: number; setBackMinor: number;
  carriedBackInMinor: number; broughtForwardUsedMinor: number; creditMinor: number; lossLeftMinor: number; taxMinor: number;
  stockRelief: StockReliefResult | null; stockReliefClaim: FarmStockReliefClaim | null }

/**
 * The corporation tax computation for an accounting period: the period's own
 * adjustments (computeBase), then loss relief across the periods around it,
 * the rates, the close company surcharge and the payment dates.
 */
export function computeCorporationTax(db: AppDatabase, params: { companyId: string; from: IsoDate; to: IsoDate }): CtComputation {
  const { companyId, from, to } = params;
  // An accounting period ends 12 months from its start at the latest (TCA
  // s.27(3)(a); s.27 is not among the collected sources). A longer one is not a
  // period to compute — apportioning its threshold to a capped 12 months is
  // not the same figure, and nothing would say the period was malformed
  // (issue #495).
  if (to >= addMonths(from, 12)) {
    throw new Error(
      `The accounting period ${from} to ${to} is longer than 12 months: an accounting period ends 12 months from its start at the latest (TCA s.27(3)(a)). `
        + 'Split it into accounting periods of 12 months or less and compute each on its own, rather than '
        + 'computing a period whose thresholds and allowances would be silently capped.',
    );
  }
  // Every figure this computation reads comes from the stored rule in force on
  // the period's end date, with its review status in the findings (issue #282).
  const figures = auditRuleFigures(db, { companyId, asOfDate: to, curated: CORPORATION_TAX_CURATED_RULES });
  const standard = figureWithCurationFallback(figures, CT_RATE_TRADING_RULE_KEY);
  const higher = figureWithCurationFallback(figures, CT_RATE_HIGHER_RULE_KEY);
  const ruleValue = (key: string) => figureWithCurationFallback(figures, key);

  // ---- The periods loss relief reaches: every earlier year with entries, and the next one ----
  const earliest = db.select({ d: journalEntries.entryDate }).from(journalEntries)
    .where(eq(journalEntries.companyId, companyId)).orderBy(journalEntries.entryDate).limit(1).get()?.d ?? from;
  const periods: Array<{ from: string; to: string }> = [];
  for (let end = addDays(from, -1); end >= earliest;) {
    const year = accountingYearContaining(db, companyId, end);
    periods.unshift({ from: year.start < earliest ? earliest : year.start, to: year.end > end ? end : year.end });
    end = addDays(year.start, -1);
  }
  const currentIndex = periods.length;
  periods.push({ from, to });
  const next = accountingYearContaining(db, companyId, addDays(to, 1));
  const latest = db.select({ d: journalEntries.entryDate }).from(journalEntries)
    .where(eq(journalEntries.companyId, companyId)).orderBy(desc(journalEntries.entryDate)).limit(1).get()?.d;
  if (latest && latest >= next.start) periods.push({ from: next.start, to: next.end });

  // ---- Loss relief, in time order (s.396, s.396A, s.396B) ----
  // The periods are walked in time order, so the allowances each one claims
  // can be accumulated as actually made and handed to the next — instead of
  // reconstructing them as annual × periods, which ignores the short-period
  // scaling the same function applies and overstates balancing charges
  // (issue #488).
  const assetClaims = new Map<string, AssetClaimsMade>();
  const runs: PeriodRun[] = [];
  let pool = 0;
  for (const p of periods) {
    const base = computeBase(db, {
      companyId, ...p,
      // An asset bought before the first period walked here was claimed in
      // periods these books do not hold: null counts those claims from its
      // purchase date rather than starting it again at year 1.
      claimsBefore: (asset) => assetClaims.get(asset.id)
        ?? (asset.purchaseDate < periods[0]!.from ? null : { claims: 0, made: 0 }),
      claimsMade: assetClaims,
    }, figures);
    const profit = Math.max(base.adjustedMinor, 0);
    let loss = Math.max(-base.adjustedMinor, 0);
    const bf = Math.min(pool, profit);
    pool -= bf;
    const claim = (currentDecision(db, companyId, 'loss_claim', companyId, p.to)?.choice as LossClaim | undefined) ?? 'carry_forward';
    let setBack = 0;
    let credit = 0;
    const higherTax = multiplyRational(Math.max(base.nonTradingIncomeMinor, 0), higher, 10_000);
    if (loss && claim !== 'carry_forward') {
      const prior = runs.at(-1);
      if (prior) {
        setBack = Math.min(loss, prior.taxableTradingMinor);
        prior.taxableTradingMinor -= setBack;
        prior.carriedBackInMinor += setBack;
        prior.taxMinor -= multiplyRational(setBack, standard, 10_000);
        loss -= setBack;
      }
      if (claim === 'claim_396a_396b' && loss) {
        credit = Math.min(multiplyRational(loss, ruleValue('ct.loss_value_basis'), 10_000), higherTax);
        loss -= Math.min(loss, Math.ceil((credit * 10_000) / ruleValue('ct.loss_value_basis')));
      }
    }
    pool += loss;
    // Stock relief for a farming company (s.666; issue #544): a claim, limited to the trading income after capital
    // allowances and losses, so it creates no loss (s.666(2)(a)).
    const farming = isFarmingTrade(db, companyId, p.from, p.to);
    const stockClaim = farming
      ? (currentDecision(db, companyId, 'farm_stock_relief', companyId, p.to)?.choice as FarmStockReliefClaim | undefined) ?? null
      : null;
    const stock = farming
      ? stockRelief(db, { companyId, from: p.from, to: p.to, category: 'general', profitAfterAllowancesMinor: profit - bf })
      : null;
    const stockReliefMinor = stockClaim === 'general' && stock ? stock.reliefMinor : 0;
    const taxableTradingMinor = profit - bf - stockReliefMinor;
    runs.push({
      ...p, base, claim, taxableTradingMinor, setBackMinor: setBack, carriedBackInMinor: 0, broughtForwardUsedMinor: bf,
      stockRelief: stock, stockReliefClaim: stockClaim,
      creditMinor: credit, lossLeftMinor: pool,
      taxMinor: multiplyRational(taxableTradingMinor, standard, 10_000) + higherTax - credit,
    });
  }
  const run = runs[currentIndex]!;
  const { base } = run;
  const lines = [...base.lines];
  const decisions = [...base.decisions];
  const findings = [...base.findings];

  if (run.broughtForwardUsedMinor) {
    lines.push({
      kind: 'deduction', label: 'Deduct: trading losses brought forward', amountMinor: -run.broughtForwardUsedMinor,
      citations: [cite('ct.loss_carry_forward')], sources: [],
      explanation: 'Losses of the same trade in earlier periods, earliest first (s.396(1)).',
    });
  }
  if (run.carriedBackInMinor) {
    lines.push({
      kind: 'deduction', label: 'Deduct: next period\'s loss set back (s.396A)', amountMinor: -run.carriedBackInMinor,
      citations: [cite('ct.relevant_trading_loss_set_off')], sources: [],
      explanation: 'Claimed for the following period: its trading loss is set against this period\'s trading income.',
    });
  }
  if (run.stockRelief) {
    const claim = run.stockReliefClaim;
    decisions.push({
      subjectType: 'farm_stock_relief', subjectId: companyId, description: `Stock relief for the period to ${to}`,
      amountMinor: run.stockRelief.reliefMinor, suggested: 'none', decided: claim,
      options: (['none', 'general'] as FarmStockReliefClaim[]).map((c) => ({ choice: c, label: FARM_STOCK_RELIEF_CLAIMS[c] })),
      reason: `Trading stock went from ${eur(run.stockRelief.openingStockMinor)} to ${eur(run.stockRelief.closingStockMinor)}. `
        + 'Stock relief is claimed in writing by the return date (s.666(5)): nothing is claimed until recorded.',
    });
    if (claim === 'young_trained' || claim === 'registered_partnership') {
      findings.push('The 100% and 50% stock relief rates are for individual farmers (s.667B) and partners (s.667C), not a company: '
        + 'no stock relief is given on that claim. Record the general rate to claim it.');
    }
    if (claim === 'general') {
      findings.push(...run.stockRelief.findings);
      if (run.stockRelief.reliefMinor) {
        lines.push({
          kind: 'deduction', label: 'Deduct: stock relief', amountMinor: -run.stockRelief.reliefMinor,
          citations: run.stockRelief.ruleKeys.map(cite), sources: [],
          explanation: `${run.stockRelief.rateBasisPoints / 100}% of the ${eur(run.stockRelief.increaseMinor)} increase in trading stock `
            + 'over the period, never more than the trading income it reduces.',
        });
      }
    }
  }
  const tradingLossMinor = Math.max(-base.adjustedMinor, 0);
  if (tradingLossMinor) {
    const decided = currentDecision(db, companyId, 'loss_claim', companyId, to)?.choice ?? null;
    decisions.push({
      subjectType: 'loss_claim', subjectId: companyId, description: `Trading loss for the period to ${to}`,
      amountMinor: tradingLossMinor, suggested: 'carry_forward', decided,
      options: (Object.keys(LOSS_CLAIMS) as LossClaim[]).map((c) => ({ choice: c, label: LOSS_CLAIMS[c] })),
      reason: `The loss is carried forward unless a claim is made; a s.396A claim is due by ${addMonths(to, ruleValue('ct.loss_claim_time_limit'))}.`,
    });
  }

  const tradingProfitMinor = run.taxableTradingMinor;
  const taxAtStandardRateMinor = multiplyRational(tradingProfitMinor, standard, 10_000);
  const taxAtHigherRateMinor = multiplyRational(Math.max(base.nonTradingIncomeMinor, 0), higher, 10_000);
  const corporationTaxMinor = taxAtStandardRateMinor + taxAtHigherRateMinor - run.creditMinor;

  // ---- Close company surcharge (ss.430, 434, 440, 441) ----
  const statusDecided = currentDecision(db, companyId, 'company_status', companyId, to)?.choice as CompanyStatus | undefined;
  const status = statusDecided ?? 'close_trading';
  decisions.push({
    subjectType: 'company_status', subjectId: companyId, description: `Close company status for the period to ${to}`,
    amountMinor: 0, suggested: 'close_trading', decided: statusDecided ?? null,
    options: (Object.keys(COMPANY_STATUSES) as CompanyStatus[]).map((c) => ({ choice: c, label: COMPANY_STATUSES[c] })),
    reason: 'Most owner-managed companies are close (controlled by five or fewer participators, or by directors). '
      + 'A company carrying on a profession or providing professional services is a service company.',
  });
  const surcharge = closeCompanySurcharge(db, {
    companyId, from, to, status, base, higherBps: higher, standardBps: standard, decisions,
  }, figures);
  findings.push(...surcharge.findings);

  // ---- Payment and return dates (Part 41A) ----
  const prior = runs[currentIndex - 1];
  const yearDays = Math.round((Date.parse(to) - Date.parse(addMonths(to, -12))) / 86_400_000);
  const periodDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  const limit = multiplyRational(ruleValue('ct.small_company_threshold'), Math.min(periodDays, yearDays), yearDays);
  const precedingPeriodTaxMinor = prior ? Math.max(prior.taxMinor, 0) : null;
  // s.959AM: a company is large when the preceding period's tax was at or over the
  // limit — or, with no preceding period (a first period), when this period's tax is.
  const firstPeriod = precedingPeriodTaxMinor === null;
  const current = Math.max(corporationTaxMinor, 0);
  const smallCompany = firstPeriod ? current < limit : precedingPeriodTaxMinor! < limit;
  const preliminaryTax: CtDates['preliminaryTax'] = [];
  const finalDue = byThe23rd(addDays(to, -31));
  if (firstPeriod && current < limit) {
    // s.959AN(4): a company's first accounting period, with expected tax under the
    // limit, owes no preliminary tax at all.
    preliminaryTax.push({ dueDate: finalDue, amountMinor: 0,
      basis: `nil: the company's first accounting period, with tax of ${eur(current)} under the ${eur(limit)} limit` });
    findings.push(`No preceding period is on the books and this period's tax is under ${eur(limit)}, so preliminary tax is nil `
      + '(s.959AN(4)). "First accounting period" means the company\'s first ever one, not the first one on these books: if the '
      + 'company traded before these books started, preliminary tax is due and this must be paid.');
  } else if (smallCompany) {
    // s.959AR, the percentages read from the rules like every other figure (issue #490).
    const currentPct = ruleValue('ct.preliminary_tax_small_current');
    const priorPct = ruleValue('ct.preliminary_tax_small_prior');
    const atCurrent = multiplyRational(current, currentPct, 10_000);
    const amount = precedingPeriodTaxMinor === null
      ? atCurrent
      : Math.min(atCurrent, multiplyRational(precedingPeriodTaxMinor, priorPct, 10_000));
    preliminaryTax.push({ dueDate: finalDue, amountMinor: amount,
      basis: precedingPeriodTaxMinor === null
        ? `${currentPct / 100}% of this period's tax`
        : `the lower of ${currentPct / 100}% of this period's tax and ${priorPct / 100}% of the preceding period's` });
  } else {
    // s.959AS: the first instalment is the lower of 45% of this period's tax and
    // 50% of the preceding period's — 45% alone for a first period. The
    // percentages come from the rules (issue #490).
    const initialPct = ruleValue('ct.preliminary_tax_large_initial');
    const initialPriorPct = ruleValue('ct.preliminary_tax_large_initial_prior');
    const totalPct = ruleValue('ct.preliminary_tax_large_total');
    const first = precedingPeriodTaxMinor === null
      ? multiplyRational(current, initialPct, 10_000)
      : Math.min(multiplyRational(current, initialPct, 10_000), multiplyRational(precedingPeriodTaxMinor, initialPriorPct, 10_000));
    preliminaryTax.push({ dueDate: byThe23rd(addDays(addMonths(from, 6), -1)), amountMinor: first,
      basis: precedingPeriodTaxMinor === null
        ? `${initialPct / 100}% of this period's tax: no preceding period, so a large first period pays instalments`
        : `the lower of ${initialPct / 100}% of this period's tax and ${initialPriorPct / 100}% of the preceding period's` });
    preliminaryTax.push({ dueDate: finalDue, amountMinor: Math.max(multiplyRational(current, totalPct, 10_000) - first, 0),
      basis: `bringing the total to ${totalPct / 100}% of this period's tax` });
  }
  const dates: CtDates = {
    returnDueDate: byThe23rd(addMonths(to, 9)), smallCompany, precedingPeriodTaxMinor, preliminaryTax,
    citations: [cite('ct.return_filing_date'), cite('ct.small_company_threshold'),
      cite(firstPeriod && current < limit ? 'ct.preliminary_tax_first_period_nil'
        : smallCompany ? 'ct.preliminary_tax_small' : 'ct.preliminary_tax_large')],
  };

  const pending = decisions.filter((d) => !d.decided);
  if (pending.length) {
    findings.push(`${pending.length} treatment(s) are suggested, not decided: the figures use the suggestion until a person chooses.`);
  }
  findings.push(...figures.findings());
  findings.push('Not computed: chargeable gains, charges on income, group relief '
    + 'and associated companies\' share of the surcharge threshold.');

  return {
    companyId, from, to, accountingProfitMinor: base.accountingProfitMinor, lines,
    adjustedTradingResultMinor: base.adjustedMinor,
    tradingProfitMinor, tradingLossMinor,
    nonTradingIncome: base.nonTradingIncome, nonTradingIncomeMinor: base.nonTradingIncomeMinor,
    taxAtStandardRateMinor, taxAtHigherRateMinor, corporationTaxMinor,
    rates: { standardBasisPoints: standard, higherBasisPoints: higher, citations: [cite(CT_RATE_TRADING_RULE_KEY), cite(CT_RATE_HIGHER_RULE_KEY)] },
    losses: {
      broughtForwardUsedMinor: run.broughtForwardUsedMinor, carriedBackInMinor: run.carriedBackInMinor,
      setBackMinor: run.setBackMinor, valueBasisCreditMinor: run.creditMinor, carriedForwardMinor: run.lossLeftMinor,
      citations: [cite('ct.loss_carry_forward'), cite('ct.relevant_trading_loss_set_off'), cite('ct.loss_value_basis')],
    },
    surcharge, dates, decisions, findings,
  };
}

/**
 * s.440(1): 20% of the excess over distributions; nothing up to the threshold;
 * at most 80% of the excess over it (the marginal relief cap). Both rates are
 * arguments, not defaults (issue #490): a caller must take them from the
 * rules, and a signature that silently supplies its own has trapped the next
 * caller before.
 */
export function section440Surcharge(
  deii: number, distributions: number, threshold: number, rateBps: number, marginalReliefCapBps: number,
): number {
  const excess = Math.max(deii - distributions, 0);
  return excess <= threshold
    ? 0
    : Math.min(multiplyRational(excess, rateBps, 10_000), multiplyRational(excess - threshold, marginalReliefCapBps, 10_000));
}

/** s.441(4): 20% on investment and estate income not distributed, 15% on the rest of (it + half of trading income − distributions). */
export function section441Surcharge(deii: number, dti: number, distributions: number, higherBps: number, lowerBps: number) {
  const total = Math.max(deii + multiplyRational(dti, 1, 2) - distributions, 0);
  const at20 = Math.min(Math.max(deii - distributions, 0), total);
  const at15 = total - at20;
  return { total, at20, at15, surchargeMinor: multiplyRational(at20, higherBps, 10_000) + multiplyRational(at15, lowerBps, 10_000) };
}

/**
 * The close company surcharge for a period (s.440; s.441 for a service
 * company), measured on the period's own income before losses brought
 * forward (s.434(4)), less the corporation tax on it (s.434(5A)).
 */
export function closeCompanySurcharge(db: AppDatabase, params: {
  companyId: string; from: string; to: string; status: CompanyStatus; base: Pick<CtBase, 'adjustedMinor' | 'nonTradingIncomeMinor'>;
  higherBps: number; standardBps: number; distributionsMinor?: number;
  /** The computation's pending-decision list: the trading-company test is a person's to decide (issue #494). */
  decisions?: CtPendingDecision[];
}, figures?: FigureAudit): CtSurcharge {
  const { status, base } = params;
  const audit = figures ?? auditRuleFigures(db, { companyId: params.companyId, asOfDate: params.to, curated: CORPORATION_TAX_CURATED_RULES });
  const rule = (key: string) => figureWithCurationFallback(audit, key);
  const citations = [cite('ct.close_company_definition'), cite('ct.distributable_income'), cite('ct.distributions_for_period')];
  const findings: string[] = [];
  const investment = Math.max(base.nonTradingIncomeMinor, 0);
  const trading = Math.max(base.adjustedMinor, 0);
  let deii = investment - multiplyRational(investment, params.higherBps, 10_000);
  // The resolved rates print on the working string, never hard-coded (issue #490).
  let tradingReductionBps = 0;
  // A trading company — one existing wholly or mainly to trade — gets its
  // distributable investment and estate income reduced (s.434(5A)(b)). That is
  // a facts test, not an income ratio: it is suggested from the split but
  // decided by a person, and the suggestion is never silent (issue #494).
  const decided = currentDecision(db, params.companyId, 'trading_company', params.companyId, params.to)?.choice as TradingCompanyStatus | undefined;
  const suggested: TradingCompanyStatus = trading >= investment ? 'trading' : 'not_trading';
  const tradingCompany = (decided ?? suggested) === 'trading';
  params.decisions?.push({
    subjectType: 'trading_company', subjectId: params.companyId,
    description: `Wholly or mainly a trading company, for the period to ${params.to}`,
    amountMinor: 0, suggested, decided: decided ?? null,
    options: (Object.keys(TRADING_COMPANY_STATUSES) as TradingCompanyStatus[])
      .map((c) => ({ choice: c, label: TRADING_COMPANY_STATUSES[c] })),
    reason: 'The s.434(5A)(b) reduction is a facts test — whether the company exists wholly or mainly to '
      + `trade — suggested here from the period's income split (trading ${eur(trading)}, investment ${eur(investment)}), `
      + 'which one bad trading year can upset. A genuine trading company should record the choice.',
  });
  if (!decided && status !== 'not_close') {
    findings.push(`The s.434(5A)(b) trading-company reduction is applied on the suggestion "${suggested}" — from this `
      + `period's income split (trading ${eur(trading)}, investment ${eur(investment)}) — because no person has recorded `
      + 'the facts test yet. Whether the company exists wholly or mainly to trade is a facts question one bad trading '
      + 'year can upset: record the choice on the decisions list.');
  }
  if (tradingCompany) {
    const reduction = rule('ct.trading_company_reduction');
    deii -= multiplyRational(deii, reduction, 10_000);
    tradingReductionBps = reduction;
  }
  const dti = trading - multiplyRational(trading, params.standardBps, 10_000);
  // Distributions are read from the dividends account, resolved by its system
  // key the way every other account the computation addresses is (issue #489).
  // A book with no dividends account cannot show its distributions: that is a
  // finding, never a silent zero.
  let dividendsAccount: string | undefined;
  try {
    dividendsAccount = systemAccountId(db, params.companyId, 'dividends_paid');
  } catch {
    dividendsAccount = undefined;
  }
  if (params.distributionsMinor !== undefined) {
    // ok — an explicit figure was supplied
  } else if (dividendsAccount) {
    // computed below
  } else {
    findings.push('No dividends account (system key dividends_paid) exists in this chart, so distributions for the '
      + 'period are read as nil. If the company distributed anything, record the dividends account (code 3200 in the '
      + 'default chart) or enter the distributions directly: the surcharge is computed on undistributed income.');
  }
  const distributions = params.distributionsMinor ?? (dividendsAccount
    ? db.select({ line: journalLines }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(and(eq(journalLines.accountId, dividendsAccount), gte(journalEntries.entryDate, params.from), lte(journalEntries.entryDate, params.to)))
      .all().reduce((sum, r) => sum + r.line.baseDebitMinor - r.line.baseCreditMinor, 0)
    : 0);

  const none = (working: string): CtSurcharge => ({
    status, distributableInvestmentIncomeMinor: deii, distributableTradingIncomeMinor: dti, distributionsMinor: distributions,
    surchargeMinor: 0, working, citations, findings,
  });
  if (status === 'not_close') return none('Not a close company: no surcharge.');

  if (status === 'close_service') {
    // s.441(4): the surcharge rates print on the working string from the
    // rules that state them, never hard-coded (issue #490).
    const surchargeRate = rule('ct.close_company_surcharge');
    const serviceRate = rule('ct.service_company_surcharge');
    const { total, at20, at15, surchargeMinor } = section441Surcharge(deii, dti, distributions,
      surchargeRate, serviceRate);
    return {
      status, distributableInvestmentIncomeMinor: deii, distributableTradingIncomeMinor: dti, distributionsMinor: distributions,
      surchargeMinor,
      working: `Investment and estate ${eur(deii)} + half of trading ${eur(multiplyRational(dti, 1, 2))} − distributions `
        + `${eur(distributions)} = ${eur(total)}: ${eur(at20)} at ${surchargeRate / 100}% and ${eur(at15)} at ${serviceRate / 100}%.`,
      citations: [...citations, cite('ct.service_company_definition'), cite('ct.service_company_surcharge'), cite('ct.surcharge_later_period')],
      findings,
    };
  }

  // s.440: 20% of the excess, nothing up to €2,000 (time-apportioned), marginal relief above.
  const yearDays = Math.round((Date.parse(params.to) - Date.parse(addMonths(params.to, -12))) / 86_400_000);
  const periodDays = Math.round((Date.parse(params.to) - Date.parse(params.from)) / 86_400_000) + 1;
  const threshold = multiplyRational(rule('ct.close_company_surcharge_de_minimis'), Math.min(periodDays, yearDays), yearDays);
  const excess = Math.max(deii - distributions, 0);
  const closeRate = rule('ct.close_company_surcharge');
  const capRate = rule('ct.surcharge_marginal_relief_cap');
  const surchargeMinor = section440Surcharge(deii, distributions, threshold, closeRate, capRate);
  return {
    status, distributableInvestmentIncomeMinor: deii, distributableTradingIncomeMinor: dti, distributionsMinor: distributions,
    surchargeMinor,
    working: `Distributable investment and estate income ${eur(deii)}`
      + `${tradingCompany ? ` (after the ${tradingReductionBps / 100}% trading company reduction)` : ''}`
      + ` − distributions ${eur(distributions)} = ${eur(excess)}; ${excess <= threshold ? `not over ${eur(threshold)}, so no surcharge`
        : `${closeRate / 100}%, limited to ${capRate / 100}% of the excess over ${eur(threshold)}`}. Charged for the period ending 12 months or more later (s.440(6)).`,
    citations: [...citations, cite('ct.close_company_surcharge'), cite('ct.close_company_surcharge_de_minimis'), cite('ct.surcharge_later_period'),
      ...(tradingCompany ? [cite('ct.trading_company_reduction')] : [])],
    findings,
  };
}

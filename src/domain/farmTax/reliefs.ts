import { and, eq, inArray, isNotNull, lte, or } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accounts, animalGroups, companyTradingActivities, farmPartnershipRegistrations, farmProfiles, items, livestockValuations,
  stockValuations,
} from '@/db/schema';
import { asIsoDate } from '../dates';
import { multiplyRational } from '../money';
import { accountBalance } from '../accounting/ledger';
import { auditRuleFigures, RejectedRuleError } from '../rules/ruleFigures';
import { CORPORATION_TAX_CURATED_RULES } from '../rules/corporationTaxCuration';

/**
 * Farm tax reliefs (EPIC 25, issue #544): stock relief (TCA ss.666, 667B,
 * 667C) and income averaging (s.657). The figures come from the rules the
 * Notes for Guidance on Part 23 state; which relief a person claims, and
 * whether they elect averaging, are their decisions, recorded in the income
 * tax computation's decisions and never assumed.
 */

const eur = (m: number) => (m / 100).toFixed(2);

/** A Part 23 figure in force on a date: the stored rule, else the shipped constant; a rejected rule stops the computation. */
export function farmFigure(db: AppDatabase, companyId: string, ruleKey: string, date: string): number {
  const f = auditRuleFigures(db, { companyId, asOfDate: date, curated: CORPORATION_TAX_CURATED_RULES }).figure(ruleKey);
  if (f.status === 'rejected' || f.status === 'retired') throw new RejectedRuleError(f);
  if (f.numericValue !== null) return f.numericValue;
  if (f.curatedValue !== null && f.curatedInForce) return f.curatedValue;
  throw new Error(`No figure for rule "${ruleKey}" on ${date}.`);
}

/** Whether the book is a farming trade in a period: a farm profile, or a farming trading activity overlapping it. */
export function isFarmingTrade(db: AppDatabase, companyId: string, from: string, to: string): boolean {
  if (db.select({ id: farmProfiles.id }).from(farmProfiles).where(eq(farmProfiles.companyId, companyId)).get()) return true;
  return db.select().from(companyTradingActivities)
    .where(and(eq(companyTradingActivities.companyId, companyId), eq(companyTradingActivities.sector, 'farming'))).all()
    .some((a) => a.commencedOn <= to && (!a.ceasedOn || a.ceasedOn >= from));
}

/** The accounts trading stock is held in: Stock on hand, the farm chart's livestock and crops, and any an item or group names. */
function stockAccountIds(db: AppDatabase, companyId: string): string[] {
  const set = new Set<string>();
  for (const a of db.select().from(accounts).where(and(eq(accounts.companyId, companyId), or(
    eq(accounts.systemKey, 'stock_on_hand'), inArray(accounts.code, ['1330', '1340']),
  ))).all()) set.add(a.id);
  for (const i of db.select({ id: items.stockAccountId }).from(items).where(and(eq(items.companyId, companyId), isNotNull(items.stockAccountId))).all()) set.add(i.id!);
  for (const g of db.select({ id: animalGroups.stockAccountId }).from(animalGroups).where(eq(animalGroups.companyId, companyId)).all()) set.add(g.id);
  return [...set];
}

/** The value of trading stock on a date: the stock accounts' balances, as closing stock and livestock valuations left them. */
export function tradingStockValue(db: AppDatabase, companyId: string, date: string): number {
  return stockAccountIds(db, companyId).reduce((s, accountId) => s + accountBalance(db, { companyId, accountId, asOf: asIsoDate(date) }), 0);
}

/** Findings where the stock accounts were not valued at a date the relief compares. */
function valuationFindings(db: AppDatabase, companyId: string, date: string): string[] {
  const out: string[] = [];
  const hasItems = db.select({ id: items.id }).from(items).where(and(eq(items.companyId, companyId), eq(items.kind, 'stock'))).get();
  const hasGroups = db.select({ id: animalGroups.id }).from(animalGroups).where(eq(animalGroups.companyId, companyId)).get();
  if (hasItems && !db.select({ id: stockValuations.id }).from(stockValuations)
    .where(and(eq(stockValuations.companyId, companyId), eq(stockValuations.valuationDate, date))).get()) {
    out.push(`No closing stock is posted at ${date}: the stock value used is the ledger's last booked figure. Post closing stock at that date.`);
  }
  if (hasGroups && !db.select({ id: livestockValuations.id }).from(livestockValuations)
    .where(and(eq(livestockValuations.companyId, companyId), eq(livestockValuations.valuationDate, date))).get()) {
    out.push(`No livestock valuation is posted at ${date}: the livestock value used is the ledger's last booked figure. Value the livestock at that date.`);
  }
  return out;
}

export type StockReliefCategory = 'general' | 'young_trained' | 'registered_partnership';

export interface StockReliefResult {
  category: StockReliefCategory;
  openingStockMinor: number;
  closingStockMinor: number;
  increaseMinor: number;
  rateBasisPoints: number;
  /** Before the no-loss limit. */
  grossReliefMinor: number;
  reliefMinor: number;
  ruleKeys: string[];
  findings: string[];
}

/** Whether the book's partnership is on the register of farm partnerships on a date. */
export function registeredFarmPartnershipOn(db: AppDatabase, companyId: string, date: string): boolean {
  return db.select().from(farmPartnershipRegistrations)
    .where(and(eq(farmPartnershipRegistrations.companyId, companyId), lte(farmPartnershipRegistrations.registeredOn, date))).all()
    .some((r) => !r.endedOn || r.endedOn >= date);
}

/**
 * Stock relief for an accounting period (issue #544): the rate for the
 * category claimed times the increase in trading stock over the period,
 * limited so it neither creates nor increases a loss (s.666(2), (3)).
 * `profitAfterAllowancesMinor` is the profit it may reduce.
 */
export function stockRelief(db: AppDatabase, p: {
  companyId: string; from: string; to: string; category: StockReliefCategory; profitAfterAllowancesMinor: number;
  priorYoungTrainedYears?: number;
}): StockReliefResult {
  const findings: string[] = [];
  const dayBefore = new Date(Date.parse(p.from) - 86_400_000).toISOString().slice(0, 10);
  const openingStockMinor = tradingStockValue(db, p.companyId, dayBefore);
  const closingStockMinor = tradingStockValue(db, p.companyId, p.to);
  findings.push(...valuationFindings(db, p.companyId, p.to));
  const increaseMinor = Math.max(closingStockMinor - openingStockMinor, 0);
  const base = { category: p.category, openingStockMinor, closingStockMinor, increaseMinor, findings };
  const ruleKeys = ['farm.stock_relief_rate', 'farm.stock_relief_no_loss', 'farm.stock_relief_last_year'];
  const lastYear = farmFigure(db, p.companyId, 'farm.stock_relief_last_year', p.to);
  if (Number(p.to.slice(0, 4)) > lastYear) {
    findings.push(`Stock relief is not available for a period ending after ${lastYear} (s.666(4)).`);
    return { ...base, rateBasisPoints: 0, grossReliefMinor: 0, reliefMinor: 0, ruleKeys };
  }
  let rateKey = 'farm.stock_relief_rate';
  if (p.category === 'young_trained') {
    const further = farmFigure(db, p.companyId, 'farm.young_trained_further_years', p.to);
    if ((p.priorYoungTrainedYears ?? 0) > further) {
      findings.push(`The 100% rate is for the year a farmer qualifies and the ${further} after (s.667B(5)(b)); it was claimed for `
        + `${p.priorYoungTrainedYears} earlier years, so the general rate is used.`);
    } else {
      rateKey = 'farm.stock_relief_rate_young_trained';
      ruleKeys.push(rateKey, 'farm.young_trained_further_years', 'farm.young_trained_annual_cap');
      findings.push(`The tax saved by the 100% rate is limited to ${eur(farmFigure(db, p.companyId, 'farm.young_trained_annual_cap', p.to))} `
        + 'a year and €100,000 over the qualifying period (s.667B(5A)): these books do not measure the tax saved, so check it.');
    }
  } else if (p.category === 'registered_partnership') {
    if (!registeredFarmPartnershipOn(db, p.companyId, p.to)) {
      findings.push(`The partnership is not recorded on the register of farm partnerships on ${p.to}: the 50% rate (s.667C) needs `
        + 'the registration. Record it, or claim the general rate. The general rate is used.');
    } else {
      rateKey = 'farm.stock_relief_rate_partnership';
      ruleKeys.push(rateKey, 'farm.partnership_relief_cap');
      findings.push(`Relief at the partnership rate is limited to ${eur(farmFigure(db, p.companyId, 'farm.partnership_relief_cap', p.to))} `
        + 'in aggregate over the three-year qualifying period (s.667C(3A)): check the claims of the earlier years against it.');
    }
  }
  const rateBasisPoints = farmFigure(db, p.companyId, rateKey, p.to);
  const grossReliefMinor = multiplyRational(increaseMinor, rateBasisPoints, 10_000);
  const reliefMinor = Math.min(grossReliefMinor, Math.max(p.profitAfterAllowancesMinor, 0));
  if (reliefMinor < grossReliefMinor) {
    findings.push(`Stock relief of ${eur(grossReliefMinor)} is limited to the profit of ${eur(Math.max(p.profitAfterAllowancesMinor, 0))}: `
      + 'it cannot create or increase a loss (s.666).');
  }
  if (increaseMinor === 0) findings.push(`Trading stock did not increase (${eur(openingStockMinor)} to ${eur(closingStockMinor)}): no stock relief.`);
  return { ...base, rateBasisPoints, grossReliefMinor, reliefMinor, ruleKeys };
}

export interface AveragingResult {
  years: Array<{ year: number; profitMinor: number; source: 'books' | 'recorded' }>;
  averageMinor: number;
  ruleKeys: string[];
}

/**
 * The averaged farming profit for a year (s.657(5)): one fifth of the
 * aggregate profits and losses of the year and the 4 before it, before
 * capital allowances. `profitOf` gives each year's figure, or null when
 * neither the books nor a recorded figure has it.
 */
export function averagedProfit(db: AppDatabase, p: {
  companyId: string; year: number; profitOf: (year: number) => { profitMinor: number; source: 'books' | 'recorded' } | null;
}): AveragingResult | { missing: number[] } {
  const span = farmFigure(db, p.companyId, 'farm.averaging_years', `${p.year}-12-31`);
  const years: AveragingResult['years'] = [];
  const missing: number[] = [];
  for (let y = p.year - span + 1; y <= p.year; y++) {
    const f = p.profitOf(y);
    if (f) years.push({ year: y, ...f });
    else missing.push(y);
  }
  if (missing.length) return { missing };
  const total = years.reduce((s, y) => s + y.profitMinor, 0);
  return { years, averageMinor: multiplyRational(total, 1, span), ruleKeys: ['farm.averaging_years'] };
}

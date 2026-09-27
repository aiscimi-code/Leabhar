import { and, eq, inArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, fixedAssets } from '@/db/schema';
import { asIsoDate } from '../dates';
import { computeIncomeTax } from '../incomeTax/computation';
import { computeCorporationTax } from '../corporationTax/computation';
import { reconcileGrants } from './grants';
import { successionCreditFor } from './partnerships';

/**
 * The farm tax summary for a year (EPIC 25, issue #546): the figures the
 * income tax or corporation tax computation used for the farm, in one place,
 * with the flags they raised. Nothing is computed here that the computations
 * did not compute: this reads them.
 */

export interface FarmTaxSummary {
  entity: 'individual' | 'company';
  from: string;
  to: string;
  /** The farming profit before capital allowances and farm reliefs. */
  profitBeforeReliefsMinor: number;
  stockReliefMinor: number;
  stockReliefCategory: string | null;
  averaging: { applied: boolean; averageMinor: number; years: Array<{ year: number; profitMinor: number; source: string }> } | null;
  /** Allowances on farm buildings and slurry storage within the capital allowances. */
  farmBuildingAllowancesMinor: number;
  capitalAllowancesMinor: number;
  taxableFarmingProfitMinor: number;
  grants: { revenueReceivedMinor: number; capitalReceivedMinor: number; awardedOutstandingMinor: number; unlinkedMinor: number };
  successionCredit: { creditMinor: number; identifier: string } | null;
  findings: string[];
}

/** The farm tax summary for an individual's year of assessment, or a company's accounting period. */
export function farmTaxSummary(db: AppDatabase, p: { companyId: string; year?: number; from?: string; to?: string }): FarmTaxSummary {
  const company = db.select().from(companies).where(eq(companies.id, p.companyId)).get();
  if (!company) throw new Error(`Company ${p.companyId} not found.`);
  const farmAssetIds = new Set(db.select({ id: fixedAssets.id }).from(fixedAssets).where(and(
    eq(fixedAssets.companyId, p.companyId), inArray(fixedAssets.assetCategory, ['farm_buildings', 'slurry_storage']),
  )).all().map((a) => a.id));
  const farmAllowances = (lines: Array<{ kind: string; sources: Array<{ entityType: string; entityId: string; amountMinor: number }> }>) =>
    lines.filter((l) => l.kind === 'deduction').flatMap((l) => l.sources)
      .filter((s) => s.entityType === 'fixed_asset' && farmAssetIds.has(s.entityId)).reduce((sum, s) => sum + s.amountMinor, 0);

  let base: Omit<FarmTaxSummary, 'grants' | 'successionCredit'>;
  if (company.entityType === 'company') {
    if (!p.from || !p.to) throw new Error('A company\'s summary is for an accounting period: give its start and end.');
    const ct = computeCorporationTax(db, { companyId: p.companyId, from: asIsoDate(p.from), to: asIsoDate(p.to) });
    const stock = ct.lines.find((l) => l.label === 'Deduct: stock relief');
    const allowanceLines = ct.lines.filter((l) => /capital allowances|balancing/i.test(l.label));
    const capital = allowanceLines.reduce((s, l) => s + l.amountMinor, 0);
    base = {
      entity: 'company', from: p.from, to: p.to,
      profitBeforeReliefsMinor: ct.adjustedTradingResultMinor - capital,
      stockReliefMinor: stock ? -stock.amountMinor : 0,
      stockReliefCategory: stock ? 'general' : null,
      averaging: null,
      farmBuildingAllowancesMinor: farmAllowances(allowanceLines),
      capitalAllowancesMinor: capital,
      taxableFarmingProfitMinor: ct.tradingProfitMinor,
      findings: ct.findings,
    };
  } else {
    if (!p.year) throw new Error('An individual\'s summary is for a year of assessment.');
    const it = computeIncomeTax(db, { companyId: p.companyId, year: p.year });
    base = {
      entity: 'individual', from: it.basis.from, to: it.basis.to,
      profitBeforeReliefsMinor: it.basisProfitMinor,
      stockReliefMinor: it.farm?.stockRelief?.reliefMinor ?? 0,
      stockReliefCategory: it.farm?.stockRelief?.category ?? null,
      averaging: it.farm?.averaging
        ? { applied: it.farm.averaging.applied, averageMinor: it.farm.averaging.averageMinor, years: it.farm.averaging.years }
        : null,
      farmBuildingAllowancesMinor: farmAllowances(it.capitalAllowanceLines),
      capitalAllowancesMinor: it.capitalAllowancesMinor,
      taxableFarmingProfitMinor: it.assessableProfitMinor,
      findings: it.findings,
    };
  }
  const recon = reconcileGrants(db, { companyId: p.companyId, asOf: base.to, raiseReviewItems: false });
  const inPeriod = (d: string) => d >= base.from && d <= base.to;
  const received = (kind: 'revenue' | 'capital') => recon.grants.filter((g) => g.kind === kind)
    .reduce((s, g) => s + g.receipts.filter((r) => inPeriod(r.date)).reduce((t, r) => t + r.amountMinor, 0), 0);
  return {
    ...base,
    grants: {
      revenueReceivedMinor: received('revenue'), capitalReceivedMinor: received('capital'),
      awardedOutstandingMinor: recon.grants.reduce((s, g) => s + Math.max(g.outstandingMinor, 0), 0),
      unlinkedMinor: recon.unlinked.filter((u) => inPeriod(u.date)).reduce((s, u) => s + u.amountMinor, 0),
    },
    successionCredit: company.entityType === 'partnership' && p.year ? successionCreditFor(db, p.companyId, p.year) : null,
  };
}

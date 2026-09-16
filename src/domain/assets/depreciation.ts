import { and, eq, lte, gte, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  fixedAssets, depreciationCharges, companies, auditEvents, accounts,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asMinor, multiplyRational } from '../money';
import {
  asIsoDate, nowIso, addMonths, endOfMonth, parts, makeDate, type IsoDate,
} from '../dates';
import { postJournalEntry } from '../accounting/journal';
import { systemAccountId } from '../config/setup';
import { AccountingError } from '../accounting/errors';

export class DepreciationError extends AccountingError {}

/**
 * Depreciation and capital allowances (README §29, §33).
 *
 * Two schedules are kept deliberately separate because they answer different
 * questions. Accounting depreciation is the company's own estimate of how the
 * asset's cost should be spread, and it hits the profit and loss account.
 * Capital allowances are what tax law permits instead, at rates set by
 * legislation rather than by the company, and they appear only in the tax
 * computation.
 *
 * Only accounting depreciation is posted to the ledger. Capital allowances are
 * computed and recorded, but never journalled — they are not accounting
 * entries, and posting them would corrupt the accounts to make the tax
 * computation look tidier.
 */

export interface DepreciationSchedule {
  assetId: string;
  assetName: string;
  method: string;
  costMinor: number;
  residualValueMinor: number;
  usefulLifeMonths: number;
  periods: Array<{
    periodStart: IsoDate;
    periodEnd: IsoDate;
    chargeMinor: number;
    accumulatedMinor: number;
    netBookValueMinor: number;
    posted: boolean;
  }>;
  totalChargeMinor: number;
}

/**
 * Build the accounting depreciation schedule for an asset.
 *
 * The final period absorbs any rounding so the asset depreciates to exactly its
 * residual value. Dividing the cost evenly and rounding each month would leave
 * a few cents on the books for ever, which then shows up as a permanently
 * un-disposable asset.
 */
export function buildDepreciationSchedule(
  db: AppDatabase,
  params: { companyId: string; assetId: string; upTo?: IsoDate },
): DepreciationSchedule {
  const asset = db.select().from(fixedAssets)
    .where(and(
      eq(fixedAssets.id, params.assetId),
      eq(fixedAssets.companyId, params.companyId),
    )).get();
  if (!asset) throw new DepreciationError(`Fixed asset ${params.assetId} not found.`);

  const depreciable = asset.baseCostMinor - asset.residualValueMinor;
  const start = asIsoDate(asset.depreciationStartDate ?? asset.purchaseDate);

  const posted = db.select().from(depreciationCharges)
    .where(and(
      eq(depreciationCharges.fixedAssetId, asset.id),
      eq(depreciationCharges.chargeType, 'accounting_depreciation'),
    )).all();
  const postedPeriods = new Set(posted.map((charge) => charge.periodStart));

  const periods: DepreciationSchedule['periods'] = [];

  if (asset.depreciationMethod === 'none' || depreciable <= 0) {
    return {
      assetId: asset.id, assetName: asset.name, method: asset.depreciationMethod,
      costMinor: asset.baseCostMinor, residualValueMinor: asset.residualValueMinor,
      usefulLifeMonths: asset.usefulLifeMonths, periods: [], totalChargeMinor: 0,
    };
  }

  const months = Math.max(1, asset.usefulLifeMonths);
  let accumulated = 0;

  for (let index = 0; index < months; index++) {
    const periodStart = index === 0 ? start : addMonths(startOfMonthFrom(start), index);
    const periodEnd = endOfMonth(addMonths(startOfMonthFrom(start), index));
    if (params.upTo && periodStart > params.upTo) break;

    let chargeMinor: number;
    if (asset.depreciationMethod === 'reducing_balance') {
      // Monthly equivalent of the annual reducing-balance rate.
      const openingNetBookValue = asset.baseCostMinor - accumulated;
      const annualRate = 10_000 / months * 12;
      chargeMinor = multiplyRational(
        asMinor(openingNetBookValue - asset.residualValueMinor),
        Math.round(annualRate / 12), 10_000,
      );
    } else {
      chargeMinor = multiplyRational(asMinor(depreciable), 1, months);
    }

    // The last period absorbs rounding so the asset lands exactly on residual.
    if (index === months - 1) chargeMinor = depreciable - accumulated;
    if (accumulated + chargeMinor > depreciable) chargeMinor = depreciable - accumulated;
    if (chargeMinor <= 0) break;

    accumulated += chargeMinor;
    periods.push({
      periodStart, periodEnd, chargeMinor,
      accumulatedMinor: accumulated,
      netBookValueMinor: asset.baseCostMinor - accumulated,
      posted: postedPeriods.has(periodStart),
    });
  }

  return {
    assetId: asset.id,
    assetName: asset.name,
    method: asset.depreciationMethod,
    costMinor: asset.baseCostMinor,
    residualValueMinor: asset.residualValueMinor,
    usefulLifeMonths: asset.usefulLifeMonths,
    periods,
    totalChargeMinor: periods.reduce((s, p) => s + p.chargeMinor, 0),
  };
}

function startOfMonthFrom(date: IsoDate): IsoDate {
  const { year, month } = parts(date);
  return makeDate(year, month, 1);
}

export interface PostDepreciationResult {
  assetsProcessed: number;
  periodsPosted: number;
  totalChargeMinor: number;
  journalEntryIds: string[];
  skipped: Array<{ assetName: string; reason: string }>;
}

/**
 * Post accounting depreciation up to a date.
 *
 * Idempotent by period: a period already charged for an asset is skipped, so
 * running this twice does not double the charge. That matters because the
 * obvious way to use it is to run it at every period end.
 */
export function postDepreciation(
  db: AppDatabase,
  params: { companyId: string; upTo: IsoDate; actor?: string; requestId?: string },
): PostDepreciationResult {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new DepreciationError(`Company ${params.companyId} not found.`);

  const assets = db.select().from(fixedAssets)
    .where(and(
      eq(fixedAssets.companyId, params.companyId),
      lte(fixedAssets.purchaseDate, params.upTo),
    )).all();

  const journalEntryIds: string[] = [];
  const skipped: Array<{ assetName: string; reason: string }> = [];
  let periodsPosted = 0;
  let totalChargeMinor = 0;

  for (const asset of assets) {
    if (asset.status === 'pending_review') {
      skipped.push({
        assetName: asset.name,
        reason: 'Still awaiting review. Confirm it is a capital purchase before depreciating it.',
      });
      continue;
    }
    if (asset.status === 'disposed' && asset.disposalDate && asset.disposalDate <= params.upTo) {
      skipped.push({ assetName: asset.name, reason: 'Disposed of.' });
      continue;
    }
    if (asset.depreciationMethod === 'none') {
      skipped.push({ assetName: asset.name, reason: 'No depreciation policy set for this asset.' });
      continue;
    }

    const schedule = buildDepreciationSchedule(db, {
      companyId: params.companyId, assetId: asset.id, upTo: params.upTo,
    });

    const due = schedule.periods.filter((p) => !p.posted && p.periodEnd <= params.upTo);
    if (due.length === 0) continue;

    const expenseAccount = asset.depreciationExpenseAccountId
      ?? systemAccountId(db, params.companyId, 'depreciation_expense');
    const accumulatedAccount = asset.accumulatedDepreciationAccountId
      ?? systemAccountId(db, params.companyId, 'accumulated_depreciation');

    for (const period of due) {
      const journal = postJournalEntry(db, {
        companyId: params.companyId,
        entryDate: period.periodEnd,
        narrative: `Depreciation — ${asset.name}`,
        sourceType: 'depreciation',
        sourceId: asset.id,
        baseCurrency: company.baseCurrency,
        createdBy: params.actor ?? 'system',
        createdVia: 'system',
        requestId: params.requestId,
        lines: [
          {
            accountId: expenseAccount,
            debitMinor: period.chargeMinor,
            memo: `${asset.name}, ${period.periodStart} to ${period.periodEnd}`,
          },
          {
            // Accumulated depreciation is a credit against the asset, which is
            // why it sits in the fixed-asset section as a negative rather than
            // reducing the cost account directly. The original cost stays
            // visible, which is what an accountant expects to see.
            accountId: accumulatedAccount,
            creditMinor: period.chargeMinor,
            memo: `${asset.name}, ${period.periodStart} to ${period.periodEnd}`,
          },
        ],
      });

      journalEntryIds.push(journal.id);
      periodsPosted += 1;
      totalChargeMinor += period.chargeMinor;

      db.transaction((tx) => {
        tx.insert(depreciationCharges).values({
          id: ids.depreciation(),
          companyId: params.companyId,
          fixedAssetId: asset.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          chargeType: 'accounting_depreciation',
          amountMinor: period.chargeMinor,
          currency: company.baseCurrency,
          journalEntryId: journal.id,
          source: 'system',
          provenanceStatus: 'system_rule',
        }).run();

        tx.update(fixedAssets).set({
          accumulatedDepreciationMinor: period.accumulatedMinor,
          status: period.netBookValueMinor <= asset.residualValueMinor
            ? 'fully_depreciated' : 'active',
          updatedAt: nowIso(),
        }).where(eq(fixedAssets.id, asset.id)).run();
      });
    }
  }

  if (periodsPosted > 0) {
    db.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: nowIso(),
      entityType: 'fixed_asset',
      entityId: 'batch',
      action: 'created',
      newValue: JSON.stringify({
        upTo: params.upTo, periodsPosted, totalChargeMinor,
        assets: assets.length,
      }),
      source: 'system',
      actor: params.actor ?? 'system',
      reason: 'Depreciation posted',
      requestId: params.requestId ?? null,
    }).run();
  }

  return {
    assetsProcessed: assets.length,
    periodsPosted,
    totalChargeMinor,
    journalEntryIds,
    skipped,
  };
}

export interface CapitalAllowanceLine {
  assetId: string;
  assetName: string;
  purchaseDate: string;
  costMinor: number;
  rateBasisPoints: number;
  years: number;
  /** The allowance for the year in question. */
  allowanceMinor: number;
  claimedToDateMinor: number;
  remainingMinor: number;
  note: string;
}

/**
 * Compute capital allowances for a financial year.
 *
 * Never posted to the ledger: these are tax figures, not accounting entries.
 * They feed the corporation tax worksheet, where the accounting depreciation is
 * added back and these are deducted instead.
 *
 * The rate and period come from each asset's own configuration rather than from
 * anything hard-coded (README §6), and the note says so, because a rate that
 * looks authoritative but is out of date is worse than one the user knows to
 * check.
 */
export function capitalAllowancesForYear(
  db: AppDatabase,
  params: { companyId: string; yearStart: IsoDate; yearEnd: IsoDate },
): { lines: CapitalAllowanceLine[]; totalMinor: number; caveat: string } {
  const assets = db.select().from(fixedAssets)
    .where(and(
      eq(fixedAssets.companyId, params.companyId),
      lte(fixedAssets.purchaseDate, params.yearEnd),
    )).all();

  const lines: CapitalAllowanceLine[] = [];

  for (const asset of assets) {
    if (asset.status === 'pending_review') continue;

    const annual = multiplyRational(
      asMinor(asset.baseCostMinor), asset.capitalAllowanceRateBasisPoints, 10_000,
    );

    // How many years of allowance have already been claimed before this year.
    const yearsElapsed = yearsBetween(asIsoDate(asset.purchaseDate), params.yearStart);
    const claimedToDate = Math.min(
      annual * Math.max(0, yearsElapsed), asset.baseCostMinor,
    );
    const remainingBefore = asset.baseCostMinor - claimedToDate;

    // The pool cannot go below zero, and the final year takes what is left.
    const allowanceMinor = asset.purchaseDate > params.yearEnd ? 0
      : Math.max(0, Math.min(annual, remainingBefore));

    if (allowanceMinor === 0 && remainingBefore <= 0) continue;

    lines.push({
      assetId: asset.id,
      assetName: asset.name,
      purchaseDate: asset.purchaseDate,
      costMinor: asset.baseCostMinor,
      rateBasisPoints: asset.capitalAllowanceRateBasisPoints,
      years: asset.capitalAllowanceYears,
      allowanceMinor,
      claimedToDateMinor: claimedToDate,
      remainingMinor: remainingBefore - allowanceMinor,
      note: asset.capitalAllowanceNotes
        ?? `Straight line at ${asset.capitalAllowanceRateBasisPoints / 100}% over `
          + `${asset.capitalAllowanceYears} years, as configured on this asset.`,
    });
  }

  return {
    lines,
    totalMinor: lines.reduce((s, l) => s + l.allowanceMinor, 0),
    caveat:
      'These are computed from each asset’s configured rate and period, on a straight-line '
      + 'basis and without time-apportionment in the year of purchase. They do NOT include '
      + 'balancing allowances or charges on disposals, and they do not consider whether an '
      + 'asset qualifies at all. Confirm the rates against current legislation and have your '
      + 'accountant review the computation.',
  };
}

function yearsBetween(from: IsoDate, to: IsoDate): number {
  const a = parts(from);
  const b = parts(to);
  const months = (b.year - a.year) * 12 + (b.month - a.month);
  return Math.floor(months / 12);
}

/**
 * Record the disposal of an asset.
 *
 * Removes the cost and accumulated depreciation, and posts the profit or loss
 * on disposal. Flags the balancing allowance or charge for the tax computation
 * without calculating it, since that depends on facts this application does not
 * hold.
 */
export function disposeAsset(
  db: AppDatabase,
  params: {
    companyId: string;
    assetId: string;
    disposalDate: IsoDate;
    proceedsMinor: number;
    notes?: string;
    actor?: string;
  },
): { journalEntryId: string; profitOrLossMinor: number; taxNote: string } {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new DepreciationError(`Company ${params.companyId} not found.`);

  const asset = db.select().from(fixedAssets)
    .where(and(
      eq(fixedAssets.id, params.assetId),
      eq(fixedAssets.companyId, params.companyId),
    )).get();
  if (!asset) throw new DepreciationError(`Fixed asset ${params.assetId} not found.`);
  if (asset.status === 'disposed') {
    throw new DepreciationError(`${asset.name} has already been disposed of.`);
  }

  const netBookValue = asset.baseCostMinor - asset.accumulatedDepreciationMinor;
  const profitOrLossMinor = params.proceedsMinor - netBookValue;

  const costAccount = asset.accountId ?? systemAccountId(db, params.companyId, 'computer_equipment');
  const accumulatedAccount = asset.accumulatedDepreciationAccountId
    ?? systemAccountId(db, params.companyId, 'accumulated_depreciation');
  const disposalAccount = systemAccountId(db, params.companyId, 'disposal_of_assets');
  const bankAccount = systemAccountId(db, params.companyId, 'bank_control');

  const lines: Parameters<typeof postJournalEntry>[1]['lines'] = [];

  if (params.proceedsMinor !== 0) {
    lines.push({
      accountId: bankAccount, debitMinor: params.proceedsMinor,
      memo: `Proceeds on disposal of ${asset.name}`,
    });
  }
  if (asset.accumulatedDepreciationMinor !== 0) {
    lines.push({
      accountId: accumulatedAccount, debitMinor: asset.accumulatedDepreciationMinor,
      memo: `Remove accumulated depreciation on ${asset.name}`,
    });
  }
  lines.push({
    accountId: costAccount, creditMinor: asset.baseCostMinor,
    memo: `Remove cost of ${asset.name}`,
  });
  if (profitOrLossMinor !== 0) {
    lines.push({
      accountId: disposalAccount,
      ...(profitOrLossMinor > 0
        ? { creditMinor: profitOrLossMinor }
        : { debitMinor: -profitOrLossMinor }),
      memo: profitOrLossMinor > 0
        ? `Profit on disposal of ${asset.name}`
        : `Loss on disposal of ${asset.name}`,
    });
  }

  const journal = postJournalEntry(db, {
    companyId: params.companyId,
    entryDate: params.disposalDate,
    narrative: `Disposal of ${asset.name}`,
    sourceType: 'fixed_asset',
    sourceId: asset.id,
    baseCurrency: company.baseCurrency,
    createdBy: params.actor ?? 'user',
    createdVia: 'user',
    lines,
  });

  const taxNote =
    'A disposal usually gives rise to a balancing allowance or a balancing charge for tax, '
    + 'comparing the proceeds with the tax written-down value rather than the accounting net '
    + 'book value. This application records the accounting entries and flags the disposal; it '
    + 'does not compute the balancing figure. Raise it with your accountant.';

  db.transaction((tx) => {
    tx.update(fixedAssets).set({
      status: 'disposed',
      disposalDate: params.disposalDate,
      disposalProceedsMinor: params.proceedsMinor,
      disposalNotes: params.notes ?? null,
      updatedAt: nowIso(),
    }).where(eq(fixedAssets.id, asset.id)).run();

    tx.insert(auditEvents).values({
      id: ids.audit(),
      companyId: params.companyId,
      occurredAt: nowIso(),
      entityType: 'fixed_asset',
      entityId: asset.id,
      action: 'updated',
      field: 'status',
      previousValue: asset.status,
      newValue: 'disposed',
      source: 'user',
      actor: params.actor ?? 'user',
      reason: `Disposed for ${params.proceedsMinor}; ${profitOrLossMinor >= 0 ? 'profit' : 'loss'} `
        + `of ${Math.abs(profitOrLossMinor)} on disposal`,
    }).run();
  });

  return { journalEntryId: journal.id, profitOrLossMinor, taxNote };
}

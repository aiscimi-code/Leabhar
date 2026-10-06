import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  accounts, auditEvents, companies, depreciationCharges, documents, fixedAssetTransfers, fixedAssets, invoices, suppliers,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { asIsoDate, isIsoDate, nowIso, type IsoDate } from '../dates';
import { asMinor } from '../money';
import { atomically, assertAccountingPeriodOpen, postJournalEntry } from '../accounting/journal';
import { accountBalance } from '../accounting/ledger';
import { systemAccountId } from '../config/setup';
import { upsertReviewItem } from '../extraction/service';
import { DepreciationError } from './depreciation';

/**
 * The fixed asset register's own lifecycle (issue #534): recording an
 * acquisition already in the ledger, moving an asset between fixed-asset
 * accounts, and reconciling the register to the ledger. Depreciation and
 * disposal are `depreciation.ts`.
 *
 * Registering posts nothing: the purchase's own journal (an invoice, a bank
 * line classified to the asset account) is the acquisition, and the register
 * records what that cost is, so its depreciation and capital allowances can
 * be computed. A transfer posts one journal and keeps a history row; the
 * reconciliation reports differences and adjusts nothing (invariant 7).
 */

export type FixedAsset = typeof fixedAssets.$inferSelect;
const eur = (m: number) => (m / 100).toFixed(2);

function requireDate(value: string, what: string): IsoDate {
  if (!isIsoDate(value)) throw new DepreciationError(`${what} is a YYYY-MM-DD date.`);
  return asIsoDate(value);
}

/** A company's fixed-asset cost account (not an accumulated depreciation account), or a refusal. */
function requireCostAccount(db: AppDatabase, companyId: string, accountId: string) {
  const account = db.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.companyId, companyId))).get();
  if (!account) throw new DepreciationError(`Account ${accountId} not found in this company.`);
  if (account.type !== 'asset' || account.subtype !== 'fixed_asset' || account.systemKey === 'accumulated_depreciation') {
    throw new DepreciationError(`${account.code} ${account.name} is not a fixed-asset cost account: register an asset against `
      + 'the account its purchase was posted to.');
  }
  return account;
}

/** Accumulated depreciation accounts are fixed-asset accounts that carry credits against cost. */
function isAccumulatedAccount(account: typeof accounts.$inferSelect): boolean {
  return account.systemKey === 'accumulated_depreciation' || /accumulated depreciation/i.test(account.name);
}

/** The cost account an asset sat in on a date, from its transfer history. */
/**
 * The wear and tear allowance a new asset starts with: 12.5% a year over eight
 * years (TCA 1997 s.284(2)). A copy of `ct.wear_and_tear_rate`, held to it by
 * figureCopies.test.ts (issue #686 step 6).
 */
export const DEFAULT_CAPITAL_ALLOWANCE_RATE_BP = 1250;
export const DEFAULT_CAPITAL_ALLOWANCE_YEARS = 8;

export function assetAccountOn(db: AppDatabase, asset: FixedAsset, date: string): string | null {
  const transfers = db.select().from(fixedAssetTransfers).where(eq(fixedAssetTransfers.fixedAssetId, asset.id))
    .orderBy(asc(fixedAssetTransfers.transferDate), sql`rowid`).all();
  if (!transfers.length) return asset.accountId;
  const before = transfers.filter((t) => t.transferDate <= date);
  return before.length ? before.at(-1)!.toAccountId : transfers[0]!.fromAccountId;
}

/** The accumulated depreciation account an asset's charges sat in on a date. */
function accumulatedAccountOn(db: AppDatabase, companyId: string, asset: FixedAsset, date: string): string {
  const fallback = systemAccountId(db, companyId, 'accumulated_depreciation');
  const transfers = db.select().from(fixedAssetTransfers)
    .where(and(eq(fixedAssetTransfers.fixedAssetId, asset.id), sql`${fixedAssetTransfers.toAccumulatedAccountId} is not null`))
    .orderBy(asc(fixedAssetTransfers.transferDate), sql`rowid`).all();
  if (!transfers.length) return asset.accumulatedDepreciationAccountId ?? fallback;
  const before = transfers.filter((t) => t.transferDate <= date);
  return before.length ? before.at(-1)!.toAccumulatedAccountId! : transfers[0]!.fromAccumulatedAccountId ?? fallback;
}

/** The cost the register holds in an account on a date: assets in it then, bought by then and not yet disposed of. */
export function registeredCostIn(db: AppDatabase, companyId: string, accountId: string, asOf: string): number {
  return db.select().from(fixedAssets).where(and(eq(fixedAssets.companyId, companyId), lte(fixedAssets.purchaseDate, asOf))).all()
    .filter((a) => !(a.disposalDate && a.disposalDate <= asOf) && assetAccountOn(db, a, asOf) === accountId)
    .reduce((s, a) => s + a.baseCostMinor, 0);
}

export interface RegisterFixedAssetInput {
  companyId: string;
  name: string;
  description?: string | null;
  assetCategory: FixedAsset['assetCategory'];
  purchaseDate: string;
  /** Cost in the base currency, net of recoverable VAT: what the purchase put on the asset account. */
  costMinor: number;
  /** The fixed-asset account the purchase was posted to. */
  accountId: string;
  supplierId?: string | null;
  invoiceId?: string | null;
  documentId?: string | null;
  depreciationMethod?: FixedAsset['depreciationMethod'];
  usefulLifeMonths?: number;
  residualValueMinor?: number;
  capitalAllowanceRateBasisPoints?: number;
  capitalAllowanceYears?: number;
  /** A car's CO2 emissions (g/km) from its registration certificate (TCA s.380K). */
  co2EmissionsGramsPerKm?: number | null;
  co2EmissionsEvidence?: string | null;
  recordedBy: string;
}

/**
 * Register an asset whose purchase is already in the ledger. Refused when the
 * account does not hold that much unregistered cost at the purchase date: the
 * register never claims an asset the books do not show.
 */
export function registerFixedAsset(db: AppDatabase, input: RegisterFixedAssetInput): { asset: FixedAsset; warnings: string[] } {
  const company = db.select().from(companies).where(eq(companies.id, input.companyId)).get();
  if (!company) throw new DepreciationError(`Company ${input.companyId} not found.`);
  if (!input.name.trim()) throw new DepreciationError('Name the asset.');
  if (!input.recordedBy.trim()) throw new DepreciationError('Say who is registering the asset.');
  const purchaseDate = requireDate(input.purchaseDate, 'The purchase date');
  const cost = asMinor(input.costMinor);
  if (cost <= 0) throw new DepreciationError('An asset\'s cost is a positive amount.');
  const account = requireCostAccount(db, input.companyId, input.accountId);
  for (const [id, table, what] of [
    [input.supplierId, suppliers, 'Supplier'], [input.invoiceId, invoices, 'Invoice'], [input.documentId, documents, 'Document'],
  ] as const) {
    if (!id) continue;
    const row = db.select({ companyId: table.companyId }).from(table).where(eq(table.id, id)).get();
    if (!row || row.companyId !== input.companyId) throw new DepreciationError(`${what} ${id} not found in this company.`);
  }
  const ledger = accountBalance(db, { companyId: input.companyId, accountId: account.id, asOf: purchaseDate });
  const registered = registeredCostIn(db, input.companyId, account.id, purchaseDate);
  if (cost > ledger - registered) {
    throw new DepreciationError(`${account.code} ${account.name} holds ${eur(ledger)} on ${purchaseDate}, of which ${eur(registered)} `
      + `is already registered: ${eur(Math.max(0, ledger - registered))} is left, not ${eur(cost)}. Post the purchase to the account `
      + 'first (or check the date and amount); the register records what the ledger holds.');
  }
  const grams = input.co2EmissionsGramsPerKm ?? null;
  if (grams !== null && (!Number.isInteger(grams) || grams < 0 || grams > 1_000)) {
    throw new DepreciationError('CO2 emissions are whole grams per km, as the registration certificate states them.');
  }
  if (grams !== null && input.assetCategory !== 'motor_vehicles') throw new DepreciationError('Only a motor vehicle has CO2 emissions recorded.');
  const warnings: string[] = [];
  if (input.assetCategory === 'motor_vehicles' && grams === null && purchaseDate >= '2008-07-01') {
    warnings.push('A car bought from July 2008 is allowed capital allowances by its CO2 emissions (TCA Part 11C). Record the '
      + 'g/km from the registration certificate; until then the restriction is not applied and the computation flags it.');
  }
  const months = input.usefulLifeMonths ?? 48;
  if (!Number.isInteger(months) || months <= 0) throw new DepreciationError('The useful life is a positive number of months.');
  const residual = asMinor(input.residualValueMinor ?? 0);
  if (residual < 0 || residual >= cost) throw new DepreciationError('The residual value is at least nil and less than the cost.');

  const id = ids.fixedAsset();
  return db.transaction((tx) => {
    tx.insert(fixedAssets).values({
      id, companyId: input.companyId, name: input.name.trim(), description: input.description?.trim() || null,
      assetCategory: input.assetCategory, purchaseDate, supplierId: input.supplierId ?? null, invoiceId: input.invoiceId ?? null,
      documentId: input.documentId ?? null, costMinor: cost, vatMinor: 0, currency: company.baseCurrency,
      baseCostMinor: cost, baseCurrency: company.baseCurrency, accountId: account.id,
      accumulatedDepreciationAccountId: systemAccountId(tx as unknown as AppDatabase, input.companyId, 'accumulated_depreciation'),
      depreciationExpenseAccountId: systemAccountId(tx as unknown as AppDatabase, input.companyId, 'depreciation_expense'),
      depreciationMethod: input.depreciationMethod ?? 'straight_line', usefulLifeMonths: months, residualValueMinor: residual,
      depreciationStartDate: purchaseDate,
      capitalAllowanceRateBasisPoints: input.capitalAllowanceRateBasisPoints ?? DEFAULT_CAPITAL_ALLOWANCE_RATE_BP,
      capitalAllowanceYears: input.capitalAllowanceYears ?? DEFAULT_CAPITAL_ALLOWANCE_YEARS,
      co2EmissionsGramsPerKm: grams, co2EmissionsEvidence: input.co2EmissionsEvidence?.trim() || null,
      status: 'active', source: 'user', provenanceStatus: 'user_confirmed',
    }).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: input.companyId, occurredAt: nowIso(), entityType: 'fixed_asset', entityId: id,
      action: 'created', newValue: JSON.stringify({ costMinor: cost, accountId: account.id, purchaseDate, co2EmissionsGramsPerKm: grams }),
      source: 'user', actor: input.recordedBy, requestId: null,
    }).run();
    return { asset: tx.select().from(fixedAssets).where(eq(fixedAssets.id, id)).get()!, warnings };
  });
}

/**
 * Record a car's CO2 emissions from its registration certificate (TCA
 * s.380K). A figure already recorded is changed only with a reason: it
 * decides the car's allowances for every year.
 */
export function recordCarEmissions(db: AppDatabase, params: {
  companyId: string; assetId: string; gramsPerKm: number; evidence: string; recordedBy: string; reason?: string;
}): FixedAsset {
  const asset = db.select().from(fixedAssets).where(and(eq(fixedAssets.id, params.assetId), eq(fixedAssets.companyId, params.companyId))).get();
  if (!asset) throw new DepreciationError(`Fixed asset ${params.assetId} not found.`);
  if (asset.assetCategory !== 'motor_vehicles') throw new DepreciationError(`${asset.name} is not a motor vehicle.`);
  if (!Number.isInteger(params.gramsPerKm) || params.gramsPerKm < 0 || params.gramsPerKm > 1_000) {
    throw new DepreciationError('CO2 emissions are whole grams per km, as the registration certificate states them.');
  }
  if (!params.evidence.trim()) throw new DepreciationError('Say where the figure comes from (the registration certificate, say).');
  if (asset.co2EmissionsGramsPerKm !== null && asset.co2EmissionsGramsPerKm !== params.gramsPerKm && !params.reason?.trim()) {
    throw new DepreciationError(`${asset.name} already has ${asset.co2EmissionsGramsPerKm}g/km recorded. Give the reason for changing it.`);
  }
  db.transaction((tx) => {
    tx.update(fixedAssets).set({
      co2EmissionsGramsPerKm: params.gramsPerKm, co2EmissionsEvidence: params.evidence.trim(), updatedAt: nowIso(),
    }).where(eq(fixedAssets.id, asset.id)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(), entityType: 'fixed_asset', entityId: asset.id,
      action: 'updated', field: 'co2_emissions_g_km',
      previousValue: JSON.stringify({ co2EmissionsGramsPerKm: asset.co2EmissionsGramsPerKm }),
      newValue: JSON.stringify({ co2EmissionsGramsPerKm: params.gramsPerKm, evidence: params.evidence.trim() }),
      source: 'user', actor: params.recordedBy, reason: params.reason?.trim() || null, requestId: null,
    }).run();
  });
  return db.select().from(fixedAssets).where(eq(fixedAssets.id, asset.id)).get()!;
}

/**
 * Move an asset to another fixed-asset account from a date: Dr the new
 * account / Cr the old, for its cost; and, where the accumulated depreciation
 * account changes too, its depreciation charged to that date likewise.
 */
export function transferFixedAsset(db: AppDatabase, params: {
  companyId: string; assetId: string; toAccountId: string; date: string; reason: string; recordedBy: string;
  toAccumulatedAccountId?: string | null; toCategory?: FixedAsset['assetCategory'] | null;
}): { asset: FixedAsset; journalEntryId: string } {
  return atomically(db, () => {
    const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
    if (!company) throw new DepreciationError(`Company ${params.companyId} not found.`);
    const asset = db.select().from(fixedAssets).where(and(eq(fixedAssets.id, params.assetId), eq(fixedAssets.companyId, params.companyId))).get();
    if (!asset) throw new DepreciationError(`Fixed asset ${params.assetId} not found.`);
    if (!params.reason.trim()) throw new DepreciationError('Give the reason for the transfer.');
    const date = requireDate(params.date, 'The transfer date');
    if (date < asset.purchaseDate) throw new DepreciationError('An asset cannot be transferred before it was bought.');
    if (asset.status === 'disposed' || (asset.disposalDate && asset.disposalDate <= date)) {
      throw new DepreciationError(`${asset.name} has been disposed of; it is no longer in any account.`);
    }
    const later = db.select({ d: fixedAssetTransfers.transferDate }).from(fixedAssetTransfers)
      .where(and(eq(fixedAssetTransfers.fixedAssetId, asset.id), sql`${fixedAssetTransfers.transferDate} > ${date}`)).get();
    if (later) throw new DepreciationError(`${asset.name} was already transferred on ${later.d}. Transfers are recorded in date order.`);
    const from = assetAccountOn(db, asset, date) ?? systemAccountId(db, params.companyId, 'computer_equipment');
    const to = requireCostAccount(db, params.companyId, params.toAccountId);
    if (to.id === from) throw new DepreciationError(`${asset.name} is already in ${to.code} ${to.name}.`);
    const fromAcc = accumulatedAccountOn(db, params.companyId, asset, date);
    let toAcc: string | null = null;
    if (params.toAccumulatedAccountId && params.toAccumulatedAccountId !== fromAcc) {
      const a = db.select().from(accounts)
        .where(and(eq(accounts.id, params.toAccumulatedAccountId), eq(accounts.companyId, params.companyId))).get();
      if (!a || !isAccumulatedAccount(a)) throw new DepreciationError('The new accumulated depreciation account is not one.');
      toAcc = a.id;
    }
    assertAccountingPeriodOpen(db, params.companyId, date);
    const depreciated = db.select({ n: sql<number>`coalesce(sum(${depreciationCharges.amountMinor}), 0)` }).from(depreciationCharges)
      .where(and(eq(depreciationCharges.fixedAssetId, asset.id), eq(depreciationCharges.chargeType, 'accounting_depreciation'),
        lte(depreciationCharges.periodEnd, date))).get()!.n;
    const lines = [
      { accountId: to.id, debitMinor: asset.baseCostMinor, memo: `${asset.name}: cost transferred in` },
      { accountId: from, creditMinor: asset.baseCostMinor, memo: `${asset.name}: cost transferred out` },
    ];
    if (toAcc && depreciated > 0) {
      lines.push(
        { accountId: fromAcc, debitMinor: depreciated, memo: `${asset.name}: depreciation transferred out` },
        { accountId: toAcc, creditMinor: depreciated, memo: `${asset.name}: depreciation transferred in` },
      );
    }
    const journal = postJournalEntry(db, {
      companyId: params.companyId, entryDate: date, narrative: `Fixed asset transfer — ${asset.name}: ${params.reason.trim()}`,
      sourceType: 'fixed_asset_transfer', sourceId: asset.id, baseCurrency: company.baseCurrency,
      createdBy: params.recordedBy, createdVia: 'user', lines,
    });
    db.insert(fixedAssetTransfers).values({
      id: ids.fixedAssetTransfer(), companyId: params.companyId, fixedAssetId: asset.id, transferDate: date,
      fromAccountId: from, toAccountId: to.id, fromAccumulatedAccountId: toAcc ? fromAcc : null, toAccumulatedAccountId: toAcc,
      fromCategory: asset.assetCategory, toCategory: params.toCategory ?? asset.assetCategory,
      journalEntryId: journal.id, reason: params.reason.trim(), recordedBy: params.recordedBy,
    }).run();
    db.update(fixedAssets).set({
      accountId: to.id, accumulatedDepreciationAccountId: toAcc ?? asset.accumulatedDepreciationAccountId,
      assetCategory: params.toCategory ?? asset.assetCategory, updatedAt: nowIso(),
    }).where(eq(fixedAssets.id, asset.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(), entityType: 'fixed_asset', entityId: asset.id,
      action: 'updated', field: 'account_id', previousValue: JSON.stringify({ accountId: from }),
      newValue: JSON.stringify({ accountId: to.id, date, journalEntryId: journal.id }),
      source: 'user', actor: params.recordedBy, reason: params.reason.trim(), requestId: null,
    }).run();
    return { asset: db.select().from(fixedAssets).where(eq(fixedAssets.id, asset.id)).get()!, journalEntryId: journal.id };
  });
}

export interface FixedAssetReconciliation {
  asOf: string;
  accounts: Array<{
    accountId: string; code: string; name: string; kind: 'cost' | 'accumulated_depreciation';
    ledgerMinor: number; registerMinor: number; differenceMinor: number;
  }>;
}

/**
 * Reconcile the register to the ledger (issue #534): each fixed-asset cost
 * account against the cost of the assets it held on the date, and each
 * accumulated depreciation account against the depreciation charged on the
 * assets still held. A difference is a review item; nothing is adjusted.
 */
export function reconcileFixedAssets(db: AppDatabase, params: { companyId: string; asOf: string }): FixedAssetReconciliation {
  const asOf = requireDate(params.asOf, 'The reconciliation date');
  const { companyId } = params;
  const fixed = db.select().from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.type, 'asset'), eq(accounts.subtype, 'fixed_asset'))).all();
  const held = db.select().from(fixedAssets).where(and(eq(fixedAssets.companyId, companyId), lte(fixedAssets.purchaseDate, asOf))).all()
    .filter((a) => !(a.disposalDate && a.disposalDate <= asOf));
  const charged = (asset: FixedAsset) => db.select({ n: sql<number>`coalesce(sum(${depreciationCharges.amountMinor}), 0)` })
    .from(depreciationCharges)
    .where(and(eq(depreciationCharges.fixedAssetId, asset.id), eq(depreciationCharges.chargeType, 'accounting_depreciation'),
      lte(depreciationCharges.periodEnd, asOf))).get()!.n;
  const rows: FixedAssetReconciliation['accounts'] = [];
  for (const account of fixed) {
    const ledger = accountBalance(db, { companyId, accountId: account.id, asOf });
    if (isAccumulatedAccount(account)) {
      // Accumulated depreciation is a credit: its natural balance on an asset account is negative.
      const register = held.filter((a) => accumulatedAccountOn(db, companyId, a, asOf) === account.id).reduce((s, a) => s + charged(a), 0);
      const ledgerCredit = -ledger;
      if (ledgerCredit === 0 && register === 0) continue;
      rows.push({ accountId: account.id, code: account.code, name: account.name, kind: 'accumulated_depreciation',
        ledgerMinor: ledgerCredit, registerMinor: register, differenceMinor: ledgerCredit - register });
    } else {
      const register = held.filter((a) => assetAccountOn(db, a, asOf) === account.id).reduce((s, a) => s + a.baseCostMinor, 0);
      if (ledger === 0 && register === 0) continue;
      rows.push({ accountId: account.id, code: account.code, name: account.name, kind: 'cost',
        ledgerMinor: ledger, registerMinor: register, differenceMinor: ledger - register });
    }
  }
  for (const r of rows.filter((x) => x.differenceMinor !== 0)) {
    upsertReviewItem(db, {
      companyId, kind: 'reconciliation_difference', severity: 'warning',
      title: `Fixed assets: ${r.code} ${r.name} differs from the register by ${eur(r.differenceMinor)}`,
      detail: r.kind === 'cost'
        ? `On ${asOf} the ledger holds ${eur(r.ledgerMinor)} of cost and the register ${eur(r.registerMinor)}. `
          + (r.differenceMinor > 0 ? 'Register the purchases posted to the account, or correct a posting that does not belong there.'
            : 'The register holds assets the ledger does not: check for a disposal or transfer not recorded.')
        : `On ${asOf} the ledger holds ${eur(r.ledgerMinor)} of accumulated depreciation and the register's charges come to `
          + `${eur(r.registerMinor)}. Find the entry posted outside the depreciation run.`,
      entityType: 'account', entityId: r.accountId, dedupeKey: `fixed_asset_reconciliation:${r.accountId}:${asOf}`,
      context: { ...r, asOf },
    });
  }
  return { asOf, accounts: rows };
}

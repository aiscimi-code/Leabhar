import { and, eq, gte, lte, sql, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  fixedAssets, suppliers, documents, vatPeriods, companies, bankTransactions,
  accounts, journalLines, journalEntries,
} from '@/db/schema';
import { profitAndLoss, balanceSheet } from './financial';
import { buildVat3Return } from '../vat/report';
import { accountBalance } from '../accounting/ledger';
import { systemAccountId } from '../config/setup';
import type { IsoDate } from '../dates';

/**
 * Year-end pack (README §33, §34).
 *
 * The objective is a clean package of evidence and figures an accountant can
 * understand without asking where anything came from.
 *
 * The corporation tax section is deliberately a *worksheet* and not a
 * calculation. README §33 requires that accounting profit and tax-adjusted
 * profit be clearly distinguished and that the final liability not be claimed
 * as correct; §48 forbids inventing Revenue requirements. So this computes the
 * adjustments it can compute from the books — depreciation added back, capital
 * allowances deducted — states each one's basis, and stops. It does not apply a
 * rate or produce a liability.
 */

export interface TaxAdjustment {
  label: string;
  amountMinor: number;
  explanation: string;
}

export interface TaxComputation {
  accountingProfitMinor: number;
  adjustments: TaxAdjustment[];
  taxAdjustedProfitMinor: number;
  disclaimer: string;
}

export interface YearEndIssue {
  severity: 'blocking' | 'warning';
  title: string;
  detail: string;
  href?: string;
}

export interface YearEndPack {
  companyId: string;
  companyName: string;
  from: IsoDate;
  to: IsoDate;
  currency: string;
  profitAndLoss: ReturnType<typeof profitAndLoss>;
  balanceSheet: ReturnType<typeof balanceSheet>;
  taxComputation: TaxComputation;
  fixedAssets: Array<{
    id: string; name: string; purchaseDate: string; supplierName: string | null;
    costMinor: number; accumulatedDepreciationMinor: number; netBookValueMinor: number;
    capitalAllowanceRateBasisPoints: number; capitalAllowanceYears: number;
  }>;
  directorsAccount: { balanceMinor: number; note: string };
  vatPeriods: Array<{
    periodId: string; name: string; status: string;
    t1Minor: number; t2Minor: number; netMinor: number;
  }>;
  documents: Array<{
    id: string; filename: string; supplierName: string | null;
    documentDate: string | null; grossMinor: number | null;
    sha256: string; matched: boolean;
  }>;
  issues: YearEndIssue[];
}

export function yearEndPack(
  db: AppDatabase,
  params: { companyId: string; from: IsoDate; to: IsoDate },
): YearEndPack {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);
  const currency = company.baseCurrency;

  const pl = profitAndLoss(db, { companyId: params.companyId, from: params.from, to: params.to });
  const bs = balanceSheet(db, {
    companyId: params.companyId, asOf: params.to, financialYearStart: params.from,
  });

  // ---- Fixed assets ----
  const assetRows = db.select({ asset: fixedAssets, supplierName: suppliers.name })
    .from(fixedAssets)
    .leftJoin(suppliers, eq(fixedAssets.supplierId, suppliers.id))
    .where(and(
      eq(fixedAssets.companyId, params.companyId),
      lte(fixedAssets.purchaseDate, params.to),
    ))
    .orderBy(fixedAssets.purchaseDate).all();

  const assets = assetRows.map(({ asset, supplierName }) => ({
    id: asset.id,
    name: asset.name,
    purchaseDate: asset.purchaseDate,
    supplierName,
    costMinor: asset.baseCostMinor,
    accumulatedDepreciationMinor: asset.accumulatedDepreciationMinor,
    netBookValueMinor: asset.baseCostMinor - asset.accumulatedDepreciationMinor,
    capitalAllowanceRateBasisPoints: asset.capitalAllowanceRateBasisPoints,
    capitalAllowanceYears: asset.capitalAllowanceYears,
  }));

  // ---- Tax computation worksheet ----
  const depreciationCharged = accountBalance(db, {
    companyId: params.companyId,
    accountId: systemAccountId(db, params.companyId, 'depreciation_expense'),
    from: params.from,
    asOf: params.to,
  });

  const capitalAllowances = assets.reduce((sum, asset) => {
    // Straight-line wear and tear, as configured per asset. A part-year is not
    // apportioned here because Irish wear-and-tear is not time-apportioned in
    // the first year, but the rate and period are the user's to set.
    if (asset.purchaseDate > params.to) return sum;
    const annual = Math.round(
      (asset.costMinor * asset.capitalAllowanceRateBasisPoints) / 10_000,
    );
    return sum + annual;
  }, 0);

  const adjustments: TaxAdjustment[] = [];

  if (depreciationCharged !== 0) {
    adjustments.push({
      label: 'Add back: depreciation charged in the accounts',
      amountMinor: depreciationCharged,
      explanation: 'Your own depreciation policy is not an allowable deduction for Irish '
        + 'corporation tax. It is added back here and replaced by capital allowances below.',
    });
  }

  if (capitalAllowances !== 0) {
    adjustments.push({
      label: 'Deduct: capital allowances (wear and tear)',
      amountMinor: -capitalAllowances,
      explanation: 'Calculated from each asset’s configured rate and period, currently '
        + 'straight line. The rates are configuration, not built into this application, and '
        + 'you should confirm them against current legislation. Balancing allowances and '
        + 'charges on disposals are NOT calculated here.',
    });
  }

  const taxAdjustedProfitMinor = pl.netProfit.valueMinor
    + adjustments.reduce((sum, a) => sum + a.amountMinor, 0);

  const taxComputation: TaxComputation = {
    accountingProfitMinor: pl.netProfit.valueMinor,
    adjustments,
    taxAdjustedProfitMinor,
    disclaimer:
      'This worksheet shows only the adjustments this application can derive from your '
      + 'books. It is not a corporation tax computation and no tax rate has been applied. '
      + 'Adjustments it does NOT make include: disallowable entertainment and other '
      + 'non-deductible expenditure, balancing allowances and charges on asset disposals, '
      + 'losses brought forward, the distinction between trading and non-trading income and '
      + 'their different rates, close company surcharges, and any reliefs or credits you may '
      + 'be entitled to. Give this worksheet to your accountant rather than treating the '
      + 'tax-adjusted profit as your taxable profit.',
  };

  // ---- Director's current account ----
  const directorsBalance = accountBalance(db, {
    companyId: params.companyId,
    accountId: systemAccountId(db, params.companyId, 'directors_current_account'),
    asOf: params.to,
  });

  const directorsNote = directorsBalance > 0
    ? 'The company owes this amount to its director or directors, typically from expenses '
      + 'paid personally on the company’s behalf. This is a liability on the balance sheet.'
    : directorsBalance < 0
      ? 'The director or directors owe this amount to the company. For a close company, a '
        + 'loan to a participator can give rise to an income tax charge and a '
        + 'benefit-in-kind issue on any interest-free element. This application flags the '
        + 'position but does not calculate any charge — raise it with your accountant.'
      : 'Nil balance.';

  // ---- VAT periods in the year ----
  const periods = db.select().from(vatPeriods)
    .where(and(
      eq(vatPeriods.companyId, params.companyId),
      gte(vatPeriods.startDate, params.from),
      lte(vatPeriods.endDate, params.to),
    )).orderBy(vatPeriods.startDate).all();

  const vatSummary = periods.map((period) => {
    const report = buildVat3Return(db, {
      companyId: params.companyId, vatPeriodId: period.id,
    });
    return {
      periodId: period.id,
      name: period.name,
      status: period.status,
      t1Minor: report.T1.amountMinor,
      t2Minor: report.T2.amountMinor,
      netMinor: report.netPositionMinor,
    };
  });

  // ---- Supporting document index ----
  const documentRows = db.select({ document: documents, supplierName: suppliers.name })
    .from(documents)
    .leftJoin(suppliers, eq(documents.supplierId, suppliers.id))
    .where(and(
      eq(documents.companyId, params.companyId),
      eq(documents.archived, false),
    ))
    .orderBy(documents.documentDate).all();

  const documentIndex = documentRows.map(({ document, supplierName }) => ({
    id: document.id,
    filename: document.originalFilename,
    supplierName,
    documentDate: document.documentDate,
    grossMinor: document.grossMinor,
    sha256: document.sha256,
    matched: document.matchedTransactionId !== null,
  }));

  // ---- Outstanding issues ----
  const issues: YearEndIssue[] = [];

  if (!bs.balances) {
    issues.push({
      severity: 'blocking',
      title: 'The balance sheet does not balance',
      detail: `Net assets and total equity differ by ${bs.differenceMinor} minor units. `
        + 'This is a defect in the underlying entries and must be found before the accounts '
        + 'can be relied on.',
      href: '/reports',
    });
  }

  const unclassified = db.select({ id: bankTransactions.id }).from(bankTransactions)
    .where(and(
      eq(bankTransactions.companyId, params.companyId),
      eq(bankTransactions.status, 'unclassified'),
      gte(bankTransactions.transactionDate, params.from),
      lte(bankTransactions.transactionDate, params.to),
    )).all();

  if (unclassified.length > 0) {
    issues.push({
      severity: 'blocking',
      title: `${unclassified.length} transaction${unclassified.length === 1 ? '' : 's'} still unclassified`,
      detail: 'These are excluded from every figure in this pack, so the profit and loss '
        + 'account and balance sheet are incomplete until they are dealt with.',
      href: '/transactions?status=unclassified',
    });
  }

  const suspenseBalance = accountBalance(db, {
    companyId: params.companyId,
    accountId: systemAccountId(db, params.companyId, 'suspense'),
    asOf: params.to,
  });

  if (suspenseBalance !== 0) {
    issues.push({
      severity: 'blocking',
      title: 'The suspense account has a balance',
      detail: 'Amounts in suspense have not been allocated to a real account. A non-zero '
        + 'balance at year end is an exception to resolve, not a result.',
      href: '/reports',
    });
  }

  const unmatchedDocuments = documentIndex.filter((d) => !d.matched).length;
  if (unmatchedDocuments > 0) {
    issues.push({
      severity: 'warning',
      title: `${unmatchedDocuments} document${unmatchedDocuments === 1 ? '' : 's'} not matched to a transaction`,
      detail: 'Either the payment has not been imported, it was paid personally, or the '
        + 'match has not been confirmed.',
      href: '/documents?status=unmatched',
    });
  }

  const openVatPeriods = vatSummary.filter((p) => p.status !== 'submitted').length;
  if (openVatPeriods > 0) {
    issues.push({
      severity: 'warning',
      title: `${openVatPeriods} VAT period${openVatPeriods === 1 ? '' : 's'} in this year not recorded as submitted`,
      detail: 'If those returns have been filed, record them so the figures as filed are '
        + 'snapshotted and any later change is visible.',
      href: '/vat',
    });
  }

  if (bs.retainedEarnings.notes.length > 0) {
    for (const note of bs.retainedEarnings.notes) {
      issues.push({ severity: 'warning', title: 'Reserves not closed off', detail: note });
    }
  }

  return {
    companyId: params.companyId,
    companyName: company.legalName,
    from: params.from,
    to: params.to,
    currency,
    profitAndLoss: pl,
    balanceSheet: bs,
    taxComputation,
    fixedAssets: assets,
    directorsAccount: { balanceMinor: directorsBalance, note: directorsNote },
    vatPeriods: vatSummary,
    documents: documentIndex,
    issues,
  };
}

import { and, eq, gte, lte } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  vatPeriods, companies, vatTreatments, documents, bankTransactions,
} from '@/db/schema';
import { buildVat3Return, drillIntoBox, type VatDrillRow, type Vat3Return } from './report';
import { validateVatPeriod, type PeriodValidation } from './periodClose';
import { reconcileBankAccount } from '../banking/reconciliation';
import { bankAccounts } from '@/db/schema';
import { asIsoDate, nowIso } from '../dates';

/**
 * VAT filing pack (README §25).
 *
 * A human-readable record of a VAT period: the figures, the transactions behind
 * them, the exceptions, the supporting documents and the reconciliation
 * position. The point is that someone — the user in six months, or their
 * accountant, or Revenue — can see not just what was filed but what it was
 * built from.
 *
 * It states the basis it was prepared on, because the same transactions produce
 * different periods under the two bases, and a pack that does not say which was
 * used cannot be checked.
 */

export interface FilingPackSection {
  box: string;
  label: string;
  amountMinor: number;
  rows: VatDrillRow[];
}

export interface FilingPack {
  companyId: string;
  companyName: string;
  vatNumber: string | null;
  vatBasis: 'invoice' | 'cash_receipts';
  basisNote: string;

  periodId: string;
  periodName: string;
  startDate: string;
  endDate: string;
  filingDeadline: string | null;
  status: string;
  currency: string;

  report: Vat3Return;
  validation: PeriodValidation;
  sections: FilingPackSection[];

  /** Every transaction with a VAT consequence in the period. */
  transactions: VatDrillRow[];
  documentsSupporting: Array<{
    id: string; filename: string; sha256: string;
    documentDate: string | null; grossMinor: number | null;
  }>;
  transactionsWithoutDocument: Array<{
    id: string; date: string; description: string; amountMinor: number;
  }>;

  reconciliation: Array<{
    bankAccountName: string;
    statementBalanceMinor: number;
    ledgerBalanceMinor: number;
    reconciled: boolean;
    summary: string;
  }>;

  preparedAt: string;
  disclaimer: string;
}

const DISCLAIMER =
  'This pack is prepared from the accounting records in this application. It is a '
  + 'preparation aid, not a filed return: this application does not submit anything to '
  + 'Revenue, and nothing here asserts that the figures are correct or that any filing '
  + 'obligation has been met. Review the figures and the supporting documents before filing.';

export function buildFilingPack(
  db: AppDatabase,
  params: { companyId: string; vatPeriodId: string },
): FilingPack {
  const company = db.select().from(companies)
    .where(eq(companies.id, params.companyId)).get();
  if (!company) throw new Error(`Company ${params.companyId} not found.`);

  const period = db.select().from(vatPeriods)
    .where(and(
      eq(vatPeriods.id, params.vatPeriodId),
      eq(vatPeriods.companyId, params.companyId),
    )).get();
  if (!period) throw new Error(`VAT period ${params.vatPeriodId} not found.`);

  const report = buildVat3Return(db, {
    companyId: params.companyId, vatPeriodId: params.vatPeriodId,
    baseCurrency: company.baseCurrency,
  });
  const validation = validateVatPeriod(db, {
    companyId: params.companyId, vatPeriodId: params.vatPeriodId,
  });

  const boxes = ['T1', 'T2', 'E1', 'E2', 'ES1', 'ES2', 'PA1'];
  const sections: FilingPackSection[] = boxes
    .map((box) => {
      const figure = (report as unknown as Record<string, { amountMinor: number; label: string }>)[box];
      return {
        box,
        label: figure?.label ?? box,
        amountMinor: figure?.amountMinor ?? 0,
        rows: drillIntoBox(db, {
          companyId: params.companyId, vatPeriodId: params.vatPeriodId, box,
        }),
      };
    })
    .filter((section) => section.rows.length > 0);

  // Every VAT-bearing transaction once, regardless of which box it fell into.
  const seen = new Set<string>();
  const transactions: VatDrillRow[] = [];
  for (const section of sections) {
    for (const row of section.rows) {
      if (seen.has(row.entryId)) continue;
      seen.add(row.entryId);
      transactions.push(row);
    }
  }
  transactions.sort((a, b) => a.taxPointDate.localeCompare(b.taxPointDate));

  // ---- Supporting documents ----
  const documentIds = [...new Set(transactions
    .map((row) => row.documentId)
    .filter((id): id is string => id !== null))];

  const documentsSupporting = documentIds.length === 0 ? [] : db.select({
    id: documents.id,
    filename: documents.originalFilename,
    sha256: documents.sha256,
    documentDate: documents.documentDate,
    grossMinor: documents.grossMinor,
  }).from(documents)
    .where(eq(documents.companyId, params.companyId)).all()
    .filter((document) => documentIds.includes(document.id));

  const transactionsWithoutDocument = transactions
    .filter((row) => row.bankTransactionId !== null && row.documentId === null)
    .map((row) => ({
      id: row.bankTransactionId!,
      date: row.taxPointDate,
      description: row.counterpartyName ?? 'Transaction',
      amountMinor: row.baseNetMinor + row.baseVatMinor,
    }));

  // ---- Reconciliation position at the period end ----
  const accounts = db.select().from(bankAccounts)
    .where(and(
      eq(bankAccounts.companyId, params.companyId),
      eq(bankAccounts.active, true),
    )).all();

  const reconciliation = accounts.map((account) => {
    const result = reconcileBankAccount(db, {
      companyId: params.companyId,
      bankAccountId: account.id,
      periodStart: asIsoDate(period.startDate),
      periodEnd: asIsoDate(period.endDate),
    });
    return {
      bankAccountName: result.bankAccountName,
      statementBalanceMinor: result.statementBalanceMinor,
      ledgerBalanceMinor: result.ledgerBalanceMinor,
      reconciled: result.reconciled,
      summary: result.summary,
    };
  });

  return {
    companyId: company.id,
    companyName: company.legalName,
    vatNumber: company.vatNumber,
    vatBasis: company.vatAccountingBasis,
    basisNote: company.vatAccountingBasis === 'cash_receipts'
      ? 'Prepared on the cash receipts basis: VAT on sales arises when payment is received, '
        + 'so a sale invoiced in an earlier period appears here if it was paid in this one. '
        + 'VAT on purchases is claimed by reference to the supplier’s invoice date.'
      : 'Prepared on the invoice basis: VAT on sales arises when the invoice is issued, '
        + 'whether or not it has been paid.',
    periodId: period.id,
    periodName: period.name,
    startDate: period.startDate,
    endDate: period.endDate,
    filingDeadline: period.filingDeadline,
    status: period.status,
    currency: company.baseCurrency,
    report,
    validation,
    sections,
    transactions,
    documentsSupporting,
    transactionsWithoutDocument,
    reconciliation,
    preparedAt: nowIso(),
    disclaimer: DISCLAIMER,
  };
}

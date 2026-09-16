import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { buildFilingPack } from '@/domain/vat/filingPack';
import type { VatDrillRow } from '@/domain/vat/report';
import {
  newWorkbook, addSheet, addCoverSheet, xlsxResponse, toCsv, csvResponse,
  amountFor, type ExportColumn,
} from '@/lib/exports';

export const dynamic = 'force-dynamic';

/** VAT filing pack as XLSX or CSV (README §25, §38). */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const format = new URL(request.url).searchParams.get('format') ?? 'xlsx';
  const company = requireCompany();
  const pack = buildFilingPack(getDb(), { companyId: company.id, vatPeriodId: id });
  const currency = pack.currency;
  const slug = pack.periodName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();

  /** A drill row plus the box it was reported in, which the row itself does not carry. */
  type RowWithBox = VatDrillRow & { vatBoxLabel: string };

  const transactionColumns: Array<ExportColumn<RowWithBox>> = [
    { header: 'Tax point', width: 12, value: (r) => r.taxPointDate },
    { header: 'Direction', width: 12, value: (r) => r.direction },
    { header: 'Counterparty', width: 30, value: (r) => r.counterpartyName ?? '' },
    { header: 'VAT treatment', width: 30, value: (r) => r.treatmentName },
    { header: 'Treatment code', width: 20, value: (r) => r.treatmentCode },
    { header: 'VAT box', width: 10, value: (r) => r.vatBoxLabel },
    { header: 'Rate', width: 10, value: (r) => `${r.rateBasisPoints / 100}%` },
    { header: `Net (${currency})`, width: 14, money: true,
      value: (r) => amountFor(r.baseNetMinor, currency) },
    { header: `VAT (${currency})`, width: 14, money: true,
      value: (r) => amountFor(r.baseVatMinor, currency) },
    { header: `Reclaimable (${currency})`, width: 16, money: true,
      value: (r) => amountFor(r.baseRecoverableVatMinor, currency) },
    { header: 'Reverse charge', width: 14, value: (r) => (r.isReverseChargeLeg ? 'Yes' : 'No') },
    { header: 'Has document', width: 14, value: (r) => (r.documentId ? 'Yes' : 'No') },
  ];

  // The box each row belongs to is not on the row itself, so attach it here.
  const rowsWithBox = pack.sections.flatMap((section) =>
    section.rows.map((row) => ({ ...row, vatBoxLabel: section.box })));

  if (format === 'csv') {
    return csvResponse(`vat-${slug}.csv`, toCsv(rowsWithBox, transactionColumns));
  }

  const workbook = newWorkbook();

  addCoverSheet(workbook, {
    title: `VAT filing pack — ${pack.periodName}`,
    companyName: pack.companyName,
    period: `${pack.startDate} to ${pack.endDate}`,
    currency,
    extra: [
      ['VAT number', pack.vatNumber ?? 'Not recorded'],
      ['Basis', pack.vatBasis === 'cash_receipts' ? 'Cash receipts basis' : 'Invoice basis'],
      ['Filing deadline', pack.filingDeadline ?? 'Not configured'],
      ['Period status', pack.status],
      ['Internal checks', pack.validation.verdict],
    ],
    caveat: `${pack.basisNote}\n\n${pack.disclaimer}`,
  });

  addSheet(workbook, {
    name: 'VAT3 summary',
    preamble: [[`VAT3 summary — ${pack.periodName}`]],
    columns: [
      { header: 'Box', width: 10, value: (r: { box: string }) => r.box },
      { header: 'Description', width: 46,
        value: (r: { label: string }) => (r as { label: string }).label },
      { header: 'Entries', width: 10,
        value: (r: { entryCount: number }) => r.entryCount },
      { header: `Amount (${currency})`, width: 18, money: true,
        value: (r: { amountMinor: number }) => amountFor(r.amountMinor, currency) },
    ],
    rows: [
      pack.report.T1, pack.report.T2, pack.report.T3, pack.report.T4,
      pack.report.E1, pack.report.E2, pack.report.ES1, pack.report.ES2, pack.report.PA1,
    ],
    footer: [
      [],
      ['Net position', pack.report.netPositionMinor >= 0 ? 'Payable' : 'Repayable',
        '', amountFor(Math.abs(pack.report.netPositionMinor), currency)],
    ],
  });

  addSheet(workbook, {
    name: 'Transactions',
    preamble: [[`Every VAT entry in ${pack.periodName}`]],
    columns: transactionColumns,
    rows: rowsWithBox,
  });

  addSheet(workbook, {
    name: 'Exceptions',
    preamble: [[pack.validation.verdict], [pack.validation.summary]],
    columns: [
      { header: 'Severity', width: 12, value: (f: { severity: string }) => f.severity },
      { header: 'Issue', width: 46, value: (f: { title: string }) => f.title },
      { header: 'Detail', width: 80, value: (f: { detail: string }) => f.detail },
    ],
    rows: pack.validation.findings,
    footer: [[], [pack.validation.disclaimer]],
  });

  addSheet(workbook, {
    name: 'Documents',
    preamble: [['Supporting documents, with the hash recorded when each was stored']],
    columns: [
      { header: 'File', width: 40, value: (d: { filename: string }) => d.filename },
      { header: 'Date', width: 14, value: (d: { documentDate: string | null }) => d.documentDate ?? '' },
      { header: `Total (${currency})`, width: 16, money: true,
        value: (d: { grossMinor: number | null }) => amountFor(d.grossMinor, currency) },
      { header: 'SHA-256', width: 68, value: (d: { sha256: string }) => d.sha256 },
    ],
    rows: pack.documentsSupporting,
  });

  if (pack.transactionsWithoutDocument.length > 0) {
    addSheet(workbook, {
      name: 'Missing documents',
      preamble: [['Transactions with VAT but no supporting invoice or receipt']],
      columns: [
        { header: 'Date', width: 14, value: (t: { date: string }) => t.date },
        { header: 'Description', width: 46, value: (t: { description: string }) => t.description },
        { header: `Amount (${currency})`, width: 16, money: true,
          value: (t: { amountMinor: number }) => amountFor(t.amountMinor, currency) },
      ],
      rows: pack.transactionsWithoutDocument,
      footer: [[], ['VAT reclaimed without a supporting invoice can be disallowed on audit.']],
    });
  }

  addSheet(workbook, {
    name: 'Reconciliation',
    preamble: [['Bank reconciliation at the period end']],
    columns: [
      { header: 'Account', width: 34, value: (r: { bankAccountName: string }) => r.bankAccountName },
      { header: `Per statement (${currency})`, width: 20, money: true,
        value: (r: { statementBalanceMinor: number }) => amountFor(r.statementBalanceMinor, currency) },
      { header: `Per books (${currency})`, width: 20, money: true,
        value: (r: { ledgerBalanceMinor: number }) => amountFor(r.ledgerBalanceMinor, currency) },
      { header: 'Reconciled', width: 12, value: (r: { reconciled: boolean }) => (r.reconciled ? 'Yes' : 'No') },
      { header: 'Notes', width: 80, value: (r: { summary: string }) => r.summary },
    ],
    rows: pack.reconciliation,
  });

  return xlsxResponse(workbook, `vat-${slug}.xlsx`);
}

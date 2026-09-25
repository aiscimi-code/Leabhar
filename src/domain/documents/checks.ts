/**
 * The arithmetic and completeness checks run on a document before a person can
 * confirm it. Pure — no database, no Node APIs — so the review screen runs the
 * same checks live in the browser that the server runs at confirmation.
 */
import type { documents } from '@/db/schema';
import { isIsoDate } from '../dates';
import { vatFromNet, sum } from '../money';

export type DocumentType = typeof documents.$inferInsert['documentType'];

export interface ReviewedLine {
  description: string;
  quantity: string | null;
  unitPriceMinor: number | null;
  netMinor: number | null;
  vatRateBasisPoints: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
}

export interface ReviewedVatTotal {
  rateBasisPoints: number | null;
  label: string | null;
  netMinor: number | null;
  vatMinor: number | null;
}

/** Everything a person confirms about a document. Amounts are integer minor units, as printed. */
export interface ReviewedDocumentValues {
  documentType: NonNullable<DocumentType>;
  invoiceNumber: string | null;
  documentDate: string | null;
  dueDate: string | null;
  supplyDate: string | null;
  currency: string | null;
  supplierNameStated: string | null;
  supplierAddress: string | null;
  supplierVatNumber: string | null;
  supplierCountry: string | null;
  customerNameStated: string | null;
  customerAddress: string | null;
  customerVatNumber: string | null;
  customerCountry: string | null;
  vatLegends: string[];
  paymentTerms: string | null;
  originalDocumentNumber: string | null;
  netMinor: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
  lines: ReviewedLine[];
  vatTotals: ReviewedVatTotal[];
}

export interface DocumentCheck {
  /** Stable code, so an acknowledgement refers to one specific check. */
  code: string;
  /** An error blocks confirmation; a warning must be acknowledged. */
  severity: 'error' | 'warning';
  message: string;
}

/**
 * A computed VAT figure may differ from the printed one by rounding. Invoices
 * round per line or per total, so a difference of one minor unit per line (or
 * per rate band) is rounding, not an error.
 */
const ROUNDING_TOLERANCE_PER_ITEM = 1;

const withinRounding = (a: number, b: number, items: number): boolean =>
  Math.abs(a - b) <= ROUNDING_TOLERANCE_PER_ITEM * Math.max(1, items);

const fmt = (minor: number): string => (minor / 100).toFixed(2);

/** Types that are evidence of a supply, and so must carry a date and a total. */
const SUPPLY_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  'supplier_invoice', 'sales_invoice', 'receipt', 'credit_note', 'sales_record',
]);

/**
 * Check the values a person is about to confirm. Pure — no database — so the
 * review screen can show the same checks live as the person edits.
 */
export function checkDocumentValues(values: ReviewedDocumentValues): DocumentCheck[] {
  const checks: DocumentCheck[] = [];
  const isEvidence = SUPPLY_EVIDENCE_TYPES.has(values.documentType);

  if (isEvidence) {
    if (!values.documentDate) {
      checks.push({ code: 'missing_date', severity: 'error', message: 'The document date is missing.' });
    }
    if (values.grossMinor === null) {
      checks.push({ code: 'missing_total', severity: 'error', message: 'The document total is missing.' });
    }
    if (!values.currency) {
      checks.push({ code: 'missing_currency', severity: 'error', message: 'The currency is missing.' });
    }
    // The counterparty is the customer on a sale and the supplier on a purchase.
    if (values.documentType === 'sales_invoice' || values.documentType === 'sales_record') {
      if (!values.customerNameStated) {
        checks.push({ code: 'missing_party', severity: 'error', message: 'The customer is not named.' });
      }
    } else if (values.documentType === 'credit_note') {
      if (!values.supplierNameStated && !values.customerNameStated) {
        checks.push({
          code: 'missing_party', severity: 'error',
          message: 'Neither the supplier nor the customer is named.',
        });
      }
    } else if (!values.supplierNameStated) {
      checks.push({ code: 'missing_party', severity: 'error', message: 'The supplier is not named.' });
    }
    if (values.lines.length === 0) {
      checks.push({
        code: 'no_lines', severity: 'warning',
        message: 'No lines were entered. Without lines, VAT can only be taken from the document\'s totals.',
      });
    }
  }
  for (const [field, value] of [
    ['documentDate', values.documentDate], ['dueDate', values.dueDate], ['supplyDate', values.supplyDate],
  ] as const) {
    if (value && !isIsoDate(value)) {
      checks.push({ code: `invalid_${field}`, severity: 'error', message: `${field} "${value}" is not a valid date (YYYY-MM-DD).` });
    }
  }
  if (values.documentType === 'credit_note' && !values.originalDocumentNumber) {
    checks.push({
      code: 'credit_note_without_original', severity: 'warning',
      message: 'This credit note does not state which invoice it credits.',
    });
  }

  // net + VAT = gross
  if (values.netMinor !== null && values.vatMinor !== null && values.grossMinor !== null
      && values.netMinor + values.vatMinor !== values.grossMinor) {
    checks.push({
      code: 'header_net_vat_gross', severity: 'warning',
      message: `Net ${fmt(values.netMinor)} + VAT ${fmt(values.vatMinor)} = ${fmt(values.netMinor + values.vatMinor)}, `
        + `but the total is ${fmt(values.grossMinor)}.`,
    });
  }

  // Each line: net × rate ≈ VAT, and net + VAT = gross.
  values.lines.forEach((line, i) => {
    const n = i + 1;
    if (!line.description.trim()) {
      checks.push({ code: `line_${n}_description`, severity: 'error', message: `Line ${n} has no description.` });
    }
    if (line.netMinor !== null && line.vatRateBasisPoints !== null && line.vatMinor !== null) {
      const expected = vatFromNet(line.netMinor, line.vatRateBasisPoints);
      if (!withinRounding(expected, line.vatMinor, 1)) {
        checks.push({
          code: `line_${n}_vat`, severity: 'warning',
          message: `Line ${n}: ${line.vatRateBasisPoints / 100}% of ${fmt(line.netMinor)} is ${fmt(expected)}, `
            + `but the VAT shown is ${fmt(line.vatMinor)}.`,
        });
      }
    }
    if (line.netMinor !== null && line.vatMinor !== null && line.grossMinor !== null
        && line.netMinor + line.vatMinor !== line.grossMinor) {
      checks.push({
        code: `line_${n}_gross`, severity: 'warning',
        message: `Line ${n}: net + VAT does not equal the line total.`,
      });
    }
  });

  // Lines sum to the header.
  const lineNets = values.lines.map((l) => l.netMinor).filter((v): v is number => v !== null);
  if (values.netMinor !== null && lineNets.length === values.lines.length && values.lines.length > 0) {
    const total = sum(lineNets);
    if (total !== values.netMinor) {
      checks.push({
        code: 'lines_net_sum', severity: 'warning',
        message: `The lines' net amounts add up to ${fmt(total)}, but the document's net is ${fmt(values.netMinor)}.`,
      });
    }
  }
  const lineVats = values.lines.map((l) => l.vatMinor).filter((v): v is number => v !== null);
  if (values.vatMinor !== null && lineVats.length === values.lines.length && values.lines.length > 0) {
    const total = sum(lineVats);
    if (!withinRounding(total, values.vatMinor, values.lines.length)) {
      checks.push({
        code: 'lines_vat_sum', severity: 'warning',
        message: `The lines' VAT adds up to ${fmt(total)}, but the document's VAT is ${fmt(values.vatMinor)}.`,
      });
    }
  }

  // Per-rate totals: net × rate ≈ VAT, and they sum to the header.
  values.vatTotals.forEach((band, i) => {
    if (band.netMinor !== null && band.rateBasisPoints !== null && band.vatMinor !== null) {
      const expected = vatFromNet(band.netMinor, band.rateBasisPoints);
      if (!withinRounding(expected, band.vatMinor, values.lines.filter((l) => l.vatRateBasisPoints === band.rateBasisPoints).length)) {
        checks.push({
          code: `vat_total_${i + 1}_rate`, severity: 'warning',
          message: `VAT total ${band.label ?? `${band.rateBasisPoints / 100}%`}: ${band.rateBasisPoints / 100}% of `
            + `${fmt(band.netMinor)} is ${fmt(expected)}, but ${fmt(band.vatMinor)} is shown.`,
        });
      }
    }
  });
  if (values.vatTotals.length > 0) {
    const bandVat = values.vatTotals.map((b) => b.vatMinor);
    if (values.vatMinor !== null && bandVat.every((v): v is number => v !== null)
        && sum(bandVat) !== values.vatMinor) {
      checks.push({
        code: 'vat_totals_sum', severity: 'warning',
        message: `The VAT totals per rate add up to ${fmt(sum(bandVat))}, but the document's VAT is ${fmt(values.vatMinor)}.`,
      });
    }
    const bandNet = values.vatTotals.map((b) => b.netMinor);
    if (values.netMinor !== null && bandNet.every((v): v is number => v !== null)
        && sum(bandNet) !== values.netMinor) {
      checks.push({
        code: 'vat_totals_net_sum', severity: 'warning',
        message: `The net amounts per rate add up to ${fmt(sum(bandNet))}, but the document's net is ${fmt(values.netMinor)}.`,
      });
    }
  }

  return checks;
}

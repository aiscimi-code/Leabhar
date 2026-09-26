import { and, eq, gte, lte, notInArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { vatEntries, vatTreatments, invoiceLines, invoices, accounts, vatPeriods, companies } from '@/db/schema';
import { multiplyRational } from '../money';
import { accountingYearContaining } from './apportionment';

/**
 * The VAT Return of Trading Details (issue #210): the annual return, due with
 * the year's final VAT3, of net values by Irish VAT rate (VATCA s.76; S.I.
 * 639/2010 reg.24(1)). The layout and every box code follow Revenue's Tax and
 * Duty Manual "VAT Return of Trading Details" (February 2026), kept at
 * docs/statutes/vat3-rtd/VAT-RTD-S76.md; §2.6 gives the grid.
 *
 * It is built from the VAT entries, the same records behind the year's VAT3s,
 * so the two agree. Where the placement of an entry is a judgement (for resale
 * or not; a rate the grid has no row for) the report says so as a finding
 * rather than deciding silently.
 */

export const RTD_GUIDANCE_PATH = 'docs/statutes/vat3-rtd/VAT-RTD-S76.md';

export type RtdRow = 'exempt' | 'zero_exports' | 'zero' | 'livestock' | 'second_reduced' | 'reduced' | 'standard' | 'flat_rate';
export type RtdSection = 'supplies' | 'acquisitions' | 'resale' | 'otherDeductible';

/** Manual §2.6, "Traditional presentation of VAT RTD". */
export const RTD_BOXES: Record<RtdSection, Partial<Record<RtdRow | 'total' | 'postponed', string>>> = {
  supplies: { exempt: 'E3', zero_exports: 'D4', zero: 'D1', livestock: 'C5', second_reduced: 'BC5', reduced: 'AC5', standard: 'P1', flat_rate: 'B5', total: 'Z1' },
  acquisitions: { exempt: 'E4', zero: 'D2', livestock: 'C6', second_reduced: 'BC6', reduced: 'AC6', standard: 'P2', flat_rate: 'B6', total: 'Z2', postponed: 'PA2' },
  resale: { exempt: 'E5', zero: 'J1', livestock: 'H5', second_reduced: 'BH5', reduced: 'AH5', standard: 'R1', flat_rate: 'G5', total: 'Z3', postponed: 'PA3' },
  otherDeductible: { exempt: 'E6', zero: 'J2', livestock: 'H6', second_reduced: 'BH6', reduced: 'AH6', standard: 'R2', flat_rate: 'G6', total: 'Z5', postponed: 'PA4' },
};

/**
 * The row for a rate. Manual §4 Q2: a change in a rate (21% to 23%) stays on
 * the same row, so the historic standard rate maps to the standard row.
 */
const RATE_ROWS: Record<number, RtdRow> = { 0: 'zero', 480: 'livestock', 900: 'second_reduced', 1350: 'reduced', 2100: 'standard', 2300: 'standard' };

/** Received services the recipient self-accounts for, which the manual puts in section 1 too (§2.2(e); §4 Q4, Q5). */
const SELF_ACCOUNTED_IN_SUPPLIES = new Set(['NON_EU_SERVICES_RCV', 'RC_CONSTRUCTION']);
/** The E2, ES2 and PA1 transactions (§2.3). */
const ACQUISITIONS = new Set(['EU_GOODS_ACQ', 'EU_SERVICES_RCV', 'IMPORT_PA']);
const EXPORTS = new Set(['EU_GOODS_SUPPLY', 'EU_SERVICES_SUPPLY', 'NON_EU_SERVICES_SUPPLY']);

export interface RtdFinding { code: string; message: string; entryIds?: string[] }

export interface RtdReturn {
  companyId: string;
  yearStart: string;
  yearEnd: string;
  /** The 23rd of the month after the year ends (manual §1). */
  dueDate: string;
  /** Net values in base-currency minor units, keyed by Revenue's box code. */
  boxes: Record<string, number>;
  findings: RtdFinding[];
  guidancePath: string;
}

const eur = (minor: number) => (minor / 100).toFixed(2);

export function buildRtdReturn(db: AppDatabase, params: { companyId: string; date: string }): RtdReturn {
  const { start, end } = accountingYearContaining(db, params.companyId, params.date);
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const rows = db.select({ e: vatEntries, code: vatTreatments.code, appliesRate: vatTreatments.appliesRate })
    .from(vatEntries)
    .innerJoin(vatTreatments, eq(vatEntries.vatTreatmentId, vatTreatments.id))
    .where(and(eq(vatEntries.companyId, params.companyId), gte(vatEntries.taxPointDate, start), lte(vatEntries.taxPointDate, end)))
    .all();

  const boxes: Record<string, number> = {};
  for (const section of Object.values(RTD_BOXES)) for (const box of Object.values(section)) boxes[box!] = 0;
  const add = (section: RtdSection, row: RtdRow, amount: number, postponed: boolean) => {
    const box = RTD_BOXES[section][row]!;
    boxes[box] = (boxes[box] ?? 0) + amount;
    boxes[RTD_BOXES[section].total!] = (boxes[RTD_BOXES[section].total!] ?? 0) + amount;
    const pa = RTD_BOXES[section].postponed;
    if (postponed && pa) boxes[pa] = (boxes[pa] ?? 0) + amount;
  };

  const findings: RtdFinding[] = [];
  const unmapped: string[] = [];
  const adjustments: string[] = [];
  const noAccount: string[] = [];
  const nonEuServices: string[] = [];
  const restricted: string[] = [];
  let resaleCount = 0;

  const rowFor = (code: string, appliesRate: boolean, rate: number): RtdRow | null =>
    code === 'IE_EXEMPT' || !appliesRate ? 'exempt' : RATE_ROWS[rate] ?? null;

  for (const { e, code, appliesRate } of rows) {
    if (code === 'OUT_OF_SCOPE') continue;
    // Manual §4 Q3: capital goods scheme adjustments are left out. Other
    // adjustments are not transactions with a trading value either.
    if (e.sourceType === 'manual_adjustment') { adjustments.push(e.id); continue; }
    // A reverse charge's output leg mirrors its input leg; the input leg places both.
    if (e.isReverseChargeLeg && e.direction === 'sales') continue;
    const row = rowFor(code, appliesRate, e.rateBasisPoints);
    const net = e.baseNetMinor;

    if (e.direction === 'sales') {
      if (EXPORTS.has(code)) {
        add('supplies', 'zero_exports', net, false);
        if (code === 'NON_EU_SERVICES_SUPPLY') nonEuServices.push(e.id);
      } else if (row) add('supplies', row, net, false);
      else unmapped.push(e.id);
      continue;
    }

    if (!row) { unmapped.push(e.id); continue; }
    const postponed = code === 'IMPORT_PA';
    if (SELF_ACCOUNTED_IN_SUPPLIES.has(code)) add('supplies', row, net, false);
    if (ACQUISITIONS.has(code)) add('acquisitions', row, net, postponed);

    // Sections 3 and 4 hold deductible inputs; section 4 "is subject to the
    // deductibility rate of the filer" (§4 Q1), so a restricted recovery
    // counts its deductible share.
    let deductibleNet = net;
    if (e.baseVatMinor !== 0) {
      if (e.baseRecoverableVatMinor === 0) continue;
      if (e.baseRecoverableVatMinor !== e.baseVatMinor) {
        deductibleNet = multiplyRational(net, e.baseRecoverableVatMinor, e.baseVatMinor);
        restricted.push(e.id);
      }
    }
    const subtype = e.invoiceLineId
      ? db.select({ subtype: accounts.subtype }).from(invoiceLines)
        .innerJoin(accounts, eq(invoiceLines.accountId, accounts.id))
        .where(eq(invoiceLines.id, e.invoiceLineId)).get()?.subtype
      : undefined;
    if (subtype === undefined) noAccount.push(e.id);
    const resale = subtype === 'cost_of_sales';
    if (resale) resaleCount += 1;
    add(resale ? 'resale' : 'otherDeductible', row, deductibleNet, postponed);
  }

  // Exempt lines raise no VAT entry, so they are read from the invoices
  // themselves, dated as their VAT would have been (supply date, else invoice date).
  const exemptLines = db.select({ line: invoiceLines, inv: invoices, subtype: accounts.subtype })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .innerJoin(vatTreatments, eq(invoiceLines.vatTreatmentId, vatTreatments.id))
    .leftJoin(accounts, eq(invoiceLines.accountId, accounts.id))
    .where(and(
      eq(invoices.companyId, params.companyId), eq(vatTreatments.code, 'IE_EXEMPT'),
      notInArray(invoices.status, ['draft', 'void']),
      gte(sql`coalesce(${invoices.supplyDate}, ${invoices.invoiceDate})`, start),
      lte(sql`coalesce(${invoices.supplyDate}, ${invoices.invoiceDate})`, end),
    )).all();
  for (const { line, inv, subtype } of exemptLines) {
    const net = inv.netMinor ? multiplyRational(line.netMinor, inv.baseNetMinor, inv.netMinor) : line.netMinor;
    if (inv.direction === 'sales') { add('supplies', 'exempt', net, false); continue; }
    const resale = subtype === 'cost_of_sales';
    if (resale) resaleCount += 1;
    add(resale ? 'resale' : 'otherDeductible', 'exempt', net, false);
  }

  if (resaleCount) {
    findings.push({
      code: 'rtd_resale_by_account',
      message: `${resaleCount} purchase line(s) are in section 3 (for resale) because they were posted to a cost-of-sales `
        + 'account; the rest are in section 4. Revenue asks for goods or services "bought for resale to customers" (manual '
        + '§2.4). Check the split before filing.',
    });
  }
  if (noAccount.length) {
    findings.push({
      code: 'rtd_purchase_without_invoice_line', entryIds: noAccount,
      message: `${noAccount.length} purchase VAT entr(ies) did not come from an invoice line, so whether they were for resale `
        + 'is unknown; they are in section 4 (other deductible). Check them.',
    });
  }
  if (unmapped.length) {
    findings.push({
      code: 'rtd_rate_not_on_grid', entryIds: unmapped,
      message: `${unmapped.length} VAT entr(ies) carry a rate the RTD grid has no row for (for example a flat-rate addition), `
        + 'and are not included. Enter them by hand on the row Revenue gives for that rate.',
    });
  }
  if (adjustments.length) {
    findings.push({
      code: 'rtd_adjustments_excluded', entryIds: adjustments,
      message: `${adjustments.length} VAT adjustment entr(ies) are left out: capital goods scheme adjustments are not included `
        + 'on the RTD (manual §4 Q3), so the RTD will not reconcile to the VAT3s by that much. Check any other adjustment '
        + 'is not a trading transaction that belongs on the return.',
    });
  }
  if (nonEuServices.length) {
    findings.push({
      code: 'rtd_non_eu_services_in_d4', entryIds: nonEuServices,
      message: `${nonEuServices.length} sale(s) of services to customers outside the EU are in D4 ("export of goods/services at `
        + '0% outside the EU"). Where the place of supply puts a service outside the scope of Irish VAT altogether, '
        + 'confirm with your accountant whether it belongs on the RTD.',
    });
  }
  if (restricted.length) {
    findings.push({
      code: 'rtd_restricted_recovery_scaled', entryIds: restricted,
      message: `${restricted.length} purchase(s) with part of the VAT recoverable are counted at the deductible share of their `
        + 'net value (manual §4 Q1).',
    });
  }
  for (const [box, value] of Object.entries(boxes)) {
    if (value < 0) {
      findings.push({
        code: 'rtd_negative_box',
        message: `Box ${box} totals ${eur(value)}. The RTD cannot take a negative figure (manual §2.1): credit notes exceed `
          + 'the supplies in that box. Decide what to enter with your accountant.',
      });
    }
  }
  const periods = db.select().from(vatPeriods)
    .where(and(eq(vatPeriods.companyId, params.companyId), lte(vatPeriods.startDate, end), gte(vatPeriods.endDate, start))).all();
  if (!periods.some((p) => p.endDate === end)) {
    findings.push({
      code: 'rtd_year_end_inside_vat_period',
      message: `The accounting year ends on ${end}, inside a VAT period. The RTD is filed with the year-end VAT3 and the VAT `
        + 'year end may differ from the financial year end (manual §2.1): confirm the RTD year with Revenue\'s record.',
    });
  }
  const open = periods.filter((p) => p.status !== 'submitted');
  if (open.length) {
    findings.push({
      code: 'rtd_returns_not_filed',
      message: `${open.map((p) => p.name).join(', ')} not yet submitted. The RTD is completed after all the year's VAT returns `
        + 'are finalised (manual §2.6), so these figures can still change.',
    });
  }
  if (company.vatAccountingBasis === 'cash_receipts') {
    findings.push({
      code: 'rtd_cash_basis_sales',
      message: 'Sales are counted as they were declared on the VAT3s, on the cash receipts basis (when paid). Revenue asks '
        + 'for net amounts "as per the purchase and sales invoices" (manual §2.1): confirm which your accountant files.',
    });
  }

  const [y, m] = end.split('-').map(Number) as [number, number];
  const due = m === 12 ? `${y + 1}-01-23` : `${y}-${String(m + 1).padStart(2, '0')}-23`;
  return { companyId: params.companyId, yearStart: start, yearEnd: end, dueDate: due, boxes, findings, guidancePath: RTD_GUIDANCE_PATH };
}

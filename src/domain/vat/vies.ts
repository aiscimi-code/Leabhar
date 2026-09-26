import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { invoices, invoiceLines, vatTreatments, customers } from '@/db/schema';
import { multiplyRational } from '../money';
import { invoiceIssueDeadline } from '../consolidation/creditNotes';

/**
 * The VIES statement (issue #210): intra-Community supplies of goods and
 * services, one line per customer VAT number and flag, per month or quarter
 * (VATCA s.82). The rules followed are Revenue's "VIES Traders Manual",
 * kept at docs/statutes/vies/vies-traders-manual.md:
 *
 * - §3.4: a supply belongs to the period in which VAT on it becomes
 *   chargeable, the date the invoice is issued or the 15th of the month after
 *   the supply, whichever is sooner. That holds on either VAT basis, so this
 *   reads invoices, not the (cash-dated) VAT entries.
 * - §3.6 and column 11: one aggregate value per customer, rounded to the euro.
 * - Column 12: "S" for services; "T" (triangulation) is not recorded here.
 * - §4.9: credit notes net against the supplies, and may go negative.
 * - §3.5: monthly statements where goods exceed €50,000 in a quarter; a
 *   "Nil" statement where there were no supplies.
 */

export const VIES_GUIDANCE_PATH = 'docs/statutes/vies/vies-traders-manual.md';
export const VIES_MONTHLY_GOODS_THRESHOLD_MINOR = 5_000_000;

export interface ViesLine {
  item: number;
  customerVatNumber: string | null;
  customerName: string;
  /** Minor units, netted, unrounded. */
  valueMinor: number;
  /** Rounded to the nearest euro, as the statement takes it. */
  valueEuro: number;
  flag: '' | 'S';
  invoiceIds: string[];
}

export interface ViesFinding { code: string; message: string }

export interface ViesStatement {
  companyId: string;
  frequency: 'M' | 'Q';
  /** YYMM of the period's last month, as the form's box 6. */
  periodCode: string;
  startDate: string;
  endDate: string;
  lines: ViesLine[];
  totalEuro: number;
  nil: boolean;
  /** The 23rd of the month after the period (manual §3.5). */
  dueDate: string;
  findings: ViesFinding[];
  guidancePath: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Round to the nearest euro, half away from zero. */
const toEuro = (minor: number) => Math.sign(minor) * Math.floor((Math.abs(minor) + 50) / 100);

/** When VAT on an intra-Community supply becomes chargeable (manual §3.4). */
export function viesChargeableDate(invoiceDate: string, supplyDate: string | null): string {
  if (!supplyDate) return invoiceDate;
  const fifteenth = invoiceIssueDeadline(supplyDate);
  return invoiceDate < fifteenth ? invoiceDate : fifteenth;
}

export function buildViesStatement(db: AppDatabase, params: {
  companyId: string; frequency: 'M' | 'Q'; year: number; month: number;
}): ViesStatement {
  const { year, month, frequency } = params;
  if (frequency === 'Q' && month % 3 !== 0) throw new Error('A quarterly VIES period ends in March, June, September or December.');
  const firstMonth = frequency === 'Q' ? month - 2 : month;
  const startDate = `${year}-${pad(firstMonth)}-01`;
  const endDate = `${year}-${pad(month)}-${pad(lastDay(year, month))}`;

  const rows = db.select({ inv: invoices, line: invoiceLines, code: vatTreatments.code })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id))
    .innerJoin(vatTreatments, eq(invoiceLines.vatTreatmentId, vatTreatments.id))
    .where(and(
      eq(invoices.companyId, params.companyId), eq(invoices.direction, 'sales'),
      notInArray(invoices.status, ['draft', 'void']),
      inArray(vatTreatments.code, ['EU_GOODS_SUPPLY', 'EU_SERVICES_SUPPLY']),
    )).all()
    .filter((r) => {
      const d = viesChargeableDate(r.inv.invoiceDate, r.inv.supplyDate);
      return d >= startDate && d <= endDate;
    });

  const findings: ViesFinding[] = [];
  const grouped = new Map<string, Omit<ViesLine, 'item' | 'valueEuro'>>();
  let goodsMinor = 0;
  for (const { inv, line, code } of rows) {
    const customer = inv.customerId
      ? db.select().from(customers).where(eq(customers.id, inv.customerId)).get()
      : undefined;
    const vat = customer?.vatNumber?.replace(/\s+/g, '').toUpperCase() || null;
    const flag = code === 'EU_SERVICES_SUPPLY' ? 'S' : '';
    // The line's share of the invoice in base currency; signed, so a credit note nets off.
    const value = inv.netMinor ? multiplyRational(line.netMinor, inv.baseNetMinor, inv.netMinor) : line.netMinor;
    if (!flag) goodsMinor += value;
    const key = `${vat ?? `no-vat:${inv.customerId}`}|${flag}`;
    const g = grouped.get(key) ?? { customerVatNumber: vat, customerName: customer?.name ?? 'Unknown customer', valueMinor: 0, flag, invoiceIds: [] };
    g.valueMinor += value;
    if (!g.invoiceIds.includes(inv.id)) g.invoiceIds.push(inv.id);
    grouped.set(key, g);
  }

  const lines: ViesLine[] = [...grouped.values()]
    .sort((a, b) => (a.customerVatNumber ?? '').localeCompare(b.customerVatNumber ?? '') || a.flag.localeCompare(b.flag))
    .map((g, i) => ({ ...g, item: i + 1, valueEuro: toEuro(g.valueMinor) }));

  for (const l of lines) {
    if (!l.customerVatNumber) {
      findings.push({
        code: 'vies_customer_vat_number_missing',
        message: `${l.customerName} has no VAT number on record. An intra-Community supply is zero-rated only to a customer `
          + 'registered in another Member State, and the statement needs their number (column 10); get it and check it on VIES.',
      });
    } else if (!/^[A-Z]{2}/.test(l.customerVatNumber) || l.customerVatNumber.startsWith('IE')) {
      findings.push({
        code: 'vies_customer_vat_number_invalid',
        message: `${l.customerName}'s VAT number "${l.customerVatNumber}" is not prefixed with another Member State's code. `
          + 'An IE number never appears on the statement (column 10); a number that fails validation nullifies the '
          + 'zero rating (manual §4.10).',
      });
    }
  }
  if (frequency === 'Q' && goodsMinor > VIES_MONTHLY_GOODS_THRESHOLD_MINOR) {
    findings.push({
      code: 'vies_monthly_required',
      message: `Goods supplied this quarter total €${(goodsMinor / 100).toFixed(2)}, above €50,000: a statement is required `
        + 'for each calendar month (manual §3.5).',
    });
  }
  if (lines.length) {
    findings.push({
      code: 'vies_triangulation_not_recorded',
      message: 'Triangulation is not recorded, so no line carries the "T" flag. If any of these goods were part of a '
        + 'triangular transaction (manual Appendix 7), mark that line before filing.',
    });
  }

  const due = month === 12 ? `${year + 1}-01-23` : `${year}-${pad(month + 1)}-23`;
  return {
    companyId: params.companyId, frequency, periodCode: `${String(year).slice(2)}${pad(month)}`, startDate, endDate,
    lines, totalEuro: lines.reduce((s, l) => s + l.valueEuro, 0), nil: lines.length === 0, dueDate: due,
    findings, guidancePath: VIES_GUIDANCE_PATH,
  };
}

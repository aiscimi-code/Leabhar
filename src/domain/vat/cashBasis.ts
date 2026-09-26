import { and, eq, gte, lte, notInArray } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, invoices, customers } from '@/db/schema';
import { SI_69_2025_CURATED_RULES } from '../rules/si692025Curation';
import { addDays, addMonths, asIsoDate } from '../dates';

/**
 * Checks on the moneys-received basis (VATCA s.80, issue #208), run when a VAT
 * period is validated.
 *
 * The basis is set on the company profile; these check that it is backed by
 * an authorisation in force for the whole period (S.I. 639/2010 reg.25), and
 * that the books still meet the s.80(1) test the company relied on. Each is a
 * warning for a person to resolve, never a change to any entry.
 */

export interface CashBasisFinding {
  code: 'cash_basis_not_authorised' | 'cash_basis_turnover_over_threshold' | 'cash_basis_registered_customers_share'
    | 'cash_basis_eligibility_unrecorded';
  title: string;
  detail: string;
}

/** €2,000,000 (s.80(1)(b), as amended by S.I. 69/2025 reg.8), from the curated rule. */
export const CASH_BASIS_TURNOVER_THRESHOLD_MINOR: number = SI_69_2025_CURATED_RULES
  .find((r) => r.ruleKey === 'vat.cash_accounting_turnover_threshold')!.numericValue!;

const eur = (minor: number) => `€${(minor / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Sales turnover (VAT-exclusive, base currency) in the 12 months ending on a
 * date, from the issued sales invoices less credit notes; and the part of it
 * invoiced to customers with a VAT number.
 */
export function salesTurnoverTwelveMonths(db: AppDatabase, params: { companyId: string; endDate: string }): {
  from: string; to: string; totalMinor: number; toRegisteredMinor: number;
} {
  const from: string = addDays(addMonths(asIsoDate(params.endDate), -12), 1);
  const rows = db.select({
    net: invoices.baseNetMinor, customerVat: customers.vatNumber,
  }).from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(
      eq(invoices.companyId, params.companyId), eq(invoices.direction, 'sales'),
      gte(invoices.invoiceDate, from), lte(invoices.invoiceDate, params.endDate),
      notInArray(invoices.status, ['draft', 'void']),
    )).all();
  let totalMinor = 0;
  let toRegisteredMinor = 0;
  for (const r of rows) {
    // A credit note's figures are already negative on the invoice row.
    const signed = r.net;
    totalMinor += signed;
    if (r.customerVat?.trim()) toRegisteredMinor += signed;
  }
  return { from, to: params.endDate, totalMinor, toRegisteredMinor };
}

export function cashBasisFindings(db: AppDatabase, params: {
  companyId: string; periodStart: string; periodEnd: string;
}): CashBasisFinding[] {
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  if (!company || company.vatAccountingBasis !== 'cash_receipts') return [];
  const findings: CashBasisFinding[] = [];

  if (!company.cashBasisAuthorisedFrom) {
    findings.push({
      code: 'cash_basis_not_authorised',
      title: 'The cash receipts basis is used, but no Revenue authorisation is recorded',
      detail: 'VAT on sales is being taken when payment is received. That basis needs Revenue\'s authorisation '
        + '(VATCA s.80(1), S.I. 639/2010 reg.25). Record the authorisation on the company profile, or change the '
        + 'basis to invoice.',
    });
  } else if (company.cashBasisAuthorisedFrom > params.periodStart) {
    findings.push({
      code: 'cash_basis_not_authorised',
      title: `The cash receipts basis is authorised only from ${company.cashBasisAuthorisedFrom}`,
      detail: `This period starts on ${params.periodStart}. Sales before ${company.cashBasisAuthorisedFrom} are on the `
        + 'invoice basis (s.80(2)(b), (c)). Check which sales in the period fall before the authorisation.',
    });
  }

  const turnover = salesTurnoverTwelveMonths(db, { companyId: params.companyId, endDate: params.periodEnd });
  if (!company.cashBasisEligibility) {
    findings.push({
      code: 'cash_basis_eligibility_unrecorded',
      title: 'Which s.80(1) test the company meets is not recorded',
      detail: 'The cash receipts basis is available on turnover of no more than '
        + `${eur(CASH_BASIS_TURNOVER_THRESHOLD_MINOR)} (s.80(1)(b)), or where at least 90% of turnover is to customers `
        + 'who are not VAT-registered (s.80(1)(a)). Record which one the authorisation rests on.',
    });
  }
  if (company.cashBasisEligibility !== 'supplies_to_unregistered' && turnover.totalMinor > CASH_BASIS_TURNOVER_THRESHOLD_MINOR) {
    findings.push({
      code: 'cash_basis_turnover_over_threshold',
      title: `Sales of ${eur(turnover.totalMinor)} in the 12 months to ${turnover.to} exceed ${eur(CASH_BASIS_TURNOVER_THRESHOLD_MINOR)}`,
      detail: `Issued sales invoices less credit notes, ${turnover.from} to ${turnover.to}, VAT-exclusive. Above the `
        + 's.80(1)(b) threshold the cash receipts basis is not available on turnover; Revenue may cancel the '
        + 'authorisation (s.80(4)). Check with your adviser.',
    });
  }
  if (company.cashBasisEligibility === 'supplies_to_unregistered' && turnover.totalMinor > 0
      && turnover.toRegisteredMinor * 10 > turnover.totalMinor) {
    const pct = Math.round((turnover.toRegisteredMinor * 1000) / turnover.totalMinor) / 10;
    findings.push({
      code: 'cash_basis_registered_customers_share',
      title: `${pct}% of sales in the 12 months to ${turnover.to} were to customers with a VAT number`,
      detail: 's.80(1)(a) needs at least 90% of turnover to be to persons who are not registered. A customer with a '
        + 'VAT number on its record is counted as registered. Check the customer records and the test relied on.',
    });
  }
  return findings;
}

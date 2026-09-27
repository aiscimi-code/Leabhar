/**
 * The CT1 computation worksheet and the tax reconciliation behind it (issue
 * #313, epic 18). The computation (`computation.ts`, issue #211) states every
 * adjustment with its provision and its ledger sources; this module lays it
 * out as the statement a person reads when they prepare the CT1 return:
 *
 *   accounting profit → adjustments → taxable trading profit
 *   → losses relieved → tax at each rate → surcharge → total liability.
 *
 * The reconciliation is built here, in the domain, not on a screen or in a
 * report: every step is a figure the computation already produced, so the
 * worksheet, the return and anything rendering them cannot disagree. Nothing
 * here files anything: the worksheet says what is computed, what is only
 * suggested and what is not computed at all.
 */
import type { AppDatabase } from '@/db';
import { companies } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { asIsoDate, type IsoDate } from '../dates';
import {
  computeCorporationTax, type CtComputation, type CtCitation, type CtLine, type CtPendingDecision,
} from './computation';
import { CORPORATION_TAX_CURATED_RULES, CT_RATE_HIGHER_RULE_KEY, CT_RATE_TRADING_RULE_KEY, nfgCitation } from '../rules/corporationTaxCuration';

/** One line of the tax reconciliation: a figure, and the provisions behind it. */
export interface Ct1ReconciliationStep {
  label: string;
  amountMinor: number;
  /** 'total' steps are the subtotals the statement is checked against. */
  kind: 'total' | 'adjustment' | 'deduction' | 'tax';
  citations: CtCitation[];
  /** The computation lines this step aggregates, so the worksheet can show what it is made of. */
  lines: Array<Pick<CtLine, 'label' | 'amountMinor' | 'explanation'>>;
}

export interface Ct1Worksheet {
  companyId: string;
  companyName: string;
  companyNumber: string | null;
  taxReferenceNumber: string | null;
  from: IsoDate;
  to: IsoDate;
  currency: string;

  computation: CtComputation;
  /** Accounting profit to total liability, one step per figure, each cited. */
  reconciliation: Ct1ReconciliationStep[];

  /** The CT1 return date and the preliminary tax payments (s.959A, Part 41A Chapter 3). */
  payment: CtComputation['dates'];
  /** Treatments the computation suggested and no person has decided yet. */
  openDecisions: CtPendingDecision[];
  findings: string[];
  disclaimer: string;
}

const DISCLAIMER = 'This worksheet is prepared from the accounting records in this application. It is a '
  + 'preparation aid, not a filed return: this application does not submit anything to Revenue. The figures '
  + 'rest on the rules cited next to them, on the treatments decided or suggested as shown, and on nothing '
  + 'beyond the findings listed. Review everything before filing the CT1.';

const cite = (ruleKey: string): CtCitation => {
  const rule = CORPORATION_TAX_CURATED_RULES.find((r) => r.ruleKey === ruleKey);
  return rule
    ? { ruleKey, citation: nfgCitation(rule.part), section: `TCA 1997 s.${rule.sectionNumber}` }
    : { ruleKey, citation: ruleKey, section: '' };
};

/**
 * The tax reconciliation: every adjustment the computation made, then the
 * taxable profit, the tax at each rate, the surcharge and the total liability.
 * The steps tie back to the computation by construction — each amount is read
 * from it, never recomputed.
 */
export function ct1Reconciliation(c: CtComputation): Ct1ReconciliationStep[] {
  const steps: Ct1ReconciliationStep[] = [];

  steps.push({
    label: 'Accounting profit for the period', amountMinor: c.accountingProfitMinor, kind: 'total',
    citations: [cite('ct.income_tax_principles')], lines: [],
  });
  for (const line of c.lines) {
    steps.push({
      label: line.label, amountMinor: line.amountMinor,
      kind: line.kind === 'add_back' ? 'adjustment' : 'deduction',
      citations: line.citations, lines: [{ label: line.label, amountMinor: line.amountMinor, explanation: line.explanation }],
    });
  }
  const adjusted = c.adjustedTradingResultMinor;
  steps.push({
    label: c.tradingLossMinor > 0 ? 'Trading loss after adjustments' : 'Trading profit after adjustments',
    amountMinor: adjusted, kind: 'total', citations: [cite('ct.income_tax_principles')], lines: [],
  });

  if (c.losses.broughtForwardUsedMinor || c.losses.carriedBackInMinor) {
    steps.push({
      label: 'Deduct: trading losses relieved against this period', amountMinor: -(c.losses.broughtForwardUsedMinor + c.losses.carriedBackInMinor),
      kind: 'deduction', citations: c.losses.citations, lines: [],
    });
  }
  steps.push({
    label: 'Taxable trading profit (charged at the standard rate)', amountMinor: c.tradingProfitMinor, kind: 'total',
    citations: [cite(CT_RATE_TRADING_RULE_KEY)], lines: [],
  });
  steps.push({
    label: 'Non-trading income charged at the higher rate', amountMinor: c.nonTradingIncomeMinor, kind: 'total',
    citations: [cite(CT_RATE_HIGHER_RULE_KEY)], lines: [],
  });
  steps.push({
    label: 'Tax at the standard rate', amountMinor: c.taxAtStandardRateMinor, kind: 'tax',
    citations: [cite(CT_RATE_TRADING_RULE_KEY), ...c.rates.citations], lines: [],
  });
  steps.push({
    label: 'Tax at the higher rate', amountMinor: c.taxAtHigherRateMinor, kind: 'tax',
    citations: [cite(CT_RATE_HIGHER_RULE_KEY)], lines: [],
  });
  if (c.losses.valueBasisCreditMinor) {
    steps.push({
      label: 'Deduct: s.396B credit against tax on other income', amountMinor: -c.losses.valueBasisCreditMinor,
      kind: 'deduction', citations: [cite('ct.loss_value_basis')], lines: [],
    });
  }
  steps.push({
    label: 'Corporation tax for the period', amountMinor: c.corporationTaxMinor, kind: 'total',
    citations: [cite(CT_RATE_TRADING_RULE_KEY), cite(CT_RATE_HIGHER_RULE_KEY)], lines: [],
  });
  steps.push({
    label: `Close company surcharge (s.${c.surcharge.status === 'close_service' ? '441' : '440'})`, amountMinor: c.surcharge.surchargeMinor,
    kind: 'tax', citations: c.surcharge.citations, lines: [],
  });
  steps.push({
    label: 'Total liability for the period', amountMinor: c.corporationTaxMinor + c.surcharge.surchargeMinor, kind: 'total',
    citations: [cite(CT_RATE_TRADING_RULE_KEY), cite(CT_RATE_HIGHER_RULE_KEY), ...c.surcharge.citations], lines: [],
  });
  return steps;
}

/**
 * The CT1 computation worksheet for an accounting period: the computation,
 * the reconciliation from accounting profit to the total liability, the
 * payment dates and everything still open, so a person can review it before
 * filing.
 */
export function buildCt1Worksheet(
  db: AppDatabase,
  params: { companyId: string; from: IsoDate; to: IsoDate },
): Ct1Worksheet {
  const { companyId } = params;
  const from = asIsoDate(params.from);
  const to = asIsoDate(params.to);
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new Error(`Company ${companyId} not found.`);
  if (company.entityType !== 'company') {
    throw new Error(`${company.legalName} is a ${company.entityType}, not a company: no CT1 is prepared for it.`);
  }
  const computation = computeCorporationTax(db, { companyId, from, to });
  return {
    companyId,
    companyName: company.legalName,
    companyNumber: company.croNumber,
    taxReferenceNumber: company.taxReferenceNumber,
    from, to,
    currency: company.baseCurrency,
    computation,
    reconciliation: ct1Reconciliation(computation),
    payment: computation.dates,
    openDecisions: computation.decisions.filter((d) => !d.decided),
    findings: computation.findings,
    disclaimer: DISCLAIMER,
  };
}

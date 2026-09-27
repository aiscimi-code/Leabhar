import type { AppDatabase } from '@/db';
import { computeIncomeTax, type IncomeTaxComputation } from './computation';

/**
 * Form 11 preparation (epic #312): the year's income tax computation laid out
 * in the order the Form 11 asks for it, with the self-assessment
 * reconciliation and the tax the person must fund.
 *
 * Nothing here files anything. The Form 11 is the individual's own-assessed
 * return, filed through ROS by the person or their agent: this is the
 * preparation of its figures from the books (README "What it does not do").
 * For a partnership, each partner's figures are their own return (s.1008):
 * the trade section is shared, the computation, reconciliation and provision
 * are per partner.
 *
 * Figures are the domain computation's, taken as given. Where the Form 11 asks
 * for something the books cannot know — the PPS number, the individual's other
 * income — the line says so rather than guessing.
 *
 * The boundary is deliberate (issue #458, ADR 0013): an individual's
 * non-trading income is never recorded, so every panel the return asks for
 * outside the business is listed as "to be completed by [name]: not in these
 * books", and the self-assessment is marked partial — it reconciles only the
 * trade's liability, never the person's total liability.
 */

export interface Form11Line {
  label: string;
  /** The figure, or null where the books cannot give one. */
  amountMinor: number | null;
  note?: string;
}

export interface Form11Section {
  title: string;
  note?: string;
  lines: Form11Line[];
}

/** The Form 11's self-assessment panel: the tax, the payments, the balance. */
export interface Form11SelfAssessment {
  name: string;
  /**
   * Always true in these books (issue #458, ADR 0013): the reconciliation
   * covers the trade's liability only, because the person's other income is
   * not recorded. Never presented as the person's total liability.
   */
  partial: boolean;
  /** Income tax + USC + PRSI for the year. */
  liabilityMinor: number;
  /** The preliminary tax due for the year (s.959AO), as computed: what was actually paid is not in these books. */
  preliminaryTaxMinor: number;
  /** The balance payable with the return; negative is repayable. */
  balanceMinor: number;
  /** When the balance is due: the return date. */
  balanceDueDate: string;
  working: string;
}

/** The tax the person must fund for the year, and when. */
export interface Form11Provision {
  name: string;
  liabilityMinor: number;
  payments: Array<{ dueDate: string; amountMinor: number; description: string }>;
  note: string;
}

export interface Form11 {
  companyId: string;
  year: number;
  computation: IncomeTaxComputation;
  sections: Form11Section[];
  selfAssessment: Form11SelfAssessment[];
  provision: Form11Provision[];
  findings: string[];
}

const eur = (minor: number) => (minor / 100).toFixed(2);

/** The form, from a computation already run: its sections, each person's reconciliation and provision. */
export function form11From(computation: IncomeTaxComputation): Form11 {
  const c = computation;
  const findings: string[] = [];

  const trade: Form11Section = {
    title: 'Trading income (Case I or II, Schedule D)',
    note: 'The trade\'s profits for the basis period, adjusted to the tax figure. The basis rules (ss.65-67) are the computation\'s.',
    lines: [
      { label: `Basis period ${c.basis.from} to ${c.basis.to}`, amountMinor: null, note: c.basis.rule },
      { label: 'Profits of the basis period', amountMinor: c.basisProfitMinor },
      ...(c.thirdYearReliefMinor
        ? [{ label: 'Less the second year\'s excess over its actual profits (s.66(3))', amountMinor: -c.thirdYearReliefMinor, note: 'An election; applied in the computation.' }]
        : []),
      ...(c.farm?.stockRelief?.reliefMinor
        ? [{ label: 'Less stock relief (s.666)', amountMinor: -c.farm.stockRelief.reliefMinor,
             note: `${c.farm.stockRelief.rateBasisPoints / 100}% of the increase in trading stock; a claim, applied in the computation.` }]
        : []),
      ...(c.farm?.averaging?.applied
        ? [{ label: 'Income averaging: adjustment to the average of five years (s.657)',
             amountMinor: c.farm.chargedBasisMinor - (c.basisProfitMinor - (c.farm.stockRelief?.reliefMinor ?? 0)),
             note: 'An election; the farming profits of the year and the 4 before it, before capital allowances.' }]
        : []),
      ...(c.capitalAllowancesMinor
        ? [{ label: 'Less capital allowances for the year of assessment (s.284)', amountMinor: c.capitalAllowancesMinor,
             note: 'Given for the year of assessment against its basis period, not apportioned with the profits.' }]
        : []),
      { label: 'Assessable trading profit' + (c.tradingLossMinor ? ' (a loss for the year)' : ''), amountMinor: c.assessableProfitMinor },
    ],
  };

  // The panels the return asks for that these books cannot answer (issue
  // #458, ADR 0013). One book is one business: the person's employment,
  // pensions, rents, investment income and other gains are theirs to enter on
  // the return, not facts of the trade.
  const outside: Form11Section[] = c.individuals.map((i) => ({
    title: `Income outside the business — to be completed by ${i.name}`,
    note: 'Not in these books (ADR 0001). If any of these exist, the s.381 claim figure and the liability change.',
    lines: [
      { label: 'Income from employment (Schedule E)', amountMinor: null, note: 'To be completed by the person: not in these books.' },
      { label: 'Pensions and annuities', amountMinor: null, note: 'To be completed by the person: not in these books.' },
      { label: 'Rents from land and premises (Case V)', amountMinor: null, note: 'To be completed by the person: not in these books.' },
      { label: 'Foreign income and interest (Case III)', amountMinor: null, note: 'To be completed by the person: not in these books.' },
      { label: 'Investment income: dividends and interest', amountMinor: null, note: 'To be completed by the person: not in these books.' },
      { label: 'Other income (Case IV)', amountMinor: null, note: 'To be completed by the person: not in these books.' },
      // A chargeable gain is capital gains tax, not Case IV income: its own panel.
      { label: 'Chargeable gains (capital gains tax)', amountMinor: null, note: 'To be completed by the person: not in these books.' },
    ],
  }));

  const individuals: Form11Section[] = c.individuals.map((i) => ({
    title: `Tax computation — ${i.name}`,
    note: i.status.startsWith('married') ? 'Jointly assessed; the spouse\'s income is not in these books.' : undefined,
    lines: [
      { label: 'Share of the trading result for the year', amountMinor: i.profitMinor },
      ...(i.allowancesBroughtForwardUsedMinor
        ? [{ label: 'Less capital allowances brought forward (s.304)', amountMinor: -i.allowancesBroughtForwardUsedMinor, note: 'Unused allowances of earlier years, carried forward as allowances without the s.392 election.' }]
        : []),
      ...(i.broughtForwardLossUsedMinor
        ? [{ label: 'Less trading losses brought forward (s.382)', amountMinor: -i.broughtForwardLossUsedMinor, note: 'Losses of earlier years of the same trade, earliest first.' }]
        : []),
      ...(i.claimedAgainstOtherIncomeMinor
        ? [{ label: 'Loss claimed against other income of the year (s.381)', amountMinor: -i.claimedAgainstOtherIncomeMinor,
             note: 'The person\'s own figure: their other income is not in these books.' }]
        : []),
      ...(i.lossCarriedForwardMinor
        ? [{ label: 'Loss carried forward against later profits of the trade (s.382)', amountMinor: null, note: `${eur(i.lossCarriedForwardMinor)} carried forward.` }]
        : []),
      ...(i.allowancesCarriedForwardMinor
        ? [{ label: 'Capital allowances carried forward (s.304)', amountMinor: null, note: `${eur(i.allowancesCarriedForwardMinor)} carried forward as allowances.` }]
        : []),
      { label: 'Income assessed from the trade', amountMinor: Math.max(i.profitMinor - i.allowancesBroughtForwardUsedMinor - i.broughtForwardLossUsedMinor, 0) },
      ...i.incomeTax.map((l) => ({ label: l.label, amountMinor: l.amountMinor })),
      { label: 'Income tax', amountMinor: i.incomeTaxMinor },
      { label: 'Universal social charge', amountMinor: i.uscMinor },
      { label: 'PRSI (Class S)', amountMinor: i.prsiMinor, note: i.prsiMinor === null ? 'No rate is available for the year.' : undefined },
      // The liability on the trade's income only: never the person's total (issue #458).
      { label: 'Liability on the trade\u2019s income', amountMinor: i.totalMinor },
    ],
  }));

  findings.push('The PPS number is not in these books: the form needs it.');
  for (const i of c.individuals) {
    findings.push(`${i.name}: the return asks for income outside the business — employment, pensions, rents, `
      + 'investment income, other income, chargeable gains — which these books do not hold and never record (issue #458, ADR 0013). '
      + `${i.name} completes those panels themselves; the self-assessment here is partial and reconciles only the trade's liability.`);
  }
  const personal = c.individuals.length > 1
    ? 'Each partner files their own Form 11: their share, their own preliminary tax and their own balance.'
    : undefined;

  const selfAssessment: Form11SelfAssessment[] = c.individuals.map((i) => ({
    name: i.name,
    partial: true,
    liabilityMinor: i.totalMinor,
    preliminaryTaxMinor: i.preliminaryTaxMinor,
    balanceMinor: i.totalMinor - i.preliminaryTaxMinor,
    balanceDueDate: c.dates.returnDue,
    working: `Liability on the trade's income ${eur(i.totalMinor)} less preliminary tax due ${eur(i.preliminaryTaxMinor)} `
      + `(s.959AO: ${c.dates.basis}): the balance, ${eur(i.totalMinor - i.preliminaryTaxMinor)}, `
      + `is payable with the return by ${c.dates.returnDue}${i.totalMinor - i.preliminaryTaxMinor < 0 ? ', repayable' : ''}. `
      + 'Partial: it reconciles the trade\u2019s liability only — the person\u2019s other income is not in these books '
      + '(issue #458, ADR 0013), so this is never their total liability.',
  }));

  const provision: Form11Provision[] = c.individuals.map((i) => ({
    name: i.name,
    liabilityMinor: i.totalMinor,
    payments: [
      { dueDate: c.dates.preliminaryTaxDue, amountMinor: i.preliminaryTaxMinor, description: 'Preliminary tax (s.959AO)' },
      { dueDate: c.dates.returnDue, amountMinor: Math.max(i.totalMinor - i.preliminaryTaxMinor, 0),
        description: 'Balance with the return' },
    ],
    note: 'Income tax, USC and PRSI are the person\'s own liability, not the trade\'s: they are added back in the trade '
      + 'computation (s.81(2)(p)) and paid from drawings. Nothing is accrued in the accounts for them. This is the '
      + 'money to set aside, and the dates it is due.',
  }));

  return {
    companyId: c.companyId,
    year: c.year,
    computation: c,
    sections: [trade, ...individuals, ...outside],
    selfAssessment,
    provision,
    findings: [...new Set([...findings, ...(personal ? [personal] : []), ...c.findings])],
  };
}

/**
 * The Form 11 preparation for a year of assessment. Each person's preliminary
 * tax is their own (s.959AO, in the computation), as the Form 11's
 * self-assessment panel asks for it.
 */
export function buildForm11(db: AppDatabase, params: { companyId: string; year: number }): Form11 {
  return form11From(computeIncomeTax(db, params));
}

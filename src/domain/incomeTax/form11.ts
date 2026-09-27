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
      ...(c.capitalAllowancesMinor
        ? [{ label: 'Less capital allowances for the year of assessment (s.284)', amountMinor: c.capitalAllowancesMinor,
             note: 'Given for the year of assessment against its basis period, not apportioned with the profits.' }]
        : []),
      { label: 'Assessable trading profit' + (c.tradingLossMinor ? ' (a loss for the year)' : ''), amountMinor: c.assessableProfitMinor },
    ],
  };

  const individuals: Form11Section[] = c.individuals.map((i) => ({
    title: `Tax computation — ${i.name}`,
    note: i.status.startsWith('married') ? 'Jointly assessed; the spouse\'s income is not in these books.' : undefined,
    lines: [
      { label: 'Share of the trading result for the year', amountMinor: i.profitMinor },
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
      { label: 'Income assessed from the trade', amountMinor: Math.max(i.profitMinor - i.broughtForwardLossUsedMinor, 0) },
      ...i.incomeTax.map((l) => ({ label: l.label, amountMinor: l.amountMinor })),
      { label: 'Income tax', amountMinor: i.incomeTaxMinor },
      { label: 'Universal social charge', amountMinor: i.uscMinor },
      { label: 'PRSI (Class S)', amountMinor: i.prsiMinor, note: i.prsiMinor === null ? 'No rate is available for the year.' : undefined },
      { label: 'Total liability', amountMinor: i.totalMinor },
    ],
  }));

  findings.push('The PPS number is not in these books: the form needs it. The return also asks for non-trading income '
    + '(pensions, rents, interest), which is not known here; if there is any, the s.381 claim figure and the liability change.');
  const personal = c.individuals.length > 1
    ? 'Each partner files their own Form 11: their share, their own preliminary tax and their own balance.'
    : undefined;

  const selfAssessment: Form11SelfAssessment[] = c.individuals.map((i) => ({
    name: i.name,
    liabilityMinor: i.totalMinor,
    preliminaryTaxMinor: i.preliminaryTaxMinor,
    balanceMinor: i.totalMinor - i.preliminaryTaxMinor,
    balanceDueDate: c.dates.returnDue,
    working: `Total liability ${eur(i.totalMinor)} less preliminary tax due ${eur(i.preliminaryTaxMinor)} `
      + `(s.959AO: ${c.dates.basis}): the balance, ${eur(i.totalMinor - i.preliminaryTaxMinor)}, `
      + `is payable with the return by ${c.dates.returnDue}${i.totalMinor - i.preliminaryTaxMinor < 0 ? ', repayable' : ''}.`,
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
    sections: [trade, ...individuals],
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

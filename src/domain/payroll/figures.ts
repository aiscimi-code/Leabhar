import type { AppDatabase } from '@/db';
import type { PayslipRuleFigure } from '@/db/schema';
import { INCOME_TAX_CURATED_RULES } from '../rules/incomeTaxCuration';
import { PAYROLL_CURATED_RULES } from '../rules/payrollCuration';
import { resolveRuleFigure, type ResolvedRuleFigure } from '../rules/ruleFigures';
import type { ManifestRuleKey } from '../rules/consumers';

export class PayrollError extends Error {
  constructor(message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PayrollError';
  }
}

const CURATED = [...PAYROLL_CURATED_RULES, ...INCOME_TAX_CURATED_RULES];

/**
 * The rule figures one payslip uses, resolved as of its pay date through the
 * knowledge base (issue #282's policy, written once in `resolveRuleFigure`).
 *
 * A payroll figure cannot be skipped: tax is either deducted correctly or
 * not at all. So a figure a person rejected or retired, or one no rule
 * states for the pay date, stops the payslip with the rule's own finding;
 * an unreviewed figure is used and named in the payslip's findings.
 */
export class PayrollFigures {
  private readonly resolved = new Map<string, ResolvedRuleFigure>();

  constructor(private readonly db: AppDatabase, private readonly companyId: string, readonly payDate: string) {}

  private resolve(ruleKey: ManifestRuleKey): ResolvedRuleFigure {
    const memo = this.resolved.get(ruleKey);
    if (memo) return memo;
    const curated = CURATED.filter((r) => r.ruleKey === ruleKey
      && r.effectiveFrom <= this.payDate && (r.effectiveTo === null || this.payDate < r.effectiveTo))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
      ?? CURATED.find((r) => r.ruleKey === ruleKey);
    if (!curated) throw new Error(`No shipped curation for payroll rule "${ruleKey}".`);
    const figure = resolveRuleFigure(this.db, { companyId: this.companyId, ruleKey, asOfDate: this.payDate, curated });
    this.resolved.set(ruleKey, figure);
    return figure;
  }

  /** The rule's figure on the pay date; refuses when there is none to use. */
  value(ruleKey: ManifestRuleKey): number {
    const f = this.resolve(ruleKey);
    if (f.numericValue === null) {
      throw new PayrollError(
        `${f.finding ?? `No figure for ${ruleKey} on ${this.payDate}.`} A payslip is not computed without it: `
        + 'tax is deducted correctly or not at all.', { ruleKey, payDate: this.payDate });
    }
    return f.numericValue;
  }

  /** A band rule's rate on the pay date. */
  rate(ruleKey: ManifestRuleKey): number {
    this.value(ruleKey);
    const f = this.resolve(ruleKey);
    if (f.rateBasisPoints === null) throw new PayrollError(`Rule ${ruleKey} states no rate.`, { ruleKey });
    return f.rateBasisPoints;
  }

  /** Name a procedure rule the payslip followed, so it is in the snapshot. */
  cite(ruleKey: ManifestRuleKey): void {
    this.resolve(ruleKey);
  }

  /** The snapshot a payslip stores (invariant 6). */
  snapshot(): PayslipRuleFigure[] {
    return [...this.resolved.values()].map((f) => ({
      ruleKey: f.ruleKey, value: f.numericValue, rateBasisPoints: f.rateBasisPoints, status: f.status,
    }));
  }

  /** What the figures' review state says, consolidated. */
  findings(): string[] {
    const all = [...this.resolved.values()];
    const out: string[] = [];
    const unreviewed = all.filter((f) => f.status === 'unreviewed').map((f) => f.ruleKey);
    if (unreviewed.length) out.push(`These figures rest on rules no person has reviewed yet: ${unreviewed.join(', ')}.`);
    const curationOnly = all.filter((f) => f.status === 'curation_only').map((f) => f.ruleKey);
    if (curationOnly.length) {
      out.push(`The statutory rules knowledge base holds no rule for: ${curationOnly.join(', ')}. Those figures come from `
        + 'the shipped curation constants, which no person has reviewed in this book.');
    }
    return out;
  }
}

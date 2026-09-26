import { COMPOSITE_SUPPLY_RULE_KEY } from '../rules/compositeSupplyCuration';
import type { LineChoices } from './suggest';

/**
 * Composite and multiple supplies across one invoice's lines (VATCA s.47,
 * issue #206).
 *
 * A line the s.47 rule marked as possibly ancillary (delivery, packaging,
 * handling) is compared with the other lines of the same invoice, the
 * candidate principal supplies:
 *
 * - they bear one printed rate: if the line is ancillary it follows that rate
 *   (s.47(1)(a)), so the principal's treatment is offered as an option and
 *   the choice flagged, whether the rate charged agrees or not;
 * - they bear different rates: which one it would follow, or how a multiple
 *   supply's price is apportioned (s.47(1)(b)), cannot be decided from the
 *   invoice, so it is flagged.
 *
 * Nothing is chosen: whether a supply is ancillary is a judgement (s.2(1)).
 */
export function applyCompositeSupply(
  lines: LineChoices[],
  /** The domestic treatment at a printed rate on the document's date, for a principal with no agreed treatment. */
  treatmentForRate: (rateBasisPoints: number) => { treatmentId: string; code: string; name: string } | undefined,
): LineChoices[] {
  const matched = (c: LineChoices) => c.line.origin === 'line' && [c.statutory.decidingRule, ...c.statutory.supportingRules]
    .some((r) => r?.ruleKey === COMPOSITE_SUPPLY_RULE_KEY);
  const pct = (bp: number) => `${bp / 100}%`;

  return lines.map((choice, i) => {
    if (!matched(choice)) return choice;
    const principals = lines.filter((c, j) => j !== i && c.line.origin === 'line' && !matched(c) && c.line.rateBasisPoints !== null);
    if (principals.length === 0) return choice;

    const rates = [...new Set(principals.map((c) => c.line.rateBasisPoints!))].sort((a, b) => a - b);
    const flags = [...choice.flags];
    let options = choice.options;
    const what = `"${choice.line.description}"`;

    if (rates.length > 1) {
      flags.push(`s.47: the other supplies on this invoice are at different rates (${rates.map(pct).join(', ')}). `
        + `Whether ${what} is ancillary to one of them (and takes its rate) or is a separate supply whose share of the `
        + 'price takes its own rate cannot be decided from the invoice.');
      return { ...choice, flags, preselectedTreatmentId: null };
    }

    const rate = rates[0]!;
    // The principal's agreed treatment when all agree on one; else the domestic treatment at their printed rate.
    const agreed = [...new Set(principals.map((c) => c.preselectedTreatmentId))];
    const agreedOption = agreed.length === 1 && agreed[0]
      ? principals[0]!.options.find((o) => o.treatmentId === agreed[0]) : undefined;
    const principal = agreedOption ?? treatmentForRate(rate);
    const names = principals.map((c) => `"${c.line.description}"`).join(', ');
    if (principal) {
      const reason = `s.47(1)(a): if ${what} is ancillary to ${names} (one composite supply), it follows their treatment.`;
      const existing = options.find((o) => o.treatmentId === principal.treatmentId);
      options = existing
        ? options.map((o) => (o === existing
          ? { ...o, reasons: [...o.reasons, reason], ruleKeys: [...new Set([...o.ruleKeys, COMPOSITE_SUPPLY_RULE_KEY])] }
          : o))
        : [...options, {
          treatmentId: principal.treatmentId, code: principal.code, name: principal.name,
          reasons: [reason], ruleKeys: [COMPOSITE_SUPPLY_RULE_KEY],
        }];
    }
    const charged = choice.line.rateBasisPoints;
    flags.push(charged === rate
      ? `s.47: ${what} is charged at ${pct(rate)}, the rate of ${names}. That is right if it is ancillary to them `
        + '(a composite supply); if it is a separate supply sold with them, it takes its own rate. Confirm which.'
      : `s.47: ${what} is charged at ${charged === null ? 'no stated rate' : pct(charged)}, but ${names} at `
        + `${pct(rate)}. If it is ancillary to them (a composite supply), s.47(1)(a) gives it ${pct(rate)}; if it is `
        + 'a separate supply, its own rate applies. Check with the supplier.');
    return { ...choice, options, flags, preselectedTreatmentId: null };
  });
}

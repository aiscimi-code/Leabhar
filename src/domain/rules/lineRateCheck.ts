import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { vatTreatments } from '@/db/schema';
import { asIsoDate } from '../dates';
import { resolveTreatment } from '../vat/engine';
import { provisionCitation } from './citation';
import { RULE_TREATMENT_BINDINGS, type VatSuggestion, type TransactionDirection } from './vatSuggestion';

/**
 * Is the rate charged on an invoice line correct for what was supplied?
 * (issue #205)
 *
 * The supplier's invoice states the rate. The statutory rules decide whether
 * that rate is right, and say so — they never change the figure. Three
 * outcomes:
 *
 * - `consistent`: a specific rule matched the line, and its rate is the rate
 *   charged;
 * - `inconsistent`: a specific rule matched, and gives a different rate (e.g.
 *   13.5% charged on something the rules put at 23%) — flagged;
 * - `undetermined`: no rule decides it, or only the standard-rate fallback
 *   matched (which cannot rule out an exemption or a reduced rate), or the
 *   line prints no rate — flagged, with every candidate rate and the
 *   provision behind each.
 */

export type LineRateOutcome = 'consistent' | 'inconsistent' | 'undetermined';

export interface RateCandidate {
  /** The rate the supplier should charge under this rule; 0 when none is charged (exempt, zero-rated, reverse charge). */
  rateBasisPoints: number;
  treatmentCode: string;
  ruleKey: string;
  ruleName: string;
  /** e.g. "VATCA 2010 s.46(1)(c)" — where the rule comes from. */
  provision: string;
}

export interface LineRateCheck {
  outcome: LineRateOutcome;
  chargedRateBasisPoints: number | null;
  /** The rate the deciding rule gives, when a specific rule decided. */
  expected: RateCandidate | null;
  /** Every rate the matched rules could support, deciding rule first. */
  candidates: RateCandidate[];
  message: string;
}

/** Treatments under which the supplier charges no Irish VAT on the line. */
const NO_VAT_CHARGED = new Set([
  'IE_EXEMPT', 'OUT_OF_SCOPE', 'EU_GOODS_SUPPLY', 'EU_SERVICES_SUPPLY', 'NON_EU_SERVICES_SUPPLY',
  'EU_SERVICES_RCV', 'NON_EU_SERVICES_RCV', 'EU_GOODS_ACQ', 'RC_CONSTRUCTION',
]);
/** Treatments that say nothing about the rate charged (only about deducting it). */
const NOT_A_RATE = new Set(['NON_DEDUCTIBLE']);

const pct = (bp: number) => `${bp / 100}%`;

export function checkLineRate(
  db: AppDatabase,
  params: {
    companyId: string;
    onDate: string;
    direction: TransactionDirection;
    statutory: VatSuggestion;
    chargedRateBasisPoints: number | null;
  },
): LineRateCheck {
  const { statutory } = params;
  const charged = params.chargedRateBasisPoints;

  const rateFor = (code: string): number | null => {
    if (NOT_A_RATE.has(code)) return null;
    if (NO_VAT_CHARGED.has(code)) return 0;
    const t = db.select({ id: vatTreatments.id }).from(vatTreatments)
      .where(and(eq(vatTreatments.companyId, params.companyId), eq(vatTreatments.code, code), eq(vatTreatments.active, true)))
      .get();
    if (!t) return null;
    try {
      return resolveTreatment(db, { companyId: params.companyId, treatmentId: t.id, onDate: asIsoDate(params.onDate) }).rateBasisPoints;
    } catch {
      return null;
    }
  };

  // Every matched rule that maps to a treatment is a candidate, deciding rule first.
  const candidates: RateCandidate[] = [];
  const seen = new Set<string>();
  const rules = [statutory.decidingRule, ...statutory.supportingRules].filter((r): r is NonNullable<typeof r> => !!r);
  for (const rule of rules) {
    const binding = RULE_TREATMENT_BINDINGS.find((b) => b.ruleKeys.includes(rule.ruleKey)
      && (b.direction === 'either' || b.direction === params.direction));
    const code = binding?.treatmentCode(statutory.facts, rule.ruleKey);
    if (!code) continue;
    const rate = rateFor(code);
    if (rate === null || seen.has(`${code}:${rate}`)) continue;
    seen.add(`${code}:${rate}`);
    candidates.push({
      rateBasisPoints: rate, treatmentCode: code, ruleKey: rule.ruleKey, ruleName: rule.ruleName,
      provision: provisionCitation(rule.citation, rule.sectionNumber),
    });
  }

  const decided = statutory.status === 'suggested' && statutory.decidingRule
    ? candidates.find((c) => c.ruleKey === statutory.decidingRule!.ruleKey) ?? null : null;
  const listed = candidates.length
    ? ` Rates the rules support: ${candidates.map((c) => `${pct(c.rateBasisPoints)} (${c.treatmentCode}, ${c.provision})`).join('; ')}.`
    : '';

  if (charged === null) {
    return {
      outcome: 'undetermined', chargedRateBasisPoints: null, expected: decided, candidates,
      message: `No VAT rate is printed on this line, so it cannot be checked.${listed}`,
    };
  }
  if (decided) {
    if (decided.rateBasisPoints === charged) {
      return {
        outcome: 'consistent', chargedRateBasisPoints: charged, expected: decided, candidates,
        message: `${pct(charged)} is the rate "${decided.ruleName}" (${decided.provision}) gives.`,
      };
    }
    return {
      outcome: 'inconsistent', chargedRateBasisPoints: charged, expected: decided, candidates,
      message: `${pct(charged)} was charged, but "${decided.ruleName}" (${decided.provision}) gives `
        + `${pct(decided.rateBasisPoints)}. The invoice figure is kept as printed; check it with the supplier.${listed}`,
    };
  }
  const why = statutory.status === 'fallback_only'
    ? 'Only the standard-rate fallback matched; the rules cannot rule out an exemption or a reduced rate for this item.'
    : statutory.status === 'kb_empty' ? 'The statutory rules are not loaded for this company.'
    : statutory.status === 'no_treatment' ? statutory.explanation
    : 'No statutory rule decides the rate for this item.';
  return {
    outcome: 'undetermined', chargedRateBasisPoints: charged, expected: null, candidates,
    message: `${pct(charged)} was charged. ${why}${listed}`,
  };
}

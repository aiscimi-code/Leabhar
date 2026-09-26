import { INPUT_RECOVERY_REASONS, BLOCKED_MOTOR_VEHICLE_RULE_KEY, QUALIFYING_VEHICLE_DISPOSAL_RULE_KEY } from './inputRecoveryCuration';
import { DOMESTIC_RC_ADVISORY_RULE_KEYS, DOMESTIC_RC_GAPS, RC_CONSTRUCTION_RULE_KEY } from './domesticReverseChargeCuration';
import {
  LETTING_LANDLORD_REASON, LETTING_OPTION_LANDLORD_RULE_KEY, CAPITAL_GOODS_REASON, CAPITAL_GOODS_RULE_KEY,
} from './propertyCuration';

/**
 * Rules that never decide a treatment (issue #208). Each turns on a fact
 * nobody has recorded (the company's principal status, whether a builder is
 * connected, whether the company opted to tax its letting), so when it
 * matches it adds its reason to whatever rule does decide, and an invoice
 * line is not pre-selected. A rule listed in `silencedBy` settles the
 * question, and the advisory is then dropped.
 */
export interface AdvisoryRule { ruleKey: string; reason: string; silencedBy: string[] }

export const ADVISORY_RULES: AdvisoryRule[] = [
  ...DOMESTIC_RC_ADVISORY_RULE_KEYS.map((ruleKey) => ({
    ruleKey, reason: DOMESTIC_RC_GAPS[ruleKey]!, silencedBy: [RC_CONSTRUCTION_RULE_KEY],
  })),
  { ruleKey: LETTING_OPTION_LANDLORD_RULE_KEY, reason: LETTING_LANDLORD_REASON, silencedBy: [] },
  { ruleKey: CAPITAL_GOODS_RULE_KEY, reason: CAPITAL_GOODS_REASON, silencedBy: [] },
  // The 20% qualifying-vehicle case turns on the car's registration and use (issue #209).
  { ruleKey: BLOCKED_MOTOR_VEHICLE_RULE_KEY, reason: INPUT_RECOVERY_REASONS[BLOCKED_MOTOR_VEHICLE_RULE_KEY]!, silencedBy: [] },
  { ruleKey: QUALIFYING_VEHICLE_DISPOSAL_RULE_KEY, reason: INPUT_RECOVERY_REASONS[QUALIFYING_VEHICLE_DISPOSAL_RULE_KEY]!, silencedBy: [] },
];

export const ADVISORY_RULE_KEYS = new Set(ADVISORY_RULES.map((r) => r.ruleKey));

/** The reasons of the advisory rules among the matched rule keys. */
export function advisoryReasons(matchedKeys: Iterable<string | null | undefined>): string[] {
  const keys = new Set(matchedKeys);
  return ADVISORY_RULES
    .filter((a) => keys.has(a.ruleKey) && !a.silencedBy.some((k) => keys.has(k)))
    .map((a) => a.reason);
}

/**
 * Deterministic, textual fact extraction from Finance Act 2024 provisions.
 *
 * "Extraction" here is deliberately mechanical: we scan a provision's verbatim
 * text for monetary amounts, percentage figures and year counts that the Act
 * *states*, and surface each as a candidate rule record — always paired with
 * the verbatim token and its enclosing sentence so the figure is verifiable
 * against the statute.
 *
 * The module NEVER decides *whether* a figure is the "correct" rate — it only
 * reports what the text states and where. Any plain-language interpretation is
 * left to `humanExplanation`, which is always stored `ai_suggestion` until
 * confirmed. This keeps the task's "LLM extracts/explains only — never
 * invents rules" invariant honest: there is no model in the extraction path.
 */
import type { ParsedProvision } from './statuteParser';

export interface ExtractedFact {
  /** Stable, human-curated key. Set by the mapping table, never derived from prose. */
  ruleKey: string;
  name: string;
  /** The verbatim figure token as it appears in the statute text. */
  rawValue: string;
  /** Numeric value when the token is a pure number. */
  numericValue: number | null;
  unit: 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';
  /** Verbatim excerpt containing the figure, for display. */
  evidence: string;
  /** Effective-dated clue from the provision, if any. */
  qualifier: string | null;
}

const EUR_AMOUNT = /€([0-9,]+(?:\.[0-9]{2})?)/g;
const PERCENT = /([0-9]+(?:\.[0-9]+)?)\s*per\s*cent/gi;
const PERCENT_TOKEN = /([0-9]+(?:\.[0-9]+)?)%/g;
const YEARS = /([0-9]+)\s*(?:years?|year)/gi;

function parseMoney(str: string): { minor: number; raw: string } | null {
  const m = str.match(/([0-9,]+)(?:\.([0-9]{2}))?/);
  if (!m) return null;
  const major = Number(m[1].replace(/,/g, ''));
  const minorFrac = m[2] ? Number(`0.${m[2]}`) : 0;
  return { minor: Math.round(major * 100 + minorFrac * 100), raw: str };
}

/**
 * Extract every concrete figure the statute *states* in a provision's text.
 * Each returned fact carries the verbatim token and its enclosing sentence so
 * no figure can be divorced from its source wording. Returns [] for provisions
 * whose text contains no stated figure (e.g. pure repeal clauses).
 */
export function extractFactsFromProvision(p: ParsedProvision): ExtractedFact[] {
  const text = p.provisionText;
  const facts: ExtractedFact[] = [];

  const seenPositions = new Set<number>();
  const capture = (idx: number, value: number | null, unit: ExtractedFact['unit'], raw: string) => {
    if (seenPositions.has(idx)) return;
    seenPositions.add(idx);
    facts.push({
      ruleKey: `s${p.sectionNumber}.amount`,
      name: `Figure stated in section ${p.sectionNumber}`,
      rawValue: raw,
      numericValue: value,
      evidence: sentenceContaining(text, idx),
      unit,
      qualifier: p.effectiveClue,
    });
  };

  let m: RegExpExecArray | null;
  while ((m = EUR_AMOUNT.exec(text))) {
    const parsed = parseMoney(m[0]);
    if (!parsed) continue;
    capture(m.index, parsed.minor, 'eur_minor', parsed.raw);
  }

  const allPercents: Array<{ value: number; raw: string; idx: number }> = [];
  for (const src of [PERCENT, PERCENT_TOKEN]) {
    const re = new RegExp(src.source, src.flags);
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(text))) {
      allPercents.push({ value: Number(mm[1]), raw: mm[0], idx: mm.index });
    }
  }
  for (const pc of allPercents) {
    capture(pc.idx, pc.value, 'percent', pc.raw);
  }

  while ((m = YEARS.exec(text))) {
    capture(m.index, Number(m[1]), 'count', m[1]);
  }

  // De-duplicate by (ruleKey, rawValue, unit).
  const byKey = new Map<string, ExtractedFact>();
  for (const f of facts) {
    const k = `${f.rawValue}:${f.unit}`;
    if (!byKey.has(k)) byKey.set(k, f);
  }
  return [...byKey.values()];
}

function sentenceContaining(text: string, idx: number): string {
  const before = text.lastIndexOf('.', idx);
  const after = text.indexOf('.', idx);
  const start = before === -1 ? 0 : before + 1;
  const end = after === -1 ? text.length : after + 1;
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/**
 * Curated mapping from provision section number to a stable rule key + gloss.
 * This is the *only* place a stable rule key is decided, and it attaches a key
 * to figures the extractor already located in the text — never to invented ones.
 * Unmapped sections still contribute facts under their generic key, but only
 * mapped keys are advertised as named lookup targets.
 */
export interface CuratedRule {
  key: string;
  name: string;
  unit: ExtractedFact['unit'];
  kind: 'threshold' | 'rate' | 'other';
}

export const SECTION_RULE_KEYS: Record<string, CuratedRule> = {
  '2': { key: 'usc.first_band_threshold', name: 'USC first band ceiling', unit: 'eur_minor', kind: 'threshold' },
  '3': { key: 'income_tax.standard_rate_threshold', name: 'Income tax standard-rate ceiling', unit: 'eur_minor', kind: 'threshold' },
  '13': { key: 'pension.standard_fund_threshold', name: 'Standard fund threshold adjustment', unit: 'eur_minor', kind: 'threshold' },
  '48': { key: 'film.tax_credit_rate', name: 'Film tax credit', unit: 'percent', kind: 'rate' },
};

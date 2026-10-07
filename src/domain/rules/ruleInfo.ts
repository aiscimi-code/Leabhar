import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  visibleActProvisionFields, visibleActProvisions, visibleKnowledgeSourceFields, visibleKnowledgeSources, visibleTaxRuleFields, visibleTaxRules,
} from '@/db/schema';
import type { IrishRuleCondition, IrishRuleException } from '@/db/schema';
import { provisionCitation } from './citation';
import { ruleReviewResolver } from './effectiveReview';

/**
 * A single rule, its provision and its source, assembled for a reader
 * (issues #448/#449: the explanation and citation read APIs).
 *
 * The explanation is built here, in the domain, rather than in the route or
 * the page, so every surface that shows why a rule applies — the API, the
 * CLI, the UI — renders the same words from the same rows and cannot
 * disagree about a rule (AGENTS.md: pages render what the domain returns).
 * Nothing here invents: the statement and the provision text are the
 * source's own words, and the conditions are rendered from the same
 * structured data the lookup engine evaluates.
 */

const OPERATOR_TEXT: Record<IrishRuleCondition['operator'], string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', ends_with: 'ends with', matches: 'matches the pattern',
  gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  between: 'is between', in: 'is one of', is_null: 'is not stated',
};

/** One condition as a person reads it, e.g. `supplyType is "services"`. */
export function describeCondition(condition: IrishRuleCondition): string {
  if (condition.operator === 'is_null') return `${condition.field} ${OPERATOR_TEXT.is_null}`;
  const value = Array.isArray(condition.value)
    ? condition.value.map((v) => JSON.stringify(v)).join(' or ')
    : JSON.stringify(condition.value);
  return `${condition.field} ${OPERATOR_TEXT[condition.operator]} ${value}`;
}

/** The row the explanation and the citation are both built from, or null. */
function loadRuleWithSource(db: AppDatabase, params: { companyId: string; ruleId: string }) {
  return db.select({
    rule: visibleTaxRuleFields,
    provision: visibleActProvisionFields,
    source: visibleKnowledgeSourceFields,
  })
    .from(visibleTaxRules)
    .innerJoin(visibleActProvisions, eq(visibleTaxRules.provisionId, visibleActProvisions.id))
    .innerJoin(visibleKnowledgeSources, eq(visibleActProvisions.sourceId, visibleKnowledgeSources.id))
    .where(and(eq(visibleTaxRules.id, params.ruleId), eq(visibleTaxRules.companyId, params.companyId)))
    .get();
}

export interface RuleExplanation {
  ruleId: string;
  ruleKey: string;
  topic: string;
  name: string;
  /** The provision's own words, as stored. */
  statement: string | null;
  /** The assembled plain-language explanation: one deterministic string. */
  explanation: string;
  conditions: string[];
  exceptions: IrishRuleException[];
  effects: {
    accounting: string | null;
    tax: string | null;
    vat: string | null;
    reporting: string | null;
  };
  reviewStatus: string;
  humanReviewRequired: boolean;
  requiresGuidance: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  citation: RuleCitation;
}

export interface RuleCitation {
  ruleId: string;
  ruleKey: string;
  provisionId: string;
  /** The source's short citation, e.g. "2010 Act 31". */
  citation: string;
  /** The provision's full citation, e.g. "2010 Act 31 s.46". */
  fullCitation: string;
  sectionNumber: string;
  heading: string;
  sourceTitle: string;
  sourceType: string;
  sourceUrl: string;
  /** When the source is a local file, where it is and its hash, so the quote is re-checkable. */
  localPath: string | null;
  sha256: string;
  retrievedAt: string;
}

/**
 * A rule's citation: which provision of which document says it, and where the
 * authoritative text lives. Returns null when the rule does not exist or
 * belongs to another company — deliberately indistinguishable, per
 * docs/API.md's not-found convention.
 */
export function ruleCitation(
  db: AppDatabase,
  params: { companyId: string; ruleId: string },
): RuleCitation | null {
  const row = loadRuleWithSource(db, params);
  if (!row) return null;
  const { rule, provision, source } = row;
  return {
    ruleId: rule.id,
    ruleKey: rule.ruleKey,
    provisionId: provision.id,
    citation: source.citation,
    fullCitation: provisionCitation(source.citation, provision.sectionNumber),
    sectionNumber: provision.sectionNumber,
    heading: provision.heading,
    sourceTitle: source.title,
    sourceType: source.sourceType,
    sourceUrl: source.sourceUrl,
    localPath: source.localPath,
    sha256: source.sha256,
    retrievedAt: source.retrievedAt,
  };
}

/**
 * A rule's explanation: what it says, when it applies, what it excepts, what
 * it effects, and where it comes from — assembled deterministically from the
 * stored rows. The prose never asserts a treatment is correct: it states what
 * the rule says and its review status, because an AI-extracted rule is a
 * suggestion until a person approves it.
 */
export function explainRule(
  db: AppDatabase,
  params: { companyId: string; ruleId: string },
): RuleExplanation | null {
  const row = loadRuleWithSource(db, params);
  if (!row) return null;
  const { rule, provision, source } = row;

  const citation: RuleCitation = {
    ruleId: rule.id,
    ruleKey: rule.ruleKey,
    provisionId: provision.id,
    citation: source.citation,
    fullCitation: provisionCitation(source.citation, provision.sectionNumber),
    sectionNumber: provision.sectionNumber,
    heading: provision.heading,
    sourceTitle: source.title,
    sourceType: source.sourceType,
    sourceUrl: source.sourceUrl,
    localPath: source.localPath,
    sha256: source.sha256,
    retrievedAt: source.retrievedAt,
  };

  const conditions = rule.conditions.map(describeCondition);
  const inForce = `${rule.effectiveFrom} to ${rule.effectiveTo ?? 'now'}`;
  // The review the book follows (issue #718): its own decision, else the catalogue's.
  const review = ruleReviewResolver(db, { companyId: params.companyId })({ ...rule, sourceSha256: source.sha256 });
  const reviewedIn = review.from === 'catalogue' ? ` in the rules catalogue${review.by ? ` by ${review.by}` : ''}` : '';
  // Reaching `active` is what lifts the need for a person to confirm the treatment (review.ts).
  const humanReviewRequired = rule.humanReviewRequired && review.status !== 'active';

  const parts: string[] = [];
  parts.push(`Rule "${rule.name}" (${rule.ruleKey}, topic ${rule.topic}) says: ${rule.statement ?? '(no statement recorded)'}.`);
  parts.push(conditions.length > 0
    ? `It applies when ${conditions.join('; ')}.`
    : 'It states an unconditional fact of its topic: it applies whenever its topic and effective window match.');
  if (rule.exceptions.length > 0) {
    parts.push(`Exceptions, which the lookup does not evaluate automatically: ${rule.exceptions
      .map((e) => `${e.condition} — ${e.effect}`).join('; ')}.`);
  }
  const effects = [
    rule.accountingEffect && `accounting: ${rule.accountingEffect}`,
    rule.taxEffect && `tax: ${rule.taxEffect}`,
    rule.vatEffect && `VAT: ${rule.vatEffect}`,
    rule.reportingEffect && `reporting: ${rule.reportingEffect}`,
  ].filter((e): e is string => e !== null);
  if (effects.length > 0) parts.push(`Its effects are — ${effects.join('; ')}.`);
  parts.push(`It is in force from ${inForce}, and its review status is ${review.status.replace(/_/g, ' ')}${reviewedIn}`
    + `${humanReviewRequired ? '; a person must confirm any treatment it suggests' : ''}`
    + `${rule.requiresGuidance ? '; it needs Revenue guidance this knowledge base does not yet hold' : ''}.`);
  parts.push(`Source: ${citation.fullCitation} — ${provision.heading} (${source.title}), ${source.sourceUrl}.`);

  return {
    ruleId: rule.id,
    ruleKey: rule.ruleKey,
    topic: rule.topic,
    name: rule.name,
    statement: rule.statement,
    explanation: parts.join(' '),
    conditions,
    exceptions: rule.exceptions,
    effects: {
      accounting: rule.accountingEffect,
      tax: rule.taxEffect,
      vat: rule.vatEffect,
      reporting: rule.reportingEffect,
    },
    reviewStatus: review.status,
    humanReviewRequired,
    requiresGuidance: rule.requiresGuidance,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    citation,
  };
}

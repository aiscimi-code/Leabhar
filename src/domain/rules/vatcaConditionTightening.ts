/**
 * Later versions of rules whose first version was curated from the Act as
 * enacted, now re-curated from the LRC-revised text with tighter conditions.
 *
 * A released version never changes (ADR-0021 §3): its dates, quote,
 * conditions and effects are part of the released-versions hash. So a
 * tightened rule is a NEW version of the same key, and the released version
 * before it is disabled (`active = false, enabled = false`), never closed or
 * edited — the same treatment `deriveSi156CapacityExclusionRule` gives the
 * TDM version before reg. 5 (#709). Disabling is what the graph check reads:
 * two open-ended spans of one key would overlap, and a disabled row keeps the
 * history queryable without changing a byte the release hashed.
 *
 * The derive follows `deriveVatScopeRules` (issue #199's guard included: a
 * rule whose quote is not verbatim in its provision is refused, never
 * inserted) and dates each version from the LRC footnotes on its quoted words
 * (issue #206), so a version's window is the words' own, never the revised
 * page's date (AGENTS.md: a revised text does not date its own figures).
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { upsertReviewItem } from '../extraction/service';
import { taxHeadsFor } from './taxHeads';
import { preferredSourceId } from './catalogueSupersession';
import { lrcAnnotationsForSource } from './vatcaScheduleIngestion';
import { containsIgnoringLayout, quotedTextWindow } from './lrcAnnotations';
import type { IrishRuleCondition, IrishRuleException, IrishRuleType } from '@/db/schema';

const VATCA_COMMENCEMENT = '2010-11-01';

/** A tightened version of a released rule: `CuratedVatcaRule`'s shape, plus the fields the derive reads. */
export interface TightenedRule {
  /** Source citation, as ingested (the revised section's own source). */
  citation: string;
  /** Section number, matched against `irish_act_provisions.section_number`. */
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  /** The topic the released version carries; the lookup routes on it, so it must not change. */
  topic: string;
  name: string;
  statementExcerpt: string;
  conditions: IrishRuleCondition[];
  exceptions: IrishRuleException[];
  crossReferences: string[];
  vatEffect: string;
  accountingEffect: string | null;
  reportingEffect: string | null;
  /** The version's own start date when the LRC footnotes date its words no later. */
  effectiveFrom: string;
  interpretationNote: string;
}

/**
 * The s.12 reverse charge, re-curated from the revised s.12. The conditions
 * stay the three a line can evaluate; every case the line cannot — the
 * s.65(2) recipient, the s.34(a)(ii)-(iii) fallbacks, the s.34 excepted
 * paragraphs, s.12(2) public bodies and the s.33(2) exclusion, and the
 * s.12(3)-(6) limited-accountability and election regimes — is an exception
 * the lookup reports by name rather than a guess.
 */
const S12_REVERSE_CHARGE: TightenedRule = {
  citation: '2010 Act 31 s.12',
  sectionNumber: '12',
  ruleKey: 'vat.reverse_charge_services_from_abroad',
  ruleType: 'other',
  topic: 'vat',
  name: 'Reverse charge: services received from a supplier established outside the State (revised s.12)',
  // Verbatim from the revised s.12 (catalogue/vatca-2010-revised/s012.json):
  // both limbs of s.12(1), the s.65(2) recipient included.
  statementExcerpt: '( a ) a taxable person who carries on a business in the State, or a person to whom '
    + 'a registration number has been assigned in accordance with section 65 (2) , receives a service from '
    + 'a supplier established outside the State, and ( b ) the place of supply of the service (as determined '
    + 'in accordance with section 34 (a) ) is the State, then the person is accountable for, and liable to '
    + 'pay, the tax chargeable in the State as if he or she had supplied that service for consideration in '
    + 'the course or furtherance of business.',
  conditions: [
    // s.12(1)(a): "receives a service".
    { field: 'supplyType', operator: 'equals', value: 'services' },
    // s.12(1)(a): "a supplier established outside the State" — the caller's
    // own determination (EU Reg 282/2011 arts.10-11), as transactionLookup
    // resolves it; a country code alone is never it (issue #207).
    { field: 'supplierEstablishedOutsideStateResolved', operator: 'equals', value: 'true' },
    // s.12(1)(a): "a taxable person who carries on a business in the State" —
    // necessary but not sufficient; the s.65(2) recipient is an exception below.
    { field: 'vatRegistered', operator: 'equals', value: 'true' },
  ],
  exceptions: [
    {
      condition: 'the service is supplied to a fixed establishment of the recipient located outside the '
        + 'State, or the recipient has no place of business or fixed establishment and the permanent address '
        + 'or usual residence governs (VATCA 2010 s.34(a)(ii)-(iii))',
      effect: 'the place of supply is not the State, so s.12(1)(b) is not met and this rule does not apply; '
        + 'the fixed-establishment test is multi-factor (EU Reg 282/2011 arts.10-11) and no line carries it '
        + '— confirm the establishment before self-accounting',
    },
    {
      condition: 'the service is of a kind in s.34(c), (d), (g), (i), (j) or (k) (connected with immovable '
        + 'goods, passenger transport, admission to events, restaurant or catering services, restaurant or '
        + 'catering services on board a ship, aircraft or train, or short-term hiring out of a means of '
        + 'transport)',
      effect: 's.34(a) excepts those supplies from its own general rule, so s.12(1)(b) is not determined by '
        + 'it; the excepted paragraph governs the place of supply and has its own rule '
        + '(vat.place_of_supply_immovable_goods and its siblings) — this rule defers and the line is reviewed',
    },
    {
      condition: 'the recipient is not a taxable person carrying on a business in the State but a person to '
        + 'whom a registration number was assigned in accordance with s.65(2) (s.12(1)(a))',
      effect: 's.12(1) applies to such a person too, but no recorded fact states a s.65(2) number, so the '
        + 'case cannot be evaluated from the line — routed to review under that name, never treated as out '
        + 'of scope',
    },
    {
      condition: 'a taxable person carrying on a business in the State, or a public body, receives a service '
        + 'other than one of a kind referred to in s.33(2)(b), (ba) or (c) from a supplier not established in '
        + 'the State, with the place of supply the State under s.34(c) (s.12(2), as amended by Finance Act 2018 '
        + '(30/2018) s.62 and sch. 2 para. 2, LRC F31, in effect 19 December 2018)',
      effect: 's.12(2), not s.12(1), makes the recipient accountable; neither the s.34(c) place-of-supply '
        + 'category, the s.33(2)(b), (ba), (c) exclusion nor public-body status is on the line — routed to '
        + 'review under that name',
    },
    {
      condition: 'the recipient is an accountable person by virtue of this section only, being a person '
        + 'referred to in s.6(1)(a) or (b) (s.12(3)-(4))',
      effect: 'accountable only for intra-Community acquisitions of goods and the services received '
        + '(s.12(3)), unless the person elected under s.12(4) that s.12(3) not apply; the election is not '
        + 'recorded — routed to review (s.12(3)-(4) limited accountability)',
    },
    {
      condition: 'the recipient is a person referred to in s.17(2) accountable by virtue of this section '
        + '(s.12(5)-(6))',
      effect: 'accountable only for intra-Community acquisitions of goods, racehorse training services '
        + 'supplied and the services received (s.12(5)), subject to the s.12(6) election, which is not '
        + 'recorded — routed to review (s.12(5)-(6) limited accountability)',
    },
  ],
  crossReferences: [
    'VATCA 2010 s.34(a)',
    'VATCA 2010 s.65(2)',
    'VATCA 2010 s.33(2)',
    'VATCA 2010 s.12(2)-(6)',
    'Finance Act 2018 s.62',
    'EU Reg 282/2011 arts.10-11',
  ],
  vatEffect: 'The RECIPIENT (not the overseas supplier) is accountable for, and liable to pay, '
    + 'Irish VAT on the supply, as if the recipient had supplied it themself (the reverse charge). '
    + 'The recipient self-accounts for output VAT on the reverse charge and may recover it as '
    + 'input VAT in the same period, subject to the deductibility rules '
    + '(vat.input_deduction_taxable_use and the s.60(2)(a) blocks) — usually a net-nil cash '
    + 'effect where the expense is fully deductible.',
  accountingEffect: null,
  reportingEffect: null,
  effectiveFrom: VATCA_COMMENCEMENT,
  interpretationNote: 'Version 2, curated from the revised s.12 (catalogue/vatca-2010-revised/s012.json); '
    + 'the released version 1, quoted from the Act as enacted, is disabled, never changed. '
    + 's.12(1)(a)\'s "a taxable person who carries on a business in the State" maps onto '
    + '`vatRegistered = true`, necessary but not sufficient: the paragraph also covers a person '
    + 'holding a registration number assigned under s.65(2), for which no TransactionContext field '
    + 'exists — routed to review by name. s.12(1)(b) is an explicit precondition: the rule applies '
    + 'only where s.34(a) determines the place of supply of the service to be the State, declared as a '
    + '`uses_value` link to vat.place_of_supply_b2b_general; the fixed-establishment and residence '
    + 'fallbacks (s.34(a)(ii)-(iii)) and the excepted paragraphs (s.34(c), (d), (g), (i), (j), (k)) are '
    + 'routed to review with named reasons, since no line carries the multi-factor establishment test '
    + '(EU Reg 282/2011 arts.10-11). s.12(2) (a taxable person or a public body receiving a service '
    + 'other than one of s.33(2)(b), (ba) or (c), the place of supply the State under s.34(c), as amended '
    + 'by Finance Act 2018 s.62 and sch. 2 para. 2, LRC F31, 19 December 2018) and the '
    + 'limited-accountability and election regimes of s.12(3)-(6) are likewise routed to review with '
    + 'named reasons: none is evaluable from transaction facts. requiresGuidance stays set: this '
    + 'version records no approval.',
};

/** Every tightened version this module derives, keyed by its section. */
export const CONDITION_TIGHTENED_RULES: TightenedRule[] = [S12_REVERSE_CHARGE];

export interface ConditionTighteningResult {
  created: number;
  unchanged: number;
  /** Released versions disabled (never closed or edited) by their successor. */
  disabled: number;
  skippedNoProvision: string[];
  /** Rules refused because their quoted excerpt is not in the provision text. */
  skippedExcerptNotInProvision: string[];
}

/**
 * Derive each tightened rule as a new version of its key. The version before
 * it — released, its hash shipped — is disabled, never closed: its dates are
 * part of the released-versions hash, so a disabled row is the only way to
 * supersede it without the build failing on a changed release.
 */
export function deriveConditionTightenedRules(
  db: AppDatabase,
  params: { companyId: string },
): ConditionTighteningResult {
  const result: ConditionTighteningResult = {
    created: 0, unchanged: 0, disabled: 0, skippedNoProvision: [], skippedExcerptNotInProvision: [],
  };

  for (const rule of CONDITION_TIGHTENED_RULES) {
    const source = db.select().from(irishKnowledgeSources)
      .where(eq(irishKnowledgeSources.citation, rule.citation)).all()
      .find((s) => s.localPath?.startsWith('catalogue/'));
    const sourceId = source?.id ?? preferredSourceId(db, rule.citation);
    const prov = sourceId
      ? db.select().from(irishActProvisions)
        .where(and(eq(irishActProvisions.sourceId, sourceId), eq(irishActProvisions.sectionNumber, rule.sectionNumber)))
        .get()
      : undefined;
    if (!prov || !prov.relevant) { result.skippedNoProvision.push(rule.ruleKey); continue; }

    // Issue #199's guard: a rule whose quote is not verbatim in its provision
    // is refused, never inserted.
    if (!containsIgnoringLayout(prov.provisionText ?? '', rule.statementExcerpt)) {
      result.skippedExcerptNotInProvision.push(rule.ruleKey);
      continue;
    }

    // The version's window is its quoted words' own (issue #206): the latest
    // LRC amendment that touches them, else the Act's commencement.
    const annotations = source ? lrcAnnotationsForSource(db, source.id) : null;
    const window = annotations ? quotedTextWindow(annotations, [rule.statementExcerpt]) : null;
    const effectiveFrom = window?.effectiveFrom ?? rule.effectiveFrom;
    const windowNote = window
      ? (window.footnotes.length
        ? `Effective from ${effectiveFrom}, the latest LRC amendment to the quoted words: `
          + `${window.footnotes.map((f) => `${f.ref} ${f.text}`).join(' ')} `
        : `Effective from ${effectiveFrom}: the LRC records no amendment to the quoted words since the Act commenced. `)
      : '';

    const rows = db.select().from(irishTaxRules)
      .where(and(eq(irishTaxRules.companyId, params.companyId), eq(irishTaxRules.ruleKey, rule.ruleKey))).all();
    const same = rows.find((r) => r.provisionId === prov.id && r.statement === rule.statementExcerpt
      && JSON.stringify(r.conditions) === JSON.stringify(rule.conditions) && r.effectiveFrom === effectiveFrom);
    if (same) {
      // Idempotent: the tightened version already stands; make sure it, and
      // only it, is in force.
      if (!same.active || !same.enabled) {
        db.update(irishTaxRules).set({ active: true, enabled: true }).where(eq(irishTaxRules.id, same.id)).run();
      }
      for (const row of rows) {
        if (row.id !== same.id && row.active) {
          db.update(irishTaxRules).set({ active: false, enabled: false }).where(eq(irishTaxRules.id, row.id)).run();
          result.disabled++;
        }
      }
      result.unchanged++;
      continue;
    }

    // The version before it — released, its hash shipped — is disabled, never
    // closed or edited: closing it would change the released-version hash and
    // fail the build.
    const prior = rows.filter((r) => r.active || r.enabled)
      .sort((a, b) => b.ruleVersion - a.ruleVersion)[0];
    const nextVersion = rows.reduce((max, r) => Math.max(max, r.ruleVersion), 0) + 1;
    if (prior) {
      db.update(irishTaxRules).set({ active: false, enabled: false })
        .where(eq(irishTaxRules.id, prior.id)).run();
      result.disabled++;
    }

    const newRuleId = ids.taxRule();
    db.insert(irishTaxRules).values({
      id: newRuleId,
      companyId: params.companyId,
      provisionId: prov.id,
      ruleKey: rule.ruleKey,
      ruleType: rule.ruleType,
      topic: rule.topic,
      taxHeads: taxHeadsFor(rule.ruleKey, rule.topic),
      name: rule.name,
      statement: rule.statementExcerpt,
      extractedFact: null,
      humanExplanation: rule.interpretationNote,
      numericValue: null,
      unit: null,
      qualifier: 'Treatment decided from context (see vatSuggestion.ts)',
      conditions: rule.conditions,
      exceptions: rule.exceptions,
      crossReferences: rule.crossReferences,
      accountingEffect: rule.accountingEffect,
      taxEffect: null,
      vatEffect: rule.vatEffect,
      reportingEffect: rule.reportingEffect,
      requiresGuidance: true,
      humanReviewRequired: true,
      reviewStatus: 'ai_extracted',
      ruleVersion: nextVersion,
      supersedesRuleId: prior?.id ?? null,
      priority: 100,
      effectiveFrom,
      effectiveTo: null,
      active: true,
      source: 'derived',
      confidence: 70,
      provenanceStatus: 'ai_suggestion',
      sourceNote: `Curated from ${rule.citation} (LRC revised). Not yet human-reviewed. ${windowNote}${rule.interpretationNote}`,
      sourceDate: nowIso(),
    }).run();
    result.created++;

    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'unresolved_ai_suggestion',
      severity: 'info',
      title: `New Irish VAT rule version extracted: ${rule.name}`,
      detail: `${rule.citation} s.${rule.sectionNumber} (version ${nextVersion}). ${rule.interpretationNote} `
        + 'Review the condition mapping against the source text and approve, or reject, before it is '
        + 'treated as authoritative.',
      entityType: 'irish_tax_rule',
      entityId: newRuleId,
      dedupeKey: `irish_tax_rule:${newRuleId}`,
      context: { ruleKey: rule.ruleKey, sectionNumber: rule.sectionNumber, ruleVersion: nextVersion },
    });
  }

  return result;
}

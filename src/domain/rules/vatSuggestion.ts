/**
 * Statutory VAT treatment suggestion for a bank transaction (issue #200).
 *
 * The missing link between the reconciled list and the statutory knowledge
 * base: take one bank transaction, gather what the evidence actually says
 * about it (the bank line, the counterparty record, the matched invoice),
 * run the deterministic `lookupTransactionRules`, and turn the rule that
 * decided it into a concrete VAT treatment the classification form can use —
 * with the provision, source file, SHA-256 and verbatim excerpt that justify
 * it, so the screen can link to the law rather than assert it.
 *
 * It is a SUGGESTION, never a posting: every rule in the KB is still
 * `ai_extracted` until a human approves it, and the result says so. Where no
 * rule speaks to the transaction, or the rule that matched maps to no
 * configured treatment, the result says that too instead of guessing — a
 * cross-border purchase with no curated rule is never quietly given the 23%
 * domestic fallback (AGENTS.md #7: nothing is silently repaired).
 *
 * Every fact passed to the lookup is recorded with where it came from
 * (`factSources`), because several are inferences (goods vs services from a
 * treatment's supply kind, EU status from a VAT-number prefix) and a reviewer
 * must be able to see which.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  bankTransactions, companies, suppliers, customers, documents, documentLines,
  vatTreatments, irishTaxRules, irishActProvisions, irishKnowledgeSources,
} from '@/db/schema';
import { lookupTransactionRules, type ApplicableRule, type TransactionContext } from './transactionLookup';
import { countStatutoryRules } from './knowledgeBase';
import { EU_COUNTRY_CODES, parseVatNumber } from '../extraction/vatNumbers';
import { resolveTreatment } from '../vat/engine';
import { asIsoDate } from '../dates';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';
import { VAT_POS_BUSINESS_ABROAD_RULE_KEY, VAT_POS_CONSUMER_RULE_KEY } from './vatPlaceOfSupplyCuration';
import { provisionCitation } from './citation';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { SCHEDULE_RULE_PRECEDENCE } from './vatcaScheduleParagraphRules';
import { scheduleThreeRate } from './scheduleRates';
import { CROSS_BORDER_GAPS, ICA_RULE_KEY, IMPORT_RULE_KEY } from './crossBorderCuration';
import { DOMESTIC_RC_GAPS, RC_CONSTRUCTION_RULE_KEY } from './domesticReverseChargeCuration';
import {
  PROPERTY_GAPS, LETTING_OPTION_RULE_KEY, LETTING_OPTION_RESIDENTIAL_RULE_KEY, JOINT_OPTION_RULE_KEY, PROPERTY_SUPPLY_RULE_KEY,
} from './propertyCuration';
import { ADVISORY_RULE_KEYS, advisoryReasons } from './advisoryRules';
import { S46_FAMILY_SCHEDULE_REF } from './vatcaRevisedCuration';

export type TransactionDirection = 'purchase' | 'sale';

const EU = new Set<string>(EU_COUNTRY_CODES);
const isEuNotIe = (c: string | null | undefined): boolean => !!c && c !== 'IE' && EU.has(c);

/**
 * Which treatment a matched statutory rule produces (issue #200 step 1).
 *
 * Ordered by precedence: the first binding whose rule matched decides.
 * Outside the scope beats everything (no supply at all); then an exemption;
 * then a service sold to a business abroad (supplied there, s.34(a)); then a
 * deduction block (an exception to the general deduction rule); a reverse
 * charge beats a rate; a specific Schedule 2/3 or 9% rule
 * beats the reduced-rate headline; the standard rate is the residual
 * fallback. A binding whose `treatmentCode` returns null matched a rule the
 * configuration or the sources cannot settle (a Schedule 3 rate on a date
 * before the s.46(1)(ca) list is known) — that stops the search and is
 * reported, rather than falling through to a rate that is known to be wrong.
 */
export interface TreatmentBinding {
  ruleKeys: string[];
  direction: TransactionDirection | 'either';
  /** The treatment for the matched rule `ruleKey`, on the facts (including the date). */
  treatmentCode: (ctx: SuggestionFacts, ruleKey: string) => string | null;
  /** Why the binding yields no treatment, when `treatmentCode` returns null. */
  gap?: string | ((ctx: SuggestionFacts, ruleKey: string) => string);
  /** Treatments to offer the person when the binding yields none (the import choice, issue #207). */
  offer?: string[];
}

export function bindingGap(binding: TreatmentBinding, ctx: SuggestionFacts, ruleKey: string): string | undefined {
  return typeof binding.gap === 'function' ? binding.gap(ctx, ruleKey) : binding.gap;
}

/**
 * Schedule 2 and 3 paragraph rules (issue #205), in precedence order. A
 * Schedule 2 rule is zero-rated (s.46(1)(b)); a Schedule 3 rule bears the
 * rate s.46 gives its sub-paragraphs on the line's date, or none when the
 * sources cannot say (`scheduleThreeRate`).
 */
const SCHEDULE_RULES = new Map(VATCA_SCHEDULE_CURATED_RULES.map((r) => [r.ruleKey, r]));
const SCHEDULE_BINDING_KEYS = SCHEDULE_RULE_PRECEDENCE.filter((k) => SCHEDULE_RULES.has(k));

function scheduleRate(ctx: SuggestionFacts, ruleKey: string): { code: string | null; provision: string; gap?: string } {
  const r = SCHEDULE_RULES.get(ruleKey);
  if (!r || r.scheduleNumber === '2') return { code: 'IE_ZERO' as const, provision: 'VATCA 2010 s.46(1)(b)' };
  const refs = r.rateRefs ?? [];
  if (refs.length === 0) return { code: null, provision: 's.46', gap: `Rule ${ruleKey} names no Schedule 3 sub-paragraph.` };
  return scheduleThreeRate(refs[0]!, ctx.transactionDate);
}

const scopeKeys = (treatment: 'IE_EXEMPT' | 'OUT_OF_SCOPE'): string[] =>
  VAT_SCOPE_CURATED_RULES.filter((r) => r.treatment === treatment).map((r) => r.ruleKey);

export const RULE_TREATMENT_BINDINGS: TreatmentBinding[] = [
  // The s.16 domestic reverse charges (issue #208) come first: s.16(3) applies to construction
  // services a principal receives wherever the subcontractor is established.
  { ruleKeys: [RC_CONSTRUCTION_RULE_KEY], direction: 'purchase', treatmentCode: () => 'RC_CONSTRUCTION' },
  // Property (issue #208 part 2): rent invoiced with VAT is an opted letting (s.97(1)(c)(ii)),
  // unless it is residential (s.97(4)); a sale of property, or a joint option, is flagged.
  {
    ruleKeys: [LETTING_OPTION_RESIDENTIAL_RULE_KEY],
    direction: 'purchase',
    treatmentCode: () => null,
    gap: PROPERTY_GAPS[LETTING_OPTION_RESIDENTIAL_RULE_KEY],
  },
  { ruleKeys: [LETTING_OPTION_RULE_KEY], direction: 'purchase', treatmentCode: () => 'IE_STD' },
  {
    ruleKeys: [JOINT_OPTION_RULE_KEY],
    direction: 'purchase',
    treatmentCode: () => null,
    gap: PROPERTY_GAPS[JOINT_OPTION_RULE_KEY],
    offer: ['RC_CONSTRUCTION'],
  },
  { ruleKeys: [PROPERTY_SUPPLY_RULE_KEY], direction: 'either', treatmentCode: () => null, gap: PROPERTY_GAPS[PROPERTY_SUPPLY_RULE_KEY] },
  {
    ruleKeys: ['vat.domestic_reverse_charge_scrap_metal'],
    direction: 'purchase',
    treatmentCode: () => null,
    gap: DOMESTIC_RC_GAPS['vat.domestic_reverse_charge_scrap_metal'],
    offer: ['RC_CONSTRUCTION'],
  },
  {
    ruleKeys: Object.keys(DOMESTIC_RC_GAPS).filter((k) => k !== 'vat.domestic_reverse_charge_scrap_metal'
      && !ADVISORY_RULE_KEYS.has(k)),
    direction: 'either',
    treatmentCode: () => null,
    gap: (_f, key) => DOMESTIC_RC_GAPS[key]!,
  },
  // Not a supply at all: nothing else about VAT applies (s.2(1), s.3).
  { ruleKeys: scopeKeys('OUT_OF_SCOPE'), direction: 'either', treatmentCode: () => 'OUT_OF_SCOPE' },
  // An exempt supply: no VAT, and so no reverse charge or rate either (Schedule 1).
  { ruleKeys: scopeKeys('IE_EXEMPT'), direction: 'either', treatmentCode: () => 'IE_EXEMPT' },
  // Loan and overdraft interest: whether granting credit is still exempt cannot be
  // established from the sources (issue #206), so it is flagged, never rated.
  {
    ruleKeys: ['vat.loan_interest_undetermined'],
    direction: 'either',
    treatmentCode: () => null,
    gap: 'Whether loan or overdraft interest is exempt cannot be confirmed: Schedule 1 para 6(1) no longer lists '
      + 'granting credit (words deleted by Finance (No. 2) Act 2023 s.63), and where they went is not in the '
      + 'repository. Choose the treatment manually.',
  },
  // Cross-border (issue #207): an acquisition is decided; an import from the customs
  // entry's own markers; the place-of-supply exceptions, distance sales, s.10 and
  // s.35 are flagged with why, and outrank the general s.34(a) and s.12 rules.
  { ruleKeys: [ICA_RULE_KEY], direction: 'purchase', treatmentCode: () => 'EU_GOODS_ACQ' },
  {
    ruleKeys: [IMPORT_RULE_KEY],
    direction: 'purchase',
    treatmentCode: (f) => (/\b(IEPOSTPONED|1A05)\b/i.test(String(f.description ?? '')) ? 'IMPORT_PA'
      : /\bB00\b/.test(String(f.description ?? '')) ? 'IMPORT_VAT_PAID' : null),
    gap: CROSS_BORDER_GAPS[IMPORT_RULE_KEY],
    offer: ['IMPORT_PA', 'IMPORT_VAT_PAID'],
  },
  {
    ruleKeys: Object.keys(CROSS_BORDER_GAPS).filter((k) => k !== IMPORT_RULE_KEY),
    direction: 'either',
    treatmentCode: () => null,
    gap: (_f, key) => CROSS_BORDER_GAPS[key]!,
  },
  // A service sold to a business established abroad is supplied there, not here (s.34(a)).
  {
    ruleKeys: [VAT_POS_BUSINESS_ABROAD_RULE_KEY],
    direction: 'sale',
    treatmentCode: (f) => (isEuNotIe(f.counterpartyCountry) ? 'EU_SERVICES_SUPPLY' : 'NON_EU_SERVICES_SUPPLY'),
  },
  {
    ruleKeys: ['vat.deduction_exclusions_entertainment'],
    direction: 'purchase',
    treatmentCode: () => 'NON_DEDUCTIBLE',
  },
  {
    ruleKeys: ['vat.reverse_charge_services_from_abroad'],
    direction: 'purchase',
    treatmentCode: (f) => (isEuNotIe(f.counterpartyCountry) ? 'EU_SERVICES_RCV' : 'NON_EU_SERVICES_RCV'),
  },
  {
    ruleKeys: ['vat.zero_rate_intra_community_goods'],
    direction: 'sale',
    treatmentCode: () => 'EU_GOODS_SUPPLY',
  },
  {
    ruleKeys: ['vat.zero_rate_export_outside_community'],
    direction: 'sale',
    treatmentCode: () => 'IE_ZERO',
  },
  {
    ruleKeys: SCHEDULE_BINDING_KEYS,
    direction: 'either',
    treatmentCode: (f, key) => scheduleRate(f, key).code,
    gap: (f, key) => scheduleRate(f, key).gap ?? 'No rate could be determined for this Schedule 3 paragraph.',
  },
  {
    // s.46 families whose versions move between 13.5% and 9% (issue #205): the
    // rate on the line's date, from the same s.46 windows as Schedule 3.
    ruleKeys: Object.keys(S46_FAMILY_SCHEDULE_REF),
    direction: 'either',
    treatmentCode: (f, key) => scheduleThreeRate(S46_FAMILY_SCHEDULE_REF[key]!, f.transactionDate).code,
    gap: (f, key) => scheduleThreeRate(S46_FAMILY_SCHEDULE_REF[key]!, f.transactionDate).gap
      ?? 'No rate could be determined for this date.',
  },
  {
    ruleKeys: ['vat.rate_livestock_current'],
    direction: 'either',
    treatmentCode: () => 'IE_LIVESTOCK',
  },
  {
    ruleKeys: [
      'vat.rate_periodicals_9pct_current', 'vat.rate_sporting_facilities_9pct_current',
      'vat.rate_heat_pump_installation_9pct_current', 'vat.rate_gas_electricity_9pct_current',
      'vat.rate_social_housing_apartment_9pct_2025_narrow', 'vat.rate_social_housing_apartment_9pct_current',
      'vat.rate_printed_matter_9pct_2020_2023',
      'vat.rate_admission_9pct_2020_2023', 'vat.rate_hotel_accommodation_9pct_2020_2023',
    ],
    direction: 'either',
    treatmentCode: () => 'IE_SECOND_RED',
  },
  {
    ruleKeys: [
      'vat.rate_reduced_current',
    ],
    direction: 'either',
    treatmentCode: () => 'IE_RED',
  },
  {
    ruleKeys: ['vat.rate_standard_current'],
    direction: 'either',
    treatmentCode: () => 'IE_STD',
  },
];

/** The context passed to the lookup, plus the facts only the binding step needs. */
export type SuggestionFacts = TransactionContext & {
  direction: TransactionDirection;
  counterpartyCountry: string | null;
};

export interface StatutoryCitation {
  ruleId: string;
  ruleKey: string;
  ruleName: string;
  provisionId: string;
  citation: string;
  sectionNumber: string;
  heading: string;
  sourceType: string;
  sourceUrl: string;
  localPath: string | null;
  sha256: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  /** The rule's verbatim excerpt from the provision text. */
  quote: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  reviewStatus: string;
  requiresGuidance: boolean;
}

export type VatSuggestionStatus =
  | 'suggested'          // a specific rule matched and maps to a configured treatment
  | 'fallback_only'      // only the residual standard-rate rule matched: 23% applies IF this is a
                         // taxable supply, but the KB curates only some exemption and outside-scope
                         // rules, so it cannot rule the rest out (issue #200); never pre-selected
  | 'no_treatment'       // a rule matched but maps to no configured treatment
  | 'no_rule'            // no bound rule matched this transaction
  | 'kb_empty';          // the statutory knowledge base has not been loaded for this company

export interface VatSuggestion {
  status: VatSuggestionStatus;
  bankTransactionId: string;
  treatment: { id: string; code: string; name: string } | null;
  /** The rate the deciding rule itself states, in basis points, when it states one. */
  ruleRateBasisPoints: number | null;
  /** The rate the configured treatment would charge on the transaction date. */
  configuredRateBasisPoints: number | null;
  /** False when the rule's stated rate and the configured rate disagree (issue #199 CONFIG_NOT_KB). */
  rateAgrees: boolean | null;
  decidingRule: StatutoryCitation | null;
  /** Other statutory rules that matched (deductibility, place of supply, filing...). */
  supportingRules: StatutoryCitation[];
  facts: SuggestionFacts;
  factSources: Record<string, string>;
  unresolvedFields: string[];
  reviewReasons: string[];
  /** Whether the suggestion matches the treatment already on the transaction (null when none is booked). */
  agreesWithBooked: boolean | null;
  /** Always true today: no statutory rule is approved yet. */
  reviewRequired: boolean;
  /** Treatment codes to offer when the rule matched but the evidence cannot choose between them (the import entry, issue #207). */
  offeredTreatmentCodes: string[];
  explanation: string;
}

/**
 * Gather the facts the lookup needs from the evidence already in the books.
 * Nothing is invented: a fact the evidence does not state is left absent, and
 * the lookup reports it as unresolved.
 */
export function transactionFacts(
  db: AppDatabase,
  params: { companyId: string; bankTransactionId: string },
): { facts: SuggestionFacts; factSources: Record<string, string> } | null {
  const tx = db.select().from(bankTransactions)
    .where(and(eq(bankTransactions.id, params.bankTransactionId), eq(bankTransactions.companyId, params.companyId)))
    .get();
  if (!tx) return null;

  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get();
  // Only a confirmed document is evidence. A draft extraction is unchecked OCR
  // and never feeds a VAT suggestion (the invoice is the proof; a misread one is not).
  const doc = db.select().from(documents)
    .where(and(
      eq(documents.companyId, params.companyId),
      eq(documents.matchedTransactionId, tx.id),
      eq(documents.reviewStatus, 'confirmed'),
    ))
    .get();
  const field = (name: 'supplierVatNumber' | 'customerVatNumber' | 'supplierCountry' | 'customerCountry'): string | null => {
    const v = doc?.[name];
    return v === undefined || v === null || v === '' ? null : v;
  };

  const direction: TransactionDirection = tx.amountMinor < 0 ? 'purchase' : 'sale';
  const sources: Record<string, string> = {
    direction: `bank amount ${tx.amountMinor < 0 ? 'negative (money out)' : 'positive (money in)'}`,
  };

  const supplierId = tx.supplierId ?? doc?.supplierId ?? null;
  const customerId = tx.customerId ?? doc?.customerId ?? null;
  const supplier = direction === 'purchase' && supplierId
    ? db.select().from(suppliers).where(eq(suppliers.id, supplierId)).get() : undefined;
  const customer = direction === 'sale' && customerId
    ? db.select().from(customers).where(eq(customers.id, customerId)).get() : undefined;
  const party = supplier ?? customer;
  const partyLabel = supplier ? 'supplier' : 'customer';

  // Counterparty country: the party record, then the invoice, then a VAT-number prefix.
  const vatNumber = party?.vatNumber
    ?? (direction === 'purchase' ? field('supplierVatNumber') : field('customerVatNumber'));
  const vatInfo = vatNumber ? parseVatNumber(vatNumber) : null;
  let counterpartyCountry: string | null = null;
  if (party?.countryCode) {
    counterpartyCountry = party.countryCode.toUpperCase();
    sources.counterpartyCountry = `${partyLabel} record "${party.name}"`;
  } else if (direction === 'purchase' && field('supplierCountry')) {
    counterpartyCountry = field('supplierCountry')!.toUpperCase();
    sources.counterpartyCountry = 'confirmed invoice (supplier country)';
  } else if (direction === 'sale' && field('customerCountry')) {
    counterpartyCountry = field('customerCountry')!.toUpperCase();
    sources.counterpartyCountry = 'confirmed invoice (customer country)';
  } else if (vatInfo?.countryCode) {
    counterpartyCountry = vatInfo.countryCode;
    sources.counterpartyCountry = `VAT number prefix (${vatInfo.normalised})`;
  }

  // Goods vs services: only from a treatment someone (or a rule) already
  // attached, which states its own supply kind. Never guessed from text.
  const kindCandidates: Array<[string | null | undefined, string]> = [
    [tx.vatTreatmentId, 'the treatment already on this transaction'],
    [party?.defaultVatTreatmentId, `${partyLabel} default treatment`],
    [doc?.suggestedVatTreatmentId, 'the matched invoice\'s suggested treatment (itself a suggestion)'],
  ];
  let supplyType: 'goods' | 'services' | null = null;
  for (const [id, label] of kindCandidates) {
    if (!id) continue;
    const t = db.select({ supplyKind: vatTreatments.supplyKind, code: vatTreatments.code })
      .from(vatTreatments).where(eq(vatTreatments.id, id)).get();
    if (t && (t.supplyKind === 'goods' || t.supplyKind === 'services')) {
      supplyType = t.supplyKind;
      sources.supplyType = `${label} (${t.code}, supply kind ${t.supplyKind})`;
      break;
    }
  }

  // What was supplied: from the confirmed invoice's own lines and VAT wording
  // when there is one (issue #206); the bank narrative only when there is not.
  const docLines = doc
    ? db.select({ description: documentLines.description }).from(documentLines)
      .where(eq(documentLines.documentId, doc.id)).all().map((l) => l.description).filter(Boolean)
    : [];
  const description = doc && docLines.length
    ? [...docLines, party?.name, ...(doc.vatLegends ?? [])].filter(Boolean).join(' ')
    : [tx.description, tx.counterpartyName, party?.name].filter(Boolean).join(' ');
  sources.description = doc && docLines.length
    ? `the ${docLines.length} line(s) of confirmed invoice "${doc.originalFilename}"`
    : 'the bank description (no confirmed invoice with lines)';

  const facts: SuggestionFacts = {
    transactionDate: tx.transactionDate,
    amountMinor: Math.abs(tx.amountMinor),
    currency: tx.currency,
    direction,
    counterpartyCountry,
    description,
    transactionType: tx.transactionType,
    vatRegistered: company ? company.vatRegistrationStatus === 'registered' : null,
    invoiceAvailable: !!doc,
    supplyType,
  };
  sources.vatRegistered = `company VAT registration status (${company?.vatRegistrationStatus ?? 'unknown'})`;
  applyEstablishment(facts, sources, { supplier, customer });
  sources.invoiceAvailable = doc ? `confirmed document "${doc.originalFilename}"` : 'no confirmed matched document';

  if (direction === 'purchase') {
    facts.supplierCountry = counterpartyCountry;
    if (counterpartyCountry) sources.supplierCountry = sources.counterpartyCountry!;
  } else {
    facts.customerCountry = counterpartyCountry;
    if (counterpartyCountry) sources.customerCountry = sources.counterpartyCountry!;
    if (vatInfo) {
      // VIES's answer for this exact number, when there is one (issue #207).
      const vies = customer?.viesStatus && customer.viesCheckedVatNumber === vatInfo.normalised ? customer.viesStatus : null;
      facts.customerVatRegisteredEu = vatInfo.structurallyValid && vatInfo.isEu && !vatInfo.isIrish && vies !== 'invalid';
      sources.customerVatRegisteredEu = vies === 'valid'
        ? `customer VAT number ${vatInfo.normalised}, confirmed valid by VIES on ${customer!.viesCheckedAt?.slice(0, 10)}`
        : vies === 'invalid'
          ? `customer VAT number ${vatInfo.normalised} reported INVALID by VIES on ${customer!.viesCheckedAt?.slice(0, 10)}`
          : `customer VAT number ${vatInfo.normalised} (structural check only, not checked with VIES)`;
    }
    // VATCA s.34(a)/(b) turns on whether the customer buys as a taxable person.
    // A recorded status wins; otherwise an EU VAT number is evidence of it
    // (282/2011 art.18(1)); a missing number is NOT evidence of a consumer.
    applyCustomerStatus(facts, sources, customer, vatInfo);
    if (supplyType === 'goods' && counterpartyCountry && !EU.has(counterpartyCountry)) {
      facts.goodsExportedOutsideEu = true;
      sources.goodsExportedOutsideEu = `derived: goods sale to a customer in ${counterpartyCountry} `
        + '(customer country, not proof of export)';
    }
  }
  if (doc?.vatMinor != null) {
    facts.vatChargedMinor = doc.vatMinor;
    sources.vatChargedMinor = 'matched document';
  }
  return { facts, factSources: sources };
}

function citationFor(db: AppDatabase, rule: ApplicableRule): StatutoryCitation {
  const row = db.select({
    rule: irishTaxRules, provision: irishActProvisions, source: irishKnowledgeSources,
  }).from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishTaxRules.provisionId, irishActProvisions.id))
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(eq(irishTaxRules.id, rule.ruleId)).get()!;
  return {
    ruleId: row.rule.id,
    ruleKey: row.rule.ruleKey,
    ruleName: row.rule.name,
    provisionId: row.provision.id,
    citation: row.source.citation,
    sectionNumber: row.provision.sectionNumber,
    heading: row.provision.heading,
    sourceType: row.source.sourceType,
    sourceUrl: row.source.sourceUrl,
    localPath: row.source.localPath,
    sha256: row.source.sha256,
    sourceStart: row.provision.sourceStart,
    sourceEnd: row.provision.sourceEnd,
    quote: row.rule.statement,
    effectiveFrom: row.rule.effectiveFrom,
    effectiveTo: row.rule.effectiveTo,
    reviewStatus: row.rule.reviewStatus,
    requiresGuidance: row.rule.requiresGuidance,
  };
}

export function suggestVatTreatment(
  db: AppDatabase,
  params: { companyId: string; bankTransactionId: string },
): VatSuggestion | null {
  const gathered = transactionFacts(db, params);
  if (!gathered) return null;
  const booked = db.select({ vatTreatmentId: bankTransactions.vatTreatmentId }).from(bankTransactions)
    .where(eq(bankTransactions.id, params.bankTransactionId)).get()?.vatTreatmentId ?? null;
  const suggestion = suggestFromFacts(db, {
    companyId: params.companyId, subjectId: params.bankTransactionId, ...gathered, bookedTreatmentId: booked,
  });
  // A bank line is only ever a pointer to what was bought (issue #206): with a
  // confirmed invoice, each of its lines is coded on posting; without one, the
  // bank words are all the rules had, and a person confirms them.
  const reason = gathered.facts.invoiceAvailable
    ? `Read from ${gathered.factSources.description}. An invoice with lines at different treatments is coded `
      + 'line by line when it is posted; this is one suggestion for the whole payment.'
    : 'No confirmed invoice: this rests on the bank description alone. Confirm it, or attach and confirm the invoice.';
  return { ...suggestion, reviewRequired: true, reviewReasons: [...suggestion.reviewReasons, reason] };
}

/**
 * The statutory suggestion for a set of facts — a bank transaction's, or one
 * line of a confirmed invoice's (issue #203). `subjectId` identifies what the
 * facts describe; `bookedTreatmentId` is the treatment already on it, if any.
 */
export function suggestFromFacts(
  db: AppDatabase,
  params: {
    companyId: string; subjectId: string; facts: SuggestionFacts; factSources: Record<string, string>;
    bookedTreatmentId: string | null;
  },
): VatSuggestion {
  const { facts, factSources } = params;

  const base = {
    bankTransactionId: params.subjectId,
    treatment: null,
    ruleRateBasisPoints: null,
    configuredRateBasisPoints: null,
    rateAgrees: null,
    decidingRule: null,
    agreesWithBooked: null,
    supportingRules: [] as StatutoryCitation[],
    facts,
    factSources,
    reviewRequired: true,
    offeredTreatmentCodes: [] as string[],
  };

  if (countStatutoryRules(db, params.companyId) === 0) {
    return {
      ...base, status: 'kb_empty', unresolvedFields: [], reviewReasons: [],
      explanation: 'The statutory knowledge base has not been loaded for this company, so no rule can be applied.',
    };
  }

  const lookup = lookupTransactionRules(db, { companyId: params.companyId, transaction: facts });
  const reviewReasons = [...lookup.reviewReasons];
  const establishmentKnown = facts.direction === 'purchase'
    ? facts.supplierEstablishedOutsideState != null : facts.customerEstablishedOutsideState != null;
  if (!establishmentKnown && facts.counterpartyCountry && facts.counterpartyCountry !== 'IE') {
    reviewReasons.push(
      `The ${facts.direction === 'purchase' ? 'supplier' : 'customer'} is in ${facts.counterpartyCountry}, but where it `
      + 'is established (EU Reg 282/2011 arts.10-11: seat of economic activity or fixed establishment) has not been '
      + 'confirmed. A country is not an establishment: confirm it on the party\'s record (issue #207).',
    );
  }

  const matched = new Map(lookup.applicableRules.map((r) => [r.ruleKey, r]));
  // Advisory rules (issue #208): a fact they turn on is unrecorded, so they flag, never decide.
  reviewReasons.push(...advisoryReasons(matched.keys()));
  let decision: { rule: ApplicableRule; binding: TreatmentBinding } | null = null;
  for (const binding of RULE_TREATMENT_BINDINGS) {
    if (binding.direction !== 'either' && binding.direction !== facts.direction) continue;
    const rule = binding.ruleKeys.map((k) => matched.get(k)).find((r) => r !== undefined);
    if (rule) { decision = { rule, binding }; break; }
  }

  // The domestic standard-rate fallback is never applied to a cross-border
  // counterparty: that case needs a reverse-charge, acquisition, import or
  // supply rule, and when none matched the honest answer is "no rule".
  // Except a service sold to a consumer abroad: s.34(b) puts its place of
  // supply here, so the domestic rate rules do apply (subject to (kc)).
  const consumerSaleHere = matched.has(VAT_POS_CONSUMER_RULE_KEY);
  if (consumerSaleHere && facts.counterpartyCountry && facts.counterpartyCountry !== 'IE') {
    reviewReasons.push(
      `A service sold to a consumer in ${facts.counterpartyCountry} is supplied in the State (s.34(b)), so Irish VAT `
      + 'applies — unless it is a telecoms, broadcasting or electronically supplied service, which is taxed where '
      + 'the consumer is (s.34(kc), One-Stop Shop; not modelled).',
    );
  }
  if (decision?.rule.ruleKey === 'vat.rate_standard_current' && !consumerSaleHere
      && facts.counterpartyCountry && facts.counterpartyCountry !== 'IE') {
    reviewReasons.push(
      `The counterparty is in ${facts.counterpartyCountry}; no curated rule covers this cross-border `
      + `${facts.direction}${facts.supplyType ? ` of ${facts.supplyType}` : ''}, so the domestic 23% fallback `
      + 'was not applied (issue #200 coverage gap).',
    );
    decision = null;
  }
  if (decision?.rule.ruleKey === 'vat.rate_standard_current' && !facts.counterpartyCountry) {
    reviewReasons.push('The counterparty\'s country is unknown; the domestic standard rate is a fallback, not a finding.');
  }

  const decidingRule = decision ? citationFor(db, decision.rule) : null;
  const supportingRules = lookup.applicableRules
    .filter((r) => r.ruleId !== decision?.rule.ruleId)
    .map((r) => citationFor(db, r));

  if (!decision) {
    return {
      ...base, status: 'no_rule', supportingRules,
      unresolvedFields: lookup.unresolvedFields, reviewReasons,
      explanation: 'No statutory rule that determines a VAT treatment matched this transaction. '
        + 'Choose the treatment manually; see the review reasons for what is missing.',
    };
  }

  const code = decision.binding.treatmentCode(facts, decision.rule.ruleKey);
  const ruleRow = db.select({ numericValue: irishTaxRules.numericValue, unit: irishTaxRules.unit })
    .from(irishTaxRules).where(eq(irishTaxRules.id, decision.rule.ruleId)).get();
  const ruleRateBasisPoints = ruleRow?.unit === 'percent' && ruleRow.numericValue != null
    ? Math.round(ruleRow.numericValue * 100)
    : (code === 'IE_ZERO' || code === 'EU_GOODS_SUPPLY' ? 0 : null);

  const where = provisionCitation(decidingRule!.citation, decidingRule!.sectionNumber);
  const gap = bindingGap(decision.binding, facts, decision.rule.ruleKey);
  if (code === null) {
    return {
      ...base, status: 'no_treatment', ruleRateBasisPoints, decidingRule, supportingRules,
      offeredTreatmentCodes: decision.binding.offer ?? [],
      unresolvedFields: lookup.unresolvedFields,
      reviewReasons: [...reviewReasons, gap ?? 'No treatment is configured for this rule.'],
      explanation: `Rule "${decidingRule!.ruleName}" (${where}) matched, but it maps to no configured VAT treatment. `
        + (gap ?? ''),
    };
  }

  const treatment = db.select({ id: vatTreatments.id, code: vatTreatments.code, name: vatTreatments.name })
    .from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, params.companyId), eq(vatTreatments.code, code), eq(vatTreatments.active, true)))
    .get();
  if (!treatment) {
    return {
      ...base, status: 'no_treatment', ruleRateBasisPoints, decidingRule, supportingRules,
      unresolvedFields: lookup.unresolvedFields,
      reviewReasons: [...reviewReasons, `The treatment ${code} is not configured (or not active) for this company.`],
      explanation: `Rule "${decidingRule!.ruleName}" (${where}) points to treatment ${code}, which this company does not have.`,
    };
  }

  let configuredRateBasisPoints: number | null = null;
  try {
    configuredRateBasisPoints = resolveTreatment(db, {
      companyId: params.companyId, treatmentId: treatment.id, onDate: asIsoDate(facts.transactionDate),
    }).rateBasisPoints;
  } catch (err) {
    reviewReasons.push(`The configured rate could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rateAgrees = ruleRateBasisPoints !== null && configuredRateBasisPoints !== null
    ? ruleRateBasisPoints === configuredRateBasisPoints : null;
  if (rateAgrees === false) {
    reviewReasons.push(
      `The rule states ${ruleRateBasisPoints! / 100}% but the configured ${treatment.code} rate on `
      + `${facts.transactionDate} is ${configuredRateBasisPoints! / 100}%.`,
    );
  }

  if (decision.rule.ruleKey === 'vat.zero_rate_export_outside_community') {
    reviewReasons.push(
      'Zero-rating an export needs proof that the goods were transported outside the EU (Sch.2 para 3(1)): the '
      + 'customs export declaration (its MRN) and the transport documents. The customer\'s country is not proof; '
      + 'without it the sale is taxable here.',
    );
  }
  const fallbackOnly = decision.rule.ruleKey === 'vat.rate_standard_current';
  if (fallbackOnly) {
    reviewReasons.push(
      'Only the residual standard-rate rule matched. It applies to a taxable supply that no zero, reduced or '
      + 'exemption rule covers — but the knowledge base curates only five Schedule 1 exemptions (postal, bank '
      + 'account services, insurance, letting, passenger transport) and four outside-the-scope categories '
      + '(wages, tax payments, capital/loans/dividends, own-account transfers), matched on description '
      + 'keywords, so it cannot rule out an exemption or scope question it has no rule for (issue #200).',
    );
  }
  const booked = params.bookedTreatmentId;
  const agreesWithBooked = booked ? booked === treatment.id : null;
  if (agreesWithBooked === false) {
    reviewReasons.push('The treatment already chosen differs from the statutory suggestion.');
  }

  return {
    ...base,
    status: fallbackOnly ? 'fallback_only' : 'suggested',
    treatment,
    ruleRateBasisPoints,
    configuredRateBasisPoints,
    rateAgrees,
    decidingRule,
    agreesWithBooked,
    supportingRules,
    unresolvedFields: lookup.unresolvedFields,
    reviewReasons: [...new Set(reviewReasons)],
    reviewRequired: true,
    explanation: fallbackOnly
      ? `No specific rule matched. ${treatment.name} applies only if this is a taxable supply that is not `
        + 'exempt or outside the scope of VAT, which the statutory rules cannot yet determine. Choose the treatment yourself.'
      : `Suggested ${treatment.name} because rule "${decidingRule!.ruleName}" (${where}) matched this `
        + `${facts.direction}. It is a suggestion: the rule is ${decidingRule!.reviewStatus.replace('_', '-')} and `
        + 'has not been approved by a person.',
  };
}

/**
 * The establishment a person confirmed on the supplier or customer record
 * (issue #207), as the facts the place-of-supply and reverse-charge rules
 * need. Nothing is inferred when it is not recorded.
 */
export function applyEstablishment(
  facts: SuggestionFacts,
  sources: Record<string, string>,
  parties: {
    supplier?: { name: string; establishment: string | null; establishmentConfirmedBy: string | null; establishmentConfirmedAt: string | null };
    customer?: { name: string; establishment: string | null; establishmentConfirmedBy: string | null; establishmentConfirmedAt: string | null };
  },
): void {
  const describe = (p: { name: string; establishment: string | null; establishmentConfirmedBy: string | null; establishmentConfirmedAt: string | null }) =>
    `${p.name}: established ${p.establishment === 'outside_state' ? 'outside' : 'in'} the State, confirmed by `
    + `${p.establishmentConfirmedBy ?? 'unknown'}${p.establishmentConfirmedAt ? ` on ${p.establishmentConfirmedAt.slice(0, 10)}` : ''}`;
  if (parties.supplier?.establishment) {
    facts.supplierEstablishedOutsideState = parties.supplier.establishment === 'outside_state';
    sources.supplierEstablishedOutsideState = describe(parties.supplier);
  }
  if (parties.customer?.establishment) {
    facts.customerEstablishedOutsideState = parties.customer.establishment === 'outside_state';
    sources.customerEstablishedOutsideState = describe(parties.customer);
  }
}

/**
 * Whether the customer buys as a taxable person (s.34(a)/(b)), from what is
 * on record (issue #207): a status a person recorded wins; otherwise a
 * well-formed EU VAT number is evidence of it (EU Reg 282/2011 art.18(1)),
 * stronger when VIES confirmed that number, and no evidence at all once VIES
 * has said it is invalid.
 */
export function applyCustomerStatus(
  facts: SuggestionFacts,
  sources: Record<string, string>,
  customer: {
    name: string; taxableStatus: string | null; taxableStatusConfirmedBy?: string | null;
    vatNumber: string | null; viesStatus?: string | null; viesCheckedVatNumber?: string | null;
    viesCheckedAt?: string | null; viesRequestIdentifier?: string | null;
  } | undefined,
  vatInfo: ReturnType<typeof parseVatNumber> | null,
): void {
  if (customer?.taxableStatus) {
    facts.customerIsTaxablePerson = customer.taxableStatus === 'taxable_person';
    sources.customerIsTaxablePerson = `customer record "${customer.name}" (${customer.taxableStatus}`
      + `${customer.taxableStatusConfirmedBy ? `, confirmed by ${customer.taxableStatusConfirmedBy}` : ''})`;
    return;
  }
  if (!vatInfo?.structurallyValid || !vatInfo.isEu) return;
  const checked = customer?.viesStatus && customer.viesCheckedVatNumber === vatInfo.normalised ? customer.viesStatus : null;
  if (checked === 'invalid') {
    sources.customerIsTaxablePerson = `customer VAT number ${vatInfo.normalised} was reported INVALID by VIES on `
      + `${customer!.viesCheckedAt?.slice(0, 10) ?? 'an earlier check'}; it is not evidence of taxable status`;
    return;
  }
  facts.customerIsTaxablePerson = true;
  sources.customerIsTaxablePerson = checked === 'valid'
    ? `customer VAT number ${vatInfo.normalised}, confirmed valid by VIES on ${customer!.viesCheckedAt?.slice(0, 10)}`
      + `${customer!.viesRequestIdentifier ? ` (consultation ${customer!.viesRequestIdentifier})` : ''} (EU Reg 282/2011 art.18(1))`
    : `customer VAT number ${vatInfo.normalised} (EU Reg 282/2011 art.18(1) evidence; structural check only, `
      + 'not checked with VIES)';
}

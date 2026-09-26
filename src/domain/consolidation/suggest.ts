import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, suppliers, customers, vatTreatments } from '@/db/schema';
import { asIsoDate } from '../dates';
import { resolveTreatment } from '../vat/engine';
import { parseVatNumber, EU_COUNTRY_CODES } from '../extraction/vatNumbers';
import { suggestFromFacts, type SuggestionFacts, type VatSuggestion } from '../rules/vatSuggestion';
import { documentEvidenceLines, type EvidenceLine } from './postDocument';
import { checkLineRate, type LineRateCheck } from '../rules/lineRateCheck';
import { applyCompositeSupply } from './compositeSupply';

/**
 * The choices for coding each line of a confirmed document (issue #203).
 *
 * Nothing here decides. Every candidate treatment comes with the reason it is
 * offered — a statutory rule that matched the document's facts, the
 * treatment confirmed for this supplier before, the rate printed on the
 * line, or VAT wording printed on the invoice. One is pre-selected only when
 * every source agrees on it; otherwise the person chooses, and the screen
 * says why there is a choice.
 */

export interface TreatmentOption {
  treatmentId: string;
  code: string;
  name: string;
  reasons: string[];
  /** Statutory rules behind this option, recorded on the line when chosen. */
  ruleKeys: string[];
}

export interface LineChoices {
  line: EvidenceLine;
  options: TreatmentOption[];
  /** Set only when every source agrees on one treatment. */
  preselectedTreatmentId: string | null;
  accountId: string | null;
  accountReason: string | null;
  statutory: VatSuggestion;
  /** Whether the rate printed on the line is the rate the rules give (issue #205). */
  rateCheck: LineRateCheck;
  /** Why a choice is needed, when one is. */
  flags: string[];
}

const EU = new Set<string>(EU_COUNTRY_CODES);

export function documentLineChoices(db: AppDatabase, params: { companyId: string; documentId: string }): {
  direction: 'sales' | 'purchase';
  lines: LineChoices[];
} {
  const { document: doc, direction, lines } = documentEvidenceLines(db, params);
  const company = db.select().from(companies).where(eq(companies.id, params.companyId)).get()!;
  const isSale = direction === 'sales';
  const party = isSale
    ? (doc.customerId ? db.select().from(customers).where(eq(customers.id, doc.customerId)).get() : undefined)
    : (doc.supplierId ? db.select().from(suppliers).where(eq(suppliers.id, doc.supplierId)).get() : undefined);
  const partyLabel = isSale ? 'customer' : 'supplier';
  const onDate = asIsoDate(doc.supplyDate ?? doc.documentDate ?? new Date().toISOString().slice(0, 10));

  // ---- Facts from the confirmed document ----
  const sources: Record<string, string> = {};
  const vatNumber = party?.vatNumber ?? (isSale ? doc.customerVatNumber : doc.supplierVatNumber);
  const vatInfo = vatNumber ? parseVatNumber(vatNumber) : null;
  let country: string | null = null;
  if (party?.countryCode) { country = party.countryCode.toUpperCase(); sources.counterpartyCountry = `${partyLabel} record "${party.name}"`; }
  else if ((isSale ? doc.customerCountry : doc.supplierCountry)) {
    country = (isSale ? doc.customerCountry : doc.supplierCountry)!.toUpperCase();
    sources.counterpartyCountry = `confirmed document (${partyLabel} country)`;
  } else if (vatInfo?.countryCode) { country = vatInfo.countryCode; sources.counterpartyCountry = `VAT number prefix (${vatInfo.normalised})`; }

  let supplyType: 'goods' | 'services' | null = null;
  if (party?.defaultVatTreatmentId) {
    const t = db.select().from(vatTreatments).where(eq(vatTreatments.id, party.defaultVatTreatmentId)).get();
    if (t && (t.supplyKind === 'goods' || t.supplyKind === 'services')) {
      supplyType = t.supplyKind;
      sources.supplyType = `${partyLabel} default treatment (${t.code}, supply kind ${t.supplyKind})`;
    }
  }

  const treatmentByCode = (code: string) => db.select().from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, params.companyId), eq(vatTreatments.code, code), eq(vatTreatments.active, true))).get();
  const partyDefault = party?.defaultVatTreatmentId
    ? db.select().from(vatTreatments).where(eq(vatTreatments.id, party.defaultVatTreatmentId)).get() : undefined;

  const legends = doc.vatLegends.join(' ').toLowerCase();
  const reverseChargeLegend = doc.vatLegends.find((l) => /reverse|autoliquidation|steuerschuldnerschaft|verlegd|inversione|inversi[oó]n|art(icle|\.)?\s*(44|196)/i.test(l));
  const exemptLegend = doc.vatLegends.find((l) => /exempt|befreit|exon[eé]r|vrijgesteld|esente|exento/i.test(l));

  const missingRates = new Set<string>();
  const choices = lines.map((line): LineChoices => {
    const facts: SuggestionFacts = {
      transactionDate: onDate,
      amountMinor: Math.abs(line.netMinor),
      currency: doc.currency ?? company.baseCurrency,
      direction: isSale ? 'sale' : 'purchase',
      counterpartyCountry: country,
      description: [line.description, party?.name, doc.vatLegends.join(' ')].filter(Boolean).join(' '),
      vatRegistered: company.vatRegistrationStatus === 'registered',
      invoiceAvailable: true,
      supplyType,
    };
    if (isSale) {
      facts.customerCountry = country;
      if (vatInfo) facts.customerVatRegisteredEu = vatInfo.structurallyValid && vatInfo.isEu && !vatInfo.isIrish;
      const customer = party as typeof customers.$inferSelect | undefined;
      if (customer?.taxableStatus) facts.customerIsTaxablePerson = customer.taxableStatus === 'taxable_person';
      else if (vatInfo?.structurallyValid && vatInfo.isEu) facts.customerIsTaxablePerson = true;
    } else {
      facts.supplierCountry = country;
    }
    if (line.vatMinor !== null) { facts.vatChargedMinor = Math.abs(line.vatMinor); sources.vatChargedMinor = 'confirmed document line'; }
    sources.invoiceAvailable = `confirmed document "${doc.originalFilename}"`;

    const statutory = suggestFromFacts(db, {
      companyId: params.companyId, subjectId: `${doc.id}#${line.number}`, facts, factSources: { ...sources },
      bookedTreatmentId: null,
    });

    const options = new Map<string, TreatmentOption>();
    const offer = (t: { id: string; code: string; name: string } | undefined, reason: string, ruleKeys: string[] = []) => {
      if (!t) return;
      const existing = options.get(t.id);
      if (existing) {
        existing.reasons.push(reason);
        existing.ruleKeys = [...new Set([...existing.ruleKeys, ...ruleKeys])];
      } else {
        options.set(t.id, { treatmentId: t.id, code: t.code, name: t.name, reasons: [reason], ruleKeys });
      }
    };

    // 1. The statutory rule that matched the document's facts.
    if ((statutory.status === 'suggested' || statutory.status === 'fallback_only') && statutory.treatment) {
      offer(statutory.treatment, statutory.explanation,
        [statutory.decidingRule?.ruleKey, ...statutory.supportingRules.map((r) => r.ruleKey)].filter((k): k is string => !!k));
    }
    // 2. What was confirmed for this party before.
    if (partyDefault) offer(partyDefault, `Previously confirmed for ${party!.name}.`);
    // 3. The rate printed on the line (a domestic rate; a charged rate means VAT was charged).
    if (line.rateBasisPoints !== null && !reverseChargeLegend) {
      for (const code of ['IE_STD', 'IE_RED', 'IE_SECOND_RED', 'IE_ZERO']) {
        const t = treatmentByCode(code);
        if (!t) continue;
        let rate: number;
        try {
          rate = resolveTreatment(db, { companyId: params.companyId, treatmentId: t.id, onDate }).rateBasisPoints;
        } catch {
          // No rate configured for this treatment on the document's date: it cannot be offered.
          missingRates.add(t.code);
          continue;
        }
        if (rate === line.rateBasisPoints && (rate > 0 || code === 'IE_ZERO')) {
          offer(t, `The line is printed at ${line.rateBasisPoints / 100}%.`);
        }
      }
    }
    // 4. VAT wording printed on the invoice.
    if (reverseChargeLegend && !isSale) {
      const code = supplyType === 'goods' && country && EU.has(country) ? 'EU_GOODS_ACQ'
        : country && EU.has(country) && country !== 'IE' ? 'EU_SERVICES_RCV'
        : country && country !== 'IE' ? 'NON_EU_SERVICES_RCV' : 'RC_CONSTRUCTION';
      offer(treatmentByCode(code), `The invoice states: "${reverseChargeLegend}".`);
    }
    if (exemptLegend) offer(treatmentByCode('IE_EXEMPT'), `The invoice states: "${exemptLegend}".`);

    const rateCheck = checkLineRate(db, {
      companyId: params.companyId, onDate, direction: facts.direction, statutory,
      chargedRateBasisPoints: line.rateBasisPoints,
    });

    const list = [...options.values()];
    const flags: string[] = [];
    // The rate charged is checked, never corrected (issue #205).
    if (rateCheck.outcome !== 'consistent') flags.push(rateCheck.message);
    if (missingRates.size) {
      flags.push(`No rate is configured on ${onDate} for ${[...missingRates].join(', ')}. Add the historical rate `
        + 'under Rates and treatments before posting a document from that date.');
    }
    if (list.length === 0) flags.push('Nothing on the document or in the rules points to a treatment. Choose one.');
    if (list.length > 1) flags.push(`${list.length} treatments are possible. Read the reason for each and choose.`);
    if (statutory.status === 'fallback_only') flags.push('The statutory rules could only fall back to the standard rate; they cannot rule out an exemption.');
    if (legends.includes('margin')) flags.push('The invoice mentions a margin scheme, which this system does not model. Take advice.');
    if (line.origin !== 'line') flags.push(line.origin === 'vat_total'
      ? 'The document prints no lines, so this line is its VAT analysis for one rate.'
      : 'The document prints no lines or VAT analysis, so this is its header total.');

    const agreed = list.length === 1 && statutory.status !== 'fallback_only' ? list[0]!.treatmentId : null;
    const accountId = party?.defaultAccountId ?? null;
    return {
      line, options: list, preselectedTreatmentId: agreed, statutory, rateCheck, flags,
      accountId, accountReason: accountId ? `Previously confirmed for ${party!.name}.` : null,
    };
  });

  // Lines are coded together where one may be ancillary to another (s.47, issue #206).
  const domesticTreatmentForRate = (rateBasisPoints: number) => {
    for (const code of ['IE_STD', 'IE_RED', 'IE_SECOND_RED', 'IE_ZERO']) {
      const t = treatmentByCode(code);
      if (!t) continue;
      try {
        if (resolveTreatment(db, { companyId: params.companyId, treatmentId: t.id, onDate }).rateBasisPoints === rateBasisPoints) {
          return { treatmentId: t.id, code: t.code, name: t.name };
        }
      } catch { /* no rate configured on this date */ }
    }
    return undefined;
  };
  return { direction, lines: applyCompositeSupply(choices, domesticTreatmentForRate) };
}

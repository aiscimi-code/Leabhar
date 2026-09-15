/**
 * EU VAT number recognition and validation.
 *
 * Used to decide VAT treatment: whether a supplier is Irish, in another EU
 * member state, or outside the EU changes the treatment entirely, and the VAT
 * number on the invoice is the most reliable signal available offline.
 *
 * The check here is structural — the right country prefix and the right shape —
 * not a VIES lookup. A structurally valid number can still be invalid or
 * deregistered, so nothing here is presented as confirmation that a number is
 * genuine, only that it is well formed.
 */

export const EU_COUNTRY_CODES = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR',
  'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
] as const;

export type EuCountryCode = (typeof EU_COUNTRY_CODES)[number];

/** Structural patterns per member state. 'EL' is the VAT prefix for Greece. */
const VAT_PATTERNS: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/,
  BE: /^BE0?\d{9,10}$/,
  BG: /^BG\d{9,10}$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ\d{8,10}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/,
  EL: /^EL\d{9}$/,
  GR: /^(EL|GR)\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  // Ireland: 7 digits + 1-2 letters, or the newer 7 digits + letter + letter form.
  IE: /^IE(\d{7}[A-W]{1,2}|\d[A-Z+*]\d{5}[A-W])$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL\d{9}B\d{2}$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
};

export function normaliseVatNumber(input: string): string {
  return input.toUpperCase().replace(/[\s.\-/]/g, '');
}

export interface VatNumberInfo {
  normalised: string;
  countryCode: string | null;
  isEu: boolean;
  isIrish: boolean;
  structurallyValid: boolean;
  note: string;
}

export function parseVatNumber(input: string): VatNumberInfo {
  const normalised = normaliseVatNumber(input);
  const prefix = normalised.slice(0, 2);

  const country = prefix === 'EL' ? 'GR' : prefix;
  const pattern = VAT_PATTERNS[prefix];
  const isEu = (EU_COUNTRY_CODES as readonly string[]).includes(country) || prefix === 'EL';
  const structurallyValid = pattern ? pattern.test(normalised) : false;

  return {
    normalised,
    countryCode: isEu ? country : null,
    isEu,
    isIrish: country === 'IE',
    structurallyValid,
    note: structurallyValid
      ? 'The number is correctly formed for its member state. This is a format check '
        + 'only — it does not confirm the number is registered or currently valid.'
      : isEu
        ? 'This does not match the expected format for that member state. Check it '
          + 'before relying on a treatment that depends on the other party being registered.'
        : 'Not recognised as an EU VAT number.',
  };
}

/** Find VAT numbers in free text, ignoring the company's own. */
export function findVatNumbers(
  text: string, excludeOwn?: string | null,
): VatNumberInfo[] {
  const own = excludeOwn ? normaliseVatNumber(excludeOwn) : null;
  const candidates = new Set<string>();

  // Match a country prefix followed by the alphanumerics that could form a number,
  // allowing the spaces and separators that appear on real invoices. Horizontal
  // whitespace only: a VAT number never spans a line break, and allowing one
  // would let the first letters of the following line be read as part of it.
  const pattern = /\b(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|GR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)[^\S\n\r]?([A-Z0-9][A-Z0-9 \t.\-/]{5,14}[A-Z0-9])\b/gi;

  for (const match of text.matchAll(pattern)) {
    candidates.add(normaliseVatNumber(match[0]));
  }

  const results: VatNumberInfo[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // Trim from the right until it becomes structurally valid; invoice text
    // often runs the number into the following word.
    for (let end = candidate.length; end >= 8; end--) {
      const trimmed = candidate.slice(0, end);
      const info = parseVatNumber(trimmed);
      if (info.structurallyValid && !seen.has(info.normalised)) {
        if (own && info.normalised === own) break;
        seen.add(info.normalised);
        results.push(info);
        break;
      }
    }
  }

  return results;
}

/**
 * Suggest a VAT treatment code from what is known about the supplier.
 *
 * This is a *suggestion*, always. README §18 is explicit that deterministic
 * rules take precedence and that AI must not silently change confirmed data;
 * the same applies to this heuristic. It exists so the common cases arrive
 * pre-filled, not so the user stops thinking.
 */
export function suggestPurchaseTreatment(params: {
  supplierVatNumber?: string | null;
  supplierCountry?: string | null;
  vatChargedMinor?: number | null;
  isGoods?: boolean;
}): { code: string; confidence: number; reason: string } {
  const vatInfo = params.supplierVatNumber ? parseVatNumber(params.supplierVatNumber) : null;
  const country = (vatInfo?.countryCode ?? params.supplierCountry ?? '').toUpperCase();
  const chargedVat = (params.vatChargedMinor ?? 0) !== 0;
  const kind = params.isGoods ? 'GOODS' : 'SERVICES';

  if (country === 'IE') {
    return chargedVat
      ? { code: 'IE_STD', confidence: 80,
          reason: 'An Irish supplier charging VAT. The rate still needs checking — it '
            + 'may be the reduced rate rather than the standard one.' }
      : { code: 'IE_ZERO', confidence: 40,
          reason: 'An Irish supplier charging no VAT. This could be zero-rated, exempt, '
            + 'or outside the scope, and those are three different things. Confirm which.' };
  }

  if (country && (EU_COUNTRY_CODES as readonly string[]).includes(country)) {
    if (chargedVat) {
      return { code: 'IE_STD', confidence: 30,
        reason: `A supplier in ${country} charged VAT rather than applying the reverse `
          + 'charge. That usually means they treated you as a consumer. Foreign VAT is '
          + 'not reclaimable on an Irish VAT return — check whether you gave them your '
          + 'VAT number.' };
    }
    return kind === 'GOODS'
      ? { code: 'EU_GOODS_ACQ', confidence: 75,
          reason: `Goods from a business in ${country} with no VAT charged: an `
            + 'intra-Community acquisition, self-accounted under the reverse charge.' }
      : { code: 'EU_SERVICES_RCV', confidence: 80,
          reason: `Services from a business in ${country} with no VAT charged: the `
            + 'reverse charge applies and you self-account for the VAT.' };
  }

  if (country) {
    return kind === 'GOODS'
      ? { code: 'IMPORT_PA', confidence: 45,
          reason: `Goods from ${country}, outside the EU. Postponed accounting applies if `
            + 'you are authorised for it; otherwise import VAT is paid at entry.' }
      : { code: 'NON_EU_SERVICES_RCV', confidence: 75,
          reason: `Services from ${country}, outside the EU. You self-account for Irish `
            + 'VAT under the reverse charge.' };
  }

  return { code: 'IE_STD', confidence: 15,
    reason: 'The supplier’s country could not be determined, so the treatment is a '
      + 'guess. Set the supplier’s country to get a reliable suggestion.' };
}

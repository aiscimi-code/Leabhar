/**
 * The exchange rate VAT is converted at (VATCA s.37(4); issue #614).
 *
 * Where an amount is in a currency other than the euro, "the exchange rate to
 * be used shall be the latest selling rate recorded by the Central Bank of
 * Ireland or the European Central Bank for the currency in question at the
 * time the tax becomes due" (s.37(4)(a)), unless a method has been agreed
 * with the Revenue Commissioners, in which case that method is used for every
 * foreign-currency transaction until Revenue withdraws the agreement
 * (s.37(4)(b)). Source: docs/statutes/vatca-2010-revised/s037.md.
 *
 * A rate's `source` is free text across the books (a bank statement's rate,
 * the invoice's booking rate). These are the sources s.37(4) accepts; any
 * other is flagged when the VAT period is validated, never refused or
 * converted again.
 */
export const S37_RATE_SOURCES = ['central_bank_of_ireland', 'european_central_bank', 'revenue_agreed_method'] as const;
export type S37RateSource = typeof S37_RATE_SOURCES[number];

const ALIASES: Record<string, S37RateSource> = {
  central_bank_of_ireland: 'central_bank_of_ireland',
  cbi: 'central_bank_of_ireland',
  european_central_bank: 'european_central_bank',
  ecb: 'european_central_bank',
  revenue_agreed_method: 'revenue_agreed_method',
};

/** The s.37(4) source a recorded rate source names, or null when it names none. */
export function s37RateSource(source: string | null | undefined): S37RateSource | null {
  if (!source) return null;
  return ALIASES[source.trim().toLowerCase().replace(/[\s-]+/g, '_')] ?? null;
}

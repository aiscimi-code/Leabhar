import { formatAmountGrouped, formatRate } from '@/domain/money';
import { formatDateIE, asIsoDate, isIsoDate } from '@/domain/dates';

/** Presentation helpers. All arithmetic happens in the domain, never here. */

const SYMBOLS: Record<string, string> = {
  EUR: '€', GBP: '£', USD: '$', CHF: 'CHF ', JPY: '¥',
};

export function money(minor: number | null | undefined, currency = 'EUR'): string {
  if (minor === null || minor === undefined) return '—';
  const symbol = SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  const negative = minor < 0;
  return `${negative ? '-' : ''}${symbol}${formatAmountGrouped(Math.abs(minor), currency)}`;
}

/** Accounting presentation: negatives in parentheses, as on a printed statement. */
export function accountingMoney(minor: number | null | undefined, currency = 'EUR'): string {
  if (minor === null || minor === undefined) return '—';
  if (minor < 0) {
    const symbol = SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
    return `(${symbol}${formatAmountGrouped(Math.abs(minor), currency)})`;
  }
  return money(minor, currency);
}

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  return isIsoDate(value) ? formatDateIE(asIsoDate(value)) : value;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${formatDateIE(asIsoDate(parsed.toISOString().slice(0, 10)))} `
    + `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}

export function rate(basisPoints: number | null | undefined): string {
  if (basisPoints === null || basisPoints === undefined) return '—';
  return formatRate(basisPoints);
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value)}%`;
}

const TITLES: Record<string, string> = {
  unclassified: 'Unclassified',
  suggested: 'Suggested',
  classified: 'Classified',
  matched: 'Matched',
  posted: 'Posted',
  reconciled: 'Reconciled',
  ignored: 'Ignored',
  duplicate: 'Duplicate',
  ai_suggestion: 'AI suggestion',
  user_confirmed: 'You confirmed',
  user_rejected: 'You rejected',
  system_rule: 'Rule',
  imported: 'Imported',
  manually_entered: 'Entered by hand',
  probable: 'Probable',
  possible: 'Possible',
  no_match: 'No match',
  conflict: 'Conflict',
  cash_receipts: 'Cash receipts basis',
  invoice: 'Invoice basis',
};

export function label(value: string | null | undefined): string {
  if (!value) return '—';
  return TITLES[value] ?? value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export function plural(n: number, singular: string, pluralForm?: string): string {
  return n === 1 ? singular : pluralForm ?? `${singular}s`;
}

export { provisionCitation } from '@/domain/rules/citation';

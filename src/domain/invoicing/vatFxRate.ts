import { parseDecimalRate } from '../money';
import { asIsoDate } from '../dates';
import { InvoicingError } from './invoices';
import type { RecordPaymentInput } from './payments';

/**
 * The s.37(4) rate at a cash-basis receipt (issue #661), from what a person
 * types: a decimal ("1.0842") or a fraction ("10842/10000"), the currency it
 * converts, where the rate came from (the CBI or ECB selling rate), and its
 * date. Nothing typed means the invoice's own rate is used and period
 * validation flags it (`RecordPaymentInput.vatFxRate`).
 */
export function parseVatFxRate(input: {
  rate: string | undefined | null; currency: string | undefined | null; source?: string | null; date?: string | null;
}): RecordPaymentInput['vatFxRate'] {
  const text = input.rate?.trim();
  if (!text) return null;
  const currency = input.currency?.trim().toUpperCase();
  if (!currency) throw new InvoicingError('Say which currency the VAT rate at receipt converts.');
  const fraction = /^(\d+)\/(\d+)$/.exec(text);
  const rate = fraction && Number(fraction[1]) > 0 && Number(fraction[2]) > 0
    ? { numerator: Number(fraction[1]), denominator: Number(fraction[2]) }
    : parseDecimalRate(text);
  if (!rate) throw new InvoicingError(`"${text}" is not an exchange rate. Give a positive decimal (1.0842) or a fraction (10842/10000).`);
  return {
    currency, ...rate, source: input.source?.trim() || 'user_supplied',
    ...(input.date?.trim() ? { date: asIsoDate(input.date.trim()) } : {}),
  };
}

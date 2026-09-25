import { describe, it, expect } from 'vitest';
import {
  parseLineItems, parseVatTotals, findVatLegends, findSupplyDate, findPaymentTerms,
  findOriginalDocumentNumber, findCustomerBlock, countryFromAddress,
} from './invoiceParser';

const lines = (text: string) => text.split('\n');
const items = (text: string) => parseLineItems(lines(text), 'EUR')
  .map((l) => [l.description, l.quantity, l.unitPriceMinor, l.netMinor, l.vatRateBasisPoints, l.vatMinor, l.grossMinor]);

describe('parseLineItems', () => {
  it('reads multiple items at different rates from one invoice', () => {
    expect(items([
      'Description                 Qty   Price    VAT%   VAT     Total',
      'Printer paper A4             2    10.00    23%    4.60    24.60',
      'Plumbing labour              1   100.00  13.5%   13.50   113.50',
      'Books                        1    20.00     0%    0.00    20.00',
      'Subtotal                                                 130.00',
      'VAT                                                       18.10',
      'Total                                                    158.10',
    ].join('\n'))).toEqual([
      ['Printer paper A4', '2', 1_000, 2_000, 2300, 460, 2_460],
      ['Plumbing labour', '1', 10_000, 10_000, 1350, 1_350, 11_350],
      ['Books', '1', 2_000, 2_000, 0, 0, 2_000],
    ]);
  });

  it('reads a single-amount line as the net, with the rest left for the person', () => {
    expect(items('Pro plan — January 2025             42.17')).toEqual([
      ['Pro plan — January 2025', null, null, 4_217, null, null, null],
    ]);
  });

  it('does not treat totals, payment details or foreign-language totals as items', () => {
    expect(items([
      'Subtotal 100.00', 'Total Due 123.00', 'Amount paid 123.00', 'IBAN IE29AIBK93115212345678',
      'Nettobetrag 89,00', 'Gesamtbetrag EUR 89,00', 'Montant HT 50,00',
    ].join('\n'))).toEqual([]);
  });

  it('keeps real items whose names contain accounting words', () => {
    expect(items('Accountancy services      500.00').map((r) => r[0])).toEqual(['Accountancy services']);
  });
});

describe('parseVatTotals', () => {
  it('reads one total per rate', () => {
    const totals = parseVatTotals(lines([
      'VAT @ 23%        23.00',
      'VAT @ 13.5%      13.50',
    ].join('\n')), 'EUR');
    expect(totals.map((t) => [t.rateBasisPoints, t.vatMinor])).toEqual([[2300, 2_300], [1350, 1_350]]);
  });
});

describe('findVatLegends', () => {
  it('finds reverse-charge wording in several languages and exemption notes', () => {
    const legends = findVatLegends(lines([
      'Reverse charge, Article 196 of Council Directive 2006/112/EC.',
      'Steuerschuldnerschaft des Leistungsempfaengers.',
      'Autoliquidation',
      'Exempt from VAT (insurance services).',
      'Thank you for your business',
    ].join('\n')));
    expect(legends).toHaveLength(4);
    expect(legends).not.toContain('Thank you for your business');
  });
});

describe('header details', () => {
  it('reads the supply date, payment terms and credited invoice', () => {
    const text = lines([
      'Date of supply: 01/03/2025', 'Payment terms: 30 days net', 'Credit note for invoice INV-2025-017',
    ].join('\n'));
    expect(findSupplyDate(text)?.value).toBe('2025-03-01');
    expect(findPaymentTerms(text)?.value).toMatch(/30 days/);
    expect(findOriginalDocumentNumber(text)?.value).toBe('INV-2025-017');
  });

  it('reads a customer block, and never mistakes "Total" for "To"', () => {
    expect(findCustomerBlock(lines('Total                EUR 42.17'))).toBeNull();
    const block = findCustomerBlock(lines(['Bill to:', 'Mulligan Digital Limited', '1 Quay St', 'Galway, Ireland'].join('\n')))!;
    expect(block.name.value).toBe('Mulligan Digital Limited');
    expect(countryFromAddress(block.address.value)).toBe('IE');
  });

  it('splits a one-line customer into name and address', () => {
    const block = findCustomerBlock(lines('Customer: Continental Design SRL, Milan, Italy'))!;
    expect(block.name.value).toBe('Continental Design SRL');
    expect(countryFromAddress(block.address.value)).toBe('IT');
  });
});

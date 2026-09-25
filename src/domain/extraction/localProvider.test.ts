import { describe, it, expect } from 'vitest';
import { LocalExtractionProvider } from './localProvider';
import type { ExtractionContext } from './types';
import { parseVatNumber, findVatNumbers, suggestPurchaseTreatment } from './vatNumbers';

const provider = new LocalExtractionProvider();

const context: ExtractionContext = {
  knownSuppliers: [],
  knownCustomers: [],
  companyVatNumber: 'IE1234567T',
  companyName: 'Acme Software Limited',
  baseCurrency: 'EUR',
  availableAccountCodes: [
    { code: '6000', name: 'Software and subscriptions' },
    { code: '6010', name: 'Hosting and infrastructure' },
  ],
  availableVatTreatments: [
    { code: 'IE_STD', name: 'Irish standard rate', description: null },
    { code: 'IE_ZERO', name: 'Irish zero-rated', description: null },
    { code: 'EU_SERVICES_RCV', name: 'EU services received', description: null },
    { code: 'NON_EU_SERVICES_RCV', name: 'Non-EU services received', description: null },
    { code: 'EU_GOODS_ACQ', name: 'EU acquisition of goods', description: null },
    { code: 'IMPORT_PA', name: 'Import postponed accounting', description: null },
  ],
};

const extract = (text: string, ctx: ExtractionContext = context) =>
  provider.extract({
    content: Buffer.from(text, 'utf8'),
    mimeType: 'text/plain',
    filename: 'invoice.txt',
    context: ctx,
  });

describe('LocalExtractionProvider', () => {
  it('extracts an Irish supplier invoice', async () => {
    const result = await extract([
      'Byrne Accountancy Services Limited',
      '12 Main Street, Dublin 2',
      'VAT Number: IE9876543W',
      '',
      'INVOICE',
      'Invoice Number: INV-2025-0041',
      'Invoice Date: 15/03/2025',
      'Due Date: 14/04/2025',
      '',
      'Annual accounts preparation      1,000.00',
      '',
      'Subtotal                         1,000.00',
      'VAT @ 23%                          230.00',
      'Total Due                        1,230.00',
      'Currency: EUR',
    ].join('\n'));

    expect(result.status).toBe('succeeded');
    expect(result.fields.invoiceNumber.value).toBe('INV-2025-0041');
    expect(result.fields.documentDate.value).toBe('2025-03-15');
    expect(result.fields.dueDate.value).toBe('2025-04-14');
    expect(result.fields.netMinor.value).toBe(100_000);
    expect(result.fields.vatMinor.value).toBe(23_000);
    expect(result.fields.grossMinor.value).toBe(123_000);
    expect(result.fields.vatRateBasisPoints.value).toBe(2300);
    expect(result.fields.currency.value).toBe('EUR');
    expect(result.fields.supplierVatNumber.value).toBe('IE9876543W');
    expect(result.fields.supplierCountry.value).toBe('IE');
    expect(result.fields.suggestedVatTreatment.value).toBe('IE_STD');
  });

  it('never reads the company’s own VAT number as the supplier’s', async () => {
    const result = await extract([
      'Some Supplier Ltd',
      'Their VAT: IE9876543W',
      'Billed to: Acme Software Limited, VAT IE1234567T',
      'Total 123.00 EUR',
    ].join('\n'));
    expect(result.fields.supplierVatNumber.value).toBe('IE9876543W');
  });

  it('extracts a US reverse-charge invoice and suggests the right treatment', async () => {
    const result = await extract([
      'Anthropic PBC',
      '548 Market Street, San Francisco, CA, United States',
      'Invoice #ANT-99120',
      'Date: March 3, 2025',
      'Claude API usage                 $120.00',
      'Total                            $120.00',
      'VAT: reverse charge applies. No VAT has been charged.',
    ].join('\n'));

    expect(result.fields.grossMinor.value).toBe(12_000);
    expect(result.fields.currency.value).toBe('USD');
    expect(result.fields.documentDate.value).toBe('2025-03-03');
    // No VAT number, but "$" and no VAT charged. The suggestion is honest
    // about being weak rather than confidently wrong.
    expect(result.fields.suggestedVatTreatment.confidence).toBeLessThan(50);
  });

  it('flags an ambiguous dollar sign rather than assuming USD', async () => {
    const result = await extract('Total $120.00');
    expect(result.fields.currency.value).toBe('USD');
    expect(result.fields.currency.confidence).toBeLessThan(70);
    expect(result.fields.currency.evidence).toContain('confirm');
  });

  it('prefers an explicit ISO code over a symbol', async () => {
    const result = await extract('Total: $120.00 USD');
    expect(result.fields.currency.confidence).toBeGreaterThan(90);
  });

  it('derives the missing third amount from the other two', async () => {
    const result = await extract([
      'Invoice',
      'Subtotal   100.00',
      'VAT @ 23%   23.00',
      'EUR',
    ].join('\n'));
    expect(result.fields.grossMinor.value).toBe(12_300);
    expect(result.fields.grossMinor.evidence).toContain('Calculated');
  });

  it('reports a total that does not add up rather than correcting it', async () => {
    const result = await extract([
      'Invoice',
      'Subtotal    100.00',
      'VAT @ 23%    23.00',
      'Total       999.00',
      'EUR',
    ].join('\n'));
    expect(result.observations.join(' ')).toContain('do not add up');
    // Confidence in all three drops, so it goes to review.
    expect(result.fields.grossMinor.confidence).toBeLessThanOrEqual(40);
  });

  it('recognises a known supplier and reuses its confirmed treatment', async () => {
    const withSupplier: ExtractionContext = {
      ...context,
      knownSuppliers: [{
        id: 'sup_1', name: 'Vercel Inc', matchKey: 'vercel inc',
        aliases: ['VERCEL'], countryCode: 'US', vatNumber: null,
        defaultAccountCode: '6010', defaultVatTreatmentCode: 'NON_EU_SERVICES_RCV',
      }],
    };
    const result = await extract('VERCEL\nHosting\nTotal 42.17 EUR', withSupplier);
    expect(result.fields.supplierName.value).toBe('Vercel Inc');
    expect(result.fields.supplierName.confidence).toBeGreaterThan(90);
    expect(result.fields.suggestedAccountCode.value).toBe('6010');
    expect(result.fields.suggestedVatTreatment.value).toBe('NON_EU_SERVICES_RCV');
    expect(result.fields.suggestedVatTreatment.evidence).toContain('Previously confirmed');
  });

  it('marks a guessed supplier name as a guess', async () => {
    const result = await extract('Unknown Trading Co\nInvoice\nTotal 50.00 EUR');
    expect(result.fields.supplierName.value).toBe('Unknown Trading Co');
    expect(result.fields.supplierName.confidence).toBeLessThan(50);
    expect(result.fields.supplierName.evidence).toContain('guess');
  });

  it('detects a credit note', async () => {
    const result = await extract('CREDIT NOTE\nCN-001\nTotal -50.00 EUR');
    expect(result.fields.documentType.value).toBe('credit_note');
  });

  it('returns nothing with zero confidence when it finds nothing', async () => {
    const result = await extract('Hello. This is not an invoice.');
    expect(result.fields.grossMinor.value).toBeNull();
    expect(result.fields.grossMinor.confidence).toBe(0);
    expect(result.overallConfidence).toBeLessThan(30);
  });

  it('says so plainly when an image cannot be read without OCR', async () => {
    const result = await provider.extract({
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png', filename: 'receipt.png', context,
    });
    expect(result.status).toBe('failed');
    expect(result.observations.join(' ')).toContain('Read text from the image (OCR)');
  });

  it('reads a four-digit amount with no thousands separator', async () => {
    // "2000.00" was previously matched as "200" then "0.00", and the rightmost
    // match won, so a EUR 2,000 invoice read as zero.
    const result = await extract([
      'TAX INVOICE',
      'Subtotal                              2000.00',
      'VAT @ 23%                              460.00',
      'Total                                 2460.00',
      'Currency: EUR',
    ].join('\n'));

    expect(result.fields.netMinor.value).toBe(200_000);
    expect(result.fields.vatMinor.value).toBe(46_000);
    expect(result.fields.grossMinor.value).toBe(246_000);
    expect(result.observations.join(' ')).not.toContain('do not add up');
  });

  it('reads large ungrouped and grouped amounts alike', async () => {
    expect((await extract('Total 12345.67 EUR')).fields.grossMinor.value).toBe(1_234_567);
    expect((await extract('Total 12,345.67 EUR')).fields.grossMinor.value).toBe(1_234_567);
    expect((await extract('Total 1000.00 EUR')).fields.grossMinor.value).toBe(100_000);
  });

  // A VAT registration number is an identifier, not an amount, and the line it
  // sits on matches the VAT label perfectly well.
  it('never reads a VAT registration number as a VAT amount', async () => {
    const result = await extract([
      'Hetzner Online GmbH',
      'USt-IdNr: DE812871812',
      'Nettobetrag                            89,00',
      'MwSt 0%                                 0,00',
      'Gesamtbetrag                    EUR    89,00',
    ].join('\n'));

    expect(result.fields.vatMinor.value).toBe(0);
    expect(result.fields.netMinor.value).toBe(8_900);
    expect(result.fields.grossMinor.value).toBe(8_900);
    expect(result.fields.supplierVatNumber.value).toBe('DE812871812');
  });

  it('does not read an Irish VAT number as an amount either', async () => {
    const result = await extract([
      'Insurance Ireland DAC',
      'VAT Number: IE4567891K',
      'Total                                  480.00',
    ].join('\n'));
    expect(result.fields.grossMinor.value).toBe(48_000);
    expect(result.fields.vatMinor.value).toBeNull();
  });

  it('reads German invoice dates and numbers', async () => {
    const result = await extract([
      'RECHNUNG',
      'Rechnungsnummer: HZ-2025-0211',
      'Rechnungsdatum: 11/02/2025',
      'Gesamtbetrag                    EUR    89,00',
    ].join('\n'));
    expect(result.fields.documentDate.value).toBe('2025-02-11');
    expect(result.fields.invoiceNumber.value).toBe('HZ-2025-0211');
  });

  it('handles European decimal formatting', async () => {
    const result = await extract([
      'Rechnung',
      'Netto        1.000,00',
      'MwSt 19%       190,00',
      'Gesamt       1.190,00',
      'EUR',
    ].join('\n'));
    expect(result.fields.grossMinor.value).toBe(119_000);
  });
});

describe('VAT number recognition', () => {
  it('validates the Irish formats', () => {
    expect(parseVatNumber('IE1234567T')).toMatchObject({
      isIrish: true, isEu: true, structurallyValid: true, countryCode: 'IE',
    });
    expect(parseVatNumber('IE 1234567 T').normalised).toBe('IE1234567T');
    expect(parseVatNumber('IE1234567FA').structurallyValid).toBe(true);
    expect(parseVatNumber('IE1234567').structurallyValid).toBe(false);
  });

  it('validates other member states', () => {
    expect(parseVatNumber('DE123456789').structurallyValid).toBe(true);
    expect(parseVatNumber('FR12345678901').structurallyValid).toBe(true);
    expect(parseVatNumber('NL123456789B01').structurallyValid).toBe(true);
    expect(parseVatNumber('LU12345678').structurallyValid).toBe(true);
    expect(parseVatNumber('DE12345').structurallyValid).toBe(false);
  });

  it('treats EL as Greece', () => {
    expect(parseVatNumber('EL123456789')).toMatchObject({
      countryCode: 'GR', isEu: true, structurallyValid: true,
    });
  });

  it('rejects non-EU numbers', () => {
    expect(parseVatNumber('US123456789').isEu).toBe(false);
  });

  it('never claims a number is registered, only well formed', () => {
    expect(parseVatNumber('IE1234567T').note).toContain('format check');
    expect(parseVatNumber('IE1234567T').note).not.toMatch(/\bis valid\b/);
  });

  it('finds numbers in running text', () => {
    const found = findVatNumbers('Supplier VAT No. DE 123 456 789 and ours is IE1234567T');
    expect(found.map((f) => f.normalised)).toContain('DE123456789');
  });

  it('excludes our own number', () => {
    const found = findVatNumbers('DE123456789 / IE1234567T', 'IE1234567T');
    expect(found.map((f) => f.normalised)).not.toContain('IE1234567T');
    expect(found.map((f) => f.normalised)).toContain('DE123456789');
  });
});

describe('suggestPurchaseTreatment', () => {
  it('suggests the standard rate for an Irish supplier charging VAT', () => {
    const s = suggestPurchaseTreatment({ supplierVatNumber: 'IE9876543W', vatChargedMinor: 2300 });
    expect(s.code).toBe('IE_STD');
    expect(s.confidence).toBeGreaterThan(70);
  });

  it('is deliberately unsure about an Irish supplier charging no VAT', () => {
    const s = suggestPurchaseTreatment({ supplierVatNumber: 'IE9876543W', vatChargedMinor: 0 });
    expect(s.confidence).toBeLessThan(50);
    expect(s.reason).toContain('three different things');
  });

  it('suggests the reverse charge for EU services with no VAT', () => {
    const s = suggestPurchaseTreatment({ supplierVatNumber: 'DE123456789', vatChargedMinor: 0 });
    expect(s.code).toBe('EU_SERVICES_RCV');
  });

  it('suggests an intra-Community acquisition for EU goods', () => {
    const s = suggestPurchaseTreatment({
      supplierVatNumber: 'DE123456789', vatChargedMinor: 0, isGoods: true,
    });
    expect(s.code).toBe('EU_GOODS_ACQ');
  });

  it('warns when an EU supplier charged their own VAT', () => {
    const s = suggestPurchaseTreatment({ supplierVatNumber: 'FR12345678901', vatChargedMinor: 2000 });
    expect(s.reason).toContain('not reclaimable on an Irish VAT return');
    expect(s.confidence).toBeLessThan(50);
  });

  it('suggests the reverse charge for non-EU services', () => {
    const s = suggestPurchaseTreatment({ supplierCountry: 'US', vatChargedMinor: 0 });
    expect(s.code).toBe('NON_EU_SERVICES_RCV');
  });

  it('admits when it does not know the country', () => {
    const s = suggestPurchaseTreatment({ vatChargedMinor: 0 });
    expect(s.confidence).toBeLessThan(25);
    expect(s.reason).toContain('could not be determined');
  });
});

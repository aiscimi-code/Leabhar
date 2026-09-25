import { describe, it, expect } from 'vitest';
import {
  AnthropicExtractionProvider, type InvoiceExtraction, type ParseInvoice,
} from './anthropicProvider';
import type { ExtractionContext } from './types';

const context: ExtractionContext = {
  knownSuppliers: [],
  knownCustomers: [],
  companyVatNumber: 'IE1234567T',
  companyName: 'Acme Software Limited',
  baseCurrency: 'EUR',
  availableAccountCodes: [{ code: '6000', name: 'Office costs' }],
  availableVatTreatments: [{ code: 'IE_STD', name: 'Irish standard rate', description: null }],
};

const f = (value: string | null, confidence = 95) => ({ value, confidence });
const none = f(null, 0);

const result = (over: Partial<InvoiceExtraction> = {}): InvoiceExtraction => ({
  documentType: f('supplier_invoice'),
  supplierName: f('Murphy Office Supplies Ltd'), supplierAddress: f('12 Main Street, Cork'),
  supplierVatNumber: f('IE 8254410U'), supplierCountry: f('ie'),
  customerName: f('Acme Software Limited'), customerAddress: none, customerVatNumber: none, customerCountry: none,
  invoiceNumber: f('MOS-4471'), documentDate: f('2025-03-18'), supplyDate: none, dueDate: none,
  currency: f('eur'), paymentTerms: f('30 days'), originalDocumentNumber: none,
  net: f('60.00'), vat: f('13.80'), gross: f('73.80'), vatRatePercent: f('23'),
  suggestedVatTreatment: f('IE_STD', 99), suggestedAccountCode: f('6000', 99),
  lines: [
    { description: 'Printer paper A4', quantity: '2', unitPrice: '10.00', net: '20.00', vatRatePercent: '23', vat: '4.60', gross: '24.60', confidence: 100 },
    { description: 'Desk lamp', quantity: '1', unitPrice: '40.00', net: '40.00', vatRatePercent: '23', vat: '9.20', gross: '49.20', confidence: 90 },
  ],
  vatTotals: [{ ratePercent: '23', label: 'VAT @ 23%', net: '60.00', vat: '13.80', confidence: 90 }],
  vatLegends: [],
  notes: [],
  ...over,
});

const providerReturning = (parsed: InvoiceExtraction | null, stopReason = 'end_turn') => {
  const calls: Array<Parameters<ParseInvoice>[0]> = [];
  const parse: ParseInvoice = async (request) => { calls.push(request); return { parsed, stopReason }; };
  return { provider: new AnthropicExtractionProvider(undefined, 'claude-sonnet-5', parse), calls };
};

const read = (provider: AnthropicExtractionProvider, mimeType = 'text/plain', content = 'invoice text') =>
  provider.extract({ content: Buffer.from(content), mimeType, filename: 'inv.txt', context });

describe('AnthropicExtractionProvider', () => {
  it('returns every line, the VAT analysis and the header, parsed into minor units', async () => {
    const { provider } = providerReturning(result());
    const r = await read(provider);
    expect(r.status).toBe('succeeded');
    expect(r.lines.map((l) => [l.description, l.quantity, l.unitPriceMinor, l.netMinor, l.vatRateBasisPoints, l.vatMinor, l.grossMinor]))
      .toEqual([
        ['Printer paper A4', '2', 1_000, 2_000, 2300, 460, 2_460],
        ['Desk lamp', '1', 4_000, 4_000, 2300, 920, 4_920],
      ]);
    expect(r.vatTotals).toEqual([{ rateBasisPoints: 2300, label: 'VAT @ 23%', netMinor: 6_000, vatMinor: 1_380, confidence: 90 }]);
    expect(r.fields.grossMinor.value).toBe(7_380);
    expect(r.fields.supplierVatNumber.value).toBe('IE8254410U');
    expect(r.fields.supplierCountry.value).toBe('IE');
    expect(r.fields.currency.value).toBe('EUR');
  });

  it('caps the model’s confidence: a model saying 100 is not a matched pattern', async () => {
    const { provider } = providerReturning(result());
    const r = await read(provider);
    expect(r.lines[0]!.confidence).toBe(90);
    expect(r.fields.suggestedVatTreatment.confidence).toBe(75);
  });

  it('drops values that do not parse, and says so, rather than storing them', async () => {
    const { provider } = providerReturning(result({
      lines: [{ description: 'Lamp', quantity: 'two', unitPrice: null, net: 'forty', vatRatePercent: '230', vat: null, gross: null, confidence: 50 }],
      documentDate: f('the eighteenth'),
      suggestedVatTreatment: f('MADE_UP'),
    }));
    const r = await read(provider);
    expect(r.lines[0]).toMatchObject({ quantity: null, netMinor: null, vatRateBasisPoints: null });
    expect(r.fields.documentDate.value).toBeNull();
    expect(r.fields.suggestedVatTreatment.value).toBeNull();
    const notes = r.observations.join(' ');
    expect(notes).toMatch(/Line 1 net: could not read "forty"/);
    expect(notes).toMatch(/"230" is not a VAT rate/);
    expect(notes).toMatch(/MADE_UP/);
  });

  it('checks the arithmetic itself and lowers confidence when it fails', async () => {
    const { provider } = providerReturning(result({ gross: f('74.80') }));
    const r = await read(provider);
    expect(r.observations.join(' ')).toMatch(/do not add up/);
    expect(r.fields.grossMinor.confidence).toBe(40);
  });

  it('keeps the VAT wording verbatim, once each', async () => {
    const { provider } = providerReturning(result({
      vatLegends: ['Reverse charge — Article 196', 'Reverse charge — Article 196', ' '],
    }));
    expect((await read(provider)).vatLegends).toEqual(['Reverse charge — Article 196']);
  });

  it('sends an image as an image block and records it as OCR', async () => {
    const { provider, calls } = providerReturning(result());
    const r = await read(provider, 'image/png', 'png-bytes');
    expect(r.textExtractionMethod).toBe('ocr');
    expect(calls[0]!.content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(calls[0]!.system).toContain('Acme Software Limited');
  });

  it('fails honestly on a refusal or an incomplete result', async () => {
    expect((await read(providerReturning(null, 'refusal').provider)).status).toBe('failed');
    const truncated = await read(providerReturning(null, 'max_tokens').provider);
    expect(truncated.status).toBe('failed');
    expect(truncated.errorMessage).toMatch(/max_tokens/);
  });

  it('is unavailable without a key', () => {
    expect(new AnthropicExtractionProvider('', 'claude-sonnet-5').isAvailable()).toBe(false);
  });
});

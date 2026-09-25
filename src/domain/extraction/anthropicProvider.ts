import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import {
  type ExtractionProvider, type ExtractionResult, type ExtractionContext,
  type ExtractedDocument, type ExtractedLineSnapshot, type ExtractedVatTotalSnapshot,
  emptyFields, overallConfidence,
} from './types';
import { parseAmount, parseRate, MoneyError } from '../money';
import { parseDateFlexible, DateError } from '../dates';
import { extractPdfText } from './pdfText';

/**
 * Optional Anthropic extraction provider (README §19).
 *
 * Used only when the company chooses it and ANTHROPIC_API_KEY is set. Everything
 * works without it — the deterministic local provider is the default — because
 * README §3 requires that the database not depend on an LLM being available.
 *
 * Two constraints shape this implementation:
 *
 *  - The model returns *suggestions*, never decisions. Results are written as a
 *    draft with status 'ai_suggestion', and a person confirms every document
 *    before anything uses it (issue #202).
 *  - Arithmetic is not delegated. The model is asked for the figures printed on
 *    the document, as printed; they are parsed and checked in code. README §50
 *    is explicit that LLM evaluation must not be relied on for arithmetic, and a
 *    model that "helpfully" recalculates a total is worse than one that misreads
 *    it, because the error looks correct.
 *
 * The response shape is enforced by structured outputs, so it always parses;
 * every amount, rate and date inside it is still re-parsed with the same
 * deterministic parsers the rest of the system uses.
 */

const Field = z.object({ value: z.string().nullable(), confidence: z.number().int() });

const LineSchema = z.object({
  description: z.string(),
  quantity: z.string().nullable(),
  unitPrice: z.string().nullable(),
  net: z.string().nullable(),
  vatRatePercent: z.string().nullable(),
  vat: z.string().nullable(),
  gross: z.string().nullable(),
  confidence: z.number().int(),
});

const VatTotalSchema = z.object({
  ratePercent: z.string().nullable(),
  label: z.string().nullable(),
  net: z.string().nullable(),
  vat: z.string().nullable(),
  confidence: z.number().int(),
});

export const InvoiceExtractionSchema = z.object({
  documentType: Field,
  supplierName: Field, supplierAddress: Field, supplierVatNumber: Field, supplierCountry: Field,
  customerName: Field, customerAddress: Field, customerVatNumber: Field, customerCountry: Field,
  invoiceNumber: Field, documentDate: Field, supplyDate: Field, dueDate: Field,
  currency: Field, paymentTerms: Field, originalDocumentNumber: Field,
  net: Field, vat: Field, gross: Field, vatRatePercent: Field,
  suggestedVatTreatment: Field, suggestedAccountCode: Field,
  lines: z.array(LineSchema),
  vatTotals: z.array(VatTotalSchema),
  vatLegends: z.array(z.string()),
  notes: z.array(z.string()),
});
export type InvoiceExtraction = z.infer<typeof InvoiceExtractionSchema>;

/** The one SDK call this provider makes; injectable so the mapping is testable without a network. */
export type ParseInvoice = (request: {
  model: string; system: string; content: Anthropic.ContentBlockParam[];
}) => Promise<{ parsed: InvoiceExtraction | null; stopReason: string | null }>;

function sdkParser(apiKey: string): ParseInvoice {
  const client = new Anthropic({ apiKey });
  return async ({ model, system, content }) => {
    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content }],
      output_config: { format: zodOutputFormat(InvoiceExtractionSchema) },
    });
    return { parsed: response.parsed_output ?? null, stopReason: response.stop_reason };
  };
}

export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly name = 'anthropic';
  readonly version = '2.0.0';
  private readonly model: string;

  constructor(
    private readonly apiKey = process.env.ANTHROPIC_API_KEY,
    model = process.env.ANTHROPIC_EXTRACTION_MODEL ?? 'claude-sonnet-5',
    private readonly parseInvoice?: ParseInvoice,
  ) {
    this.model = model;
  }

  isAvailable(): boolean {
    return Boolean(this.parseInvoice)
      || (typeof this.apiKey === 'string' && this.apiKey.trim().length > 0);
  }

  async extract(params: {
    content: Buffer; mimeType: string; filename: string; context: ExtractionContext;
  }): Promise<ExtractionResult> {
    const started = Date.now();

    if (!this.isAvailable()) {
      return failure(this, started,
        'No ANTHROPIC_API_KEY is configured, so the AI provider is unavailable. '
          + 'The local extractor is used instead.');
    }

    let text = '';
    let method: ExtractionResult['textExtractionMethod'] = 'none';
    const isImage = /^image\/(png|jpeg|gif|webp)$/.test(params.mimeType);
    const isPdf = params.mimeType === 'application/pdf';

    if (isPdf) {
      try {
        text = await extractPdfText(params.content);
        method = 'pdf_text_layer';
      } catch { /* fall through to sending the document itself */ }
    } else if (params.mimeType.startsWith('text/')) {
      text = params.content.toString('utf8');
      method = 'provided';
    } else if (!isImage) {
      return failure(this, started,
        `The AI reader cannot read ${params.mimeType} files. Convert it to PDF or an image.`);
    }

    const useDocument = (isPdf && text.trim().length < 40) || isImage;
    if (useDocument) method = 'ocr';

    const content: Anthropic.ContentBlockParam[] = useDocument
      ? [
          isImage
            ? {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: params.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                  data: params.content.toString('base64'),
                },
              }
            : {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: params.content.toString('base64') },
              },
          { type: 'text', text: userPrompt(params.filename, '') },
        ]
      : [{ type: 'text', text: userPrompt(params.filename, text) }];

    try {
      const parse = this.parseInvoice ?? sdkParser(this.apiKey!);
      const { parsed, stopReason } = await parse({ model: this.model, system: systemPrompt(params.context), content });
      if (stopReason === 'refusal') {
        return failure(this, started, 'The AI reader declined to read this document.', text, method);
      }
      if (!parsed) {
        return failure(this, started,
          `The AI reader did not return a complete result (stopped: ${stopReason ?? 'unknown'}).`, text, method);
      }

      const { fields, lines, vatTotals, vatLegends, observations } = mapExtraction(parsed, params.context);
      const confidence = overallConfidence(fields);

      return {
        provider: this.name,
        providerVersion: this.version,
        model: this.model,
        textExtractionMethod: method,
        extractedText: text,
        fields,
        lines,
        vatTotals,
        vatLegends,
        overallConfidence: confidence,
        status: confidence >= 50 ? 'succeeded' : 'partial',
        durationMs: Date.now() - started,
        observations,
      };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        return failure(this, started, 'The Anthropic API key was rejected.', text, method);
      }
      if (error instanceof Anthropic.RateLimitError) {
        return failure(this, started, 'The Anthropic API is rate limiting requests. Try again shortly.', text, method);
      }
      if (error instanceof Anthropic.APIError) {
        return failure(this, started, `The Anthropic API returned ${error.status}: ${error.message}`, text, method);
      }
      return failure(this, started,
        `Could not reach the Anthropic API: ${(error as Error).message}`, text, method);
    }
  }
}

function failure(
  provider: ExtractionProvider, started: number, message: string,
  text = '', method: ExtractionResult['textExtractionMethod'] = 'none',
): ExtractionResult {
  return {
    provider: provider.name, providerVersion: provider.version,
    textExtractionMethod: method, extractedText: text,
    fields: emptyFields(), lines: [], vatTotals: [], vatLegends: [], overallConfidence: 0, status: 'failed',
    errorMessage: message, durationMs: Date.now() - started,
    observations: [message],
  };
}

function systemPrompt(context: ExtractionContext): string {
  return [
    'You extract structured data from invoices, receipts and credit notes for an Irish',
    'company’s bookkeeping system. You are a reading aid, not an accountant: every',
    'value you return is shown to a person beside the document, to check and confirm.',
    '',
    'Rules:',
    '1. Report only what is PRINTED on the document. Never calculate a figure that',
    '   is not there, and never correct one that looks wrong. If the document’s own',
    '   arithmetic is inconsistent, report the printed figures and say so in "notes".',
    '2. If a value is not present, return null for it. Never guess to be helpful.',
    '3. Give each value an honest confidence from 0 to 100. Use a low number when',
    '   you are unsure: an unsure value that says so is far more useful than a',
    '   confident one that is wrong.',
    '4. Amounts are decimal strings exactly as printed, e.g. "1234.56". Do not',
    '   convert currencies or round. VAT rates are percentages as strings, e.g. "13.5".',
    '5. Dates are YYYY-MM-DD. If the document uses an ambiguous numeric format,',
    '   read it day-first (European) and lower your confidence.',
    '6. "lines": every goods or services line, in order, with the columns the',
    '   document prints for it (null where a column is not printed). Totals, VAT',
    '   summary rows, payment details and headings are not lines.',
    '7. "vatTotals": the VAT analysis per rate, as printed (one entry per rate band).',
    '8. "vatLegends": any wording about VAT treatment, verbatim — reverse charge,',
    '   Article 44/196/138, intra-Community supply, exempt, zero-rated, margin',
    '   scheme, outside the scope, postponed accounting, in any language.',
    '9. "documentType": one of supplier_invoice, sales_invoice, receipt, credit_note,',
    '   proforma, sales_record, statement, other.',
    '10. Countries are ISO 3166 two-letter codes (IE, DE, GB, US …).',
    '',
    `The company using this system is "${context.companyName}"`
      + (context.companyVatNumber ? ` with VAT number ${context.companyVatNumber}.` : '.'),
    'On a purchase it is the customer; on its own sales invoice it is the supplier.',
    'Never report its name or VAT number as the other party’s.',
    '',
    'For "suggestedVatTreatment" and "suggestedAccountCode", use only a code from these',
    'lists, or null. They are suggestions for the person to accept or change.',
    'Account codes:',
    ...context.availableAccountCodes.map((a) => `  ${a.code} ${a.name}`),
    'VAT treatment codes:',
    ...context.availableVatTreatments.map((t) => `  ${t.code} ${t.name}`),
  ].join('\n');
}

function userPrompt(filename: string, text: string): string {
  return text.trim().length > 0
    ? `Filename: ${filename}\n\nDocument text:\n\n${text}`
    : `Filename: ${filename}\n\nExtract the details from the attached document.`;
}

const DOCUMENT_TYPES = new Set([
  'supplier_invoice', 'sales_invoice', 'receipt', 'credit_note', 'proforma', 'sales_record', 'statement', 'other',
]);

/** A model's self-reported certainty is not evidence, so it is capped below a matched pattern's. */
const cap = (confidence: number, max = 90): number => Math.max(0, Math.min(max, Math.round(confidence)));

/**
 * Map the model's structured result onto typed fields, lines and VAT totals.
 *
 * Every amount, rate and date is re-parsed with the deterministic parsers the
 * rest of the system uses; a value that does not parse is dropped and noted,
 * never stored. Arithmetic is checked here, not trusted from the model.
 */
export function mapExtraction(raw: InvoiceExtraction, context: ExtractionContext): {
  fields: ExtractedDocument;
  lines: ExtractedLineSnapshot[];
  vatTotals: ExtractedVatTotalSnapshot[];
  vatLegends: string[];
  observations: string[];
} {
  const fields = emptyFields();
  const observations = raw.notes.filter((n) => n.trim() !== '');
  const present = (f: { value: string | null }): f is { value: string; confidence: number } =>
    f.value !== null && f.value.trim() !== '';

  const text = (source: { value: string | null; confidence: number }, target: keyof ExtractedDocument, transform = (v: string) => v) => {
    if (present(source)) {
      (fields[target] as { value: string | null; confidence: number }) = {
        value: transform(source.value.trim()), confidence: cap(source.confidence),
      };
    }
  };

  if (present(raw.documentType) && DOCUMENT_TYPES.has(raw.documentType.value)) {
    fields.documentType = { value: raw.documentType.value, confidence: cap(raw.documentType.confidence) };
  }
  text(raw.supplierName, 'supplierName');
  text(raw.supplierAddress, 'supplierAddress');
  text(raw.supplierVatNumber, 'supplierVatNumber', (v) => v.replace(/\s/g, '').toUpperCase());
  text(raw.supplierCountry, 'supplierCountry', (v) => v.toUpperCase());
  text(raw.customerName, 'customerName');
  text(raw.customerAddress, 'customerAddress');
  text(raw.customerVatNumber, 'customerVatNumber', (v) => v.replace(/\s/g, '').toUpperCase());
  text(raw.customerCountry, 'customerCountry', (v) => v.toUpperCase());
  text(raw.invoiceNumber, 'invoiceNumber');
  text(raw.currency, 'currency', (v) => v.toUpperCase());
  text(raw.paymentTerms, 'paymentTerms');
  text(raw.originalDocumentNumber, 'originalDocumentNumber');

  for (const [country, target] of [[raw.supplierCountry, 'supplierCountry'], [raw.customerCountry, 'customerCountry']] as const) {
    if (present(country) && !/^[A-Z]{2}$/i.test(country.value.trim())) {
      fields[target] = { value: null, confidence: 0 };
      observations.push(`"${country.value}" is not a two-letter country code, so it was discarded.`);
    }
  }

  // Suggestions are only accepted if they name something that actually exists.
  if (present(raw.suggestedVatTreatment)) {
    if (context.availableVatTreatments.some((t) => t.code === raw.suggestedVatTreatment.value)) {
      fields.suggestedVatTreatment = { value: raw.suggestedVatTreatment.value, confidence: cap(raw.suggestedVatTreatment.confidence, 75) };
    } else {
      observations.push(`The suggested VAT treatment "${raw.suggestedVatTreatment.value}" is not one of this `
        + 'company’s configured treatments, so it was discarded.');
    }
  }
  if (present(raw.suggestedAccountCode)
      && context.availableAccountCodes.some((a) => a.code === raw.suggestedAccountCode.value)) {
    fields.suggestedAccountCode = { value: raw.suggestedAccountCode.value, confidence: cap(raw.suggestedAccountCode.confidence, 75) };
  }

  for (const [source, target] of [
    [raw.documentDate, 'documentDate'], [raw.supplyDate, 'supplyDate'], [raw.dueDate, 'dueDate'],
  ] as const) {
    if (!present(source)) continue;
    try {
      fields[target] = { value: parseDateFlexible(source.value), confidence: cap(source.confidence) };
    } catch (error) {
      if (!(error instanceof DateError)) throw error;
      observations.push(`Could not read "${source.value}" as a date, so it was discarded.`);
    }
  }

  const currency = fields.currency.value ?? context.baseCurrency;
  const amount = (value: string | null, where: string): number | null => {
    if (value === null || value.trim() === '') return null;
    try {
      return parseAmount(value, currency);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      observations.push(`${where}: could not read "${value}" as an amount, so it was discarded.`);
      return null;
    }
  };
  const rate = (value: string | null, where: string): number | null => {
    if (value === null || value.trim() === '') return null;
    try {
      const bp = parseRate(value);
      if (bp >= 0 && bp <= 3000) return bp;
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
    }
    observations.push(`${where}: "${value}" is not a VAT rate, so it was discarded.`);
    return null;
  };

  for (const [source, target, where] of [
    [raw.net, 'netMinor', 'Net'], [raw.vat, 'vatMinor', 'VAT'], [raw.gross, 'grossMinor', 'Total'],
  ] as const) {
    const value = amount(source.value, where);
    if (value !== null) fields[target] = { value, confidence: cap(source.confidence) };
  }
  const headerRate = rate(raw.vatRatePercent.value, 'VAT rate');
  if (headerRate !== null) fields.vatRateBasisPoints = { value: headerRate, confidence: cap(raw.vatRatePercent.confidence) };

  const lines: ExtractedLineSnapshot[] = raw.lines
    .filter((l) => l.description.trim() !== '')
    .map((l, i) => {
      const where = `Line ${i + 1}`;
      const quantity = l.quantity !== null && /^\d+(\.\d+)?$/.test(l.quantity.trim()) ? l.quantity.trim() : null;
      return {
        description: l.description.trim(),
        quantity,
        unitPriceMinor: amount(l.unitPrice, `${where} unit price`),
        netMinor: amount(l.net, `${where} net`),
        vatRateBasisPoints: rate(l.vatRatePercent, `${where} rate`),
        vatMinor: amount(l.vat, `${where} VAT`),
        grossMinor: amount(l.gross, `${where} total`),
        confidence: cap(l.confidence),
      };
    });

  const vatTotals: ExtractedVatTotalSnapshot[] = raw.vatTotals.map((t, i) => ({
    rateBasisPoints: rate(t.ratePercent, `VAT total ${i + 1} rate`),
    label: t.label?.trim() || null,
    netMinor: amount(t.net, `VAT total ${i + 1} net`),
    vatMinor: amount(t.vat, `VAT total ${i + 1} VAT`),
    confidence: cap(t.confidence),
  }));

  const vatLegends = [...new Set(raw.vatLegends.map((l) => l.trim()).filter(Boolean))];

  // Arithmetic is checked in code, never trusted from the model.
  const { netMinor, vatMinor, grossMinor } = fields;
  if (netMinor.value !== null && vatMinor.value !== null && grossMinor.value !== null
      && netMinor.value + vatMinor.value !== grossMinor.value) {
    observations.push(
      `The extracted amounts do not add up: ${netMinor.value / 100} + ${vatMinor.value / 100} `
        + `does not equal ${grossMinor.value / 100}. Check the document.`,
    );
    for (const field of [netMinor, vatMinor, grossMinor]) field.confidence = Math.min(field.confidence, 40);
  }

  return { fields, lines, vatTotals, vatLegends, observations };
}

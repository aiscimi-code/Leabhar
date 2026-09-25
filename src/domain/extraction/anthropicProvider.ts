import {
  type ExtractionProvider, type ExtractionResult, type ExtractionContext,
  type ExtractedDocument, emptyFields, overallConfidence,
} from './types';
import { parseAmount, MoneyError } from '../money';
import { parseDateFlexible, DateError } from '../dates';
import { extractPdfText } from './pdfText';

/**
 * Optional Anthropic extraction provider (README §19).
 *
 * Active only when ANTHROPIC_API_KEY is set. Everything works without it — the
 * deterministic local provider is the default — because README §3 requires that
 * the database not depend on an LLM being available.
 *
 * Two constraints shape this implementation:
 *
 *  - The model returns *suggestions*, never decisions. Results are written with
 *    source 'ai' and status 'ai_suggestion', and README §19 forbids AI silently
 *    changing confirmed accounting data. The write path enforces that; this
 *    provider simply never claims more than it should.
 *  - Arithmetic is not delegated. The model is asked for the figures printed on
 *    the document, and the net/VAT/gross relationship is then checked in code.
 *    README §50 is explicit that LLM evaluation must not be relied on for
 *    arithmetic, and a model that "helpfully" recalculates a total is worse than
 *    one that misreads it, because the error looks correct.
 */
export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly name = 'anthropic';
  readonly version = '1.0.0';
  private readonly model: string;

  constructor(
    private readonly apiKey = process.env.ANTHROPIC_API_KEY,
    model = process.env.ANTHROPIC_EXTRACTION_MODEL ?? 'claude-sonnet-5',
  ) {
    this.model = model;
  }

  isAvailable(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
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
    const isImage = params.mimeType.startsWith('image/');
    const isPdf = params.mimeType === 'application/pdf';

    if (isPdf) {
      try {
        text = await extractPdfText(params.content);
        method = 'pdf_text_layer';
      } catch { /* fall through to sending the document itself */ }
    } else if (params.mimeType === 'text/plain') {
      text = params.content.toString('utf8');
      method = 'provided';
    }

    const useDocument = (isPdf && text.trim().length < 40) || isImage;
    if (useDocument) method = 'ocr';

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 2048,
          system: systemPrompt(params.context),
          messages: [{
            role: 'user',
            content: useDocument
              ? [
                  {
                    type: isImage ? 'image' : 'document',
                    source: {
                      type: 'base64',
                      media_type: isImage ? params.mimeType : 'application/pdf',
                      data: params.content.toString('base64'),
                    },
                  },
                  { type: 'text', text: userPrompt(params.filename, '') },
                ]
              : [{ type: 'text', text: userPrompt(params.filename, text) }],
          }],
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return failure(this, started,
          `The Anthropic API returned ${response.status}. ${body.slice(0, 300)}`, text, method);
      }

      const payload = await response.json() as {
        content: Array<{ type: string; text?: string }>;
      };
      const raw = payload.content.find((c) => c.type === 'text')?.text ?? '';
      const parsed = parseModelJson(raw);
      if (!parsed) {
        return failure(this, started,
          'The model did not return usable JSON.', text, method);
      }

      const { fields, observations } = mapToFields(parsed, params.context);
      const confidence = overallConfidence(fields);

      return {
        provider: this.name,
        providerVersion: this.version,
        model: this.model,
        textExtractionMethod: method,
        extractedText: text,
        fields,
        lines: [],
        vatTotals: [],
        vatLegends: [],
        overallConfidence: confidence,
        status: confidence >= 50 ? 'succeeded' : 'partial',
        durationMs: Date.now() - started,
        observations,
      };
    } catch (error) {
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
    'You extract structured data from invoices and receipts for an Irish company’s',
    'bookkeeping system. You are a reading aid, not an accountant: your output is',
    'shown to a person as a suggestion for them to confirm.',
    '',
    'Rules:',
    '1. Report only what is PRINTED on the document. Never calculate a figure that',
    '   is not there, and never correct one that looks wrong. If the document’s own',
    '   arithmetic is inconsistent, report the printed figures and say so in "notes".',
    '2. If a field is not present, return null for it. Never guess to be helpful.',
    '3. Give each field an honest confidence from 0 to 100. Use a low number when',
    '   you are unsure. An unsure field that says so is far more useful than a',
    '   confident one that is wrong.',
    '4. Amounts must be returned as decimal strings exactly as printed, e.g. "1234.56".',
    '   Do not convert currencies or round anything.',
    '5. Dates must be returned as YYYY-MM-DD. If the document uses an ambiguous',
    '   numeric format, prefer day-first (European) and lower your confidence.',
    '',
    `The company using this system is "${context.companyName}"`,
    context.companyVatNumber ? ` with VAT number ${context.companyVatNumber}.` : '.',
    'That is the CUSTOMER on a purchase invoice. Never report the company’s own',
    'name or VAT number as the supplier’s.',
    '',
    'Available accounting account codes:',
    ...context.availableAccountCodes.map((a) => `  ${a.code} ${a.name}`),
    '',
    'Available VAT treatment codes:',
    ...context.availableVatTreatments.map((t) => `  ${t.code} ${t.name}`),
    '',
    'Respond with a single JSON object and nothing else, in this shape:',
    '{"documentType":{"value":string|null,"confidence":number},',
    ' "supplierName":{...},"customerName":{...},"invoiceNumber":{...},',
    ' "documentDate":{...},"dueDate":{...},"currency":{...},',
    ' "net":{...},"vat":{...},"gross":{...},"vatRatePercent":{...},',
    ' "supplierVatNumber":{...},"customerVatNumber":{...},"supplierCountry":{...},',
    ' "suggestedVatTreatment":{...},"suggestedAccountCode":{...},',
    ' "notes":[string]}',
  ].join('\n');
}

function userPrompt(filename: string, text: string): string {
  return text.trim().length > 0
    ? `Filename: ${filename}\n\nDocument text:\n\n${text.slice(0, 40_000)}`
    : `Filename: ${filename}\n\nExtract the fields from the attached document.`;
}

function parseModelJson(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface RawField { value?: unknown; confidence?: unknown }

/**
 * Map the model's JSON onto typed fields.
 *
 * Every value is re-parsed here with the same deterministic parsers the rest of
 * the system uses, so a malformed amount or date from the model is rejected
 * rather than stored. The model's confidence is capped, because a model's
 * self-reported certainty is not evidence.
 */
function mapToFields(
  raw: Record<string, unknown>, context: ExtractionContext,
): { fields: ExtractedDocument; observations: string[] } {
  const fields = emptyFields();
  const observations: string[] = [];

  const notes = raw['notes'];
  if (Array.isArray(notes)) {
    for (const note of notes) if (typeof note === 'string') observations.push(note);
  }

  const read = (key: string): RawField =>
    (raw[key] && typeof raw[key] === 'object' ? raw[key] as RawField : {});

  const confidenceOf = (field: RawField, cap = 90): number => {
    const value = typeof field.confidence === 'number' ? field.confidence : 0;
    // Capped: a model asserting 100 is not the same as a regex that matched.
    return Math.max(0, Math.min(cap, Math.round(value)));
  };

  const text = (key: string, target: keyof ExtractedDocument): void => {
    const field = read(key);
    if (typeof field.value === 'string' && field.value.trim() !== '') {
      (fields[target] as { value: string | null; confidence: number }) = {
        value: field.value.trim(), confidence: confidenceOf(field),
      };
    }
  };

  text('documentType', 'documentType');
  text('supplierName', 'supplierName');
  text('customerName', 'customerName');
  text('invoiceNumber', 'invoiceNumber');
  text('currency', 'currency');
  text('supplierVatNumber', 'supplierVatNumber');
  text('customerVatNumber', 'customerVatNumber');
  text('supplierCountry', 'supplierCountry');

  // Suggestions are only accepted if they name something that actually exists.
  const treatment = read('suggestedVatTreatment');
  if (typeof treatment.value === 'string') {
    const valid = context.availableVatTreatments.some((t) => t.code === treatment.value);
    if (valid) {
      fields.suggestedVatTreatment = {
        value: treatment.value, confidence: confidenceOf(treatment, 75),
      };
    } else {
      observations.push(
        `The suggested VAT treatment "${treatment.value}" is not one of this company’s `
          + 'configured treatments, so it was discarded.',
      );
    }
  }

  const accountCode = read('suggestedAccountCode');
  if (typeof accountCode.value === 'string') {
    const valid = context.availableAccountCodes.some((a) => a.code === accountCode.value);
    if (valid) {
      fields.suggestedAccountCode = {
        value: accountCode.value, confidence: confidenceOf(accountCode, 75),
      };
    }
  }

  for (const [key, target] of [['documentDate', 'documentDate'], ['dueDate', 'dueDate']] as const) {
    const field = read(key);
    if (typeof field.value === 'string' && field.value.trim() !== '') {
      try {
        fields[target] = {
          value: parseDateFlexible(field.value), confidence: confidenceOf(field),
        };
      } catch (error) {
        if (!(error instanceof DateError)) throw error;
        observations.push(`Could not read "${field.value}" as a date, so it was discarded.`);
      }
    }
  }

  const currency = fields.currency.value ?? context.baseCurrency;
  for (const [key, target] of
       [['net', 'netMinor'], ['vat', 'vatMinor'], ['gross', 'grossMinor']] as const) {
    const field = read(key);
    if (field.value === null || field.value === undefined) continue;
    try {
      fields[target] = {
        value: parseAmount(String(field.value), currency), confidence: confidenceOf(field),
      };
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      observations.push(`Could not read "${field.value}" as an amount, so it was discarded.`);
    }
  }

  const rate = read('vatRatePercent');
  if (typeof rate.value === 'number' && rate.value >= 0 && rate.value <= 30) {
    fields.vatRateBasisPoints = {
      value: Math.round(rate.value * 100), confidence: confidenceOf(rate),
    };
  }

  // Arithmetic is checked in code, never trusted from the model.
  const { netMinor, vatMinor, grossMinor } = fields;
  if (netMinor.value !== null && vatMinor.value !== null && grossMinor.value !== null
      && netMinor.value + vatMinor.value !== grossMinor.value) {
    observations.push(
      `The extracted amounts do not add up: ${netMinor.value / 100} + ${vatMinor.value / 100} `
        + `does not equal ${grossMinor.value / 100}. Check the document.`,
    );
    for (const field of [netMinor, vatMinor, grossMinor]) {
      field.confidence = Math.min(field.confidence, 40);
    }
  }

  return { fields, observations };
}

import { parseAmount, MoneyError, vatFromNet } from '../money';
import { parseDateFlexible, DateError } from '../dates';
import {
  type ExtractionProvider, type ExtractionResult, type ExtractionContext,
  type ExtractedDocument, type ExtractedField, emptyFields, overallConfidence,
} from './types';
import { findVatNumbers, suggestPurchaseTreatment, parseVatNumber } from './vatNumbers';
import { extractPdfText } from './pdfText';

/**
 * Deterministic local extractor (README §12).
 *
 * This is the default provider, and the reason the application works with AI
 * switched off. It reads the PDF text layer and applies labelled-field patterns:
 * an invoice that says "Total: €123.00" is not a problem that needs a language
 * model, and a regex that finds it reports high confidence honestly, whereas an
 * LLM asked the same question reports high confidence whether or not it is right.
 *
 * Where it cannot find something it says so with zero confidence, and the
 * document goes to the review queue rather than acquiring a guessed value.
 */
export class LocalExtractionProvider implements ExtractionProvider {
  readonly name = 'local';
  readonly version = '1.0.0';

  isAvailable(): boolean { return true; }

  async extract(params: {
    content: Buffer; mimeType: string; filename: string; context: ExtractionContext;
  }): Promise<ExtractionResult> {
    const started = Date.now();
    const observations: string[] = [];

    let text = '';
    let method: ExtractionResult['textExtractionMethod'] = 'none';

    try {
      if (params.mimeType === 'application/pdf') {
        text = await extractPdfText(params.content);
        method = 'pdf_text_layer';
        if (text.trim().length < 40) {
          observations.push(
            'This PDF contains almost no selectable text, which usually means it is a '
              + 'scan. Enable an OCR-capable extraction provider, or enter the figures '
              + 'by hand.',
          );
        }
      } else if (params.mimeType === 'text/plain') {
        text = params.content.toString('utf8');
        method = 'provided';
      } else if (params.mimeType.startsWith('image/')) {
        observations.push(
          'This is an image. The local extractor does not perform OCR, so nothing was '
            + 'read from it. Enter the figures by hand or configure an OCR provider.',
        );
      }
    } catch (error) {
      return {
        provider: this.name, providerVersion: this.version,
        textExtractionMethod: method, extractedText: '',
        fields: emptyFields(), overallConfidence: 0, status: 'failed',
        errorMessage: (error as Error).message,
        durationMs: Date.now() - started,
        observations: [`Could not read this file: ${(error as Error).message}`],
      };
    }

    const fields = this.extractFields(text, params.context, params.filename, observations);
    const confidence = overallConfidence(fields);

    return {
      provider: this.name,
      providerVersion: this.version,
      textExtractionMethod: method,
      extractedText: text,
      fields,
      overallConfidence: confidence,
      status: text.trim().length === 0 ? 'failed' : confidence >= 50 ? 'succeeded' : 'partial',
      durationMs: Date.now() - started,
      observations,
    };
  }

  private extractFields(
    text: string, context: ExtractionContext, filename: string, observations: string[],
  ): ExtractedDocument {
    const fields = emptyFields();
    if (text.trim().length === 0) return fields;

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const haystack = text.replace(/ /g, ' ');

    // ---- Currency ----
    const currency = detectCurrency(haystack);
    if (currency) {
      fields.currency = { value: currency.code, confidence: currency.confidence,
                          evidence: currency.evidence };
    }
    const workingCurrency = currency?.code ?? context.baseCurrency;

    // ---- Amounts ----
    const gross = findLabelledAmount(lines, GROSS_LABELS, workingCurrency);
    const net = findLabelledAmount(lines, NET_LABELS, workingCurrency);
    const vat = findLabelledAmount(lines, VAT_LABELS, workingCurrency);

    if (gross) fields.grossMinor = gross;
    if (net) fields.netMinor = net;
    if (vat) fields.vatMinor = vat;

    // Derive whichever of the three is missing, but only from two that agree.
    this.reconcileAmounts(fields, observations);

    // ---- VAT rate ----
    const rate = findVatRate(haystack);
    if (rate) fields.vatRateBasisPoints = rate;

    // ---- Dates ----
    const documentDate = findLabelledDate(lines, [
      /\b(?:invoice\s+date|date\s+of\s+issue|issue\s+date|receipt\s+date|date\s+issued)\b/i,
      /\bdate\b/i,
    ]);
    if (documentDate) fields.documentDate = documentDate;

    const dueDate = findLabelledDate(lines, [
      /\b(?:due\s+date|payment\s+due|due\s+on|pay\s+by)\b/i,
    ]);
    if (dueDate) fields.dueDate = dueDate;

    // ---- Invoice number ----
    const invoiceNumber = findInvoiceNumber(lines);
    if (invoiceNumber) fields.invoiceNumber = invoiceNumber;

    // ---- VAT numbers and country ----
    const vatNumbers = findVatNumbers(haystack, context.companyVatNumber);
    if (vatNumbers.length > 0) {
      const supplierVat = vatNumbers[0]!;
      fields.supplierVatNumber = {
        value: supplierVat.normalised, confidence: 90, evidence: supplierVat.note,
      };
      if (supplierVat.countryCode) {
        fields.supplierCountry = { value: supplierVat.countryCode, confidence: 85 };
      }
      if (vatNumbers.length > 1) {
        observations.push(
          `${vatNumbers.length} VAT numbers appear on this document. The first was taken `
            + 'as the supplier’s; check which is which.',
        );
      }
    }

    // ---- Supplier, matched against known profiles ----
    const supplier = matchKnownSupplier(haystack, context);
    if (supplier) {
      fields.supplierName = supplier.field;
      if (!fields.supplierCountry.value && supplier.countryCode) {
        fields.supplierCountry = { value: supplier.countryCode, confidence: 70 };
      }
      if (supplier.defaultAccountCode) {
        fields.suggestedAccountCode = {
          value: supplier.defaultAccountCode, confidence: 85,
          evidence: `Previously confirmed treatment for ${supplier.field.value}.`,
        };
      }
      if (supplier.defaultVatTreatmentCode) {
        fields.suggestedVatTreatment = {
          value: supplier.defaultVatTreatmentCode, confidence: 85,
          evidence: `Previously confirmed treatment for ${supplier.field.value}.`,
        };
      }
    } else {
      const guessed = guessSupplierFromHeading(lines, context);
      if (guessed) fields.supplierName = guessed;
    }

    // ---- Document type ----
    fields.documentType = detectDocumentType(haystack, filename);

    // ---- Suggested VAT treatment, where history has not already answered ----
    if (!fields.suggestedVatTreatment.value) {
      const suggestion = suggestPurchaseTreatment({
        supplierVatNumber: fields.supplierVatNumber.value,
        supplierCountry: fields.supplierCountry.value,
        vatChargedMinor: fields.vatMinor.value,
      });
      const available = new Set(context.availableVatTreatments.map((t) => t.code));
      if (available.has(suggestion.code)) {
        fields.suggestedVatTreatment = {
          value: suggestion.code,
          confidence: suggestion.confidence,
          evidence: suggestion.reason,
        };
      }
    }

    return fields;
  }

  /**
   * Fill in a missing amount from the other two, and report a disagreement
   * rather than choosing a winner. README §44 requires that invoice total
   * mismatches are surfaced, not silently repaired.
   */
  private reconcileAmounts(fields: ExtractedDocument, observations: string[]): void {
    const net = fields.netMinor.value;
    const vat = fields.vatMinor.value;
    const gross = fields.grossMinor.value;

    if (net !== null && vat !== null && gross !== null) {
      if (net + vat !== gross) {
        observations.push(
          `The amounts read from this document do not add up: net ${net / 100} plus VAT `
            + `${vat / 100} is ${(net + vat) / 100}, but the total reads ${gross / 100}. `
            + 'Check the document before confirming.',
        );
        fields.netMinor.confidence = Math.min(fields.netMinor.confidence, 40);
        fields.vatMinor.confidence = Math.min(fields.vatMinor.confidence, 40);
        fields.grossMinor.confidence = Math.min(fields.grossMinor.confidence, 40);
      }
      return;
    }

    if (net !== null && vat !== null && gross === null) {
      fields.grossMinor = {
        value: net + vat,
        confidence: Math.min(fields.netMinor.confidence, fields.vatMinor.confidence) - 5,
        evidence: 'Calculated as net plus VAT.',
      };
    } else if (gross !== null && vat !== null && net === null) {
      fields.netMinor = {
        value: gross - vat,
        confidence: Math.min(fields.grossMinor.confidence, fields.vatMinor.confidence) - 5,
        evidence: 'Calculated as total less VAT.',
      };
    } else if (gross !== null && net !== null && vat === null) {
      fields.vatMinor = {
        value: gross - net,
        confidence: Math.min(fields.grossMinor.confidence, fields.netMinor.confidence) - 5,
        evidence: 'Calculated as total less net.',
      };
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Invoice labels, most specific first, so a weaker pattern is only reached when
 * the strong one finds nothing.
 *
 * The non-English terms are here because an Irish company buying from EU
 * suppliers routinely receives invoices in German, French, Dutch, Spanish and
 * Italian. Those are exactly the invoices carrying a reverse charge, so failing
 * to read them would push the most VAT-sensitive documents into manual entry.
 */
const GROSS_LABELS: RegExp[] = [
  /\b(?:amount\s+due|total\s+due|balance\s+due|grand\s+total|invoice\s+total|total\s+amount|total\s+\(inc[^)]*\))\b/i,
  /\b(?:gesamtbetrag|rechnungsbetrag|bruttobetrag|montant\s+total|total\s+ttc|totaal|totale|importe\s+total)\b/i,
  /\b(?:total|gesamt|brutto|totaal\s+incl)\b/i,
];

const NET_LABELS: RegExp[] = [
  /\b(?:sub\s?total|net\s+(?:amount|total)|total\s+(?:excl|ex)[^:]*)\b/i,
  /\b(?:nettobetrag|zwischensumme|netto|montant\s+ht|total\s+ht|subtotaal|imponibile|base\s+imponible)\b/i,
];

const VAT_LABELS: RegExp[] = [
  /\b(?:vat|tax)\s*(?:amount|total|@|\()/i,
  /\b(?:mwst|ust|umsatzsteuer|mehrwertsteuer|tva|btw|iva|impuesto)\b/i,
  /\b(?:vat|sales\s+tax)\b/i,
];

const CURRENCY_SYMBOLS: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /€/, code: 'EUR' },
  { pattern: /£/, code: 'GBP' },
  { pattern: /\$/, code: 'USD' },
];

function detectCurrency(text: string): { code: string; confidence: number; evidence: string } | null {
  // An explicit ISO code is far more reliable than a symbol: "$" could be USD,
  // CAD or AUD, and getting it wrong silently misstates the books.
  const isoMatch = /\b(EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CAD|AUD|JPY|NZD)\b/.exec(text);
  if (isoMatch) {
    return { code: isoMatch[1]!, confidence: 95, evidence: isoMatch[0] };
  }
  for (const { pattern, code } of CURRENCY_SYMBOLS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        code,
        // A dollar sign is genuinely ambiguous, so it is reported as such.
        confidence: code === 'USD' ? 55 : 80,
        evidence: code === 'USD'
          ? 'A "$" symbol was found. This was read as USD, but it could be another '
            + 'dollar currency — confirm it.'
          : match[0],
      };
    }
  }
  return null;
}

/** Amounts on the same line as a label, or on the line immediately after it. */
function findLabelledAmount(
  lines: string[], labels: RegExp[], currency: string,
): ExtractedField<number> | null {
  for (const [labelIndex, label] of labels.entries()) {
    // A later pattern in the list is a weaker signal.
    const baseConfidence = 92 - labelIndex * 12;

    for (const [index, line] of lines.entries()) {
      if (!label.test(line)) continue;

      const sameLine = lastAmountIn(line, currency);
      if (sameLine !== null) {
        return { value: sameLine, confidence: baseConfidence, evidence: line };
      }
      const next = lines[index + 1];
      if (next) {
        const nextLine = lastAmountIn(next, currency);
        if (nextLine !== null) {
          return { value: nextLine, confidence: baseConfidence - 10, evidence: `${line} / ${next}` };
        }
      }
    }
  }
  return null;
}

const AMOUNT_PATTERN = /[€£$]?\s?-?\(?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?\)?/g;

/** The rightmost amount on a line, which on an invoice is the figure that counts. */
function lastAmountIn(line: string, currency: string): number | null {
  const matches = [...line.matchAll(AMOUNT_PATTERN)]
    .map((m) => m[0].trim())
    .filter((t) => /\d/.test(t))
    // A bare integer under 4 digits with no separator is usually a quantity or
    // a percentage, not a money amount.
    .filter((t) => /[.,]/.test(t) || /[€£$]/.test(t) || t.replace(/\D/g, '').length > 3);

  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return parseAmount(matches[i]!, currency);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
    }
  }
  return null;
}

function findVatRate(text: string): ExtractedField<number> | null {
  const TAX_WORD = '(?:vat|tax|mwst|ust|tva|btw|iva)';
  const patterns = [
    new RegExp(`${TAX_WORD}[^%\\n]{0,20}?(\\d{1,2}(?:[.,]\\d{1,2})?)\\s*%`, 'i'),
    new RegExp(`(\\d{1,2}(?:[.,]\\d{1,2})?)\\s*%\\s*${TAX_WORD}`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const rate = Number(match[1]!.replace(',', '.'));
      if (rate >= 0 && rate <= 30) {
        return {
          value: Math.round(rate * 100),
          confidence: 85,
          evidence: match[0].trim(),
        };
      }
    }
  }
  return null;
}

function findLabelledDate(lines: string[], labels: RegExp[]): ExtractedField<string> | null {
  const DATE_TEXT = /\b(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})\b/;

  for (const [labelIndex, label] of labels.entries()) {
    const baseConfidence = 90 - labelIndex * 20;
    for (const [index, line] of lines.entries()) {
      if (!label.test(line)) continue;
      for (const candidate of [line, lines[index + 1] ?? '']) {
        const match = DATE_TEXT.exec(candidate);
        if (!match) continue;
        try {
          return {
            value: parseDateFlexible(match[1]!),
            confidence: candidate === line ? baseConfidence : baseConfidence - 10,
            evidence: line,
          };
        } catch (error) {
          if (!(error instanceof DateError)) throw error;
        }
      }
    }
  }
  return null;
}

function findInvoiceNumber(lines: string[]): ExtractedField<string> | null {
  const patterns = [
    /\b(?:invoice|receipt|credit\s+note)\s*(?:no\.?|number|#|ref\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{2,30})/i,
    /\b(?:invoice|receipt)\s*#\s*([A-Z0-9][A-Z0-9\-_/]{2,30})/i,
    /\b(?:reference|ref)\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{4,30})/i,
  ];
  for (const [index, pattern] of patterns.entries()) {
    for (const line of lines) {
      const match = pattern.exec(line);
      if (match && match[1]) {
        return {
          value: match[1].replace(/[.,;:]$/, ''),
          confidence: 88 - index * 15,
          evidence: line,
        };
      }
    }
  }
  return null;
}

function detectDocumentType(text: string, filename: string): ExtractedField<string> {
  const haystack = `${text}\n${filename}`.toLowerCase();
  const rules: Array<[RegExp, string, number]> = [
    [/credit\s+note/, 'credit_note', 90],
    [/\b(?:statement\s+of\s+account|bank\s+statement|account\s+statement)\b/, 'bank_statement', 85],
    [/\binvoice\b/, 'supplier_invoice', 75],
    [/\b(?:receipt|payment\s+confirmation|paid\s+in\s+full)\b/, 'receipt', 70],
  ];
  for (const [pattern, type, confidence] of rules) {
    if (pattern.test(haystack)) return { value: type, confidence };
  }
  return { value: 'unknown', confidence: 0 };
}

function matchKnownSupplier(
  text: string, context: ExtractionContext,
): { field: ExtractedField<string>; countryCode: string | null;
     defaultAccountCode?: string | null; defaultVatTreatmentCode?: string | null } | null {
  const haystack = text.toLowerCase();
  for (const supplier of context.knownSuppliers) {
    const candidates = [supplier.name, ...supplier.aliases].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate.length >= 3 && haystack.includes(candidate.toLowerCase())) {
        return {
          field: { value: supplier.name, confidence: 95,
                   evidence: `Matched the known supplier "${candidate}".` },
          countryCode: supplier.countryCode,
          defaultAccountCode: supplier.defaultAccountCode,
          defaultVatTreatmentCode: supplier.defaultVatTreatmentCode,
        };
      }
    }
  }
  return null;
}

/**
 * Fall back to the first substantial line that is not our own company name.
 * Weak, and reported as weak.
 */
function guessSupplierFromHeading(
  lines: string[], context: ExtractionContext,
): ExtractedField<string> | null {
  const ownName = context.companyName.toLowerCase();
  for (const line of lines.slice(0, 8)) {
    const trimmed = line.trim();
    if (trimmed.length < 3 || trimmed.length > 60) continue;
    if (trimmed.toLowerCase().includes(ownName)) continue;
    if (/^(invoice|receipt|bill|statement|tax\s+invoice)$/i.test(trimmed)) continue;
    if (/^\d/.test(trimmed)) continue;
    if (!/[a-z]/i.test(trimmed)) continue;
    return {
      value: trimmed, confidence: 35,
      evidence: 'Taken from the top of the document. This is a guess — confirm it.',
    };
  }
  return null;
}

import { parseAmount, MoneyError, vatFromNet } from '../money';
import { parseDateFlexible, DateError } from '../dates';
import {
  type ExtractionProvider, type ExtractionResult, type ExtractionContext,
  type ExtractedDocument, type ExtractedField, emptyFields, overallConfidence,
} from './types';
import { findVatNumbers, suggestPurchaseTreatment, parseVatNumber } from './vatNumbers';
import { extractPdfText } from './pdfText';
import {
  parseLineItems, parseVatTotals, findVatLegends, findSupplyDate, findPaymentTerms,
  findOriginalDocumentNumber, findCustomerBlock, findSupplierAddress, countryFromAddress,
} from './invoiceParser';

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
  readonly version = '2.0.0';

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
          'This is an image. Use "Read text from the image (OCR)" on the review screen: the text is '
            + 'recognised on this computer, then read the same way as a PDF.',
        );
      }
    } catch (error) {
      return {
        provider: this.name, providerVersion: this.version,
        textExtractionMethod: method, extractedText: '',
        fields: emptyFields(), lines: [], vatTotals: [], vatLegends: [], overallConfidence: 0, status: 'failed',
        errorMessage: (error as Error).message,
        durationMs: Date.now() - started,
        observations: [`Could not read this file: ${(error as Error).message}`],
      };
    }

    return this.fromText(text, method, params.context, params.filename, observations, started);
  }

  /**
   * Read a document from text already obtained — the PDF text layer here, or
   * OCR text recognised in the browser on the review screen (issue #202). One
   * path, so a scanned invoice is read exactly as a text PDF would be.
   */
  fromText(
    text: string,
    method: ExtractionResult['textExtractionMethod'],
    context: ExtractionContext,
    filename: string,
    observations: string[] = [],
    started: number = Date.now(),
  ): ExtractionResult {
    const fields = this.extractFields(text, context, filename, observations);
    const textLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const currency = fields.currency.value ?? context.baseCurrency;
    const lines = text.trim() ? parseLineItems(textLines, currency) : [];
    const vatTotals = text.trim() ? parseVatTotals(textLines, currency) : [];
    const vatLegends = text.trim() ? findVatLegends(textLines) : [];

    const supply = findSupplyDate(textLines);
    if (supply) fields.supplyDate = supply;
    const terms = findPaymentTerms(textLines);
    if (terms) fields.paymentTerms = terms;
    const original = findOriginalDocumentNumber(textLines);
    if (original) fields.originalDocumentNumber = original;
    const customer = findCustomerBlock(textLines);
    if (customer) {
      if (!fields.customerName.value) fields.customerName = customer.name;
      if (customer.address.value) {
        fields.customerAddress = customer.address;
        const country = countryFromAddress(customer.address.value);
        if (country) fields.customerCountry = { value: country, confidence: 50, evidence: customer.address.value };
      }
    }
    const supplierAddress = findSupplierAddress(textLines, fields.supplierName.value);
    if (supplierAddress) {
      fields.supplierAddress = supplierAddress;
      if (!fields.supplierCountry.value) {
        const country = countryFromAddress(supplierAddress.value);
        if (country) fields.supplierCountry = { value: country, confidence: 45, evidence: supplierAddress.value ?? undefined };
      }
    }
    if (text.trim() && lines.length === 0) {
      observations.push('No line items could be read. Add the lines from the document when you confirm it.');
    }

    const confidence = overallConfidence(fields);
    return {
      provider: this.name,
      providerVersion: this.version,
      textExtractionMethod: method,
      extractedText: text,
      fields,
      lines,
      vatTotals,
      vatLegends,
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
    const documentDate = findLabelledDate(lines, DOCUMENT_DATE_LABELS);
    if (documentDate) fields.documentDate = documentDate;

    const dueDate = findLabelledDate(lines, DUE_DATE_LABELS);
    if (dueDate) fields.dueDate = dueDate;

    // ---- Invoice number ----
    const invoiceNumber = findInvoiceNumber(lines);
    if (invoiceNumber) fields.invoiceNumber = invoiceNumber;

    // ---- VAT numbers and country ----
    // A VAT number on a line labelled as the customer's is the customer's.
    const customerVatLine = lines.find((l) => /\b(?:customer|client|buyer|recipient|bill(?:ed)?\s+to)\b.*\b(?:vat|tax)\b/i.test(l));
    const customerVat = customerVatLine ? findVatNumbers(customerVatLine, context.companyVatNumber)[0] : undefined;
    if (customerVat) {
      fields.customerVatNumber = { value: customerVat.normalised, confidence: 85, evidence: customerVatLine };
      if (customerVat.countryCode) {
        fields.customerCountry = { value: customerVat.countryCode, confidence: 80, evidence: customerVatLine };
      }
    }
    const vatNumbers = findVatNumbers(haystack, context.companyVatNumber)
      .filter((v) => v.normalised !== customerVat?.normalised);
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
    fields.documentType = detectDocumentType(haystack, filename, lines, context);
    if (fields.documentType.value === 'sales_invoice') {
      // We issued it: the supplier is this company, and any VAT number other
      // than ours belongs to the customer, never to a supplier.
      fields.supplierName = { value: context.companyName, confidence: 80, evidence: 'This company issued the invoice.' };
      fields.supplierVatNumber = context.companyVatNumber
        ? { value: context.companyVatNumber, confidence: 80 } : { value: null, confidence: 0 };
      fields.supplierCountry = { value: null, confidence: 0 };
      fields.suggestedAccountCode = { value: null, confidence: 0 };
      fields.suggestedVatTreatment = { value: null, confidence: 0 };
      if (!fields.customerVatNumber.value && vatNumbers[0]) {
        fields.customerVatNumber = { value: vatNumbers[0].normalised, confidence: 60, evidence: vatNumbers[0].note };
        if (vatNumbers[0].countryCode) fields.customerCountry = { value: vatNumbers[0].countryCode, confidence: 60 };
      }
    }

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

/**
 * Date and reference labels, in the same languages as the amount labels above
 * and for the same reason: a German or French invoice whose date cannot be read
 * loses one of the three legs a match needs, so it can never match
 * automatically however well the amount agrees.
 */
const DOCUMENT_DATE_LABELS: RegExp[] = [
  /\b(?:invoice\s+date|date\s+of\s+issue|issue\s+date|receipt\s+date|date\s+issued)\b/i,
  /\b(?:rechnungsdatum|belegdatum|date\s+de\s+facture|factuurdatum|fecha\s+de\s+factura|data\s+fattura)\b/i,
  /\b(?:datum|fecha|data|date)\b/i,
];

const DUE_DATE_LABELS: RegExp[] = [
  /\b(?:due\s+date|payment\s+due|due\s+on|pay\s+by)\b/i,
  /\b(?:f\u00e4lligkeitsdatum|zahlbar\s+bis|date\s+d.{0,2}\u00e9ch\u00e9ance|vervaldatum|vencimiento|scadenza)\b/i,
];

const INVOICE_NUMBER_LABELS: RegExp[] = [
  /\b(?:invoice|receipt|credit\s+note)\s*(?:no\.?|number|#|ref\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{2,30})/i,
  /\b(?:rechnungsnummer|rechnungs-?nr|belegnummer|num\u00e9ro\s+de\s+facture|factuurnummer|n\u00famero\s+de\s+factura|numero\s+fattura)\s*\.?\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{2,30})/i,
  /\b(?:invoice|receipt)\s*#\s*([A-Z0-9][A-Z0-9\-_/]{2,30})/i,
  /\b(?:reference|ref)\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{4,30})/i,
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

      // Some layouts put the label on one line and the figure on the next.
      // But a line carrying an identifier — letters glued to digits, as in
      // "USt-IdNr: DE812871812" — is a registration number, not a label
      // pointing at the next line. Falling through there would read the
      // following line's amount as this line's VAT.
      if (/[A-Za-z]\d|\d[A-Za-z]/.test(line)) continue;

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

/**
 * An amount is either a grouped number (1,234.56 / 1.234,56) or a plain run of
 * digits (2000.00), each optionally followed by a decimal part.
 *
 * The two alternatives are needed because a grouped-only pattern silently
 * truncates an ungrouped four-digit amount: "2000.00" matches as "200" and then
 * "0.00", and the rightmost match wins, so a €2,000 invoice reads as zero. That
 * is exactly the kind of failure that looks like a data-entry mistake rather
 * than a bug, so it is worth the extra alternation.
 */
const AMOUNT_PATTERN = /[€£$]?\s?-?\(?(?:\d{1,3}(?:[.,\s]\d{3})+|\d+)(?:[.,]\d{1,2})?\)?/g;

/**
 * The rightmost amount on a line, which on an invoice is the figure that counts.
 *
 * Two rejections matter more than they look:
 *
 *  - A number glued to a letter is an identifier, not an amount. "DE812871812"
 *    is a VAT number and "IE4567891K" is an Irish one, and a line reading
 *    "VAT Number: DE812871812" matches the VAT label perfectly well. Without
 *    this rule the supplier's VAT registration is read as the VAT charged.
 *  - A bare integer under four digits with no separator is usually a quantity,
 *    a percentage or a line number.
 */
function lastAmountIn(line: string, currency: string): number | null {
  const candidates: string[] = [];

  for (const match of line.matchAll(AMOUNT_PATTERN)) {
    const text = match[0];
    const trimmed = text.trim();
    if (trimmed === '' || !/\d/.test(trimmed)) continue;

    // The pattern allows a leading space, so the raw match can start one
    // character early. Measure the trimmed span, otherwise the character
    // "before" the amount is the last letter of its own label.
    const leading = text.length - text.trimStart().length;
    const start = (match.index ?? 0) + leading;
    const end = start + trimmed.length;

    const before = start > 0 ? line[start - 1] : '';
    const after = end < line.length ? line[end] : '';
    if (/[A-Za-z]/.test(before ?? '') || /[A-Za-z]/.test(after ?? '')) continue;
    // Next to a slash it is part of a reference or a date: "2006/112/EC" is a
    // Directive, "15/01/2025" a date, neither an amount.
    if (before === '/' || after === '/') continue;

    if (!/[.,]/.test(trimmed) && !/[€£$]/.test(trimmed)
        && trimmed.replace(/\D/g, '').length <= 3) continue;

    candidates.push(trimmed);
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      return parseAmount(candidates[i]!, currency);
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
  for (const [index, pattern] of INVOICE_NUMBER_LABELS.entries()) {
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

function detectDocumentType(
  text: string, filename: string, lines: string[] = [], context?: ExtractionContext,
): ExtractedField<string> {
  const haystack = `${text}\n${filename}`.toLowerCase();
  // An invoice whose letterhead is this company's own was issued by us.
  // Lines addressed to someone ("Billed to: …") name the recipient, not the issuer.
  const head = lines.slice(0, 6)
    .filter((l) => !/\b(?:bill(?:ed)?\s+to|invoice\s+to|sold\s+to|ship\s+to|customer|client|to)\b\s*:/i.test(l))
    .join('\n').toLowerCase();
  const ownName = context?.companyName.toLowerCase() ?? '';
  const ownVat = context?.companyVatNumber?.replace(/\s/g, '').toLowerCase() ?? '';
  const issuedByUs = (ownName.length >= 3 && head.includes(ownName))
    || (ownVat.length >= 8 && head.replace(/\s/g, '').includes(ownVat));
  const rules: Array<[RegExp, string, number]> = [
    [/credit\s+note|gutschrift|avoir|creditnota|nota\s+di\s+credito/, 'credit_note', 90],
    [/\b(?:statement\s+of\s+account|bank\s+statement|account\s+statement)\b/, 'bank_statement', 85],
    [/\bpro[\s-]?forma\b/, 'proforma', 85],
    [/\bsales\s+invoice\b/, 'sales_invoice', 85],
    ...(issuedByUs ? [[/\binvoice\b/, 'sales_invoice', 70] as [RegExp, string, number]] : []),
    [/\binvoice\b/, 'supplier_invoice', 75],
    [/\b(?:rechnung|facture|factuur|fattura|factura)\b/, 'supplier_invoice', 70],
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
    // "VAT Number: IE…" or "Invoice Date: …" is a label, not a name.
    if (/^[^:]{1,30}:\s/.test(trimmed)) continue;
    return {
      value: trimmed, confidence: 35,
      evidence: 'Taken from the top of the document. This is a guess — confirm it.',
    };
  }
  return null;
}

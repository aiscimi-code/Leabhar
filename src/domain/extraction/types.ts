/**
 * Provider-agnostic extraction interface (README §3, §12).
 *
 * The database must not depend on an LLM being available: AI is an assistant to
 * the accounting system, not the accounting system itself. Every provider here
 * implements the same interface, the deterministic local one is the default, and
 * the application works end to end with AI switched off entirely.
 */

export interface ExtractedField<T = string> {
  value: T | null;
  /** 0-100. A deterministic extractor that found an exact pattern reports high. */
  confidence: number;
  /** The text the value was taken from, so the user can check it in one glance. */
  evidence?: string;
}

import type { ExtractedLineSnapshot, ExtractedVatTotalSnapshot } from '@/db/schema';

export type { ExtractedLineSnapshot, ExtractedVatTotalSnapshot };

export interface ExtractedDocument {
  documentType: ExtractedField<string>;
  supplierName: ExtractedField<string>;
  customerName: ExtractedField<string>;
  invoiceNumber: ExtractedField<string>;
  documentDate: ExtractedField<string>;
  dueDate: ExtractedField<string>;
  currency: ExtractedField<string>;
  /** Minor units. */
  netMinor: ExtractedField<number>;
  vatMinor: ExtractedField<number>;
  grossMinor: ExtractedField<number>;
  vatRateBasisPoints: ExtractedField<number>;
  supplierVatNumber: ExtractedField<string>;
  customerVatNumber: ExtractedField<string>;
  supplierCountry: ExtractedField<string>;
  /** Everything else the document states (issue #202). */
  supplyDate: ExtractedField<string>;
  supplierAddress: ExtractedField<string>;
  customerAddress: ExtractedField<string>;
  customerCountry: ExtractedField<string>;
  paymentTerms: ExtractedField<string>;
  /** For a credit note: the invoice number it credits. */
  originalDocumentNumber: ExtractedField<string>;
  /** A treatment CODE, e.g. NON_EU_SERVICES_RCV. Always a suggestion. */
  suggestedVatTreatment: ExtractedField<string>;
  /** An account CODE from the chart of accounts. Always a suggestion. */
  suggestedAccountCode: ExtractedField<string>;
}

export interface ExtractionResult {
  provider: string;
  providerVersion: string;
  model?: string;
  textExtractionMethod: 'pdf_text_layer' | 'ocr' | 'none' | 'provided';
  extractedText: string;
  fields: ExtractedDocument;
  /** Every line the document lists, as read (issue #202). Empty when none could be read. */
  lines: ExtractedLineSnapshot[];
  /** The VAT analysis by rate, as printed. */
  vatTotals: ExtractedVatTotalSnapshot[];
  /** VAT wording found on the document ("reverse charge", "Article 196", "zero-rated", "exempt"...). */
  vatLegends: string[];
  overallConfidence: number;
  status: 'succeeded' | 'partial' | 'failed';
  errorMessage?: string;
  durationMs: number;
  /** Anything the extractor noticed that a human should look at. */
  observations: string[];
}

export interface ExtractionContext {
  /** Known supplier names, so an extractor can recognise a repeat supplier. */
  knownSuppliers: Array<{ id: string; name: string; matchKey: string; aliases: string[];
                          countryCode: string | null; vatNumber: string | null;
                          defaultAccountCode?: string | null;
                          defaultVatTreatmentCode?: string | null }>;
  knownCustomers: Array<{ id: string; name: string; matchKey: string; aliases: string[] }>;
  /** The company's own details, so its own VAT number is not read as a supplier's. */
  companyVatNumber: string | null;
  companyName: string;
  baseCurrency: string;
  availableAccountCodes: Array<{ code: string; name: string }>;
  availableVatTreatments: Array<{ code: string; name: string; description: string | null }>;
}

export interface ExtractionProvider {
  readonly name: string;
  readonly version: string;
  /** False when the provider needs configuration it does not have. */
  isAvailable(): boolean;
  extract(params: {
    content: Buffer;
    mimeType: string;
    filename: string;
    context: ExtractionContext;
  }): Promise<ExtractionResult>;
}

export function emptyField<T>(): ExtractedField<T> {
  return { value: null, confidence: 0 };
}

export function emptyFields(): ExtractedDocument {
  return {
    documentType: emptyField<string>(),
    supplierName: emptyField<string>(),
    customerName: emptyField<string>(),
    invoiceNumber: emptyField<string>(),
    documentDate: emptyField<string>(),
    dueDate: emptyField<string>(),
    currency: emptyField<string>(),
    netMinor: emptyField<number>(),
    vatMinor: emptyField<number>(),
    grossMinor: emptyField<number>(),
    vatRateBasisPoints: emptyField<number>(),
    supplierVatNumber: emptyField<string>(),
    customerVatNumber: emptyField<string>(),
    supplierCountry: emptyField<string>(),
    supplyDate: emptyField<string>(),
    supplierAddress: emptyField<string>(),
    customerAddress: emptyField<string>(),
    customerCountry: emptyField<string>(),
    paymentTerms: emptyField<string>(),
    originalDocumentNumber: emptyField<string>(),
    suggestedVatTreatment: emptyField<string>(),
    suggestedAccountCode: emptyField<string>(),
  };
}

/** Mean confidence across the fields that actually matter for bookkeeping. */
export function overallConfidence(fields: ExtractedDocument): number {
  const weighted: Array<[keyof ExtractedDocument, number]> = [
    ['grossMinor', 3], ['documentDate', 3], ['supplierName', 2], ['currency', 2],
    ['vatMinor', 2], ['invoiceNumber', 1], ['netMinor', 1],
  ];
  let total = 0;
  let weight = 0;
  for (const [key, w] of weighted) {
    total += fields[key].confidence * w;
    weight += w;
  }
  return weight === 0 ? 0 : Math.round(total / weight);
}

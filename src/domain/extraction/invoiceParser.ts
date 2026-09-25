/**
 * Best-effort reading of the detail on an invoice or receipt (issue #202):
 * line items, the VAT analysis by rate, VAT wording, supply date, payment
 * terms, the invoice a credit note refers to, and the parties' addresses.
 *
 * Pure text in, structured draft out — no database, no files — so it runs the
 * same over a PDF's text layer on the server and over OCR text produced in the
 * browser, and so it can be tested deterministically.
 *
 * Nothing here is authoritative. Layouts vary endlessly and OCR misreads
 * digits, so every value carries a confidence and the evidence line it came
 * from, and every document is checked and confirmed by a person before it is
 * used. Where a line's figures do not add up, it is still returned — with low
 * confidence — rather than dropped or "corrected": the reviewer sees exactly
 * what was read (AGENTS.md #7).
 */
import { parseAmount, MoneyError, vatFromNet } from '../money';
import { parseDateFlexible, DateError } from '../dates';
import type { ExtractedField, ExtractedLineSnapshot, ExtractedVatTotalSnapshot } from './types';

/** Rates an Irish supplier can charge, and the common EU standard rates, in basis points. */
const KNOWN_RATES = new Set([0, 480, 900, 1350, 2300, 1900, 2000, 2100, 2200, 2400, 2500, 2700, 700, 500, 1000, 1200]);

const AMOUNT_TOKEN = /^[(-]?[€£$]?\s?-?(?:\d{1,3}(?:[,.\s]\d{3})+|\d+)[.,]\d{2}\)?$/;
const RATE_TOKEN = /^(\d{1,2}(?:[.,]\d{1,2})?)\s?%$/;
const QTY_TOKEN = /^\d{1,5}(?:[.,]\d{1,3})?$/;

/** Lines that are totals, headings or party details — never items. */
const NOT_AN_ITEM = new RegExp([
  '\\b(?:sub\\s?-?total|total|net\\s+amount|amount\\s+due|balance|grand|vat|tax|mwst|ust|tva|btw|iva)\\b',
  // Totals in the other EU languages suppliers commonly invoice in.
  '\\b\\w*(?:betrag|summe)\\b|\\b(?:montant|totale|totaal|subtotaal|importe|imponibile)\\b',
  // Payment details, not goods or services. Kept narrow: "Business cards" or
  // "Accountancy services" are real items and must not be excluded.
  '\\b(?:amount\\s+paid|paid\\s+by|change\\s+due|iban|bic|swift|sort\\s+code)\\b',
  '\\b(?:invoice|receipt|date|due|number|no\\.|page|phone|tel|email|www\\.|http)\\b',
].join('|'), 'i');

function toAmount(token: string, currency: string): number | null {
  try {
    const cleaned = token.replace(/[()]/g, '').trim();
    const value = parseAmount(cleaned, currency);
    return token.includes('(') ? -Math.abs(value) : value;
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

function toRate(token: string): number | null {
  const m = RATE_TOKEN.exec(token.trim());
  if (!m) return null;
  const bp = Math.round(Number(m[1]!.replace(',', '.')) * 100);
  return bp >= 0 && bp <= 3000 ? bp : null;
}

/** "2 x 49.50" / "2.5" / "10" → decimal string. */
function toQuantity(token: string): string | null {
  const t = token.trim().replace(/x$/i, '');
  if (!QTY_TOKEN.test(t)) return null;
  return t.replace(',', '.');
}

/**
 * Split a line into a description and its trailing numeric columns.
 * Tokens are separated by 2+ spaces or tabs where the layout preserved them,
 * else by single spaces from the right.
 */
function splitColumns(line: string): { description: string; tail: string[] } {
  const tokens = line.trim().split(/\s+/);
  const tail: string[] = [];
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]!;
    if (AMOUNT_TOKEN.test(last) || RATE_TOKEN.test(last) || QTY_TOKEN.test(last.replace(/x$/i, ''))
        || /^[€£$]$/.test(last) || /^x$/i.test(last)) {
      tail.unshift(tokens.pop()!);
    } else {
      break;
    }
  }
  return { description: tokens.join(' '), tail: tail.filter((t) => !/^[€£$x]$/i.test(t)) };
}

/**
 * Read the line items. A line is an item when it has a description followed by
 * at least one money amount, and is not a total, heading or party detail.
 */
export function parseLineItems(textLines: string[], currency: string): ExtractedLineSnapshot[] {
  const items: ExtractedLineSnapshot[] = [];
  for (const raw of textLines) {
    const line = raw.replace(/ /g, ' ').trim();
    if (line.length < 4 || NOT_AN_ITEM.test(line)) continue;
    const { description, tail } = splitColumns(line);
    if (!/[A-Za-z]{2,}/.test(description)) continue;

    const amounts: number[] = [];
    let rate: number | null = null;
    let quantity: string | null = null;
    for (const token of tail) {
      if (RATE_TOKEN.test(token)) { rate = toRate(token); continue; }
      if (AMOUNT_TOKEN.test(token)) {
        const a = toAmount(token, currency);
        if (a !== null) amounts.push(a);
        continue;
      }
      if (quantity === null && amounts.length === 0) quantity = toQuantity(token);
    }
    if (amounts.length === 0) continue;

    const item = interpretAmounts(amounts, quantity, rate);
    items.push({ description, quantity, ...item, evidence: line });
  }
  return items;
}

/**
 * Decide what each trailing amount is, preferring the reading whose arithmetic
 * holds. Confidence is high only when it does.
 */
function interpretAmounts(
  amounts: number[], quantity: string | null, rate: number | null,
): Omit<ExtractedLineSnapshot, 'description' | 'quantity' | 'evidence'> {
  const qty = quantity !== null ? Number(quantity) : null;
  const blank = { unitPriceMinor: null, netMinor: null, vatRateBasisPoints: rate, vatMinor: null, grossMinor: null };
  const qtyTimes = (unit: number, total: number) => qty !== null && Math.abs(Math.round(unit * qty) - total) <= 1;

  if (amounts.length >= 4) {
    const [unit, net, vat, gross] = amounts.slice(-4) as [number, number, number, number];
    const ok = net + vat === gross;
    return { ...blank, unitPriceMinor: unit, netMinor: net, vatMinor: vat, grossMinor: gross,
      vatRateBasisPoints: rate ?? impliedRate(net, vat), confidence: ok ? 70 : 35 };
  }
  if (amounts.length === 3) {
    const [a, b, c] = amounts as [number, number, number];
    if (a + b === c) {
      return { ...blank, netMinor: a, vatMinor: b, grossMinor: c, vatRateBasisPoints: rate ?? impliedRate(a, b), confidence: 70 };
    }
    if (qtyTimes(a, b)) {
      // unit, net, and the third is either VAT or gross.
      if (rate !== null && Math.abs(vatFromNet(b, rate) - c) <= 1) {
        return { ...blank, unitPriceMinor: a, netMinor: b, vatMinor: c, grossMinor: b + c, confidence: 65 };
      }
      if (c > b) return { ...blank, unitPriceMinor: a, netMinor: b, grossMinor: c, vatMinor: c - b,
        vatRateBasisPoints: rate ?? impliedRate(b, c - b), confidence: 60 };
    }
    return { ...blank, unitPriceMinor: a, netMinor: b, grossMinor: c, confidence: 30 };
  }
  if (amounts.length === 2) {
    const [a, b] = amounts as [number, number];
    if (qtyTimes(a, b) || (qty === null && a === b)) {
      return { ...blank, unitPriceMinor: a, netMinor: b, confidence: 60 };
    }
    if (rate !== null && Math.abs(vatFromNet(a, rate) - b) <= 1) {
      return { ...blank, netMinor: a, vatMinor: b, grossMinor: a + b, confidence: 60 };
    }
    return { ...blank, unitPriceMinor: a, netMinor: b, confidence: 35 };
  }
  return { ...blank, netMinor: amounts[0]!, confidence: qty === null ? 45 : 40 };
}

/** The rate a net/VAT pair implies, only when it is a real rate (to within rounding). */
function impliedRate(net: number, vat: number): number | null {
  if (net === 0) return null;
  for (const rate of KNOWN_RATES) {
    if (Math.abs(vatFromNet(net, rate) - vat) <= 1) return rate;
  }
  return null;
}

/**
 * Read the VAT analysis: lines such as "VAT @ 23% on 100.00  23.00",
 * "23% VAT  46.00", "MwSt 19% 19,00".
 */
export function parseVatTotals(textLines: string[], currency: string): ExtractedVatTotalSnapshot[] {
  const totals: ExtractedVatTotalSnapshot[] = [];
  const seen = new Set<string>();
  const TAX = /\b(?:vat|tax|mwst|ust|tva|btw|iva)\b/i;
  for (const raw of textLines) {
    const line = raw.replace(/ /g, ' ').trim();
    if (!TAX.test(line)) continue;
    if (/\b(?:reg(?:istration)?|number|no\.?|id)\b/i.test(line) && /[A-Z]{2}\s?\d/.test(line)) continue;
    const rateMatch = /(\d{1,2}(?:[.,]\d{1,2})?)\s?%/.exec(line);
    if (!rateMatch) continue;
    const rate = Math.round(Number(rateMatch[1]!.replace(',', '.')) * 100);
    const amounts = [...line.slice(rateMatch.index + rateMatch[0].length).matchAll(/[€£$]?\s?-?(?:\d{1,3}(?:[,.\s]\d{3})+|\d+)[.,]\d{2}/g)]
      .map((m) => toAmount(m[0], currency)).filter((v): v is number => v !== null);
    if (amounts.length === 0) continue;
    let netMinor: number | null = null;
    let vatMinor: number | null = null;
    if (amounts.length >= 2) {
      const [a, b] = amounts.slice(-2) as [number, number];
      if (Math.abs(vatFromNet(a, rate) - b) <= 1) { netMinor = a; vatMinor = b; }
      else if (Math.abs(vatFromNet(b, rate) - a) <= 1) { netMinor = b; vatMinor = a; }
      else { vatMinor = amounts[amounts.length - 1]!; }
    } else {
      vatMinor = amounts[0]!;
    }
    const key = `${rate}:${netMinor}:${vatMinor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const consistent = netMinor !== null && vatMinor !== null;
    totals.push({
      rateBasisPoints: rate, label: `${rate / 100}%`, netMinor, vatMinor,
      confidence: consistent ? 75 : 45, evidence: line,
    });
  }
  return totals;
}

/** VAT wording that changes the treatment. Returned verbatim (the line it appears on). */
const LEGEND_PATTERNS: RegExp[] = [
  /reverse[\s-]?charge/i,
  /\bart(?:icle|\.)?\s*(?:44|196)\b/i,
  /\b(?:article|art\.?)\s*138\b/i,
  /steuerschuldnerschaft\s+des\s+leistungsempf/i,
  /autoliquidation/i,
  /\bbtw\s+verlegd\b/i,
  /inversione\s+contabile/i,
  /inversi[oó]n\s+del\s+sujeto\s+pasivo/i,
  /intra[\s-]?community\s+(?:supply|acquisition)/i,
  /zero[\s-]?rated/i,
  /\b(?:vat|tax)[\s-]?exempt\b|\bexempt\s+from\s+(?:vat|tax)\b/i,
  /margin\s+scheme/i,
  /outside\s+the\s+scope\s+of\s+(?:irish\s+)?vat/i,
  /postponed\s+accounting/i,
  /section\s+16\b.*\bvat\b|\bvat\b.*\bsection\s+16\b/i,
];

export function findVatLegends(textLines: string[]): string[] {
  const found: string[] = [];
  for (const raw of textLines) {
    const line = raw.trim();
    if (LEGEND_PATTERNS.some((p) => p.test(line))) {
      const snippet = line.length > 200 ? `${line.slice(0, 197)}…` : line;
      if (!found.includes(snippet)) found.push(snippet);
    }
  }
  return found;
}

const DATE_TEXT = /\b(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})\b/;

export function findSupplyDate(textLines: string[]): ExtractedField<string> | null {
  const LABEL = /\b(?:date\s+of\s+supply|supply\s+date|delivery\s+date|date\s+of\s+delivery|tax\s+point|leistungsdatum|lieferdatum|date\s+de\s+livraison|leverdatum)\b/i;
  for (const [i, line] of textLines.entries()) {
    if (!LABEL.test(line)) continue;
    for (const candidate of [line, textLines[i + 1] ?? '']) {
      const m = DATE_TEXT.exec(candidate.replace(LABEL, ''));
      if (!m) continue;
      try {
        return { value: parseDateFlexible(m[1]!), confidence: candidate === line ? 80 : 70, evidence: line };
      } catch (error) {
        if (!(error instanceof DateError)) throw error;
      }
    }
  }
  return null;
}

export function findPaymentTerms(textLines: string[]): ExtractedField<string> | null {
  for (const line of textLines) {
    const m = /\b(?:payment\s+terms|terms)\s*:?\s*(.{2,80})$/i.exec(line)
      ?? /\b((?:net|due\s+within|payable\s+within)\s+\d{1,3}\s*(?:days)?)\b/i.exec(line);
    if (m) return { value: m[1]!.trim(), confidence: 70, evidence: line };
  }
  return null;
}

/** For a credit note: the invoice it credits, when stated. */
export function findOriginalDocumentNumber(textLines: string[]): ExtractedField<string> | null {
  const PATTERNS = [
    /\b(?:original\s+invoice|against\s+invoice|credit(?:ing)?\s+(?:for|of)\s+invoice|re:?\s*invoice|relates\s+to\s+invoice|invoice\s+ref(?:erence)?)\s*(?:no\.?|number|#)?\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{2,30})/i,
  ];
  for (const line of textLines) {
    for (const p of PATTERNS) {
      const m = p.exec(line);
      if (m) return { value: m[1]!.replace(/[.,;:]$/, ''), confidence: 75, evidence: line };
    }
  }
  return null;
}

/**
 * The block of lines under a "Bill to"-style heading: the customer's name and
 * address. Stops at the next labelled line. Weak, and reported as weak.
 */
export function findCustomerBlock(textLines: string[]): { name: ExtractedField<string>; address: ExtractedField<string> } | null {
  // The word boundary matters: without it "Total" reads as "To" + "tal ...".
  const HEAD = /^(?:bill(?:ed)?\s+to|invoice\s+to|sold\s+to|customer|client|to)\b(?!\s+(?:vat|tax|no\b|number|ref))\s*:?\s*(.*)$/i;
  for (const [i, line] of textLines.entries()) {
    const m = HEAD.exec(line.trim());
    if (!m) continue;
    const block: string[] = [];
    if (m[1]!.trim()) block.push(m[1]!.trim());
    for (const next of textLines.slice(i + 1, i + 7)) {
      const t = next.trim();
      if (!t || /:\s|\b(?:invoice|date|vat|total|qty|description|amount)\b/i.test(t)) break;
      block.push(t);
    }
    if (block.length === 0) continue;
    // "Customer: Name Limited, Galway, Ireland" on one line: the name is the
    // part before the first comma, the rest is address.
    if (block.length === 1 && block[0]!.includes(',')) {
      const [first, ...rest] = block[0]!.split(',').map((p) => p.trim());
      block.splice(0, 1, first!, ...rest.filter(Boolean));
    }
    return {
      name: { value: block[0]!, confidence: 55, evidence: line },
      address: block.length > 1
        ? { value: block.slice(1).join(', '), confidence: 40, evidence: block.slice(1).join(' / ') }
        : { value: null, confidence: 0 },
    };
  }
  return null;
}

/**
 * The supplier's address: the lines directly beneath the supplier's name at the
 * top of the document, up to the first labelled or numeric-only line.
 */
export function findSupplierAddress(textLines: string[], supplierName: string | null): ExtractedField<string> | null {
  if (!supplierName) return null;
  const start = textLines.findIndex((l) => l.toLowerCase().includes(supplierName.toLowerCase()));
  if (start < 0 || start > 12) return null;
  const block: string[] = [];
  for (const next of textLines.slice(start + 1, start + 6)) {
    const t = next.trim();
    if (!t || /:\s|\b(?:invoice|receipt|date|vat|tax|bill|total|tel|phone|email|www)\b/i.test(t)) break;
    block.push(t);
  }
  return block.length > 0 ? { value: block.join(', '), confidence: 35, evidence: block.join(' / ') } : null;
}

/** Country names that commonly end an address, mapped to ISO codes. */
const COUNTRY_NAMES: Array<[RegExp, string]> = [
  [/\b(?:ireland|éire|eire)\b/i, 'IE'], [/\b(?:united\s+kingdom|uk|england|scotland|wales|northern\s+ireland)\b/i, 'GB'],
  [/\b(?:united\s+states|usa|u\.s\.a\.)\b/i, 'US'], [/\b(?:germany|deutschland)\b/i, 'DE'],
  [/\b(?:france)\b/i, 'FR'], [/\b(?:netherlands|nederland)\b/i, 'NL'], [/\b(?:luxembourg)\b/i, 'LU'],
  [/\b(?:italy|italia)\b/i, 'IT'], [/\b(?:spain|españa|espana)\b/i, 'ES'], [/\b(?:belgium|belgique|belgië)\b/i, 'BE'],
  [/\b(?:sweden|sverige)\b/i, 'SE'], [/\b(?:denmark|danmark)\b/i, 'DK'], [/\b(?:poland|polska)\b/i, 'PL'],
  [/\b(?:portugal)\b/i, 'PT'], [/\b(?:austria|österreich)\b/i, 'AT'], [/\b(?:finland|suomi)\b/i, 'FI'],
  [/\b(?:canada)\b/i, 'CA'], [/\b(?:australia)\b/i, 'AU'], [/\b(?:switzerland|schweiz|suisse)\b/i, 'CH'],
];

export function countryFromAddress(address: string | null): string | null {
  if (!address) return null;
  const last = address.split(',').map((s) => s.trim()).filter(Boolean).slice(-2).join(' ');
  for (const [pattern, code] of COUNTRY_NAMES) if (pattern.test(last)) return code;
  return null;
}

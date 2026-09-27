import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { InvoiceDocument } from '@/domain/invoicing/invoiceDocument';
import { money, date } from './format';

/**
 * Render a sales invoice or credit note as a PDF (issue #395), locally, with
 * the standard PDF fonts. It lays out what `salesInvoiceDocument` returns and
 * computes nothing. A document with missing particulars is marked as a draft
 * across the top and lists what is missing, so it cannot pass for a finished
 * VAT invoice.
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const WARN = rgb(0.72, 0.13, 0.1);

/** The standard fonts encode WinAnsi only; anything else would throw, so it is replaced visibly. */
function safe(text: string): string {
  return [...text].map((ch) => {
    const code = ch.codePointAt(0)!;
    if (code === 0x0a || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return ch;
    return '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch) ? ch : '?';
  }).join('');
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of safe(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

export async function renderInvoicePdf(doc: InvoiceDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const title = doc.kind === 'credit_note' ? 'Credit note' : doc.kind === 'debit_note' ? 'Debit note' : 'Invoice';
  pdf.setTitle(`${title} ${doc.number ?? ''}`.trim());
  pdf.setProducer('Leabhar');
  pdf.setCreator('Leabhar');

  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - MARGIN;
  const width = A4[0] - MARGIN * 2;

  const text = (s: string, x: number, size = 9, font = regular, color = INK) => {
    page.drawText(safe(s), { x, y, size, font, color });
  };
  const right = (s: string, xRight: number, size = 9, font = regular, color = INK) => {
    const t = safe(s);
    page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 30) {
      page = pdf.addPage(A4);
      y = A4[1] - MARGIN;
    }
  };

  if (doc.missing.length > 0) {
    text('DRAFT — MISSING PARTICULARS: NOT A VALID VAT INVOICE', MARGIN, 11, bold, WARN);
    y -= 20;
  }

  // Header: who is supplying, and what this is.
  text(doc.supplier.tradingName ?? doc.supplier.name, MARGIN, 16, bold);
  right(title.toUpperCase(), A4[0] - MARGIN, 16, bold);
  y -= 18;
  const supplierLines = [
    ...(doc.supplier.tradingName ? [doc.supplier.name] : []),
    ...(doc.supplier.address ? wrap(doc.supplier.address, regular, 9, 250) : []),
    ...(doc.supplier.vatNumber ? [`VAT no. ${doc.supplier.vatNumber}`] : []),
  ];
  const meta: Array<[string, string]> = [
    [`${title} no.`, doc.number ?? '—'],
    ['Date of issue', date(doc.issueDate)],
    ...(doc.supplyDate ? [['Date of supply', date(doc.supplyDate)] as [string, string]] : []),
    ...(doc.dueDate && doc.kind !== 'credit_note' ? [['Due', date(doc.dueDate)] as [string, string]] : []),
    ...(doc.creditsInvoiceNumber ? [['Credits invoice', doc.creditsInvoiceNumber] as [string, string]] : []),
    ...(doc.adjustsInvoiceNumber ? [['Adds to invoice', doc.adjustsInvoiceNumber] as [string, string]] : []),
  ];
  const headerRows = Math.max(supplierLines.length, meta.length);
  for (let i = 0; i < headerRows; i++) {
    if (supplierLines[i]) text(supplierLines[i]!, MARGIN, 9, regular, MUTED);
    if (meta[i]) {
      right(meta[i]![1], A4[0] - MARGIN, 9, bold);
      right(meta[i]![0], A4[0] - MARGIN - 110, 9, regular, MUTED);
    }
    y -= 12;
  }

  // Bill to.
  y -= 12;
  text('Bill to', MARGIN, 8, bold, MUTED);
  y -= 12;
  for (const line of [
    doc.customer.name,
    ...(doc.customer.attention ? [`Attn: ${doc.customer.attention}`] : []),
    ...(doc.customer.address ? wrap(doc.customer.address, regular, 9, 260) : []),
    ...(doc.customer.vatNumber ? [`VAT no. ${doc.customer.vatNumber}`] : []),
  ]) {
    text(line, MARGIN, 9);
    y -= 12;
  }

  // Lines.
  y -= 14;
  const col = { qty: MARGIN + 250, unit: MARGIN + 315, disc: MARGIN + 370, net: MARGIN + 430, rate: MARGIN + 462, vat: A4[0] - MARGIN };
  const head = () => {
    text('Description', MARGIN, 8, bold, MUTED);
    right('Qty', col.qty, 8, bold, MUTED);
    right('Unit price', col.unit, 8, bold, MUTED);
    right('Discount', col.disc, 8, bold, MUTED);
    right('Net', col.net, 8, bold, MUTED);
    right('Rate', col.rate + 18, 8, bold, MUTED);
    right('VAT', col.vat, 8, bold, MUTED);
    y -= 5;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.5, color: MUTED });
    y -= 12;
  };
  head();
  for (const line of doc.lines) {
    const desc = wrap(line.description, regular, 9, 200);
    ensure(desc.length * 11 + 6);
    if (y > A4[1] - MARGIN - 1) head();
    const qty = line.quantityMilli % 1000 === 0 ? String(line.quantityMilli / 1000) : (line.quantityMilli / 1000).toFixed(3);
    right(qty, col.qty);
    if (line.unitPriceMinor !== 0) right(money(line.unitPriceMinor, doc.currency), col.unit);
    if (line.discountMinor !== 0) {
      right(line.discountBasisPoints !== null ? `${(line.discountBasisPoints / 100).toFixed(2)}%` : money(line.discountMinor, doc.currency), col.disc);
    }
    right(money(line.netMinor, doc.currency), col.net);
    right(`${(line.rateBasisPoints / 100).toFixed(line.rateBasisPoints % 100 === 0 ? 0 : 1)}%`, col.rate + 18);
    right(money(line.vatMinor, doc.currency), col.vat);
    for (const d of desc) { text(d, MARGIN); y -= 11; }
    y -= 3;
  }

  // Per-rate summary and totals.
  ensure(40 + doc.rates.length * 12);
  page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: A4[0] - MARGIN, y: y + 4 }, thickness: 0.5, color: MUTED });
  y -= 10;
  for (const r of doc.rates) {
    right(`Net at ${(r.rateBasisPoints / 100).toFixed(r.rateBasisPoints % 100 === 0 ? 0 : 1)}%`, col.net - 70, 9, regular, MUTED);
    right(money(r.netMinor, doc.currency), col.net);
    right(`VAT ${money(r.vatMinor, doc.currency)}`, col.vat);
    y -= 12;
  }
  y -= 4;
  for (const [label, amount, strong] of [
    ['Total excluding VAT', doc.netMinor, false], ['VAT', doc.vatMinor, false],
    [doc.kind === 'credit_note' ? 'Total credited' : 'Total due', doc.grossMinor, true],
  ] as Array<[string, number, boolean]>) {
    right(label, col.net + 10, strong ? 10 : 9, strong ? bold : regular, strong ? INK : MUTED);
    right(money(amount, doc.currency), col.vat, strong ? 10 : 9, strong ? bold : regular);
    y -= strong ? 16 : 12;
  }

  // Legends the supply requires.
  if (doc.legends.length > 0) {
    y -= 6;
    for (const legend of doc.legends) {
      const lines = wrap(legend, bold, 9, width);
      ensure(lines.length * 11);
      for (const l of lines) { text(l, MARGIN, 9, bold); y -= 11; }
    }
  }

  if (doc.missing.length > 0) {
    y -= 10;
    ensure(14 + doc.missing.length * 11);
    text('Missing before this can be issued as a VAT invoice (S.I. 639/2010 reg.20):', MARGIN, 9, bold, WARN);
    y -= 12;
    for (const m of doc.missing) {
      for (const l of wrap(`• ${m.what} (${m.paragraph})`, regular, 9, width)) { text(l, MARGIN + 8, 9, regular, WARN); y -= 11; }
    }
  }

  // Footer on every page.
  const footer = [doc.supplier.name, doc.supplier.croNumber ? `CRO ${doc.supplier.croNumber}` : null,
    doc.supplier.vatNumber ? `VAT ${doc.supplier.vatNumber}` : null].filter(Boolean).join(' · ');
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(safe(footer), { x: MARGIN, y: MARGIN - 20, size: 7.5, font: regular, color: MUTED });
    const n = `Page ${i + 1} of ${pages.length}`;
    p.drawText(n, { x: A4[0] - MARGIN - regular.widthOfTextAtSize(n, 7.5), y: MARGIN - 20, size: 7.5, font: regular, color: MUTED });
  });

  return pdf.save();
}

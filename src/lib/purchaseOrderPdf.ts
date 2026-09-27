import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import type { PurchaseOrderDocument } from '@/domain/invoicing/purchaseOrders';
import { money, date } from './format';

/**
 * A purchase order PDF (issue #411), laid out from what the domain returns.
 * An order is a request to a supplier, not a tax document: it carries no VAT.
 */

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);

const safe = (text: string) => [...text].map((ch) => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch) ? ch : '?';
}).join('');

function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of safe(s).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next; else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

const quantity = (milli: number) => (milli % 1000 === 0 ? String(milli / 1000) : (milli / 1000).toFixed(3).replace(/0+$/, ''));

export async function renderPurchaseOrderPdf(docu: PurchaseOrderDocument): Promise<Uint8Array> {
  const { order, buyer, supplier } = docu;
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Purchase order ${order.number}`);
  pdf.setProducer('Leabhar');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage(A4);
  let y = A4[1] - M;
  const text = (s: string, x: number, size = 9, font = regular, color = INK) =>
    page.drawText(safe(s), { x, y, size, font, color });
  const right = (s: string, xRight: number, size = 9, font = regular, color = INK) => {
    const t = safe(s);
    page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
  };
  const ensure = (needed: number) => { if (y - needed < M + 20) { page = pdf.addPage(A4); y = A4[1] - M; } };

  text(buyer.name, M, 15, bold);
  right('PURCHASE ORDER', A4[0] - M, 14, bold);
  y -= 16;
  const left = [...(buyer.address ? wrap(buyer.address, regular, 9, 250) : []), ...(buyer.vatNumber ? [`VAT ${buyer.vatNumber}`] : [])];
  const meta: Array<[string, string]> = [
    ['Order', order.number], ['Date', date(order.orderDate)],
    ...(order.expectedDate ? [['Wanted by', date(order.expectedDate)] as [string, string]] : []),
    ['Currency', order.currency],
  ];
  for (let i = 0; i < Math.max(left.length, meta.length); i++) {
    if (left[i]) text(left[i]!, M, 9, regular, MUTED);
    if (meta[i]) { right(meta[i]![1], A4[0] - M, 9, bold); right(meta[i]![0], A4[0] - M - 110, 9, regular, MUTED); }
    y -= 12;
  }
  y -= 10;
  text('Supplier', M, 8, bold, MUTED);
  y -= 12;
  for (const l of [supplier.name, ...(supplier.address ? wrap(supplier.address, regular, 9, 260) : [])]) { text(l, M); y -= 12; }
  y -= 12;

  const col = { qty: M + 330, amount: A4[0] - M };
  text('Description', M, 8, bold, MUTED); right('Quantity', col.qty, 8, bold, MUTED); right('Net', col.amount, 8, bold, MUTED);
  y -= 5;
  page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.5, color: MUTED });
  y -= 12;
  for (const l of order.lines) {
    const lines = wrap(l.description, regular, 9, 260);
    ensure(13 * lines.length);
    right(quantity(l.quantityMilli), col.qty); right(money(l.netMinor, order.currency), col.amount);
    for (const d of lines) { text(d, M); y -= 13; }
  }
  y -= 4;
  right('Total, excluding VAT', col.qty, 10, bold);
  right(money(order.orderedMinor, order.currency), col.amount, 10, bold);
  y -= 24;
  if (order.notes) {
    ensure(40);
    for (const l of wrap(order.notes, regular, 9, A4[0] - 2 * M)) { text(l, M); y -= 12; }
    y -= 8;
  }
  ensure(20);
  text(`Please quote ${order.number} on your invoice.`, M, 9, regular, MUTED);
  return pdf.save();
}

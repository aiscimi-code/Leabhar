import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { CustomerStatement, ReminderLetter } from '@/domain/invoicing/receivables';
import { money, date } from './format';

/**
 * Customer statement and reminder letter PDFs (issue #405), laid out from what
 * the domain returns; nothing is computed here. Standard fonts, generated
 * locally.
 */

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);

const safe = (text: string) => [...text].map((ch) => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch) ? ch : '?';
}).join('');

interface Writer {
  pdf: PDFDocument; page: PDFPage; y: number; regular: PDFFont; bold: PDFFont;
}

async function start(title: string): Promise<Writer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('Leabhar');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  return { pdf, page: pdf.addPage(A4), y: A4[1] - M, regular, bold };
}

function text(w: Writer, s: string, x: number, size = 9, font?: PDFFont, color = INK) {
  w.page.drawText(safe(s), { x, y: w.y, size, font: font ?? w.regular, color });
}
function right(w: Writer, s: string, xRight: number, size = 9, font?: PDFFont, color = INK) {
  const f = font ?? w.regular;
  const t = safe(s);
  w.page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y: w.y, size, font: f, color });
}
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
function ensure(w: Writer, needed: number) {
  if (w.y - needed < M + 20) { w.page = w.pdf.addPage(A4); w.y = A4[1] - M; }
}
function header(w: Writer, supplierName: string, supplierAddress: string | null, title: string, to: { name: string; address: string | null }, meta: Array<[string, string]>) {
  text(w, supplierName, M, 15, w.bold);
  right(w, title.toUpperCase(), A4[0] - M, 14, w.bold);
  w.y -= 16;
  const left = supplierAddress ? wrap(supplierAddress, w.regular, 9, 250) : [];
  for (let i = 0; i < Math.max(left.length, meta.length); i++) {
    if (left[i]) text(w, left[i]!, M, 9, undefined, MUTED);
    if (meta[i]) { right(w, meta[i]![1], A4[0] - M, 9, w.bold); right(w, meta[i]![0], A4[0] - M - 110, 9, undefined, MUTED); }
    w.y -= 12;
  }
  w.y -= 10;
  text(w, 'To', M, 8, w.bold, MUTED);
  w.y -= 12;
  for (const l of [to.name, ...(to.address ? wrap(to.address, w.regular, 9, 260) : [])]) { text(w, l, M); w.y -= 12; }
  w.y -= 12;
}

export async function renderStatementPdf(
  st: CustomerStatement, supplier: { name: string; address: string | null },
): Promise<Uint8Array> {
  const w = await start(`Statement ${st.customerName} ${st.to}`);
  header(w, supplier.name, supplier.address, 'Statement of account', { name: st.customerName, address: st.address },
    [['Period', `${date(st.from)} – ${date(st.to)}`], ['Currency', st.currency]]);
  const col = { ref: M + 70, kind: M + 260, amount: M + 400, balance: A4[0] - M };
  const head = () => {
    text(w, 'Date', M, 8, w.bold, MUTED); text(w, 'Reference', col.ref, 8, w.bold, MUTED);
    text(w, 'Type', col.kind, 8, w.bold, MUTED); right(w, 'Amount', col.amount, 8, w.bold, MUTED);
    right(w, 'Balance', col.balance, 8, w.bold, MUTED);
    w.y -= 5;
    w.page.drawLine({ start: { x: M, y: w.y }, end: { x: A4[0] - M, y: w.y }, thickness: 0.5, color: MUTED });
    w.y -= 12;
  };
  head();
  text(w, date(st.from), M); text(w, 'Balance brought forward', col.ref);
  right(w, money(st.openingBalanceMinor, st.currency), col.balance);
  w.y -= 13;
  const kinds: Record<string, string> = {
    invoice: 'Invoice', debit_note: 'Debit note', credit_note: 'Credit note', payment: 'Payment',
    refund: 'Refund', payment_reversed: 'Reversal', write_off: 'Written off',
  };
  for (const e of st.entries) {
    ensure(w, 14);
    if (w.y > A4[1] - M - 1) head();
    text(w, date(e.date), M);
    text(w, wrap(e.reference, w.regular, 9, 180)[0] ?? '', col.ref);
    text(w, kinds[e.kind] ?? e.kind, col.kind);
    right(w, money(e.amountMinor, st.currency), col.amount);
    right(w, money(e.balanceMinor, st.currency), col.balance);
    w.y -= 13;
  }
  w.y -= 4;
  right(w, 'Balance due', col.amount, 10, w.bold);
  right(w, money(st.closingBalanceMinor, st.currency), col.balance, 10, w.bold);
  w.y -= 24;
  ensure(w, 40);
  text(w, `Ageing at ${date(st.to)}`, M, 8, w.bold, MUTED);
  w.y -= 12;
  const step = (A4[0] - 2 * M) / st.ageing.length;
  st.ageing.forEach((a, i) => text(w, a.label, M + i * step, 8, undefined, MUTED));
  w.y -= 12;
  st.ageing.forEach((a, i) => text(w, money(a.amountMinor, st.currency), M + i * step, 9, w.bold));
  return w.pdf.save();
}

export async function renderReminderPdf(letter: ReminderLetter): Promise<Uint8Array> {
  const w = await start(`${letter.title} ${letter.customer.name}`);
  header(w, letter.supplier.name, letter.supplier.address, letter.title, letter.customer, [['Date', date(letter.asOf)]]);
  for (const l of wrap(letter.body, w.regular, 10, A4[0] - 2 * M)) { text(w, l, M, 10); w.y -= 14; }
  w.y -= 10;
  const col = { date: M + 110, due: M + 200, days: M + 330, amount: A4[0] - M };
  text(w, 'Invoice', M, 8, w.bold, MUTED); text(w, 'Dated', col.date, 8, w.bold, MUTED);
  text(w, 'Due', col.due, 8, w.bold, MUTED); right(w, 'Days overdue', col.days + 40, 8, w.bold, MUTED);
  right(w, 'Outstanding', col.amount, 8, w.bold, MUTED);
  w.y -= 5;
  w.page.drawLine({ start: { x: M, y: w.y }, end: { x: A4[0] - M, y: w.y }, thickness: 0.5, color: MUTED });
  w.y -= 12;
  const totals = new Map<string, number>();
  for (const l of letter.lines) {
    ensure(w, 14);
    text(w, l.number ?? '—', M); text(w, date(l.invoiceDate), col.date); text(w, date(l.dueDate), col.due);
    right(w, String(l.daysOverdue), col.days + 40); right(w, money(l.outstandingMinor, l.currency), col.amount);
    totals.set(l.currency, (totals.get(l.currency) ?? 0) + l.outstandingMinor);
    w.y -= 13;
  }
  w.y -= 4;
  for (const [currency, total] of totals) {
    right(w, 'Total overdue', col.days + 40, 10, w.bold);
    right(w, money(total, currency), col.amount, 10, w.bold);
    w.y -= 14;
  }
  w.y -= 16;
  text(w, `${letter.supplier.name}${letter.supplier.vatNumber ? ` · VAT ${letter.supplier.vatNumber}` : ''}`, M, 8, undefined, MUTED);
  return w.pdf.save();
}

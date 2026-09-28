import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatAmountGrouped } from '@/domain/money';
import type { StatementBlock } from './statementLines';

/**
 * Financial statements and trial balance as a PDF (issue #553), laid out from
 * the same `StatementBlock`s the spreadsheet export writes, so a figure is the
 * same in either. Nothing is computed here. Standard fonts, generated locally.
 */

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.75, 0.75, 0.78);
const COL = 88;

const safe = (text: string) => [...text].map((ch) => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch) ? ch : '?';
}).join('');

interface Writer { pdf: PDFDocument; page: PDFPage; y: number; regular: PDFFont; bold: PDFFont; footer: string }

function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of safe(s).split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !current) current = next; else { out.push(current); current = word; }
  }
  if (current) out.push(current);
  return out;
}

function newPage(w: Writer) {
  w.page = w.pdf.addPage(A4);
  w.y = A4[1] - M;
  w.page.drawText(safe(w.footer), { x: M, y: M - 20, size: 7, font: w.regular, color: MUTED });
}

function ensure(w: Writer, needed: number, block?: StatementBlock) {
  if (w.y - needed >= M) return;
  newPage(w);
  if (block) columnHeads(w, block, true);
}

function columnHeads(w: Writer, block: StatementBlock, continued = false) {
  if (continued) { w.page.drawText(safe(`${block.title} (continued)`), { x: M, y: w.y, size: 9, font: w.bold, color: MUTED }); }
  block.columns.forEach((c, i) => {
    const xRight = A4[0] - M - (block.columns.length - 1 - i) * COL;
    const t = safe(c);
    w.page.drawText(t, { x: xRight - w.bold.widthOfTextAtSize(t, 8), y: w.y, size: 8, font: w.bold, color: MUTED });
  });
  w.y -= 6;
  w.page.drawLine({ start: { x: M, y: w.y }, end: { x: A4[0] - M, y: w.y }, thickness: 0.5, color: RULE });
  w.y -= 12;
}

function drawBlock(w: Writer, block: StatementBlock, currency: string) {
  ensure(w, 80);
  w.page.drawText(safe(block.title), { x: M, y: w.y, size: 13, font: w.bold, color: INK });
  w.y -= 15;
  w.page.drawText(safe(block.subtitle), { x: M, y: w.y, size: 9, font: w.regular, color: MUTED });
  w.y -= 18;
  columnHeads(w, block);
  const labelWidth = A4[0] - 2 * M - block.columns.length * COL - 8;
  for (const l of block.lines) {
    const font = l.isTotal || l.depth === 0 ? w.bold : w.regular;
    const lines = wrap(l.label, font, 9, labelWidth - l.depth * 14);
    ensure(w, 14 * lines.length + (l.isTotal ? 4 : 0), block);
    if (l.isTotal) {
      w.page.drawLine({ start: { x: A4[0] - M - block.columns.length * COL + 8, y: w.y + 10 }, end: { x: A4[0] - M, y: w.y + 10 }, thickness: 0.5, color: INK });
    }
    lines.forEach((text, i) => {
      w.page.drawText(text, { x: M + l.depth * 14, y: w.y - i * 11, size: 9, font, color: l.depth > 0 ? MUTED : INK });
    });
    l.values.forEach((v, i) => {
      if (v === null) return;
      const t = safe(v < 0 ? `(${formatAmountGrouped(-v, currency)})` : formatAmountGrouped(v, currency));
      const xRight = A4[0] - M - (l.values.length - 1 - i) * COL;
      w.page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, 9), y: w.y, size: 9, font, color: INK });
    });
    w.y -= 11 * lines.length + (l.isTotal ? 5 : 2);
  }
  w.y -= 8;
  for (const note of block.notes) {
    const lines = wrap(note, w.regular, 8, A4[0] - 2 * M);
    ensure(w, 10 * lines.length + 4);
    for (const text of lines) { w.page.drawText(text, { x: M, y: w.y, size: 8, font: w.regular, color: MUTED }); w.y -= 10; }
    w.y -= 4;
  }
}

export async function renderStatementsPdf(params: {
  companyName: string; period: string; currency: string; blocks: StatementBlock[]; generatedOn: string;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${params.companyName} financial statements ${params.period}`);
  pdf.setProducer('Leabhar');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const footer = `${params.companyName} · ${params.period} · generated ${params.generatedOn} from the posted ledger. Negative figures in brackets. `
    + 'A bookkeeping report, not statutory financial statements.';
  const w: Writer = { pdf, page: undefined as unknown as PDFPage, y: 0, regular, bold, footer };
  newPage(w);
  w.page.drawText(safe(params.companyName), { x: M, y: w.y, size: 16, font: bold, color: INK });
  w.y -= 26;
  params.blocks.forEach((block, i) => {
    if (i > 0) newPage(w);
    drawBlock(w, block, params.currency);
  });
  return pdf.save();
}

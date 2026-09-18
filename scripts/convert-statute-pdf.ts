/**
 * One-time conversion of an Irish Statute Book PDF into a parseable Markdown
 * extract, for Acts printed in the "marginal note" layout (a principal/
 * consolidated Act: each section's short heading and predecessor-provision
 * citation are printed in a narrow right-hand column beside the section,
 * rather than above it the way an amending Act like the Finance Acts are).
 *
 * This is NOT part of the application's runtime ingestion pipeline — it is
 * the same one-off step that produced docs/statutes/2024-act-43/
 * 2024-act-43-enacted.md (see that file's own header). Run it once per
 * source document, review the output, and commit the result alongside the
 * PDF; `src/domain/rules/*Parser.ts` then parses the committed Markdown
 * deterministically at ingest time.
 *
 * Why a custom converter instead of `pdftotext -layout`: pdftotext's layout
 * mode reconstructs each output line independently by column position, so a
 * marginal note only becomes visually separated from the main text when the
 * main text on that exact line happens to be short — a long main-text line
 * runs straight into the margin note with a single space, indistinguishable
 * from an ordinary word gap. This converter instead partitions pdfjs's raw
 * text items into a main column and a margin column per page (by finding the
 * widest x-gap in the right half of the page), reconstructs each column's
 * reading order independently, and re-attaches each section's margin heading
 * to the line directly above its section number — the same convention
 * `extractHeadingAbove` in statuteParser.ts already expects, so a section
 * parser for this layout can reuse most of that logic.
 *
 * Usage:
 *   npx tsx scripts/convert-statute-pdf.ts <input.pdf> <output.md> \
 *     --section-re '^(\d+[A-Z]?)\s*\.—' \
 *     [--start-after 'BE IT ENACTED'] [--stop-at 'SCHEDULE']
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Item {
  x: number;
  /** Right edge (x + rendered width), so a gap can be measured from where this item actually ends. */
  end: number;
  y: number;
  text: string;
}

interface Line {
  y: number;
  items: Item[];
}

async function extractPages(pdfPath: string): Promise<Array<{ width: number; items: Item[] }>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = readFileSync(pdfPath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const pages: Array<{ width: number; items: Item[] }> = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const raw of content.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
      if (!raw.str || raw.str.trim() === '' || !raw.transform) continue;
      const x = raw.transform[4] ?? 0;
      items.push({
        x, end: x + (raw.width ?? raw.str.length * 4),
        y: Math.round((raw.transform[5] ?? 0) * 2) / 2, text: raw.str,
      });
    }
    pages.push({ width: viewport.width, items });
  }
  await loadingTask.destroy();
  return pages;
}

/** Group items into visual lines by y (items sharing a y form one line), reading order top-to-bottom, left-to-right. */
function toLines(items: Item[]): Line[] {
  const byY = new Map<number, Item[]>();
  for (const item of items) {
    const line = byY.get(item.y) ?? [];
    line.push(item);
    byY.set(item.y, line);
  }
  return [...byY.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF y increases upward
    .map(([y, lineItems]) => ({ y, items: lineItems.sort((a, b) => a.x - b.x) }));
}

function lineText(line: Line): string {
  return line.items.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Split a page's items into (main, margin) columns.
 *
 * The Irish Statute Book's marginal-note layout mirrors its margins on
 * facing pages, the way a printed book's inner/outer margins do: the note
 * column sits on the right on some pages and on the left on others —
 * verified against docs/statutes/vatca-2010/pdf.pdf (section 1's heading is
 * at x≈542 on a page whose body starts at x≈238 — margin on the right; a few
 * pages later section 3's heading is at x≈226 on a page whose body starts at
 * x≈318 — margin on the LEFT). A fixed threshold, or any rule assuming the
 * margin is always on one side, misclassifies whichever pages don't match it.
 *
 * This works per line: for each visual row, find the widest gap between the
 * END of one item and the START of the next (not start-to-start, which
 * overstates the gap after a long item and understates it after a short
 * one). If the widest gap is far wider than normal word spacing, split the
 * line there into two groups and decide which is margin:
 *
 *  1. If either group's own joined text matches `sectionRe` (a section
 *     number followed by its opening punctuation, e.g. "12 .—(1) Where—"),
 *     THAT group is main and the other is margin — this is the case that
 *     matters most, because it is where a wrong guess would corrupt a
 *     section's own opening words rather than just a citation. A short
 *     section-start fragment ("12 .—(1) Where—", 13 chars) can otherwise be
 *     shorter than a long heading's first line ("Services received from
 *     abroad and", 27 chars) and be misclassified as the margin by length
 *     alone — verified against VATCA 2010 s.12, which this rule fixes.
 *  2. Otherwise, the smaller group (by total text length) is margin — a
 *     margin note or citation is a handful of words; ordinary body text
 *     fills the rest of the row. This handles both page layouts, since the
 *     margin column sits on the right on some pages and the left on others
 *     (verified: section 1's heading is at x≈542 on a page whose body starts
 *     at x≈238 — margin on the right; section 3's heading is at x≈226 on a
 *     page whose body starts at x≈318 — margin on the left).
 *
 * This deliberately does NOT try to also catch a margin heading's wrapped
 * continuation line with no main-column content on that row (e.g. "general."
 * alone, below "Interpretation —"): classifying a lone short line by
 * proximity to a page-wide "margin x" estimate was tried and is not safe — a
 * page's main body text can legitimately start at an x close to that
 * estimate, corrupting long unrelated runs of real body text into what looks
 * like one giant "heading". A heading occasionally missing its wrapped
 * second line is a cosmetic gap, documented as a limitation; silently
 * merging unrelated provisions is a correctness bug. See docs/RULES_KB.md.
 */
function splitColumns(
  page: { width: number; items: Item[] }, sectionRe: RegExp,
): { mainLines: Line[]; marginLines: Line[] } {
  const allLines = toLines(page.items);
  const mainLines: Line[] = [];
  const marginLines: Line[] = [];
  const wideGapMinPt = 15;

  for (const line of allLines) {
    let splitIdx = -1;
    let widestGap = wideGapMinPt;
    for (let i = 1; i < line.items.length; i++) {
      const gap = line.items[i]!.x - line.items[i - 1]!.end;
      if (gap >= widestGap) { widestGap = gap; splitIdx = i; }
    }
    if (splitIdx === -1) {
      mainLines.push(line);
      continue;
    }
    const left = line.items.slice(0, splitIdx);
    const right = line.items.slice(splitIdx);
    const joined = (items: Item[]) => items.map((i) => i.text).join(' ').replace(/\s+/g, ' ').trim();

    let mainGroup: Item[];
    let marginGroup: Item[];
    if (sectionRe.test(joined(left))) {
      [mainGroup, marginGroup] = [left, right];
    } else if (sectionRe.test(joined(right))) {
      [mainGroup, marginGroup] = [right, left];
    } else {
      const textLen = (items: Item[]) => items.reduce((n, i) => n + i.text.length, 0);
      [marginGroup, mainGroup] = textLen(left) <= textLen(right) ? [left, right] : [right, left];
    }
    mainLines.push({ y: line.y, items: mainGroup });
    marginLines.push({ y: line.y, items: marginGroup });
  }

  return { mainLines, marginLines };
}

interface ConvertOptions {
  sectionRe: RegExp;
  /** Discard everything up to and including the first line starting with this
   *  (e.g. the enacting formula) — skips the ARRANGEMENT OF SECTIONS table of
   *  contents, which repeats section numbers/headings/"SCHEDULE" in a form
   *  that would otherwise be mistaken for the body. */
  startAfter?: string;
  /** Stop converting at the first line starting with this, once in the body
   *  (e.g. "SCHEDULE" to end at the last numbered section). */
  stopAt?: string;
}

function convert(pages: Array<{ width: number; items: Item[] }>, opts: ConvertOptions): string {
  const out: string[] = [];
  let inBody = !opts.startAfter;

  for (const page of pages) {
    const { mainLines, marginLines: marginLinesUnsorted } = splitColumns(page, opts.sectionRe);
    const marginLines = [...marginLinesUnsorted].sort((a, b) => b.y - a.y); // top-to-bottom

    let stopped = false;
    for (const line of mainLines) {
      const text = lineText(line);
      if (!text) continue;
      // A row with zero main-column content (only a predecessor-provision
      // citation like "[VATA s. 44]", sometimes wrapped as "[VATA s. 8(2B)"
      // / "and (3D)( b )]") has no internal gap to split on and stays in
      // `mainLines` by default — filtered here instead. Never true of the
      // main text, which does not open a line with "[" or close a short
      // line with "]" anywhere in this Act's prose style.
      if (/^\[/.test(text) || /^[A-Za-z0-9().\s]{1,40}\]$/.test(text)) continue;

      if (!inBody) {
        if (opts.startAfter && text.startsWith(opts.startAfter)) inBody = true;
        continue;
      }
      if (opts.stopAt && text.startsWith(opts.stopAt)) { stopped = true; break; }

      // A section-start line gets its margin heading inserted as its own
      // line directly above — the layout convention statuteParser.ts's
      // extractHeadingAbove already parses. The heading is the contiguous
      // run of margin lines starting at this exact y and continuing while a
      // line does not look like the bracketed predecessor-provision
      // citation ("[VATA s. 44]") that follows every heading; a heading
      // occasionally wraps onto a second line ("Interpretation —" / "general.").
      if (opts.sectionRe.test(text)) {
        const startIdx = marginLines.findIndex((m) => m.y === line.y);
        if (startIdx >= 0) {
          const headingParts: string[] = [];
          for (let i = startIdx; i < marginLines.length; i++) {
            const t = lineText(marginLines[i]!);
            if (!t || t.startsWith('[')) break;
            headingParts.push(t);
          }
          if (headingParts.length) out.push('', headingParts.join(' '));
        }
      }
      out.push(text);
    }
    if (stopped) break;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

async function main() {
  const [inputPath, outputPath, ...rest] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    console.error('Usage: convert-statute-pdf.ts <input.pdf> <output.md> --section-re <regex> [--stop-at <text>]');
    process.exit(2);
  }

  const sectionReFlag = rest.indexOf('--section-re');
  const sectionRePattern = sectionReFlag >= 0 ? rest[sectionReFlag + 1] : String.raw`^(\d+[A-Z]?)\s*\.—`;
  const stopAtFlag = rest.indexOf('--stop-at');
  const stopAt = stopAtFlag >= 0 ? rest[stopAtFlag + 1] : undefined;
  const startAfterFlag = rest.indexOf('--start-after');
  const startAfter = startAfterFlag >= 0 ? rest[startAfterFlag + 1] : undefined;

  const pages = await extractPages(inputPath);
  const md = convert(pages, { sectionRe: new RegExp(sectionRePattern!), stopAt, startAfter });
  writeFileSync(outputPath, md, 'utf8');
  console.error(`Converted ${pages.length} pages -> ${outputPath} (${md.length} chars).`);
}

main();

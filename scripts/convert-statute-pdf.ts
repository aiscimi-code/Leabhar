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

interface Page {
  pageNumber: number;
  width: number;
  items: Item[];
}

async function extractPages(pdfPath: string): Promise<Page[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const buf = readFileSync(pdfPath);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const pages: Page[] = [];

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
    pages.push({ pageNumber, width: viewport.width, items });
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

interface ColumnBoundary {
  /** x below which an item belongs to the low-x column, and at/above which it belongs to the high-x column. */
  threshold: number;
  /** Which side of the threshold is the margin column. */
  marginSide: 'low' | 'high';
}

/**
 * Determine the main/margin column boundary for even and odd pages, once,
 * from the whole document.
 *
 * Earlier versions of this tried to detect the column boundary *relatively*,
 * per visual row (the widest gap between two items on that row), bootstrapped
 * per page from that page's own citations, or classified each item by a
 * small symmetric tolerance around the margin column's anchor x. All three
 * fail in ways cross-checking every extracted heading against the Act's own
 * "ARRANGEMENT OF SECTIONS" table of contents exposed:
 *
 *  - Per-row gaps collapse to normal word-spacing whenever the main text
 *    runs close to the margin (VATCA s.1: "...Value-Added Tax Consolidation"
 *    is followed by "Short title." with only a ~6pt gap) — no threshold
 *    distinguishes that from an ordinary space without also mis-splitting
 *    real prose elsewhere. Most headings longer than a couple of words were
 *    silently truncated or dropped this way.
 *  - Per-page bootstrapping from that page's own citations fails outright on
 *    a page with none (VATCA ss.121–123, a repeal/transitional chapter that
 *    happens to cite nothing) — the whole page falls back to "no split",
 *    corrupting nearby section-start lines.
 *  - A symmetric ±4pt tolerance around the margin anchor x correctly
 *    classifies a section-start row (main and margin content sharing one y,
 *    e.g. "12 .—(1) Where—" beside "Services received") but misses a
 *    multi-word citation's own sub-glyphs, which render up to ~65pt further
 *    from the anchor than an ordinary word gap (verified: VATCA s.12's
 *    "[VATA s. 8(1A)( aa ) and ( ab )..." has "8(1A)(" exactly at the anchor
 *    but "aa"/"ab" render 24-65pt further out). Widening the tolerance to
 *    catch that drift instead risks swallowing real main text on the other
 *    side. Classifying a whole row by its leftmost item (to catch the drift
 *    via row-consistency instead) breaks the section-start row itself: its
 *    leftmost item is the main-column section number, so the margin heading
 *    sharing that row gets pulled into the main column wholesale.
 *
 * What actually resolves this: plotting every item's x for a parity across
 * the whole document shows two dense, well-separated clusters with a
 * completely empty band between them (verified for this document: even
 * pages have zero items with 292 <= x <= 302; odd pages have zero items
 * with 536 <= x <= 540) — the main column's rightmost/leftmost reach and the
 * margin column's own reach (drift included) never overlap once aggregated
 * over the whole book, even though a single line or page sometimes suggests
 * otherwise. So the boundary is the midpoint of the single widest gap in
 * that global x distribution, computed once for the whole document and
 * keyed by `pageNumber % 2` — never per page or per row — and then applied
 * to every item directly (no row-consistency pass needed, since a single
 * global threshold already handles a section-start row's mixed content
 * correctly: whichever side of the threshold each item's own x falls on).
 */
function findColumnBoundaryByParity(pages: Page[]): Map<number, ColumnBoundary> {
  const citationXByParity = new Map<number, number[]>();
  const allXByParity = new Map<number, number[]>();
  for (const page of pages) {
    const parity = page.pageNumber % 2;
    const allXs = allXByParity.get(parity) ?? [];
    allXByParity.set(parity, allXs);
    for (const item of page.items) {
      allXs.push(item.x);
      if (/^\[\s*(VATA|FA)\b/.test(item.text.trim())) {
        const list = citationXByParity.get(parity) ?? [];
        list.push(item.x);
        citationXByParity.set(parity, list);
      }
    }
  }

  const boundaryByParity = new Map<number, ColumnBoundary>();
  for (const [parity, citationXs] of citationXByParity) {
    const sortedCitationXs = [...citationXs].sort((a, b) => a - b);
    const marginAnchor = sortedCitationXs[Math.floor(sortedCitationXs.length / 2)]!;

    // Widest gap in the whole page's x distribution, searched within 150pt
    // of the citation anchor (the main/margin boundary is always close to
    // it; restricting the search avoids picking up an unrelated gap
    // elsewhere on the page, e.g. in wide whitespace between two words).
    const distinctXs = [...new Set(allXByParity.get(parity) ?? [])]
      .filter((x) => Math.abs(x - marginAnchor) <= 150)
      .sort((a, b) => a - b);
    let widestGap = 0;
    let threshold = marginAnchor;
    for (let i = 1; i < distinctXs.length; i++) {
      const gap = distinctXs[i]! - distinctXs[i - 1]!;
      if (gap > widestGap) {
        widestGap = gap;
        threshold = (distinctXs[i]! + distinctXs[i - 1]!) / 2;
      }
    }

    boundaryByParity.set(parity, {
      threshold,
      marginSide: marginAnchor >= threshold ? 'high' : 'low',
    });
  }
  return boundaryByParity;
}

/** Split a page's items into (main, margin) columns using the document's parity-keyed column boundary. */
function splitColumns(
  page: Page, boundaryByParity: Map<number, ColumnBoundary>,
): { mainLines: Line[]; marginLines: Line[] } {
  const boundary = boundaryByParity.get(page.pageNumber % 2);
  if (boundary === undefined) {
    // No page of this parity carried a citation anywhere in the document —
    // would mean an Act with no predecessor cross-references at all.
    return { mainLines: toLines(page.items), marginLines: [] };
  }

  const isMargin = (i: Item) => (
    boundary.marginSide === 'high' ? i.x >= boundary.threshold : i.x <= boundary.threshold
  );

  const mainItems: Item[] = [];
  const marginItems: Item[] = [];
  for (const item of page.items) {
    (isMargin(item) ? marginItems : mainItems).push(item);
  }

  return { mainLines: toLines(mainItems), marginLines: toLines(marginItems) };
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

/**
 * Whether `text` is (or, after stripping a leaked heading prefix per the
 * rule below, becomes) a section-start line — used both to detect the
 * current line and to look ahead for the *next* one, so heading collection
 * knows where the current section's margin heading must stop.
 */
function sectionStartText(text: string, sectionRe: RegExp): string | null {
  const leaked = text.match(/^([A-Za-z][A-Za-z.,—\s-]{0,30}?)\s+(\d{1,3}[A-Z]?\s*\.—.*)$/);
  const stripped = leaked && !sectionRe.test(text) ? leaked[2]! : text;
  return sectionRe.test(stripped) ? stripped : null;
}

function convert(pages: Page[], opts: ConvertOptions): string {
  const out: string[] = [];
  let inBody = !opts.startAfter;
  const boundaryByParity = findColumnBoundaryByParity(pages);

  for (const page of pages) {
    const { mainLines, marginLines: marginLinesUnsorted } = splitColumns(page, boundaryByParity);
    const marginLines = [...marginLinesUnsorted].sort((a, b) => b.y - a.y); // top-to-bottom

    let stopped = false;
    for (let lineIdx = 0; lineIdx < mainLines.length; lineIdx++) {
      const line = mainLines[lineIdx]!;
      let text = lineText(line);
      if (!text) continue;

      if (!inBody) {
        if (opts.startAfter && text.startsWith(opts.startAfter)) inBody = true;
        continue;
      }
      if (opts.stopAt && text.startsWith(opts.stopAt)) { stopped = true; break; }

      // A margin heading occasionally wraps onto a word or two that lands at
      // an x between the two columns — neither close enough to the
      // bootstrapped margin x to classify as margin, nor part of the main
      // text — and so ends up prefixed onto the section-start row itself
      // (verified: VATCA s.4, "Definitions — Part 4 .—(1) In this Act—",
      // where "Part" is that stray word). Detected by the one thing this
      // Act's own typesetting makes distinctive: "<number>.—" opens a
      // section nowhere else in the running text, so 1-4 leaked words
      // immediately before it are reliably heading, not body prose.
      const leaked = text.match(/^([A-Za-z][A-Za-z.,—\s-]{0,30}?)\s+(\d{1,3}[A-Z]?\s*\.—.*)$/);
      let leakedPrefix: string | null = null;
      if (leaked && !opts.sectionRe.test(text)) {
        leakedPrefix = leaked[1]!.trim();
        text = leaked[2]!;
      }

      // A section-start line gets its margin heading inserted as its own
      // line directly above — the layout convention statuteParser.ts's
      // extractHeadingAbove already parses. The heading is the contiguous
      // run of margin lines starting at this exact y and continuing while a
      // line does not look like the bracketed predecessor-provision
      // citation ("[VATA s. 44]") that follows every heading; a heading
      // commonly wraps onto a second or third line (now correctly captured,
      // since `splitColumns` classifies by absolute column position rather
      // than a per-row gap — a wrapped continuation line has no main-column
      // content to form a gap against, which is exactly the case that broke
      // the previous, gap-based version).
      if (opts.sectionRe.test(text)) {
        // A run of consecutive sections that cite no predecessor provision
        // at all (VATCA ss.121-123, a repeal/transitional chapter) has no
        // "[...]" citation line to stop the collection, so without a second
        // boundary it swallows every later section's heading on the page
        // too (verified: s.121's heading absorbed s.122's and s.123's, and
        // s.122's absorbed s.123's, until the page ran out of margin
        // lines). The current section's heading can never legitimately
        // extend past where the *next* section's own heading starts, so
        // that line's y — found the same way a section-start is detected on
        // its own line, including the leaked-prefix case — is an
        // additional, always-safe stop condition.
        let nextSectionY: number | undefined;
        for (let j = lineIdx + 1; j < mainLines.length; j++) {
          if (sectionStartText(lineText(mainLines[j]!), opts.sectionRe)) {
            nextSectionY = mainLines[j]!.y;
            break;
          }
        }

        const startIdx = marginLines.findIndex((m) => m.y === line.y);
        const headingParts: string[] = [];
        if (startIdx >= 0) {
          for (let i = startIdx; i < marginLines.length; i++) {
            const m = marginLines[i]!;
            if (nextSectionY !== undefined && m.y <= nextSectionY) break;
            const t = lineText(m);
            if (!t || t.startsWith('[')) break;
            headingParts.push(t);
          }
        }
        if (leakedPrefix) headingParts.push(leakedPrefix);
        if (headingParts.length) out.push('', headingParts.join(' '));
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

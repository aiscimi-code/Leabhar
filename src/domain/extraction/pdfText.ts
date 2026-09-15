/**
 * PDF text-layer extraction.
 *
 * Reads the text a PDF already contains. It does not perform OCR: a scanned
 * image has no text layer, and this returns little or nothing, which the caller
 * reports honestly rather than papering over.
 */
export async function extractPdfText(content: Buffer): Promise<string> {
  // pdfjs-dist is loaded lazily so a document-free run of the application never
  // pays for it, and so a failure to load degrades to "no text" rather than
  // taking the process down.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(content),
    useSystemFonts: true,
    isEvalSupported: false,
    // No network fetches from a local-first application.
    disableFontFace: true,
  });

  const pdf = await loadingTask.promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content_ = await page.getTextContent();

    // Group text items into lines by their vertical position, so labelled-field
    // patterns like "Total: 123.00" survive as a single line.
    const rows = new Map<number, Array<{ x: number; text: string }>>();
    for (const item of content_.items) {
      if (!('str' in item) || item.str.trim() === '') continue;
      const transform = item.transform as number[];
      const y = Math.round((transform[5] ?? 0) * 2) / 2;
      const x = transform[4] ?? 0;
      const row = rows.get(y) ?? [];
      row.push({ x, text: item.str });
      rows.set(y, row);
    }

    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0]) // PDF y increases upward
      .map(([, items]) => items.sort((a, b) => a.x - b.x).map((i) => i.text).join(' ')
        .replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    pages.push(lines.join('\n'));
  }

  await pdf.destroy();
  return pages.join('\n\n');
}

export async function pdfPageCount(content: Buffer): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(content), isEvalSupported: false }).promise;
  const count = pdf.numPages;
  await pdf.destroy();
  return count;
}

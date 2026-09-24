import { parseCsv, parseStatementGrid, type ParsedRow } from "./csv";
import { extractFields } from "./extract";
import { matchBooks } from "./match";
import { applyRules } from "./rules";
import type { Books, SourceDocument, Transaction } from "./types";

export type ImportReport = {
  statementFiles: number;
  importedRows: number;
  duplicates: number;
  skippedRows: number;
  documents: number;
  documentDuplicates: number;
  matched: number;
  rulesApplied: number;
  notes: string[];
};

function fingerprint(accountId: string, row: ParsedRow): string {
  return `${accountId}|${row.date}|${row.amountMinor}|${row.description.trim().toLowerCase()}`;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function spreadsheetGrid(data: ArrayBuffer): Promise<string[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The spreadsheet has no sheets.");
  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = row.values;
    const cells = Array.isArray(values) ? values.slice(1) : [];
    grid.push(cells.map((cell) => (cell == null ? "" : String(cell))));
  });
  return grid;
}

async function pdfText(data: ArrayBuffer): Promise<{ text: string; scanned: boolean }> {
  const pdfjs = await import("pdfjs-dist");
  // Same-origin /pdf.worker.min.mjs is redirected away on www.fgi.ie (middleware
  // only leaves /portal on that host). The worker version tracks the installed
  // pdfjs-dist so the API and the worker cannot drift.
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  let text = "";
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      let lastY: number | null = null;
      for (const item of content.items) {
        if (!("str" in item) || !item.str) continue;
        const y = "transform" in item ? item.transform[5] : null;
        if (lastY != null && y != null && Math.abs(y - lastY) > 2) text += "\n";
        else if (text && !text.endsWith("\n")) text += " ";
        text += item.str;
        if (y != null) lastY = y;
      }
      text += "\n";
    }
    if (text.trim().length >= 40 || typeof document === "undefined") {
      return { text, scanned: false };
    }
    const ocr = await ocrPdf(doc);
    return { text: ocr || text, scanned: true };
  } finally {
    await doc.cleanup();
  }
}

async function ocrPdf(doc: import("pdfjs-dist").PDFDocumentProxy): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    let all = "";
    const pages = Math.min(doc.numPages, 2);
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) continue;
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), "image/png"));
      if (!blob) continue;
      const result = await worker.recognize(blob);
      all += `${result.data.text ?? ""}\n`;
    }
    return all;
  } finally {
    await worker.terminate();
  }
}

async function imageText(file: File): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const result = await worker.recognize(file);
    return result.data.text ?? "";
  } finally {
    await worker.terminate();
  }
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export async function ingestFiles(
  books: Books,
  accountId: string,
  files: File[],
  onStatus?: (message: string) => void,
): Promise<{ books: Books; report: ImportReport }> {
  const account = books.accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("Choose a bank account before importing.");
  const report: ImportReport = {
    statementFiles: 0,
    importedRows: 0,
    duplicates: 0,
    skippedRows: 0,
    documents: 0,
    documentDuplicates: 0,
    matched: 0,
    rulesApplied: 0,
    notes: [],
  };
  const seen = new Set(books.transactions.map((txn) => txn.fingerprint));
  const docHashes = new Set(books.documents.map((doc) => doc.sha256));
  const transactions: Transaction[] = [...books.transactions];
  const documents: SourceDocument[] = [...books.documents];
  let statementBalance: { minor: number; date: string } | null = null;

  for (const file of files) {
    onStatus?.(`Reading ${file.name}…`);
    const ext = extOf(file.name);
    try {
      if (ext === "csv" || ext === "xlsx" || ext === "xls") {
        const data = await file.arrayBuffer();
        const grid =
          ext === "csv" ? parseCsv(new TextDecoder().decode(data)) : await spreadsheetGrid(data);
        const parsed = parseStatementGrid(grid);
        report.statementFiles += 1;
        report.skippedRows += parsed.skipped;
        for (const row of parsed.rows) {
          const fp = fingerprint(accountId, row);
          if (seen.has(fp)) {
            report.duplicates += 1;
            continue;
          }
          seen.add(fp);
          transactions.push({
            id: crypto.randomUUID(),
            accountId,
            date: row.date,
            description: row.description,
            amountMinor: row.amountMinor,
            currency: account.currency,
            category: null,
            treatment: null,
            provenance: "imported",
            sourceFile: file.name,
            fingerprint: fp,
            matchedDocumentId: null,
          });
          report.importedRows += 1;
          if (row.balanceMinor != null) statementBalance = { minor: row.balanceMinor, date: row.date };
        }
        continue;
      }
      if (ext === "pdf" || ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "tif" || ext === "tiff") {
        const data = await file.arrayBuffer();
        const sha = await sha256Hex(data);
        if (docHashes.has(sha)) {
          report.documentDuplicates += 1;
          continue;
        }
        docHashes.add(sha);
        let method: SourceDocument["method"] = "none";
        let text = "";
        let note: string | null = null;
        if (ext === "pdf") {
          const result = await pdfText(data);
          text = result.text;
          method = result.scanned ? "ocr" : text.trim() ? "pdf-text" : "none";
          if (!text.trim()) note = "No text layer and recognition found nothing. Enter the figures yourself.";
        } else {
          try {
            text = await imageText(file);
            method = text.trim() ? "ocr" : "none";
            if (!text.trim()) note = "Recognition found no text. Enter the figures yourself. The image was not uploaded.";
          } catch {
            method = "none";
            note = "Image recognition could not start in this browser. Enter the figures yourself. The image was not uploaded.";
          }
        }
        const fields = extractFields(text);
        documents.push({
          id: crypto.randomUUID(),
          filename: file.name,
          sha256: sha,
          kind: fields.kind,
          method,
          supplier: fields.supplier,
          number: fields.number,
          date: fields.date,
          currency: "EUR",
          netMinor: fields.netMinor,
          vatMinor: fields.vatMinor,
          grossMinor: fields.grossMinor,
          vatRateLabel: fields.vatRateLabel,
          excerpt: fields.excerpt,
          matchedTransactionId: null,
          note,
        });
        report.documents += 1;
        continue;
      }
      report.notes.push(`${file.name}: skipped — use CSV, XLSX, PDF, or an image.`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Could not read this file.";
      report.notes.push(`${file.name}: ${reason}`);
    }
  }

  let next: Books = { ...books, transactions, documents };
  if (statementBalance) {
    next = {
      ...next,
      accounts: next.accounts.map((item) =>
        item.id === accountId
          ? { ...item, statementBalanceMinor: statementBalance.minor, statementDate: statementBalance.date }
          : item,
      ),
    };
    report.notes.push(
      `Statement balance on the last row (${(statementBalance.minor / 100).toFixed(2)} on ${statementBalance.date}) was written onto ${account.name}. Change it under Reconcile if that row is not the closing balance.`,
    );
  }
  const ruled = applyRules(next);
  next = matchBooks(ruled.books);
  report.rulesApplied = ruled.applied;
  report.matched = next.documents.filter((doc) => doc.matchedTransactionId).length;
  return { books: next, report };
}

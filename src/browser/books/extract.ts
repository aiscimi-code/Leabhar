import { parseDate } from "./dates";
import { parseMoneyToMinor } from "./money";
import type { DocKind } from "./types";

export type ExtractedFields = {
  kind: DocKind;
  supplier: string | null;
  number: string | null;
  date: string | null;
  netMinor: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
  vatRateLabel: string | null;
  excerpt: string;
};

const AMOUNT_RE = /(?:€\s*)?-?\(?\d{1,3}(?:[ .]\d{3})*[.,]\d{2}\)?|\(?\d+[.,]\d{2}\)?/g;

function amountsIn(line: string): number[] {
  const found: number[] = [];
  for (const match of line.match(AMOUNT_RE) ?? []) {
    const minor = parseMoneyToMinor(match);
    if (minor != null) found.push(Math.abs(minor));
  }
  return found;
}

function labelledAmount(lines: string[], pred: (line: string) => boolean): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!pred(line)) continue;
    const here = amountsIn(line);
    if (here.length) return here[here.length - 1]!;
    const next = lines[i + 1];
    if (!next) continue;
    const there = amountsIn(next);
    if (there.length === 1) return there[0]!;
  }
  return null;
}

export function extractFields(text: string): ExtractedFields {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const flat = lines.join("\n");
  const vatId = (line: string) => /vat\s*(reg|registration|no\.?|number)\b/i.test(line);

  const gross = labelledAmount(
    lines,
    (line) =>
      !vatId(line) &&
      !/total vat|vat total/i.test(line) &&
      /^(grand\s+)?total\b|amount due|balance due|invoice total|total due|total eur|gross\b/i.test(line),
  );
  const vat = labelledAmount(
    lines,
    (line) => !vatId(line) && /\bvat\b/i.test(line) && !/vat rate/i.test(line),
  );
  const net = labelledAmount(lines, (line) => /^(net|sub-?total|total ex|goods total)\b/i.test(line));

  let grossMinor = gross;
  let netMinor = net;
  let vatMinor = vat;
  if (grossMinor == null && netMinor != null && vatMinor != null) grossMinor = netMinor + vatMinor;
  if (netMinor == null && grossMinor != null && vatMinor != null) netMinor = grossMinor - vatMinor;
  if (grossMinor == null && netMinor == null && vatMinor == null) {
    const last = [...lines].reverse().map(amountsIn).find((list) => list.length);
    if (last) grossMinor = last[last.length - 1]!;
  }

  const numberMatch = /invoice\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/-]{1,20})/i.exec(flat);
  const dateMatch =
    /(?:invoice date|tax date|date)\s*[:\-]?\s*(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}-\d{2}-\d{2})/i.exec(
      flat,
    );
  const fromMatch = /(?:^|\n)(?:from|supplier|vendor)\s*[:\-]\s*([^\n]{2,80})/i.exec(`\n${flat}`);
  const supplier =
    fromMatch?.[1]?.trim() ??
    lines.find((line) => line.length > 2 && line.length < 70 && !/invoice|statement|page \d/i.test(line)) ??
    null;

  let vatRateLabel: string | null = null;
  if (/13\.5\s*%/.test(flat)) vatRateLabel = "13.5%";
  else if (/23\s*%/.test(flat)) vatRateLabel = "23%";
  else if (/(^|[^\d])9\s*%/.test(flat)) vatRateLabel = "9%";
  else if (/0\s*%|zero[ -]?rated/.test(flat)) vatRateLabel = "0%";

  let kind: DocKind = "unknown";
  if (/receipt/i.test(flat)) kind = "receipt";
  else if (/invoice|credit note/i.test(flat)) kind = "invoice";

  return {
    kind,
    supplier,
    number: numberMatch?.[1] ?? null,
    date: dateMatch ? parseDate(dateMatch[1]!) : null,
    netMinor,
    vatMinor,
    grossMinor,
    vatRateLabel,
    excerpt: flat.slice(0, 800),
  };
}

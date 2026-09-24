import { parseDate } from "./dates";
import { parseMoneyToMinor } from "./money";

export type ParsedRow = {
  date: string;
  description: string;
  amountMinor: number;
  balanceMinor: number | null;
};

export type ParsedStatement = {
  rows: ParsedRow[];
  skipped: number;
  headers: string[];
};

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  const s = text.replace(/^\uFEFF/, "");
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    cell += c;
    i += 1;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function norm(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const DATE = new Set([
  "date",
  "transactiondate",
  "posteddate",
  "completeddate",
  "bookingdate",
  "valuedate",
  "transdate",
]);
const DESC = new Set([
  "description",
  "details",
  "narrative",
  "particulars",
  "payee",
  "name",
  "memo",
  "transactiondescription",
]);
const REF = new Set(["reference", "ref", "transactionid"]);
const AMOUNT = new Set(["amount", "amounteur", "value", "transactionamount", "money"]);
const DEBIT = new Set(["debit", "moneyout", "paidout", "withdrawal", "out"]);
const CREDIT = new Set(["credit", "moneyin", "paidin", "deposit", "in"]);
const BALANCE = new Set(["balance", "runningbalance", "accountbalance"]);
const TYPE = new Set(["type", "drcr", "creditdebit"]);

function indexOf(headers: string[], set: Set<string>): number {
  return headers.findIndex((header) => set.has(header));
}

const BROUGHT_FORWARD = /brought forward|opening balance|balance b\/f|previous balance|start balance/i;

/** Map a headered CSV or spreadsheet grid into signed statement rows. */
export function parseStatementGrid(grid: string[][]): ParsedStatement {
  if (grid.length === 0) return { rows: [], skipped: 0, headers: [] };
  const headers = grid[0]!.map(norm);
  const dateCol = indexOf(headers, DATE);
  const descCol = indexOf(headers, DESC);
  const refCol = indexOf(headers, REF);
  const amountCol = indexOf(headers, AMOUNT);
  const debitCol = indexOf(headers, DEBIT);
  const creditCol = indexOf(headers, CREDIT);
  const balanceCol = indexOf(headers, BALANCE);
  const typeCol = indexOf(headers, TYPE);
  if (dateCol < 0 || (amountCol < 0 && debitCol < 0 && creditCol < 0)) {
    throw new Error(
      `Could not find a date and an amount in this file. Headers seen: ${grid[0]!.filter(Boolean).join(", ") || "(none)"}.`,
    );
  }

  const rows: ParsedRow[] = [];
  let skipped = 0;
  for (const cells of grid.slice(1)) {
    const date = parseDate(cells[dateCol] ?? "");
    const description = [descCol >= 0 ? cells[descCol] : "", refCol >= 0 ? cells[refCol] : ""]
      .map((part) => (part ?? "").trim())
      .filter((part, index, all) => part && all.indexOf(part) === index)
      .join(" — ");
    if (BROUGHT_FORWARD.test(description)) {
      skipped += 1;
      continue;
    }
    let amount: number | null = null;
    if (debitCol >= 0 || creditCol >= 0) {
      const debit = parseMoneyToMinor(cells[debitCol] ?? "") ?? 0;
      const credit = parseMoneyToMinor(cells[creditCol] ?? "") ?? 0;
      if (cells[debitCol]?.trim() || cells[creditCol]?.trim()) {
        amount = Math.abs(credit) - Math.abs(debit);
      }
    }
    if (amount == null && amountCol >= 0) {
      amount = parseMoneyToMinor(cells[amountCol] ?? "");
      const kind = (typeCol >= 0 ? cells[typeCol] : "")?.trim().toLowerCase() ?? "";
      if (amount != null && /debit|dr|out|withdrawal|payment/.test(kind)) amount = -Math.abs(amount);
      if (amount != null && /credit|cr|in|deposit|lodgement/.test(kind)) amount = Math.abs(amount);
    }
    if (!date || amount == null) {
      skipped += 1;
      continue;
    }
    const balance = balanceCol >= 0 ? parseMoneyToMinor(cells[balanceCol] ?? "") : null;
    rows.push({
      date,
      description: description || "(no description)",
      amountMinor: amount,
      balanceMinor: balance,
    });
  }
  return { rows, skipped, headers: grid[0]!.map((header) => header.trim()) };
}

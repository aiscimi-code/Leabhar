import { inRange } from "./dates";
import { splitVatInclusive, vatOnExclusive } from "./money";
import { TREATMENT_BY_ID, type Books, type Transaction, type TreatmentId } from "./types";

export type VatLine = {
  id: string;
  date: string;
  description: string;
  treatment: TreatmentId;
  netMinor: number;
  vatMinor: number;
  box: "T1" | "T2" | "both" | "none";
  confirmed: boolean;
};

export type VatWorksheet = {
  lines: VatLine[];
  t1Minor: number;
  t2Minor: number;
  t3Minor: number;
  unconfirmed: number;
  unclassified: number;
};

function lineFor(txn: Transaction, confirmed: boolean): VatLine | null {
  if (!txn.treatment) return null;
  const spec = TREATMENT_BY_ID[txn.treatment];
  if (spec.boxes === "none" || spec.rateBps == null) {
    return {
      id: txn.id,
      date: txn.date,
      description: txn.description,
      treatment: txn.treatment,
      netMinor: txn.amountMinor,
      vatMinor: 0,
      box: "none",
      confirmed,
    };
  }
  if (spec.boxes === "reverse") {
    const netMinor = txn.amountMinor;
    const vatMinor = Math.abs(vatOnExclusive(netMinor, spec.rateBps));
    return {
      id: txn.id,
      date: txn.date,
      description: txn.description,
      treatment: txn.treatment,
      netMinor,
      vatMinor,
      box: "both",
      confirmed,
    };
  }
  const split = splitVatInclusive(txn.amountMinor, spec.rateBps);
  return {
    id: txn.id,
    date: txn.date,
    description: txn.description,
    treatment: txn.treatment,
    netMinor: split.netMinor,
    vatMinor: Math.abs(split.vatMinor),
    box: txn.amountMinor >= 0 ? "T1" : "T2",
    confirmed,
  };
}

/**
 * Cash-basis VAT3 preparation.
 * T1 / T2 include only lines you have confirmed.
 * Reverse charge puts the same VAT into both boxes (nil net, both boxes move).
 * The bank amount is treated as VAT-inclusive, except reverse charge, where it
 * is treated as the VAT-exclusive consideration.
 */
export function vatWorksheet(books: Books, from: string, to: string): VatWorksheet {
  const lines: VatLine[] = [];
  let unconfirmed = 0;
  let unclassified = 0;
  for (const txn of books.transactions) {
    if (!inRange(txn.date, from, to)) continue;
    const confirmed = txn.provenance === "user_confirmed" || txn.provenance === "manually_entered";
    if (!txn.treatment) {
      unclassified += 1;
      continue;
    }
    const line = lineFor(txn, confirmed);
    if (!line) continue;
    if (!confirmed) unconfirmed += 1;
    lines.push(line);
  }
  lines.sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
  let t1Minor = 0;
  let t2Minor = 0;
  for (const line of lines) {
    if (!line.confirmed || line.box === "none") continue;
    if (line.box === "T1" || line.box === "both") t1Minor += line.vatMinor;
    if (line.box === "T2" || line.box === "both") t2Minor += line.vatMinor;
  }
  return {
    lines,
    t1Minor,
    t2Minor,
    t3Minor: t1Minor - t2Minor,
    unconfirmed,
    unclassified,
  };
}

const BALANCE_SHEET = new Set(["Tax payment", "Director funding", "Drawings", "Transfer"]);

export type CashBook = {
  income: { id: string; date: string; description: string; netMinor: number }[];
  expenses: { id: string; date: string; description: string; netMinor: number }[];
  excluded: { id: string; date: string; description: string; amountMinor: number; category: string }[];
  incomeMinor: number;
  expenseMinor: number;
  surplusMinor: number;
  skipped: number;
};

/** Cash book for the period. Not a statutory profit and loss. */
export function cashBook(books: Books, from: string, to: string): CashBook {
  const income: CashBook["income"] = [];
  const expenses: CashBook["expenses"] = [];
  const excluded: CashBook["excluded"] = [];
  let skipped = 0;
  for (const txn of books.transactions) {
    if (!inRange(txn.date, from, to)) continue;
    const confirmed = txn.provenance === "user_confirmed" || txn.provenance === "manually_entered";
    if (!confirmed || !txn.treatment || !txn.category) {
      skipped += 1;
      continue;
    }
    if (BALANCE_SHEET.has(txn.category) || txn.treatment === "out_of_scope") {
      excluded.push({
        id: txn.id,
        date: txn.date,
        description: txn.description,
        amountMinor: txn.amountMinor,
        category: txn.category,
      });
      continue;
    }
    const spec = TREATMENT_BY_ID[txn.treatment];
    let net = txn.amountMinor;
    if (spec.boxes === "rated" && spec.rateBps) {
      net = splitVatInclusive(txn.amountMinor, spec.rateBps).netMinor;
    }
    if (net >= 0) income.push({ id: txn.id, date: txn.date, description: txn.description, netMinor: net });
    else expenses.push({ id: txn.id, date: txn.date, description: txn.description, netMinor: net });
  }
  const incomeMinor = income.reduce((sum, row) => sum + row.netMinor, 0);
  const expenseMinor = expenses.reduce((sum, row) => sum + row.netMinor, 0);
  return {
    income,
    expenses,
    excluded,
    incomeMinor,
    expenseMinor,
    surplusMinor: incomeMinor + expenseMinor,
    skipped,
  };
}

import { dateDiffDays } from "./dates";
import type { Books } from "./types";

const CENT = 1;
const DAY_WINDOW = 21;

/**
 * Link a document to one bank line when the gross (or net, if gross is missing)
 * agrees within a cent and the dates are within 21 days. One line, one document.
 */
export function matchBooks(books: Books): Books {
  const transactions = books.transactions.map((txn) => ({
    ...txn,
    matchedDocumentId: null as string | null,
  }));
  const documents = books.documents.map((doc) => ({
    ...doc,
    matchedTransactionId: null as string | null,
  }));
  const used = new Set<string>();

  const order = documents
    .map((doc, index) => ({ index, target: doc.grossMinor ?? doc.netMinor }))
    .filter((item) => item.target != null)
    .map((item) => item.index);

  for (const index of order) {
    const doc = documents[index]!;
    const target = doc.grossMinor ?? doc.netMinor;
    if (target == null) continue;
    let best: { id: string; score: number } | null = null;
    for (const txn of transactions) {
      if (used.has(txn.id)) continue;
      const delta = Math.abs(Math.abs(txn.amountMinor) - Math.abs(target));
      if (delta > CENT) continue;
      let days = 0;
      if (doc.date) {
        days = Math.abs(dateDiffDays(doc.date, txn.date));
        if (!Number.isFinite(days) || days > DAY_WINDOW) continue;
      }
      const score = delta * 100 + days;
      if (!best || score < best.score) best = { id: txn.id, score };
    }
    if (!best) continue;
    doc.matchedTransactionId = best.id;
    used.add(best.id);
    const txn = transactions.find((item) => item.id === best.id);
    if (txn) txn.matchedDocumentId = doc.id;
  }

  return { ...books, transactions, documents };
}

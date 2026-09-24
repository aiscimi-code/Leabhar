import type { Books } from "./types";

export function encodeBooks(books: Books): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(books));
}

export function decodeBooks(bytes: Uint8Array): Books {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("The password opened this file, but the contents are not a Leabhar books vault.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("This vault decrypted, but it is not books this portal understands.");
  }
  const books = parsed as Partial<Books>;
  if (books.version !== 1 || !books.company?.legalName || !Array.isArray(books.transactions)) {
    throw new Error("This vault decrypted, but it is not books this portal understands.");
  }
  return {
    version: 1,
    company: books.company,
    accounts: Array.isArray(books.accounts) ? books.accounts : [],
    transactions: books.transactions,
    documents: Array.isArray(books.documents) ? books.documents : [],
    rules: Array.isArray(books.rules) ? books.rules : [],
  };
}

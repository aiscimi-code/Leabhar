import { create } from "zustand";
import { decodeBooks, encodeBooks } from "../books/codec";
import { demoBooks } from "../books/demo";
import { emptyBooks } from "../books/empty";
import { ingestFiles, type ImportReport } from "../books/intake";
import { matchBooks } from "../books/match";
import { parseMoneyToMinor } from "../books/money";
import { applyRules, newRule } from "../books/rules";
import type { Books, Rule, SourceDocument, Transaction, TreatmentId } from "../books/types";
import { createKey, openVault, seal, type KeyMaterial, VaultError } from "./crypto";
import { idbForget, idbLoad, idbSave } from "./idb";

export type CreateInput = {
  legalName: string;
  bankName: string;
  opening: string;
  openingDate: string;
  password: string;
  confirm: string;
  acknowledged: boolean;
  demo: boolean;
};

type SessionState = {
  status: "checking" | "locked" | "open";
  books: Books | null;
  material: KeyMaterial | null;
  localName: string | null;
  backupStale: boolean;
  storageWarning: string | null;
  busy: string | null;
  error: string | null;
  lastImport: ImportReport | null;
  hydrate: () => Promise<void>;
  createVault: (input: CreateInput) => Promise<void>;
  unlockLocal: (password: string) => Promise<void>;
  unlockFile: (file: File, password: string) => Promise<void>;
  lock: () => void;
  forgetBrowser: () => Promise<void>;
  downloadVault: () => Promise<void>;
  markBackedUp: () => void;
  importFiles: (accountId: string, files: File[]) => Promise<void>;
  addAccount: (input: { name: string; opening: string; openingDate: string }) => Promise<void>;
  setStatement: (accountId: string, balance: string, date: string) => Promise<void>;
  saveTransaction: (
    id: string,
    patch: { category: string; treatment: TreatmentId | null; description: string },
  ) => Promise<void>;
  confirmTransaction: (id: string) => Promise<void>;
  clearSuggestion: (id: string) => Promise<void>;
  confirmSuggestions: () => Promise<void>;
  saveDocument: (id: string, patch: Pick<SourceDocument, "supplier" | "number" | "date" | "netMinor" | "vatMinor" | "grossMinor">) => Promise<void>;
  addRule: (input: Omit<Rule, "id">) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  dismissError: () => void;
};

function message(error: unknown): string {
  if (error instanceof VaultError || error instanceof Error) return error.message;
  return "Something went wrong.";
}

async function persist(books: Books, material: KeyMaterial): Promise<string | null> {
  const bytes = await seal(material, encodeBooks(books));
  try {
    await idbSave(bytes, books.company.legalName);
    return null;
  } catch {
    return "This browser refused to store the encrypted vault. Download it before you leave — it is only in memory.";
  }
}

export const useSession = create<SessionState>((set, get) => ({
  status: "locked",
  books: null,
  material: null,
  localName: null,
  backupStale: false,
  storageWarning: null,
  busy: null,
  error: null,
  lastImport: null,

  dismissError: () => set({ error: null }),

  hydrate: async () => {
    if (get().books) return;
    try {
      const stored = await idbLoad();
      if (get().books) return;
      set({ status: "locked", localName: stored?.legalName ?? null });
    } catch {
      if (!get().books) set({ status: "locked", localName: null });
    }
  },

  createVault: async (input) => {
    if (!input.legalName.trim()) throw new Error("Enter the company's legal name.");
    if (input.password.length < 8) throw new Error("Use at least 8 characters. A longer passphrase is safer.");
    if (input.password !== input.confirm) throw new Error("The two passwords do not match.");
    if (!input.acknowledged) {
      throw new Error("Tick the box. A lost password cannot be recovered, and this portal has no account to reset.");
    }
    set({ busy: "Deriving a key from your password…", error: null });
    try {
      const books = input.demo
        ? demoBooks(input.legalName)
        : emptyBooks({
            legalName: input.legalName,
            bankName: input.bankName,
            opening: input.opening,
            openingDate: input.openingDate,
          });
      const material = await createKey(input.password, (progress) => {
        set({ busy: `Deriving a key… ${Math.round(progress * 100)}%` });
      });
      const storageWarning = await persist(books, material);
      set({
        status: "open",
        books,
        material,
        localName: books.company.legalName,
        backupStale: true,
        storageWarning,
        busy: null,
        lastImport: null,
      });
    } catch (error) {
      set({ busy: null, error: message(error) });
      throw error;
    }
  },

  unlockLocal: async (password) => {
    set({ busy: "Reading the encrypted vault in this browser…", error: null });
    try {
      const stored = await idbLoad();
      if (!stored) throw new Error("There is no vault saved in this browser.");
      set({ busy: "Checking password…" });
      const opened = await openVault(new Uint8Array(stored.bytes), password, (progress) => {
        set({ busy: `Checking password… ${Math.round(progress * 100)}%` });
      });
      const books = decodeBooks(opened.plaintext);
      set({
        status: "open",
        books,
        material: opened.material,
        localName: books.company.legalName,
        backupStale: false,
        busy: null,
        error: null,
      });
    } catch (error) {
      set({ busy: null, error: message(error) });
      throw error;
    }
  },

  unlockFile: async (file, password) => {
    set({ busy: "Reading the vault file…", error: null });
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      set({ busy: "Checking password…" });
      const opened = await openVault(buffer, password, (progress) => {
        set({ busy: `Checking password… ${Math.round(progress * 100)}%` });
      });
      const books = decodeBooks(opened.plaintext);
      const storageWarning = await persist(books, opened.material);
      set({
        status: "open",
        books,
        material: opened.material,
        localName: books.company.legalName,
        backupStale: false,
        storageWarning,
        busy: null,
        error: null,
      });
    } catch (error) {
      set({ busy: null, error: message(error) });
      throw error;
    }
  },

  lock: () => {
    set({
      status: "locked",
      books: null,
      material: null,
      busy: null,
      error: null,
      lastImport: null,
      backupStale: false,
    });
  },

  forgetBrowser: async () => {
    await idbForget();
    set({
      status: "locked",
      books: null,
      material: null,
      localName: null,
      backupStale: false,
      storageWarning: null,
      busy: null,
      error: null,
      lastImport: null,
    });
  },

  downloadVault: async () => {
    const { books, material } = get();
    if (!books || !material) throw new Error("Unlock the vault first.");
    const bytes = await seal(material, encodeBooks(books));
    const { downloadBytes, vaultFilename } = await import("./download");
    downloadBytes(vaultFilename(books.company.legalName), bytes, "application/octet-stream");
    try {
      await idbSave(bytes, books.company.legalName);
    } catch {
      set({ storageWarning: "Downloaded, but this browser would not store a copy." });
    }
    set({ backupStale: false });
  },

  markBackedUp: () => set({ backupStale: false }),

  importFiles: async (accountId, files) => {
    const { books, material } = get();
    if (!books || !material) throw new Error("Unlock the vault first.");
    if (files.length === 0) throw new Error("Choose at least one file.");
    set({ busy: "Reading files…", error: null });
    try {
      const result = await ingestFiles(books, accountId, files, (busy) => set({ busy }));
      const storageWarning = await persist(result.books, material);
      set({
        books: result.books,
        lastImport: result.report,
        backupStale: true,
        storageWarning,
        busy: null,
      });
    } catch (error) {
      set({ busy: null, error: message(error) });
      throw error;
    }
  },

  addAccount: async (input) => {
    await mutate(set, get, (books) => {
      const opening = input.opening.trim() ? parseMoneyToMinor(input.opening) : 0;
      if (opening == null) throw new Error("Opening balance is not a number.");
      if (!input.name.trim()) throw new Error("Name the account.");
      return {
        ...books,
        accounts: [
          ...books.accounts,
          {
            id: crypto.randomUUID(),
            name: input.name.trim(),
            currency: "EUR",
            openingBalanceMinor: opening,
            openingDate: input.openingDate,
            statementBalanceMinor: null,
            statementDate: null,
          },
        ],
      };
    });
  },

  setStatement: async (accountId, balance, date) => {
    await mutate(set, get, (books) => {
      const minor = parseMoneyToMinor(balance);
      if (minor == null) throw new Error("Statement balance is not a number.");
      return {
        ...books,
        accounts: books.accounts.map((account) =>
          account.id === accountId
            ? { ...account, statementBalanceMinor: minor, statementDate: date || null }
            : account,
        ),
      };
    });
  },

  saveTransaction: async (id, patch) => {
    await mutate(set, get, (books) => ({
      ...books,
      transactions: books.transactions.map((txn) =>
        txn.id === id
          ? {
              ...txn,
              description: patch.description.trim() || txn.description,
              category: patch.category || null,
              treatment: patch.treatment,
              provenance: patch.treatment ? "user_confirmed" : "imported",
            }
          : txn,
      ),
    }));
  },

  confirmTransaction: async (id) => {
    await mutate(set, get, (books) => ({
      ...books,
      transactions: books.transactions.map((txn) => {
        if (txn.id !== id) return txn;
        if (!txn.treatment || !txn.category) {
          throw new Error("Set a category and a VAT treatment before confirming.");
        }
        return { ...txn, provenance: "user_confirmed" as const };
      }),
    }));
  },

  clearSuggestion: async (id) => {
    await mutate(set, get, (books) => ({
      ...books,
      transactions: books.transactions.map((txn) =>
        txn.id === id
          ? { ...txn, category: null, treatment: null, provenance: "imported" as const }
          : txn,
      ),
    }));
  },

  confirmSuggestions: async () => {
    await mutate(set, get, (books) => ({
      ...books,
      transactions: books.transactions.map((txn) =>
        txn.provenance === "system_rule" && txn.treatment && txn.category
          ? { ...txn, provenance: "user_confirmed" as const }
          : txn,
      ),
    }));
  },

  saveDocument: async (id, patch) => {
    await mutate(set, get, (books) =>
      matchBooks({
        ...books,
        documents: books.documents.map((doc) => (doc.id === id ? { ...doc, ...patch, note: doc.note } : doc)),
      }),
    );
  },

  addRule: async (input) => {
    await mutate(set, get, (books) => {
      if (!input.contains.trim()) throw new Error("Enter text the description must contain.");
      const ruled = applyRules({ ...books, rules: [...books.rules, newRule(input)] });
      return ruled.books;
    });
  },

  deleteRule: async (id) => {
    await mutate(set, get, (books) => applyRules({ ...books, rules: books.rules.filter((rule) => rule.id !== id) }).books);
  },
}));

async function mutate(
  set: (partial: Partial<SessionState>) => void,
  get: () => SessionState,
  change: (books: Books) => Books,
) {
  const { books, material } = get();
  if (!books || !material) throw new Error("Unlock the vault first.");
  set({ busy: "Saving…", error: null });
  try {
    const next = change(books);
    const storageWarning = await persist(next, material);
    set({ books: next, backupStale: true, storageWarning, busy: null });
  } catch (error) {
    set({ busy: null, error: message(error) });
    throw error;
  }
}

export function accountBalance(books: Books, accountId: string): number {
  const account = books.accounts.find((item) => item.id === accountId);
  const opening = account?.openingBalanceMinor ?? 0;
  return books.transactions
    .filter((txn) => txn.accountId === accountId)
    .reduce((sum, txn) => sum + txn.amountMinor, opening);
}

export function transactionsCsv(books: Books): string {
  const names = new Map(books.accounts.map((account) => [account.id, account.name]));
  const docs = new Map(books.documents.map((doc) => [doc.id, doc.filename]));
  const header = [
    "date",
    "account",
    "description",
    "amount_eur",
    "category",
    "vat_treatment",
    "provenance",
    "matched_document",
    "source_file",
  ];
  const lines = [header.join(",")];
  for (const txn of [...books.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
    lines.push(
      [
        txn.date,
        csv(names.get(txn.accountId) ?? ""),
        csv(txn.description),
        (txn.amountMinor / 100).toFixed(2),
        csv(txn.category ?? ""),
        csv(txn.treatment ?? ""),
        txn.provenance,
        csv(txn.matchedDocumentId ? (docs.get(txn.matchedDocumentId) ?? "") : ""),
        csv(txn.sourceFile),
      ].join(","),
    );
  }
  return lines.join("\n");
}

function csv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export type { Transaction };

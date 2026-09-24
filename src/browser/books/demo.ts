import { defaultRules } from "./rules";
import type { Books } from "./types";

/** Fictional company so every screen can be tried. Not anyone's books. */
export function demoBooks(legalName: string): Books {
  const current = "acct-current";
  const reserve = "acct-reserve";
  const docId = "doc-office";
  const purchaseId = "txn-office";
  return {
    version: 1,
    company: {
      legalName: legalName.trim() || "Harbour Lane Studio Ltd",
      baseCurrency: "EUR",
      accountingBasis: "cash",
      vatFrequency: "bi-monthly",
      isDemo: true,
    },
    accounts: [
      {
        id: current,
        name: "Current account",
        currency: "EUR",
        openingBalanceMinor: 150_000,
        openingDate: "2026-09-01",
        statementBalanceMinor: 425_660,
        statementDate: "2026-09-20",
      },
      {
        id: reserve,
        name: "Tax reserve",
        currency: "EUR",
        openingBalanceMinor: 0,
        openingDate: "2026-09-01",
        statementBalanceMinor: 20_000,
        statementDate: "2026-09-20",
      },
    ],
    transactions: [
      txn(current, "txn-sale", "2026-09-02", "SEPA CREDIT North Quay Ceramics", 123_000, "Sales", "standard", "user_confirmed", "demo.csv"),
      txn(current, purchaseId, "2026-09-04", "SEPA PAYMENT Office Supplies Ltd", -24_600, "Purchases", "standard", "user_confirmed", "demo.csv", docId),
      txn(current, "txn-github", "2026-09-05", "GitHub subscription", -4_500, "Software and hosting", "reverse_charge", "system_rule", "demo.csv"),
      txn(current, "txn-director", "2026-09-08", "Director funds introduced", 200_000, "Director funding", "out_of_scope", "user_confirmed", "demo.csv"),
      txn(current, "txn-card", "2026-09-11", "CARD PAYMENT 4837", -8_740, null, null, "imported", "demo.csv"),
      txn(current, "txn-fee", "2026-09-12", "Revolut Business monthly fee", -1_000, "Bank charges", "exempt", "user_confirmed", "demo.csv"),
      txn(current, "txn-vat", "2026-09-15", "Revenue payment - VAT", -50_000, "Tax payment", "out_of_scope", "user_confirmed", "demo.csv"),
      txn(current, "txn-murphy", "2026-09-18", "SEPA CREDIT Murphy Consulting", 61_500, "Sales", "standard", "system_rule", "demo.csv"),
      txn(current, "txn-xfer-out", "2026-09-20", "Transfer to tax reserve", -20_000, "Transfer", "out_of_scope", "user_confirmed", "demo.csv"),
      txn(reserve, "txn-xfer-in", "2026-09-20", "Transfer from current account", 20_000, "Transfer", "out_of_scope", "user_confirmed", "demo.csv"),
    ],
    documents: [
      {
        id: docId,
        filename: "office-supplies-ltd-inv-2041.pdf",
        sha256: "demo-office-supplies",
        kind: "invoice",
        method: "sample",
        supplier: "Office Supplies Ltd",
        number: "INV-2041",
        date: "2026-09-03",
        currency: "EUR",
        netMinor: 20_000,
        vatMinor: 4_600,
        grossMinor: 24_600,
        vatRateLabel: "23%",
        excerpt: "Office Supplies Ltd\nInvoice INV-2041\nDate 03/09/2026\nNet 200.00\nVAT 23% 46.00\nTotal 246.00",
        matchedTransactionId: purchaseId,
        note: "Sample document, not a scan of a real invoice.",
      },
    ],
    rules: defaultRules(),
  };
}

function txn(
  accountId: string,
  id: string,
  date: string,
  description: string,
  amountMinor: number,
  category: string | null,
  treatment: Books["transactions"][number]["treatment"],
  provenance: Books["transactions"][number]["provenance"],
  sourceFile: string,
  matchedDocumentId: string | null = null,
): Books["transactions"][number] {
  return {
    id,
    accountId,
    date,
    description,
    amountMinor,
    currency: "EUR",
    category,
    treatment,
    provenance,
    sourceFile,
    fingerprint: `${accountId}|${date}|${amountMinor}|${description.toLowerCase()}`,
    matchedDocumentId,
  };
}

import { parseMoneyToMinor } from "./money";
import { defaultRules } from "./rules";
import type { Books } from "./types";

export function emptyBooks(input: {
  legalName: string;
  bankName: string;
  opening: string;
  openingDate: string;
}): Books {
  const openingBalanceMinor = input.opening.trim() ? (parseMoneyToMinor(input.opening) ?? 0) : 0;
  return {
    version: 1,
    company: {
      legalName: input.legalName.trim(),
      baseCurrency: "EUR",
      accountingBasis: "cash",
      vatFrequency: "bi-monthly",
      isDemo: false,
    },
    accounts: [
      {
        id: crypto.randomUUID(),
        name: input.bankName.trim() || "Current account",
        currency: "EUR",
        openingBalanceMinor,
        openingDate: input.openingDate,
        statementBalanceMinor: null,
        statementDate: null,
      },
    ],
    transactions: [],
    documents: [],
    rules: defaultRules(),
  };
}

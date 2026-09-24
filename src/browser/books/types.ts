export const TREATMENTS = [
  { id: "standard", label: "Standard 23%", rateBps: 2300, boxes: "rated" },
  { id: "reduced", label: "Reduced 13.5%", rateBps: 1350, boxes: "rated" },
  { id: "second_reduced", label: "Second reduced 9%", rateBps: 900, boxes: "rated" },
  { id: "zero", label: "Zero-rated 0%", rateBps: 0, boxes: "rated" },
  { id: "exempt", label: "Exempt", rateBps: null, boxes: "none" },
  { id: "out_of_scope", label: "Outside the scope", rateBps: null, boxes: "none" },
  { id: "reverse_charge", label: "Reverse charge 23%", rateBps: 2300, boxes: "reverse" },
] as const;

export type TreatmentId = (typeof TREATMENTS)[number]["id"];

export const TREATMENT_BY_ID = Object.fromEntries(TREATMENTS.map((t) => [t.id, t])) as Record<
  TreatmentId,
  (typeof TREATMENTS)[number]
>;

export type Provenance = "imported" | "system_rule" | "user_confirmed" | "manually_entered";

export type BankAccount = {
  id: string;
  name: string;
  currency: "EUR";
  openingBalanceMinor: number;
  openingDate: string;
  statementBalanceMinor: number | null;
  statementDate: string | null;
};

export type Transaction = {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amountMinor: number;
  currency: string;
  category: string | null;
  treatment: TreatmentId | null;
  provenance: Provenance;
  sourceFile: string;
  fingerprint: string;
  matchedDocumentId: string | null;
};

export type DocKind = "invoice" | "bill" | "receipt" | "unknown";
export type ExtractMethod = "pdf-text" | "ocr" | "none" | "sample";

export type SourceDocument = {
  id: string;
  filename: string;
  sha256: string;
  kind: DocKind;
  method: ExtractMethod;
  supplier: string | null;
  number: string | null;
  date: string | null;
  currency: string;
  netMinor: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
  vatRateLabel: string | null;
  excerpt: string;
  matchedTransactionId: string | null;
  note: string | null;
};

export type Rule = {
  id: string;
  label: string;
  /** Comma-separated substrings. First matching rule wins. Not a regular expression. */
  contains: string;
  direction: "in" | "out" | "any";
  category: string;
  treatment: TreatmentId;
};

export type Company = {
  legalName: string;
  baseCurrency: "EUR";
  accountingBasis: "cash";
  vatFrequency: "bi-monthly";
  isDemo: boolean;
};

export type Books = {
  version: 1;
  company: Company;
  accounts: BankAccount[];
  transactions: Transaction[];
  documents: SourceDocument[];
  rules: Rule[];
};

export const CATEGORIES = [
  "Sales",
  "Purchases",
  "Software and hosting",
  "Bank charges",
  "Wages",
  "Motor and travel",
  "Premises",
  "Professional fees",
  "Tax payment",
  "Director funding",
  "Drawings",
  "Transfer",
  "Other",
] as const;

export function treatmentLabel(id: TreatmentId | null): string {
  if (!id) return "Not set";
  return TREATMENT_BY_ID[id].label;
}

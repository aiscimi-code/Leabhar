import type { Books, Rule, Transaction, TreatmentId } from "./types";

export function defaultRules(): Rule[] {
  return [
    {
      id: "rule-tax",
      label: "Revenue tax payment",
      contains: "revenue commissioners, revenue payment, vat payment, ros payment",
      direction: "out",
      category: "Tax payment",
      treatment: "out_of_scope",
    },
    {
      id: "rule-director",
      label: "Director funds introduced",
      contains: "director funds, funds introduced, director loan, directors loan",
      direction: "in",
      category: "Director funding",
      treatment: "out_of_scope",
    },
    {
      id: "rule-wages",
      label: "Wages",
      contains: "salary, wages, payroll",
      direction: "out",
      category: "Wages",
      treatment: "out_of_scope",
    },
    {
      id: "rule-bank",
      label: "Bank charges",
      contains: "bank fee, account fee, monthly fee, revolut business",
      direction: "out",
      category: "Bank charges",
      treatment: "exempt",
    },
    {
      id: "rule-software",
      label: "Non-EU software (reverse charge — check the supplier)",
      contains: "github, vercel, anthropic, aws, adobe",
      direction: "out",
      category: "Software and hosting",
      treatment: "reverse_charge",
    },
  ];
}

export function ruleMatches(rule: Rule, txn: Transaction): boolean {
  if (rule.direction === "in" && txn.amountMinor <= 0) return false;
  if (rule.direction === "out" && txn.amountMinor >= 0) return false;
  const hay = txn.description.toLowerCase();
  return rule.contains
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .some((needle) => hay.includes(needle));
}

/** Suggest a treatment. Never overwrites a decision you already confirmed. */
export function applyRules(books: Books): { books: Books; applied: number } {
  let applied = 0;
  const transactions = books.transactions.map((txn) => {
    if (txn.provenance === "user_confirmed" || txn.provenance === "manually_entered") return txn;
    const rule = books.rules.find((candidate) => ruleMatches(candidate, txn));
    if (!rule) {
      if (txn.provenance === "system_rule") {
        return { ...txn, provenance: "imported" as const, category: null, treatment: null };
      }
      return txn;
    }
    if (
      txn.provenance === "system_rule" &&
      txn.category === rule.category &&
      txn.treatment === rule.treatment
    ) {
      return txn;
    }
    applied += 1;
    return {
      ...txn,
      category: rule.category,
      treatment: rule.treatment,
      provenance: "system_rule" as const,
    };
  });
  return { books: { ...books, transactions }, applied };
}

export function newRule(input: {
  label: string;
  contains: string;
  direction: Rule["direction"];
  category: string;
  treatment: TreatmentId;
}): Rule {
  return { id: crypto.randomUUID(), ...input };
}

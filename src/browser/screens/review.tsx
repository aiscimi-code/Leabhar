"use client";

import { useState } from "react";
import { Button, CategorySelect, Empty, Page, Panel, ProvenanceBadge, TreatmentSelect } from "@/browser/ui/primitives";
import { formatMoney } from "@/browser/books/money";
import { CATEGORIES, TREATMENTS, type TreatmentId } from "@/browser/books/types";
import { useSession } from "@/browser/vault/session";

export function ReviewPage() {
  const books = useSession((state) => state.books);
  const confirmTransaction = useSession((state) => state.confirmTransaction);
  const clearSuggestion = useSession((state) => state.clearSuggestion);
  const saveTransaction = useSession((state) => state.saveTransaction);
  const confirmSuggestions = useSession((state) => state.confirmSuggestions);
  const addRule = useSession((state) => state.addRule);
  const deleteRule = useSession((state) => state.deleteRule);
  const busy = useSession((state) => state.busy);
  if (!books) return null;

  const queue = books.transactions.filter(
    (txn) => txn.provenance === "imported" || txn.provenance === "system_rule",
  );
  const suggestions = queue.filter((txn) => txn.provenance === "system_rule").length;

  return (
    <Page
      title="Review queue"
      subtitle="A rule is a suggestion. Confirm it before it can land in the VAT worksheet. Nothing here is filed with Revenue."
      actions={
        suggestions > 0 ? (
          <Button variant="primary" disabled={!!busy} onClick={() => void confirmSuggestions()}>
            Confirm {suggestions} rule suggestion{suggestions === 1 ? "" : "s"}
          </Button>
        ) : null
      }
    >
      <Panel title={`${queue.length} line${queue.length === 1 ? "" : "s"} waiting`}>
        {queue.length === 0 ? (
          <Empty title="Nothing waiting" detail="Imported lines with no decision, and rule suggestions, show up here." />
        ) : (
          <div className="divide-y divide-line">
            {queue.map((txn) => (
              <ReviewRow
                key={txn.id}
                id={txn.id}
                date={txn.date}
                description={txn.description}
                amountMinor={txn.amountMinor}
                category={txn.category ?? ""}
                treatment={txn.treatment ?? ""}
                provenance={txn.provenance}
                disabled={!!busy}
                onConfirm={() => void confirmTransaction(txn.id)}
                onClear={() => void clearSuggestion(txn.id)}
                onSave={(patch) => void saveTransaction(txn.id, patch)}
              />
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Rules" description="First match wins. A rule never overwrites a line you have already confirmed.">
        <ul className="divide-y divide-line">
          {books.rules.map((rule) => (
            <li key={rule.id} className="px-4 py-2 flex items-start justify-between gap-3">
              <div>
                <div className="font-medium">{rule.label}</div>
                <div className="text-xs text-ink-muted">
                  {rule.direction === "any" ? "Any direction" : rule.direction === "in" ? "Money in" : "Money out"} · contains “
                  {rule.contains}” · {rule.category} · {TREATMENTS.find((item) => item.id === rule.treatment)?.label}
                </div>
              </div>
              <Button variant="ghost" disabled={!!busy} onClick={() => void deleteRule(rule.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="px-4 py-3 border-t border-line grid gap-2 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void addRule({
              label: String(data.get("label") ?? ""),
              contains: String(data.get("contains") ?? ""),
              direction: String(data.get("direction") ?? "any") as "in" | "out" | "any",
              category: String(data.get("category") ?? "Other"),
              treatment: String(data.get("treatment") ?? "out_of_scope") as TreatmentId,
            });
            event.currentTarget.reset();
          }}
        >
          <input name="label" required placeholder="Label" className="border border-line-strong rounded px-2 min-h-11 md:min-h-8" />
          <input
            name="contains"
            required
            placeholder="Text in the description, commas for alternatives"
            className="border border-line-strong rounded px-2 min-h-11 md:min-h-8"
          />
          <select name="direction" className="border border-line-strong rounded px-2 min-h-11 md:min-h-8 bg-surface">
            <option value="any">Any direction</option>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
          <select name="category" className="border border-line-strong rounded px-2 min-h-11 md:min-h-8 bg-surface">
            {CATEGORIES.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
          <select name="treatment" className="border border-line-strong rounded px-2 min-h-11 md:min-h-8 bg-surface">
            {TREATMENTS.map((treatment) => (
              <option key={treatment.id} value={treatment.id}>
                {treatment.label}
              </option>
            ))}
          </select>
          <Button type="submit" variant="secondary" disabled={!!busy}>
            Add rule
          </Button>
        </form>
      </Panel>
    </Page>
  );
}

function ReviewRow({
  date,
  description,
  amountMinor,
  category,
  treatment,
  provenance,
  disabled,
  onConfirm,
  onClear,
  onSave,
}: {
  id: string;
  date: string;
  description: string;
  amountMinor: number;
  category: string;
  treatment: TreatmentId | "";
  provenance: string;
  disabled: boolean;
  onConfirm: () => void;
  onClear: () => void;
  onSave: (patch: { category: string; treatment: TreatmentId | null; description: string }) => void;
}) {
  const [categoryValue, setCategoryValue] = useState(category);
  const [treatmentValue, setTreatmentValue] = useState<TreatmentId | "">(treatment);
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="num !text-left mr-2">{date}</span>
          <span>{description}</span>
        </div>
        <span className={amountMinor < 0 ? "num num-negative" : "num"}>{formatMoney(amountMinor)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <ProvenanceBadge status={provenance} />
        <div className="w-full sm:w-44">
          <CategorySelect value={categoryValue} onChange={setCategoryValue} />
        </div>
        <div className="w-full sm:w-52">
          <TreatmentSelect value={treatmentValue} onChange={setTreatmentValue} />
        </div>
        <Button
          variant="primary"
          disabled={disabled || !treatmentValue || !categoryValue}
          onClick={() => {
            if (categoryValue === category && treatmentValue === treatment && provenance === "system_rule") onConfirm();
            else onSave({ category: categoryValue, treatment: treatmentValue || null, description });
          }}
        >
          {categoryValue === category && treatmentValue === treatment ? "Confirm" : "Save decision"}
        </Button>
        {provenance === "system_rule" && (
          <Button variant="ghost" disabled={disabled} onClick={onClear}>
            Clear suggestion
          </Button>
        )}
      </div>
    </div>
  );
}

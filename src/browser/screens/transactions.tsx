"use client";

import { Fragment, useMemo, useState } from "react";
import { Button, CategorySelect, Input, Page, Panel, ProvenanceBadge, Select, TreatmentSelect } from "@/browser/ui/primitives";
import { formatMoney } from "@/browser/books/money";
import { treatmentLabel, type TreatmentId } from "@/browser/books/types";
import { useSession } from "@/browser/vault/session";

export function TransactionsPage() {
  const books = useSession((state) => state.books);
  const saveTransaction = useSession((state) => state.saveTransaction);
  const busy = useSession((state) => state.busy);
  const [accountId, setAccountId] = useState("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = useMemo(() => {
    if (!books) return [];
    return books.transactions
      .filter((txn) => accountId === "all" || txn.accountId === accountId)
      .filter((txn) => txn.description.toLowerCase().includes(query.trim().toLowerCase()))
      .sort((a, b) => b.date.localeCompare(a.date) || b.description.localeCompare(a.description));
  }, [books, accountId, query]);
  if (!books) return null;
  const names = new Map(books.accounts.map((account) => [account.id, account.name]));

  return (
    <Page title="Transactions" subtitle="Imported lines are write-once as evidence. A decision sits beside the line; it does not rewrite the bank row.">
      <div className="flex flex-col sm:flex-row gap-2 mb-3 no-print">
        <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="sm:max-w-xs">
          <option value="all">All accounts</option>
          {books.accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </Select>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter description" aria-label="Filter description" />
      </div>
      <Panel title={`${rows.length} line${rows.length === 1 ? "" : "s"}`}>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-ink-muted">No lines match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Account</th>
                  <th>Description</th>
                  <th>Treatment</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((txn) => (
                  <Fragment key={txn.id}>
                    <tr className="cursor-pointer" onClick={() => setOpenId(openId === txn.id ? null : txn.id)}>
                      <td className="num !text-left">{txn.date}</td>
                      <td>{names.get(txn.accountId)}</td>
                      <td>
                        {txn.description} <ProvenanceBadge status={txn.provenance} />
                      </td>
                      <td className="text-ink-muted">{treatmentLabel(txn.treatment)}</td>
                      <td className={txn.amountMinor < 0 ? "num num-negative" : "num"}>{formatMoney(txn.amountMinor)}</td>
                    </tr>
                    {openId === txn.id && (
                      <tr key={`${txn.id}-edit`}>
                        <td colSpan={5}>
                          <TxnEdit
                            description={txn.description}
                            category={txn.category ?? ""}
                            treatment={txn.treatment ?? ""}
                            disabled={!!busy}
                            onSave={(patch) => void saveTransaction(txn.id, patch)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Page>
  );
}

function TxnEdit({
  description,
  category,
  treatment,
  disabled,
  onSave,
}: {
  description: string;
  category: string;
  treatment: TreatmentId | "";
  disabled: boolean;
  onSave: (patch: { category: string; treatment: TreatmentId | null; description: string }) => void;
}) {
  const [desc, setDesc] = useState(description);
  const [cat, setCat] = useState(category);
  const [treat, setTreat] = useState<TreatmentId | "">(treatment);
  return (
    <div className="grid gap-2 md:grid-cols-4 items-end py-1">
      <Input value={desc} onChange={(event) => setDesc(event.target.value)} aria-label="Description" />
      <CategorySelect value={cat} onChange={setCat} />
      <TreatmentSelect value={treat} onChange={setTreat} />
      <Button variant="primary" disabled={disabled} onClick={() => onSave({ description: desc, category: cat, treatment: treat || null })}>
        Save decision
      </Button>
    </div>
  );
}

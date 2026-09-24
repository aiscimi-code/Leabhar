"use client";

import { useState } from "react";
import { Badge, Button, Input, Page, Panel } from "@/browser/ui/primitives";
import { formatMoney } from "@/browser/books/money";
import { accountBalance, useSession } from "@/browser/vault/session";

export function ReconcilePage() {
  const books = useSession((state) => state.books);
  const setStatement = useSession((state) => state.setStatement);
  const busy = useSession((state) => state.busy);
  if (!books) return null;

  return (
    <Page
      title="Reconcile"
      subtitle="The book balance is the opening balance plus every imported line. Classification does not move it. The difference is only against the closing figure you take from the statement."
    >
      {books.accounts.map((account) => {
        const book = accountBalance(books, account.id);
        const lines = books.transactions.filter((txn) => txn.accountId === account.id);
        const movement = lines.reduce((sum, txn) => sum + txn.amountMinor, 0);
        const difference = account.statementBalanceMinor == null ? null : account.statementBalanceMinor - book;
        const unconfirmed = lines.filter((txn) => txn.provenance !== "user_confirmed" && txn.provenance !== "manually_entered").length;
        return (
          <Panel
            key={account.id}
            title={account.name}
            actions={
              difference == null ? (
                <Badge tone="neutral">No statement balance</Badge>
              ) : difference === 0 ? (
                <Badge tone="positive">Ties</Badge>
              ) : (
                <Badge tone="negative">Does not tie</Badge>
              )
            }
          >
            <table className="ledger">
              <tbody>
                <tr>
                  <td>Opening balance ({account.openingDate})</td>
                  <td className="num">{formatMoney(account.openingBalanceMinor)}</td>
                </tr>
                <tr>
                  <td>{lines.length} imported lines</td>
                  <td className={movement < 0 ? "num num-negative" : "num"}>{formatMoney(movement)}</td>
                </tr>
                <tr>
                  <td>Book balance</td>
                  <td className={book < 0 ? "num num-negative" : "num"}>{formatMoney(book)}</td>
                </tr>
                <tr>
                  <td>Statement balance{account.statementDate ? ` (${account.statementDate})` : ""}</td>
                  <td className="num">
                    {account.statementBalanceMinor == null ? "—" : formatMoney(account.statementBalanceMinor)}
                  </td>
                </tr>
                <tr>
                  <td>Difference (statement minus book)</td>
                  <td className={difference ? "num num-negative" : "num"}>{difference == null ? "—" : formatMoney(difference)}</td>
                </tr>
              </tbody>
            </table>
            {unconfirmed > 0 && (
              <p className="px-4 py-2 text-ink-muted">
                {unconfirmed} line{unconfirmed === 1 ? "" : "s"} still need a decision. That does not explain a cash difference — it only means the VAT worksheet is ignoring them.
              </p>
            )}
            <StatementForm
              disabled={!!busy}
              initialBalance={account.statementBalanceMinor == null ? "" : (account.statementBalanceMinor / 100).toFixed(2)}
              initialDate={account.statementDate ?? ""}
              onSave={(balance, date) => void setStatement(account.id, balance, date)}
            />
          </Panel>
        );
      })}
    </Page>
  );
}

function StatementForm({
  initialBalance,
  initialDate,
  disabled,
  onSave,
}: {
  initialBalance: string;
  initialDate: string;
  disabled: boolean;
  onSave: (balance: string, date: string) => void;
}) {
  const [balance, setBalance] = useState(initialBalance);
  const [date, setDate] = useState(initialDate);
  return (
    <form
      className="px-4 py-3 flex flex-wrap gap-2 items-end border-t border-line"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(balance, date);
      }}
    >
      <label className="block text-xs text-ink-faint">
        Statement balance
        <Input value={balance} onChange={(event) => setBalance(event.target.value)} inputMode="decimal" className="mt-1 w-36" />
      </label>
      <label className="block text-xs text-ink-faint">
        Statement date
        <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-1" />
      </label>
      <Button type="submit" variant="secondary" disabled={disabled}>
        Save statement figure
      </Button>
    </form>
  );
}

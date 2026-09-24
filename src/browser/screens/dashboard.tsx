"use client";

import Link from "next/link";
import { Badge, Page, Panel, ProvenanceBadge, Stat } from "@/browser/ui/primitives";
import { formatMoney } from "@/browser/books/money";
import { todayIso, vatPeriodContaining } from "@/browser/books/dates";
import { vatWorksheet } from "@/browser/books/vat";
import { accountBalance, useSession } from "@/browser/vault/session";

export function Dashboard() {
  const books = useSession((state) => state.books);
  if (!books) return null;
  const period = vatPeriodContaining(todayIso());
  const vat = vatWorksheet(books, period.from, period.to);
  const waiting = books.transactions.filter((txn) => txn.provenance !== "user_confirmed" && txn.provenance !== "manually_entered").length;
  const unmatchedDocs = books.documents.filter((doc) => !doc.matchedTransactionId).length;
  const recent = [...books.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);

  return (
    <Page
      title={books.company.legalName}
      subtitle="Cash basis, euro, bi-monthly VAT. Figures below are only as good as the lines you have confirmed."
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 bg-surface border border-line rounded mb-4">
        <Stat label="Bank accounts" value={String(books.accounts.length)} hint="Add another under Bank accounts" />
        <Stat label="Transactions" value={String(books.transactions.length)} />
        <Stat
          label="Waiting on you"
          value={String(waiting)}
          tone={waiting ? "caution" : "positive"}
          hint="Not in the VAT worksheet yet"
        />
        <Stat
          label={`VAT T3 ${period.label}`}
          value={formatMoney(vat.t3Minor)}
          tone={vat.t3Minor > 0 ? "negative" : "positive"}
          hint="Confirmed lines only. Not a ROS filing."
        />
      </div>

      <Panel title="Where the money sits">
        {books.accounts.length === 0 ? (
          <p className="px-4 py-3 text-ink-muted">No bank account yet.</p>
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Account</th>
                <th className="text-right">Book balance</th>
                <th className="text-right">Statement</th>
              </tr>
            </thead>
            <tbody>
              {books.accounts.map((account) => {
                const book = accountBalance(books, account.id);
                const gap = account.statementBalanceMinor == null ? null : account.statementBalanceMinor - book;
                return (
                  <tr key={account.id}>
                    <td>{account.name}</td>
                    <td className={book < 0 ? "num num-negative" : "num"}>{formatMoney(book)}</td>
                    <td>
                      {gap == null ? (
                        <span className="text-ink-faint">Not entered</span>
                      ) : gap === 0 ? (
                        <Badge tone="positive">Ties</Badge>
                      ) : (
                        <span className="num num-negative">{formatMoney(gap)} difference</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Recent transactions"
        actions={
          <Link href="/portal/review" className="text-sm text-accent hover:underline">
            Review queue{waiting ? ` (${waiting})` : ""}
            {unmatchedDocs ? ` · ${unmatchedDocs} unmatched documents` : ""}
          </Link>
        }
      >
        {recent.length === 0 ? (
          <p className="px-4 py-6 text-ink-muted">
            Nothing imported yet. Use Import to point at bank CSVs or spreadsheets, and at invoice PDFs or images.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="text-right">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((txn) => (
                  <tr key={txn.id}>
                    <td className="num !text-left">{txn.date}</td>
                    <td>{txn.description}</td>
                    <td className={txn.amountMinor < 0 ? "num num-negative" : "num"}>{formatMoney(txn.amountMinor)}</td>
                    <td>
                      <ProvenanceBadge status={txn.provenance} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Page>
  );
}

"use client";

import { useState } from "react";
import { Button, Input, Page, Panel, Stat } from "@/browser/ui/primitives";
import { todayIso, vatPeriodContaining } from "@/browser/books/dates";
import { formatMoney } from "@/browser/books/money";
import { cashBook } from "@/browser/books/vat";
import { useSession } from "@/browser/vault/session";

export function ReportsPage() {
  const books = useSession((state) => state.books);
  const period = vatPeriodContaining(todayIso());
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  if (!books) return null;
  const book = cashBook(books, from, to);

  return (
    <Page
      title="Cash book"
      subtitle="Money in and money out that you have confirmed, with VAT taken out of rated amounts. Not a profit and loss, not a balance sheet, and not accounts you would sign."
    >
      <div className="flex flex-wrap gap-2 mb-3 items-end no-print">
        <label className="text-xs text-ink-faint">
          From
          <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1" />
        </label>
        <label className="text-xs text-ink-faint">
          To
          <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="mt-1" />
        </label>
        <Button variant="ghost" onClick={() => { setFrom(period.from); setTo(period.to); }}>
          {period.label}
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 bg-surface border border-line rounded mb-4">
        <Stat label="Income, net" value={formatMoney(book.incomeMinor)} tone="positive" />
        <Stat label="Expenses, net" value={formatMoney(book.expenseMinor)} />
        <Stat
          label="Surplus / (deficit)"
          value={formatMoney(book.surplusMinor)}
          tone={book.surplusMinor >= 0 ? "positive" : "negative"}
        />
      </div>
      <Panel title="Income">
        <Rows rows={book.income} empty="No confirmed income in this range." />
      </Panel>
      <Panel title="Expenses">
        <Rows rows={book.expenses} empty="No confirmed expenses in this range." />
      </Panel>
      <Panel title="Left out of this cash book" description="Tax payments, director funding, drawings, transfers, and anything still undecided.">
        {book.excluded.length === 0 && book.skipped === 0 ? (
          <p className="px-4 py-3 text-ink-muted">Nothing excluded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="ledger">
              <tbody>
                {book.excluded.map((row) => (
                  <tr key={row.id}>
                    <td className="num !text-left">{row.date}</td>
                    <td>{row.description}</td>
                    <td className="text-ink-muted">{row.category}</td>
                    <td className={row.amountMinor < 0 ? "num num-negative" : "num"}>{formatMoney(row.amountMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {book.skipped > 0 && (
              <p className="px-4 py-2 text-ink-muted">{book.skipped} undecided line{book.skipped === 1 ? "" : "s"} not shown.</p>
            )}
          </div>
        )}
      </Panel>
    </Page>
  );
}

function Rows({ rows, empty }: { rows: { id: string; date: string; description: string; netMinor: number }[]; empty: string }) {
  if (rows.length === 0) return <p className="px-4 py-3 text-ink-muted">{empty}</p>;
  return (
    <table className="ledger">
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="num !text-left">{row.date}</td>
            <td>{row.description}</td>
            <td className={row.netMinor < 0 ? "num num-negative" : "num"}>{formatMoney(row.netMinor)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

"use client";

import { useState } from "react";
import { Button, Input, Page, Panel, Stat } from "@/browser/ui/primitives";
import { todayIso, vatPeriodContaining } from "@/browser/books/dates";
import { formatMoney } from "@/browser/books/money";
import { treatmentLabel } from "@/browser/books/types";
import { vatWorksheet } from "@/browser/books/vat";
import { downloadText } from "@/browser/vault/download";
import { useSession } from "@/browser/vault/session";

export function VatPage() {
  const books = useSession((state) => state.books);
  const period = vatPeriodContaining(todayIso());
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  if (!books) return null;
  const sheet = vatWorksheet(books, from, to);
  const confirmed = sheet.lines.filter((line) => line.confirmed && line.box !== "none");

  const csv = [
    "box,date,description,treatment,net_eur,vat_eur,confirmed",
    ...sheet.lines.map((line) =>
      [
        line.box,
        line.date,
        `"${line.description.replaceAll('"', '""')}"`,
        line.treatment,
        (line.netMinor / 100).toFixed(2),
        (line.vatMinor / 100).toFixed(2),
        line.confirmed ? "yes" : "no",
      ].join(","),
    ),
  ].join("\n");

  return (
    <Page
      title="VAT worksheet"
      subtitle="A cash-basis preparation of T1, T2 and T3. It is not a VAT3 and it is not filed. Only lines you confirmed are in the boxes. Standard, reduced and second-reduced amounts are treated as VAT-inclusive. A reverse-charge line treats the bank amount as VAT-exclusive and puts the same VAT in T1 and T2, assuming you can deduct it in full."
      actions={
        <Button variant="secondary" onClick={() => downloadText(`vat-${from}-${to}.csv`, csv, "text/csv")}>
          Download this worksheet
        </Button>
      }
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
        <Button
          variant="ghost"
          onClick={() => {
            setFrom(period.from);
            setTo(period.to);
          }}
        >
          {period.label}
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 bg-surface border border-line rounded mb-4">
        <Stat label="T1 VAT on sales" value={formatMoney(sheet.t1Minor)} hint="Includes reverse-charge VAT" />
        <Stat label="T2 VAT on purchases" value={formatMoney(sheet.t2Minor)} hint="Includes reverse-charge VAT, if deductible" />
        <Stat
          label="T3 payable / (repayable)"
          value={formatMoney(sheet.t3Minor)}
          tone={sheet.t3Minor > 0 ? "negative" : "positive"}
          hint={sheet.t3Minor >= 0 ? "Payable if you filed this" : "Repayable if you filed this"}
        />
      </div>
      {(sheet.unconfirmed > 0 || sheet.unclassified > 0) && (
        <p className="text-caution mb-3">
          Left out of T1–T3: {sheet.unconfirmed} suggestion{sheet.unconfirmed === 1 ? "" : "s"} not yet confirmed
          {sheet.unclassified ? `, ${sheet.unclassified} line${sheet.unclassified === 1 ? "" : "s"} with no treatment` : ""}.
        </p>
      )}
      <Panel title="Lines in the period">
        {sheet.lines.length === 0 ? (
          <p className="px-4 py-6 text-ink-muted">No treated lines in this range.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="ledger">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Treatment</th>
                  <th>Box</th>
                  <th className="text-right">Net</th>
                  <th className="text-right">VAT</th>
                </tr>
              </thead>
              <tbody>
                {sheet.lines.map((line) => (
                  <tr key={line.id} className={line.confirmed && line.box !== "none" ? "" : "text-ink-faint"}>
                    <td className="num !text-left">{line.date}</td>
                    <td>{line.description}</td>
                    <td>{treatmentLabel(line.treatment)}</td>
                    <td>{line.confirmed ? (line.box === "none" ? "Excluded" : line.box) : "Not confirmed"}</td>
                    <td className="num">{formatMoney(line.netMinor)}</td>
                    <td className="num">{formatMoney(line.vatMinor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <p className="text-xs text-ink-faint">
        {confirmed.length} confirmed line{confirmed.length === 1 ? "" : "s"} in the boxes. Second reduced rate is 9%
        (food, catering and hairdressing from 1 July 2026 — check the supply actually qualifies). Accommodation stays
        at 13.5%. This worksheet does not complete E1, E2 or the other ROS boxes.
      </p>
    </Page>
  );
}

"use client";

import { Fragment, useState } from "react";
import { Badge, Button, Empty, Input, Page, Panel } from "@/browser/ui/primitives";
import { formatMoney, parseMoneyToMinor } from "@/browser/books/money";
import { useSession } from "@/browser/vault/session";

export function DocumentsPage() {
  const books = useSession((state) => state.books);
  const saveDocument = useSession((state) => state.saveDocument);
  const busy = useSession((state) => state.busy);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!books) return null;
  const txnById = new Map(books.transactions.map((txn) => [txn.id, txn]));

  return (
    <Page
      title="Documents"
      subtitle="PDFs are read from their text layer in this browser. Photos are recognised here too, when the recogniser can start. The original file is not kept inside the vault — only the extracted fields, a short excerpt, and a hash so the same file is not imported twice. Keep your own copies."
    >
      <Panel title={`${books.documents.length} document${books.documents.length === 1 ? "" : "s"}`}>
        {books.documents.length === 0 ? (
          <Empty title="No invoices yet" detail="Import a PDF or an image from the Import screen. You can correct a bad read before it is matched." />
        ) : (
          <div className="overflow-x-auto">
            <table className="ledger">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Read as</th>
                  <th>Supplier</th>
                  <th>Date</th>
                  <th className="text-right">Gross</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                {books.documents.map((doc) => {
                  const match = doc.matchedTransactionId ? txnById.get(doc.matchedTransactionId) : undefined;
                  const open = openId === doc.id;
                  return (
                    <Fragment key={doc.id}>
                      <tr className="cursor-pointer" onClick={() => setOpenId(open ? null : doc.id)}>
                        <td>{doc.filename}</td>
                        <td>
                          <Badge tone={doc.method === "none" ? "caution" : "neutral"}>{doc.method}</Badge>
                        </td>
                        <td>{doc.supplier ?? "—"}</td>
                        <td className="num !text-left">{doc.date ?? "—"}</td>
                        <td className="num">{doc.grossMinor == null ? "—" : formatMoney(doc.grossMinor)}</td>
                        <td>{match ? match.description : <span className="text-ink-faint">Unmatched</span>}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={6}>
                            <DocEdit
                              supplier={doc.supplier ?? ""}
                              number={doc.number ?? ""}
                              date={doc.date ?? ""}
                              net={doc.netMinor}
                              vat={doc.vatMinor}
                              gross={doc.grossMinor}
                              excerpt={doc.excerpt}
                              note={doc.note}
                              disabled={!!busy}
                              onSave={(patch) => void saveDocument(doc.id, patch)}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </Page>
  );
}

function DocEdit({
  supplier,
  number,
  date,
  net,
  vat,
  gross,
  excerpt,
  note,
  disabled,
  onSave,
}: {
  supplier: string;
  number: string;
  date: string;
  net: number | null;
  vat: number | null;
  gross: number | null;
  excerpt: string;
  note: string | null;
  disabled: boolean;
  onSave: (patch: {
    supplier: string | null;
    number: string | null;
    date: string | null;
    netMinor: number | null;
    vatMinor: number | null;
    grossMinor: number | null;
  }) => void;
}) {
  const [supplierValue, setSupplier] = useState(supplier);
  const [numberValue, setNumber] = useState(number);
  const [dateValue, setDate] = useState(date);
  const [netValue, setNet] = useState(net == null ? "" : (net / 100).toFixed(2));
  const [vatValue, setVat] = useState(vat == null ? "" : (vat / 100).toFixed(2));
  const [grossValue, setGross] = useState(gross == null ? "" : (gross / 100).toFixed(2));
  return (
    <div className="mt-2 space-y-2 no-print" onClick={(event) => event.stopPropagation()}>
      {note && <p className="text-caution">{note}</p>}
      <div className="grid gap-2 md:grid-cols-3">
        <Input value={supplierValue} onChange={(event) => setSupplier(event.target.value)} aria-label="Supplier" placeholder="Supplier" />
        <Input value={numberValue} onChange={(event) => setNumber(event.target.value)} aria-label="Invoice number" placeholder="Number" />
        <Input value={dateValue} onChange={(event) => setDate(event.target.value)} aria-label="Invoice date" placeholder="YYYY-MM-DD" />
        <Input value={netValue} onChange={(event) => setNet(event.target.value)} aria-label="Net" placeholder="Net" inputMode="decimal" />
        <Input value={vatValue} onChange={(event) => setVat(event.target.value)} aria-label="VAT" placeholder="VAT" inputMode="decimal" />
        <Input value={grossValue} onChange={(event) => setGross(event.target.value)} aria-label="Gross" placeholder="Gross" inputMode="decimal" />
      </div>
      <Button
        variant="primary"
        disabled={disabled}
        onClick={() =>
          onSave({
            supplier: supplierValue.trim() || null,
            number: numberValue.trim() || null,
            date: dateValue.trim() || null,
            netMinor: netValue.trim() ? parseMoneyToMinor(netValue) : null,
            vatMinor: vatValue.trim() ? parseMoneyToMinor(vatValue) : null,
            grossMinor: grossValue.trim() ? parseMoneyToMinor(grossValue) : null,
          })
        }
      >
        Save and rematch
      </Button>
      {excerpt && (
        <pre className="text-xs text-ink-muted whitespace-pre-wrap bg-surface-sunken p-2 rounded max-h-40 overflow-auto">
          {excerpt}
        </pre>
      )}
    </div>
  );
}

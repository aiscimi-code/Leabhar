"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Field, Page, Panel, Select } from "@/browser/ui/primitives";
import { downloadText } from "@/browser/vault/download";
import { useSession } from "@/browser/vault/session";

const SAMPLE = `Date,Details,Debit,Credit,Balance
01/09/2026,Brought forward,,,1500.00
02/09/2026,SEPA CREDIT North Quay Ceramics,,1230.00,2730.00
04/09/2026,SEPA PAYMENT Office Supplies Ltd,246.00,,2484.00
05/09/2026,GitHub subscription,45.00,,2439.00
12/09/2026,Revolut Business monthly fee,10.00,,2429.00
15/09/2026,Revenue payment - VAT,500.00,,1929.00
18/09/2026,SEPA CREDIT Murphy Consulting,,615.00,2544.00
`;

export function ImportPage() {
  const books = useSession((state) => state.books);
  const importFiles = useSession((state) => state.importFiles);
  const lastImport = useSession((state) => state.lastImport);
  const busy = useSession((state) => state.busy);
  const [accountId, setAccountId] = useState(books?.accounts[0]?.id ?? "");
  const folderRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);

  if (!books) return null;

  return (
    <Page
      title="Import"
      subtitle="Point at bank statements (CSV or Excel) and at invoices (PDF or image). Files are read in this browser. There is no upload."
    >
      <Panel title="Files">
        <form
          className="px-4 py-4 max-w-lg"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const picked = [...data.getAll("files"), ...data.getAll("folder")].filter(
              (item): item is File => item instanceof File && item.size > 0,
            );
            void importFiles(accountId, picked);
          }}
        >
          <Field label="Bank account for statements" hint="Invoices are not tied to an account until a bank line matches them.">
            <Select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {books.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Files" hint="CSV, XLSX, PDF, PNG, or JPEG. You can pick more than one.">
            <input
              name="files"
              type="file"
              multiple
              accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,text/csv,application/pdf"
              className="block w-full text-sm"
            />
          </Field>
          <Field label="Or a folder" hint="Chrome and Edge can read a folder. Safari and Firefox: use the file picker above.">
            <input
              ref={folderRef}
              name="folder"
              type="file"
              multiple
              className="block w-full text-sm"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" onClick={() => downloadText("sample-statement.csv", SAMPLE, "text/csv")}>
              Download a sample statement
            </Button>
            <Button type="submit" variant="primary" disabled={!!busy || !accountId}>
              {busy ? "Working…" : "Import chosen files"}
            </Button>
          </div>
        </form>
      </Panel>

      {lastImport && (
        <Panel tone="positive" title="Last import">
          <div className="px-4 py-3 space-y-1">
            <p>
              {lastImport.statementFiles} statement file{lastImport.statementFiles === 1 ? "" : "s"},{" "}
              {lastImport.importedRows} new line{lastImport.importedRows === 1 ? "" : "s"}
              {lastImport.duplicates ? `, ${lastImport.duplicates} already on file` : ""}
              {lastImport.skippedRows ? `, ${lastImport.skippedRows} rows skipped` : ""}.
            </p>
            <p>
              {lastImport.documents} document{lastImport.documents === 1 ? "" : "s"} read
              {lastImport.documentDuplicates ? `, ${lastImport.documentDuplicates} duplicate file${lastImport.documentDuplicates === 1 ? "" : "s"} ignored` : ""}.{" "}
              {lastImport.matched} document{lastImport.matched === 1 ? "" : "s"} currently matched to a bank line.{" "}
              {lastImport.rulesApplied} rule suggestion{lastImport.rulesApplied === 1 ? "" : "s"} applied.
            </p>
            {lastImport.notes.map((note) => (
              <p key={note} className="text-ink-muted">
                {note}
              </p>
            ))}
          </div>
        </Panel>
      )}
    </Page>
  );
}

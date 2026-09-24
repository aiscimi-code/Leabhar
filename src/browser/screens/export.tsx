"use client";

import { Button, Page, Panel } from "@/browser/ui/primitives";
import { downloadText, vaultFilename } from "@/browser/vault/download";
import { transactionsCsv, useSession } from "@/browser/vault/session";

export function ExportPage() {
  const books = useSession((state) => state.books);
  const downloadVault = useSession((state) => state.downloadVault);
  const lock = useSession((state) => state.lock);
  const forgetBrowser = useSession((state) => state.forgetBrowser);
  const busy = useSession((state) => state.busy);
  if (!books) return null;

  return (
    <Page
      title="Export and lock"
      subtitle="The encrypted file is the copy you can move. JSON and CSV are readable by an accountant and by you — they are not encrypted, so treat them like the books themselves."
    >
      <Panel tone="warning" title="Before you lock">
        <div className="px-4 py-3 space-y-2">
          <p>
            An encrypted copy named <span className="font-mono text-sm">{vaultFilename(books.company.legalName)}</span>{" "}
            can also sit in this browser. Clearing the browser, or using another machine, needs the downloaded file
            plus the same password. There is no other copy.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button variant="primary" disabled={!!busy} onClick={() => void downloadVault()}>
              Download encrypted vault
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                downloadText(
                  `${vaultFilename(books.company.legalName).replace(/\.leabhar$/, "")}-books.json`,
                  JSON.stringify(books, null, 2),
                  "application/json",
                )
              }
            >
              Download JSON
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                downloadText(
                  `${vaultFilename(books.company.legalName).replace(/\.leabhar$/, "")}-transactions.csv`,
                  transactionsCsv(books),
                  "text/csv",
                )
              }
            >
              Download transactions CSV
            </Button>
          </div>
        </div>
      </Panel>
      <Panel title="Lock this screen">
        <div className="px-4 py-3 space-y-3">
          <p>Locking forgets the key in memory. The encrypted vault stays in this browser until you remove it.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={lock}>
              Lock
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (window.confirm("Remove the encrypted vault from this browser? A downloaded file is not affected. This cannot be undone from here.")) {
                  void forgetBrowser();
                }
              }}
            >
              Remove from this browser
            </Button>
          </div>
        </div>
      </Panel>
    </Page>
  );
}

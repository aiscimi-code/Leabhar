"use client";

import { useState } from "react";
import { Button, Field, Input, Panel } from "@/browser/ui/primitives";
import { todayIso } from "@/browser/books/dates";
import { useSession } from "@/browser/vault/session";

export function Gate() {
  const localName = useSession((state) => state.localName);
  const busy = useSession((state) => state.busy);
  const error = useSession((state) => state.error);
  const createVault = useSession((state) => state.createVault);
  const unlockLocal = useSession((state) => state.unlockLocal);
  const unlockFile = useSession((state) => state.unlockFile);
  const [mode, setMode] = useState<"create" | "unlock" | "auto">("auto");
  const [demo, setDemo] = useState(false);
  const shown = mode === "auto" ? (localName ? "unlock" : "create") : mode;

  return (
    <div className="px-4 py-6 max-w-[760px] mx-auto">
      <header className="mb-4 pb-3 border-b border-line">
        <p className="text-xs uppercase tracking-wider font-semibold text-ink-faint">Leabhar</p>
        <h1 className="text-lg font-semibold text-ink mt-1">Portal</h1>
        <p className="text-ink-muted mt-1">
          Books for an Irish sole trader or small company, opened in the browser. Nothing here is an account
          on a server.
        </p>
      </header>

      <Panel tone="warning" title="What is stored, and what is not">
        <div className="px-4 py-3 space-y-2 text-ink">
          <p>
            The password never leaves this browser. It is turned into a key in memory, used to encrypt one
            file, and then forgotten. There is no forgot-password link, because there is no copy of the
            password and no copy of your books anywhere else.
          </p>
          <p>
            <strong>Lose the password, or lose the file and clear this browser, and the books are gone.</strong>{" "}
            Nobody at Leabhar can reset it. This is one device unless you move the downloaded{" "}
            <span className="font-mono text-sm">.leabhar</span> file yourself — there is no sync.
          </p>
          <p className="text-ink-muted">
            Statements and invoices are read from files you pick. They are not uploaded. Closing the tab locks
            the books; opening them again asks for the password. The file on disk is not readable as SQLite or
            as text without it.
          </p>
        </div>
      </Panel>

      <div className="flex flex-wrap gap-2 mb-4">
        <Button variant={shown === "create" ? "primary" : "secondary"} onClick={() => setMode("create")}>
          Start a new set of books
        </Button>
        <Button variant={shown === "unlock" ? "primary" : "secondary"} onClick={() => setMode("unlock")}>
          Unlock a vault
        </Button>
      </div>

      {error && <p className="text-sm text-negative mb-3">{error}</p>}

      {shown === "create" ? (
        <Panel title={demo ? "Fictional demo company" : "New company"}>
          <form
            className="px-4 py-4 max-w-md"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void createVault({
                legalName: String(data.get("legalName") ?? ""),
                bankName: String(data.get("bankName") ?? ""),
                opening: String(data.get("opening") ?? ""),
                openingDate: String(data.get("openingDate") ?? ""),
                password: String(data.get("password") ?? ""),
                confirm: String(data.get("confirm") ?? ""),
                acknowledged: data.get("ack") === "on",
                demo,
              });
            }}
          >
            <Field label="Company legal name">
              <Input name="legalName" required placeholder="Harbour Lane Studio Ltd" autoComplete="organization" />
            </Field>
            {!demo && (
              <>
                <Field label="First bank account" hint="You can add more after the vault exists.">
                  <Input name="bankName" placeholder="Current account" defaultValue="Current account" />
                </Field>
                <Field label="Opening balance" hint="Optional. Leave blank to start at zero. EUR.">
                  <div className="flex gap-2">
                    <Input name="opening" placeholder="0.00" className="max-w-[140px]" inputMode="decimal" />
                    <Input name="openingDate" type="date" required defaultValue={todayIso()} />
                  </div>
                </Field>
              </>
            )}
            <Field
              label="Password"
              hint="At least 8 characters. A short sentence you can remember is better than a clever word you will not."
            >
              <Input name="password" type="password" required minLength={8} autoComplete="new-password" />
            </Field>
            <Field label="Repeat password">
              <Input name="confirm" type="password" required minLength={8} autoComplete="new-password" />
            </Field>
            <label className="flex items-start gap-2 mb-3 text-ink">
              <input name="ack" type="checkbox" required className="mt-1" />
              <span>I understand that a lost password cannot be recovered, and that support cannot restore these books.</span>
            </label>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="submit" variant="primary" disabled={!!busy}>
                {busy ? "Working…" : demo ? "Create demo vault" : "Create vault"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setDemo((value) => !value)}>
                {demo ? "Use an empty company instead" : "Fill it with fictional demo books"}
              </Button>
            </div>
          </form>
        </Panel>
      ) : (
        <Panel title="Unlock">
          <div className="px-4 py-4 max-w-md space-y-4">
            {localName && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void unlockLocal(String(data.get("password") ?? ""));
                }}
              >
                <Field label="Saved in this browser" hint={localName}>
                  <Input name="password" type="password" required autoComplete="current-password" />
                </Field>
                <Button type="submit" variant="primary" disabled={!!busy}>
                  {busy ? "Working…" : "Unlock this browser"}
                </Button>
              </form>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const file = data.get("vault");
                if (!(file instanceof File) || file.size === 0) return;
                void unlockFile(file, String(data.get("password") ?? ""));
              }}
            >
              <Field label="Vault file" hint="The .leabhar file you downloaded. This replaces whatever is saved in this browser.">
                <Input name="vault" type="file" accept=".leabhar,application/octet-stream" required={!localName} />
              </Field>
              <Field label="Password">
                <Input name="password" type="password" required autoComplete="current-password" />
              </Field>
              <Button type="submit" variant="primary" disabled={!!busy}>
                {busy ? "Working…" : "Unlock file"}
              </Button>
            </form>
          </div>
        </Panel>
      )}
    </div>
  );
}

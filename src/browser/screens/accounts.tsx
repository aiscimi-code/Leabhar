"use client";

import { Button, Field, Input, Page, Panel } from "@/browser/ui/primitives";
import { todayIso } from "@/browser/books/dates";
import { formatMoney } from "@/browser/books/money";
import { accountBalance, useSession } from "@/browser/vault/session";

export function AccountsPage() {
  const books = useSession((state) => state.books);
  const addAccount = useSession((state) => state.addAccount);
  const busy = useSession((state) => state.busy);
  if (!books) return null;

  return (
    <Page title="Bank accounts" subtitle="Each statement imports into one account. A second account is a separate balance, not a second company.">
      <Panel title="On file">
        <table className="ledger">
          <thead>
            <tr>
              <th>Name</th>
              <th>Opened</th>
              <th className="text-right">Opening</th>
              <th className="text-right">Book balance</th>
            </tr>
          </thead>
          <tbody>
            {books.accounts.map((account) => {
              const balance = accountBalance(books, account.id);
              return (
                <tr key={account.id}>
                  <td>{account.name}</td>
                  <td className="num !text-left">{account.openingDate}</td>
                  <td className="num">{formatMoney(account.openingBalanceMinor)}</td>
                  <td className={balance < 0 ? "num num-negative" : "num"}>{formatMoney(balance)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
      <Panel title="Add an account">
        <form
          className="px-4 py-4 max-w-md"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void addAccount({
              name: String(data.get("name") ?? ""),
              opening: String(data.get("opening") ?? ""),
              openingDate: String(data.get("openingDate") ?? ""),
            });
            event.currentTarget.reset();
          }}
        >
          <Field label="Name">
            <Input name="name" required placeholder="Tax reserve" />
          </Field>
          <Field label="Opening balance">
            <div className="flex gap-2">
              <Input name="opening" placeholder="0.00" className="max-w-[140px]" inputMode="decimal" />
              <Input name="openingDate" type="date" required defaultValue={todayIso()} />
            </div>
          </Field>
          <Button type="submit" variant="primary" disabled={!!busy}>
            Add account
          </Button>
        </form>
      </Panel>
    </Page>
  );
}

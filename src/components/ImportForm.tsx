'use client';

import { useState, useTransition, useRef } from 'react';
import { importStatementAction } from '@/app/actions';
import { Button, Help } from './primitives';

export function ImportForm({ accounts }: {
  accounts: Array<{ id: string; name: string; currency: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(formData) => {
        startTransition(async () => {
          const result = await importStatementAction(formData);
          setMessage(result.ok
            ? { ok: true, text: result.message }
            : { ok: false, text: result.error });
          if (result.ok) formRef.current?.reset();
        });
      }}
    >
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label className="block text-[11px] uppercase tracking-wide font-semibold text-ink-faint mb-1">
            Bank account
            <Help>
              Which account this statement belongs to. Transactions are fingerprinted per
              account, so the same line on two different accounts is correctly treated as two
              different transactions.
            </Help>
          </label>
          <select name="bankAccountId" required
            className="border border-line-strong rounded px-2 py-1 text-[12px] min-w-56">
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.currency})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wide font-semibold text-ink-faint mb-1">
            Statement file
          </label>
          <input
            type="file" name="file" accept=".csv,.xlsx" required
            className="text-[12px] file:mr-2 file:px-2.5 file:py-1 file:rounded file:border
              file:border-line-strong file:bg-surface file:text-ink file:text-[12px]
              file:font-medium file:cursor-pointer"
          />
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Importing…' : 'Import'}
        </Button>
      </div>

      {message && (
        <p className={`mt-3 text-[12px] leading-relaxed max-w-3xl ${
          message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
        </p>
      )}
    </form>
  );
}

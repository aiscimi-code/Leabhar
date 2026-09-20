'use client';

import { useState, useTransition } from 'react';
import { Panel, Button, Field, Input, Badge } from '@/components/primitives';
import { createVaultAction, importIntoVaultAction, type PortalResult, type PortalSummary } from './actions';

/**
 * The portal (issue #166): a way to use Leabhar from a browser, hosted
 * publicly, that keeps nothing of yours on the server.
 *
 * Every request here opens its own private database in memory, does its
 * work, and throws that database away the moment it responds — see
 * `db/portal.ts` and `actions.ts`. The only place your data persists is the
 * encrypted file this page hands back to you after every change. Lose that
 * file, or forget your password, and there is no way to recover it: there
 * is nothing on the server to recover it from.
 */

type Mode = 'create' | 'resume';

const filenameFor = (legalName: string): string =>
  `${legalName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'leabhar'}.leabhar`;

export default function PortalPage() {
  const [mode, setMode] = useState<Mode>('create');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<PortalResult | null>(null);
  const [vaultBase64, setVaultBase64] = useState<string | null>(null);

  const run = (action: (formData: FormData) => Promise<PortalResult>, formData: FormData) => {
    startTransition(async () => {
      const outcome = await action(formData);
      setResult(outcome);
      setVaultBase64(outcome.ok ? outcome.vaultBase64 : null);
    });
  };

  const summary: PortalSummary | null = result?.ok ? result.summary : null;

  return (
    <div className="px-6 py-5 max-w-[900px] mx-auto">
      <header className="mb-5 pb-3 border-b border-line">
        <h1 className="text-[19px] font-semibold text-ink leading-tight">Leabhar portal</h1>
        <p className="text-ink-muted mt-1">
          Try Leabhar from a browser, with nothing of yours kept on this server.
        </p>
      </header>

      <Panel tone="warning" title="What this does and does not promise">
        <div className="px-4 py-3 text-[13px] text-ink space-y-2">
          <p>
            Each action below opens a private database in memory on the server, does the
            work you asked for, and discards that database the moment it replies — nothing
            is written to a disk or store here. The <strong>only</strong> copy of your
            data is the encrypted file this page hands back to you afterwards.
          </p>
          <p>
            That means: <strong>save the downloaded file after every change</strong>, and{' '}
            <strong>do not forget your password</strong>. There is no account recovery,
            because there is no account on the server to recover — only your file and your
            password decrypt it. Your password does travel to the server for the length of
            one request (it has to, to do the work), but it is never stored.
          </p>
          <p className="text-ink-muted">
            This is a first slice: it creates a company and one bank account, and imports a
            bank statement CSV. Invoices (PDF/image), classification, VAT and everything
            else the CLI and the installed app already do are not wired in here yet.
          </p>
        </div>
      </Panel>

      <div className="flex gap-2 mb-4">
        <Button variant={mode === 'create' ? 'primary' : 'secondary'} onClick={() => setMode('create')}>
          Start a new set of books
        </Button>
        <Button variant={mode === 'resume' ? 'primary' : 'secondary'} onClick={() => setMode('resume')}>
          Resume from a downloaded vault
        </Button>
      </div>

      {mode === 'create' ? (
        <Panel title="New company">
          <form
            className="px-4 py-4 space-y-1 max-w-md"
            action={(formData) => run(createVaultAction, formData)}
          >
            <Field label="Company name">
              <Input name="legalName" required placeholder="e.g. Wild Atlantic Woodcraft Ltd" />
            </Field>
            <Field label="Bank account name" hint="You can add more accounts later via the CLI.">
              <Input name="bankName" placeholder="Current Account" />
            </Field>
            <Field label="Base currency">
              <Input name="baseCurrency" defaultValue="EUR" maxLength={3} className="uppercase" />
            </Field>
            <Field label="Opening balance (optional)" hint="Leave blank to start at zero.">
              <div className="flex gap-2">
                <Input name="opening" placeholder="0.00" className="max-w-[140px]" />
                <Input name="openingDate" type="date" />
              </div>
            </Field>
            <Field label="Password" hint="At least 8 characters. This is the only thing protecting this vault — choose one you will remember.">
              <Input name="password" type="password" required minLength={8} autoComplete="new-password" />
            </Field>
            {result && !result.ok && <p className="text-[12px] text-negative">{result.error}</p>}
            <div className="pt-2">
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? 'Working…' : 'Create vault'}
              </Button>
            </div>
          </form>
        </Panel>
      ) : (
        <Panel title="Resume">
          <form
            className="px-4 py-4 space-y-1 max-w-md"
            action={(formData) => run(importIntoVaultAction, formData)}
          >
            <Field label="Vault file" hint="The .leabhar file this page gave you last time.">
              <Input name="vault" type="file" accept=".leabhar" required />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" required autoComplete="current-password" />
            </Field>
            <Field label="Bank statement to import (optional)" hint="A CSV export from your bank.">
              <Input name="statement" type="file" accept=".csv" />
            </Field>
            {result && !result.ok && <p className="text-[12px] text-negative">{result.error}</p>}
            <div className="pt-2">
              <Button type="submit" variant="primary" disabled={pending}>
                {pending ? 'Working…' : 'Unlock'}
              </Button>
            </div>
          </form>
        </Panel>
      )}

      {summary && vaultBase64 && (
        <Panel tone="positive" title={summary.legalName}>
          <div className="px-4 py-3 text-[13px] space-y-3">
            {summary.importMessage && <p>{summary.importMessage}</p>}
            <p className="text-ink-muted">
              Bank account: {summary.bankAccountName} · {summary.transactionCount} transaction
              {summary.transactionCount === 1 ? '' : 's'} on file.
            </p>

            <a
              href={`data:application/octet-stream;base64,${vaultBase64}`}
              download={filenameFor(summary.legalName)}
              className="inline-block px-3 py-1.5 rounded border text-[12px] font-medium
                bg-accent text-white border-accent hover:bg-accent/90"
            >
              Download my encrypted vault
            </a>
            <p className="text-[11.5px] text-ink-muted">
              Keep this file — it is the only copy of what you just did. Use "Resume from a
              downloaded vault" above next time, with the same password.
            </p>

            {summary.recentTransactions.length > 0 && (
              <table className="w-full text-[12px] mt-2">
                <thead>
                  <tr className="text-left text-ink-faint uppercase text-[10.5px]">
                    <th className="pb-1 pr-2">Date</th>
                    <th className="pb-1 pr-2">Description</th>
                    <th className="pb-1 pr-2 text-right">Amount</th>
                    <th className="pb-1">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.recentTransactions.map((t, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1 pr-2 num">{t.date}</td>
                      <td className="py-1 pr-2">{t.description}</td>
                      <td className="py-1 pr-2 text-right num">
                        {(t.amountMinor / 100).toFixed(2)} {t.currency}
                      </td>
                      <td className="py-1"><Badge>{t.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

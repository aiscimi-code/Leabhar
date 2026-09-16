'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Page, Panel } from '@/components/primitives';
import type { ActionResult } from '@/app/settings-actions';

/**
 * Login or first-run setup page.
 *
 * When no user exists yet, this is the setup screen: create the one local
 * user. After that, it is the login screen.
 */
export function LoginForm({ mode, action }: {
  mode: 'login' | 'setup';
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const router = useRouter();

  const isSetup = mode === 'setup';

  return (
    <Page
      title={isSetup ? 'Set up Leabhar' : 'Log in'}
      subtitle={isSetup
        ? 'Create your local user. This is the only account — Leabhar is single-user, local-first.'
        : 'Log in to access your accounting data.'}
    >
      <Panel title={isSetup ? 'Create the first user' : 'Log in'}>
        <form
          className="px-4 py-4 space-y-4 max-w-md"
          action={(formData) => {
            startTransition(async () => {
              const outcome = await action(formData);
              setResult(outcome);
              if (outcome.ok) {
                router.push('/');
                router.refresh();
              }
            });
          }}
        >
          {isSetup && (
            <div>
              <label className="block text-[13px] font-medium text-ink mb-1">
                Display name
              </label>
              <input
                type="text"
                name="displayName"
                placeholder="Your name"
                className="w-full px-3 py-2 text-[14px] border border-ink-faint rounded bg-surface"
                required
              />
            </div>
          )}

          <div>
            <label className="block text-[13px] font-medium text-ink mb-1">
              Username
            </label>
            <input
              type="text"
              name="username"
              autoComplete="username"
              className="w-full px-3 py-2 text-[14px] border border-ink-faint rounded bg-surface"
              required
              minLength={2}
            />
          </div>

          <div>
            <label className="block text-[13px] font-medium text-ink mb-1">
              Password
            </label>
            <input
              type="password"
              name="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              className="w-full px-3 py-2 text-[14px] border border-ink-faint rounded bg-surface"
              required
              minLength={8}
            />
            {isSetup && (
              <p className="text-[11px] text-ink-muted mt-1">
                At least 8 characters. This is stored locally only — it never leaves your machine.
              </p>
            )}
          </div>

          {result && !result.ok && (
            <p className="text-[12px] text-negative">{result.error}</p>
          )}

          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Working…' : isSetup ? 'Create user and log in' : 'Log in'}
          </Button>
        </form>
      </Panel>
    </Page>
  );
}

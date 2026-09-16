'use client';

import { useRef, useState, useTransition, type ReactNode } from 'react';
import { Button } from './primitives';
import type { ActionResult } from '@/app/settings-actions';

/**
 * A form that calls a server action and reports what happened.
 *
 * Every configuration change in this application can come back with warnings
 * rather than a plain success — changing the VAT basis does not restate
 * anything, deactivating a rate leaves historical entries pointing at it. Those
 * warnings are the point, so this shows them beside the success message instead
 * of discarding them.
 */
export function ActionForm({
  action, submit, children, variant = 'primary', resetOnSuccess = false,
  confirm, inline = false, extra,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  submit: string;
  children?: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  resetOnSuccess?: boolean;
  /** Text shown before the action runs, for anything not easily undone. */
  confirm?: string;
  /** Lay the submit button out beside the fields rather than below them. */
  inline?: boolean;
  /** Hidden values the form always sends. */
  extra?: Record<string, string>;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      className={inline ? 'flex items-end gap-2 flex-wrap' : undefined}
      action={(formData) => {
        if (confirm && !window.confirm(confirm)) return;
        startTransition(async () => {
          const outcome = await action(formData);
          setResult(outcome);
          if (outcome.ok && resetOnSuccess) formRef.current?.reset();
        });
      }}
    >
      {extra && Object.entries(extra).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {children}

      <div className={inline ? '' : 'mt-1'}>
        <Button type="submit" variant={variant} disabled={pending}>
          {pending ? 'Working…' : submit}
        </Button>
      </div>

      {result && <ActionMessage result={result} />}
    </form>
  );
}

export function ActionMessage({ result }: { result: ActionResult }) {
  if (!result.ok) {
    return (
      <p className="mt-2 text-[12px] leading-snug text-negative max-w-3xl">{result.error}</p>
    );
  }
  return (
    <div className="mt-2 max-w-3xl">
      <p className="text-[12px] leading-snug text-positive">{result.message}</p>
      {result.warnings && result.warnings.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {result.warnings.map((warning) => (
            <li key={warning} className="text-[12px] leading-snug text-caution flex gap-1.5">
              <span aria-hidden="true">!</span>
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

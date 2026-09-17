'use client';

import { useState, useTransition } from 'react';
import { Button } from './primitives';
import type { ActionResult } from '@/app/actions';

/**
 * A picker plus action button, reused on the transaction and document pages for
 * manual linking. The server supplies the list of options; the user's selection
 * is sent to the named server action. Keeping this a client component lets the
 * server components on both pages stay simple.
 */
export function LinkControls({
  action, options, extra, selectName, label, submit, emptyHint,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  options: Array<{ value: string; label: string }>;
  /** Hidden values the form always sends (e.g. the page's own id). */
  extra: Record<string, string>;
  /** The form field name the picked option is sent under. */
  selectName: string;
  label: string;
  submit: string;
  emptyHint?: string;
}) {
  const [selected, setSelected] = useState('');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  if (options.length === 0) {
    return emptyHint
      ? <p className="text-[12px] text-ink-faint">{emptyHint}</p>
      : null;
  }

  return (
    <form
      action={(formData) => {
        if (!selected) return;
        startTransition(async () => {
          const outcome = await action(formData);
          setResult(outcome);
          if (outcome.ok) setSelected('');
        });
      }}
    >
      {Object.entries(extra).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          name={selectName} value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="border border-line-strong rounded px-2 py-1 text-[12px] flex-1 min-w-[12rem]"
        >
          <option value="">{label}…</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <Button type="submit" variant="secondary" disabled={pending || !selected}>
          {pending ? 'Working…' : submit}
        </Button>
      </div>
      {result && (
        <p className={`mt-1.5 text-[12px] ${result.ok ? 'text-positive' : 'text-negative'}`}>
          {result.ok ? result.message : result.error}
        </p>
      )}
    </form>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { resolveReviewItemAction, acceptMatchAction } from '@/app/actions';
import { Button } from './primitives';

/**
 * Inline actions on a review item (README §20).
 *
 * Resolving something from the queue without navigating away is the difference
 * between a queue that gets worked and one that gets ignored.
 */
export function ReviewActions({ reviewItemId, suggestedActions }: {
  reviewItemId: string;
  suggestedActions: Array<{ label: string; action: string; payload?: Record<string, unknown> }>;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState(false);

  const run = (fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) => {
    startTransition(async () => {
      const result = await fn();
      setMessage(result.ok ? { ok: true, text: result.message } : { ok: false, text: result.error });
      if (result.ok) setDone(true);
    });
  };

  if (done) {
    return <span className="text-[12px] text-positive shrink-0">{message?.text ?? 'Done.'}</span>;
  }

  return (
    <div className="shrink-0 flex flex-col items-end gap-1.5">
      <div className="flex gap-1.5">
        {suggestedActions.slice(0, 2).map((action, index) => (
          <Button
            key={index}
            disabled={pending}
            onClick={() => {
              if (action.action !== 'accept_match') return;
              const payload = action.payload ?? {};
              const formData = new FormData();
              formData.set('documentId', String(payload['documentId']));
              formData.set('bankTransactionId', String(payload['bankTransactionId']));
              run(() => acceptMatchAction(formData));
            }}
          >
            {action.label}
          </Button>
        ))}
        <Button
          disabled={pending}
          onClick={() => {
            const formData = new FormData();
            formData.set('reviewItemId', reviewItemId);
            formData.set('action', 'resolve');
            run(() => resolveReviewItemAction(formData));
          }}
        >
          Mark resolved
        </Button>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() => {
            const formData = new FormData();
            formData.set('reviewItemId', reviewItemId);
            formData.set('action', 'dismiss');
            run(() => resolveReviewItemAction(formData));
          }}
        >
          Dismiss
        </Button>
      </div>
      {message && !message.ok && (
        <span className="text-[11.5px] text-negative max-w-xs text-right">{message.text}</span>
      )}
    </div>
  );
}

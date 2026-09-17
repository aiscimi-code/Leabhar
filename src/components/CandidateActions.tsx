'use client';

import { useTransition } from 'react';
import { Button } from './primitives';
import type { ActionResult } from '@/app/actions';

/**
 * Accept and Reject buttons for a single match candidate. Two actions rather
 * than one, because a rejection is a decision in its own right — it records
 * that the user considered this candidate and ruled it out, which is different
 * from leaving it pending.
 */
export function CandidateActions({
  accept, reject, documentId, bankTransactionId,
}: {
  accept: (formData: FormData) => Promise<ActionResult>;
  reject: (formData: FormData) => Promise<ActionResult>;
  documentId: string;
  bankTransactionId: string;
}) {
  const [pending, startTransition] = useTransition();

  const run = (action: (formData: FormData) => Promise<ActionResult>) =>
    (formData: FormData) => {
      startTransition(async () => { await action(formData); });
    };

  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      <form action={run(accept)}>
        <input type="hidden" name="documentId" value={documentId} />
        <input type="hidden" name="bankTransactionId" value={bankTransactionId} />
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? '…' : 'Accept'}
        </Button>
      </form>
      <form action={run(reject)}>
        <input type="hidden" name="documentId" value={documentId} />
        <input type="hidden" name="bankTransactionId" value={bankTransactionId} />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? '…' : 'Reject'}
        </Button>
      </form>
    </div>
  );
}

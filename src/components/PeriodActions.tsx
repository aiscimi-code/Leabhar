'use client';

import { useState, useTransition } from 'react';
import { transitionVatPeriodAction } from '@/app/actions';
import { Button, Badge } from './primitives';
import { label } from '@/lib/format';

const NEXT: Record<string, Array<{ to: string; text: string; needsReason?: boolean; needsRef?: boolean }>> = {
  open: [{ to: 'review', text: 'Start review' }],
  review: [
    { to: 'ready', text: 'Run checks and mark ready' },
    { to: 'open', text: 'Reopen' },
  ],
  ready: [
    { to: 'locked', text: 'Lock period', needsReason: true },
    { to: 'review', text: 'Back to review' },
  ],
  locked: [
    { to: 'submitted', text: 'Record as submitted', needsRef: true },
    { to: 'ready', text: 'Unlock', needsReason: true },
  ],
  submitted: [],
};

/** VAT period lifecycle (README §24). Marking ready runs the validation first. */
export function PeriodActions({ vatPeriodId, status, ready }: {
  vatPeriodId: string; status: string; ready: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');

  const options = NEXT[status] ?? [];

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide font-semibold text-ink-faint">
          Current
        </span>
        <Badge tone={status === 'submitted' ? 'positive' : 'neutral'}>{label(status)}</Badge>
      </div>

      {options.length === 0 ? (
        <p className="text-ink-muted">
          This period has been recorded as submitted. Its figures are snapshotted, and any
          later change will show as a difference rather than silently altering what was filed.
        </p>
      ) : (
        <>
          {options.some((o) => o.needsReason) && (
            <input
              type="text" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (recorded in the audit trail)"
              className="w-full border border-line-strong rounded px-2 py-1 text-[12px] mb-2"
            />
          )}
          {options.some((o) => o.needsRef) && (
            <input
              type="text" value={reference} onChange={(e) => setReference(e.target.value)}
              placeholder="ROS submission reference"
              className="w-full border border-line-strong rounded px-2 py-1 text-[12px] mb-2"
            />
          )}
          <div className="flex flex-wrap gap-1.5">
            {options.map((option) => (
              <Button
                key={option.to}
                variant={option.to === 'ready' || option.to === 'submitted' ? 'primary' : 'secondary'}
                disabled={pending || (option.to === 'ready' && !ready)}
                title={option.to === 'ready' && !ready
                  ? 'Blocking issues must be resolved first.' : undefined}
                onClick={() => {
                  const formData = new FormData();
                  formData.set('vatPeriodId', vatPeriodId);
                  formData.set('to', option.to);
                  if (reason) formData.set('reason', reason);
                  if (reference) formData.set('submissionReference', reference);
                  startTransition(async () => {
                    const result = await transitionVatPeriodAction(formData);
                    setMessage(result.ok
                      ? { ok: true, text: result.message }
                      : { ok: false, text: result.error });
                  });
                }}
              >
                {option.text}
              </Button>
            ))}
          </div>
        </>
      )}

      {message && (
        <p className={`mt-2 text-[12px] leading-snug ${message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
        </p>
      )}

      <p className="mt-3 text-[11.5px] text-ink-muted leading-snug border-t border-line pt-2">
        Marking a period ready means this application&rsquo;s own checks passed. It is not a
        statement that the return is correct, and this application does not file anything.
      </p>
    </div>
  );
}

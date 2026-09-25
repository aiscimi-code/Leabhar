'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from './primitives';
import { reversePaymentAction, type ActionResult } from '@/app/actions';

/**
 * Reverse a settlement (issue #220). Collapsed by default: this undoes a
 * posted payment, so it asks for a reason and, where the original period is
 * closed or its VAT return filed, a later date to reverse at.
 */
export function ReversePaymentForm({ paymentId, bankTransactionId, paymentDate }: {
  paymentId: string; bankTransactionId: string; paymentDate: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <div className="px-4 py-2.5 border-t border-line">
        <Button variant="ghost" onClick={() => setOpen(true)}>Reverse this settlement…</Button>
      </div>
    );
  }
  return (
    <div className="px-4 py-3 border-t border-line space-y-2 text-[12px]">
      <p className="text-ink-muted">
        The payment&apos;s journal is reversed by a new entry, the invoices it settled are open again, and any
        output VAT it released is reversed. Nothing is deleted. The bank line can then be settled again.
      </p>
      <Input placeholder="Why? For example: settled against the wrong invoice" value={reason}
        onChange={(e) => setReason(e.target.value)} />
      <div className="flex items-center gap-2">
        <span className="text-ink-faint">Reverse at</span>
        <Input type="date" className="!w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        <span className="text-ink-faint">Leave empty to reverse at the payment date ({paymentDate}). Choose a later
          date if that period is closed or its VAT return is filed.</span>
      </div>
      <div className="flex gap-2">
        <Button variant="danger" disabled={pending || reason.trim().length < 3} onClick={() => startTransition(async () => {
          const r = await reversePaymentAction({ paymentId, bankTransactionId, reason, reversalDate: date || undefined });
          setResult(r);
          if (r.ok) router.refresh();
        })}>{pending ? 'Reversing…' : 'Reverse the settlement'}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {result && <p className={result.ok ? 'text-positive' : 'text-negative'}>{result.ok ? result.message : result.error}</p>}
    </div>
  );
}

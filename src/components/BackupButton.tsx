'use client';

import { useState, useTransition } from 'react';
import { createBackupAction } from '@/app/actions';
import { Button } from './primitives';

export function BackupButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div className="flex items-center gap-2">
      {message && (
        <span className={`text-[12px] ${message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
        </span>
      )}
      <Button
        variant="primary"
        disabled={pending}
        onClick={() => startTransition(async () => {
          const result = await createBackupAction();
          setMessage(result.ok
            ? { ok: true, text: result.message }
            : { ok: false, text: result.error });
        })}
      >
        {pending ? 'Backing up…' : 'Create backup'}
      </Button>
    </div>
  );
}

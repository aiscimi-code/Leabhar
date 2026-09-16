'use client';

import { useState, useTransition } from 'react';
import { loadDemoDataAction } from '@/app/actions';
import { Button } from './primitives';

export function DemoLoader() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  return (
    <div>
      <Button
        variant="primary"
        disabled={pending}
        onClick={() => startTransition(async () => {
          const result = await loadDemoDataAction();
          setMessage(result.ok
            ? { ok: true, text: result.message }
            : { ok: false, text: result.error });
        })}
      >
        {pending ? 'Creating demo company…' : 'Load demo data'}
      </Button>
      {message && (
        <p className={`mt-2 text-[12px] leading-snug ${message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
          {message.ok && ' Reload the page to see it.'}
        </p>
      )}
    </div>
  );
}

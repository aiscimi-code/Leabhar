'use client';

import { useState, useTransition } from 'react';
import { restoreBackupAction } from '@/app/actions';
import { Button, Badge } from './primitives';
import type { ActionResult } from '@/app/actions';

/**
 * Per-backup restore control.
 *
 * Restoring overwrites the live database, so this is gated behind an explicit
 * confirmation prompt. The verification status is shown beside the button so
 * an unusable backup is visibly unusable rather than silently offered.
 */
export function RestoreButton({ path, version, usable }: {
  path: string;
  version: number;
  usable: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant={usable ? 'secondary' : 'danger'}
        disabled={pending}
        onClick={() => {
          if (!window.confirm(
            `Restore backup v${version}?\n\n`
            + 'This replaces your current database and documents. '
            + 'Your existing data is moved to a pre-restore copy first, but this is a serious action.\n\n'
            + 'Click OK to restore, or Cancel to keep your current data.',
          )) return;
          startTransition(async () => {
            const formData = new FormData();
            formData.set('path', path);
            formData.set('force', usable ? 'false' : 'true');
            const outcome = await restoreBackupAction(formData);
            setResult(outcome);
          });
        }}
      >
        {pending ? 'Restoring…' : 'Restore'}
      </Button>
      {result && (
        <div className="max-w-xs">
          {result.ok ? (
            <p className="text-[12px] leading-snug text-positive">{result.message}</p>
          ) : (
            <p className="text-[12px] leading-snug text-negative">{result.error}</p>
          )}
          {result.ok && (result as { warnings?: string[] }).warnings?.map((w) => (
            <p key={w} className="text-[12px] leading-snug text-caution mt-1">{w}</p>
          ))}
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { scanAnomaliesAction, type ActionResult } from '@/app/settings-actions';
import { Button } from './primitives';

/**
 * Runs the anomaly scan (README §35) on demand.
 *
 * It is a button rather than something that runs on every page load, because
 * the scan only ever asks questions — an unusually large payment, a supplier
 * who normally bills monthly going quiet — and questions asked unprompted on
 * every visit become noise that gets ignored.
 */
export function AnomalyScan() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  return (
    <div className="flex items-center gap-3">
      <Button
        disabled={pending}
        onClick={() => startTransition(async () => setResult(await scanAnomaliesAction()))}
      >
        {pending ? 'Scanning…' : 'Scan for anomalies'}
      </Button>
      {result && (
        <span className={`text-[12px] leading-snug ${result.ok ? 'text-ink-muted' : 'text-negative'}`}>
          {result.ok ? result.message : result.error}
        </span>
      )}
    </div>
  );
}

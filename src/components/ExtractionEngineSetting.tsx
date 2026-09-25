'use client';

import { useState, useTransition } from 'react';
import { setExtractionEngineAction, type ActionResult } from '@/app/actions';

/**
 * How uploaded documents are read (issue #202). The person's choice: reading
 * on this computer needs nothing else and sends nothing anywhere; the AI reader
 * sends the file to Anthropic. Either way every document is checked and
 * confirmed by a person before it is used.
 */
export function ExtractionEngineSetting({ engine, aiAvailable }: {
  engine: 'local' | 'anthropic'; aiAvailable: boolean;
}) {
  const [value, setValue] = useState(engine);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const choose = (next: 'local' | 'anthropic') => {
    setValue(next);
    startTransition(async () => setResult(await setExtractionEngineAction(next)));
  };
  return (
    <div className="px-4 py-3 space-y-2 text-[12px]">
      <label className="flex gap-2 items-start">
        <input type="radio" name="engine" checked={value === 'local'} disabled={pending} onChange={() => choose('local')} />
        <span><strong>On this computer</strong> (default). Text is read from the PDF, or recognised from a
          scanned page or photo on the review screen. Nothing leaves this machine.</span>
      </label>
      <label className="flex gap-2 items-start">
        <input type="radio" name="engine" checked={value === 'anthropic'} disabled={pending || !aiAvailable}
          onChange={() => choose('anthropic')} />
        <span><strong>AI reader (Anthropic)</strong>. The file is sent to Anthropic to be read.
          {aiAvailable ? '' : ' Unavailable: no ANTHROPIC_API_KEY is configured.'}</span>
      </label>
      {result && <p className={result.ok ? 'text-positive' : 'text-negative'}>{result.ok ? result.message : result.error}</p>}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { loadDemoDataAction } from '@/app/actions';
import { Button } from './primitives';
import type { DemoEntityType } from '@/db/seed/demo';

const VARIANTS: Array<{ entityType: DemoEntityType; label: string; blurb: string }> = [
  {
    entityType: 'company',
    label: 'Limited company',
    blurb: 'An Irish LTD with corporation tax worksheets and CT decisions.',
  },
  {
    entityType: 'sole_trader',
    label: 'Sole trader',
    blurb: 'Income tax (Form 11) for a sole trader — no partners panel.',
  },
  {
    entityType: 'partnership',
    label: 'Partnership',
    blurb: 'Two partners, profit shares, and income tax — Partners panel on Company settings.',
  },
];

export function DemoLoader() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<DemoEntityType | null>(null);

  const load = (entityType: DemoEntityType) => {
    setBusy(entityType);
    startTransition(async () => {
      const formData = new FormData();
      formData.set('entityType', entityType);
      const result = await loadDemoDataAction(formData);
      setMessage(result.ok
        ? { ok: true, text: result.message }
        : { ok: false, text: result.error });
      setBusy(null);
    });
  };

  return (
    <div>
      <p className="text-ink-muted mb-3 leading-relaxed text-[12px]">
        Each variant is fictional demo data, labelled as such. Loading one archives any
        earlier demo so only one book is active (issue #283).
      </p>
      <div className="flex flex-col gap-2">
        {VARIANTS.map((variant) => (
          <div key={variant.entityType} className="flex items-start gap-3">
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => load(variant.entityType)}
              data-testid={`load-demo-${variant.entityType}`}
            >
              {busy === variant.entityType ? 'Creating…' : `Load ${variant.label}`}
            </Button>
            <p className="text-[12px] text-ink-muted leading-snug pt-1.5">{variant.blurb}</p>
          </div>
        ))}
      </div>
      {message && (
        <p
          data-testid={message.ok ? 'demo-load-ok' : 'demo-load-error'}
          className={`mt-2 text-[12px] leading-snug ${message.ok ? 'text-positive' : 'text-negative'}`}
        >
          {message.text}
          {message.ok && ' Reload the page to see it.'}
        </p>
      )}
    </div>
  );
}

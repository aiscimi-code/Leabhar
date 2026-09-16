'use client';

import { useState, useTransition, useRef } from 'react';
import { uploadDocumentAction, rematchAllAction } from '@/app/actions';
import { Button } from './primitives';

export function UploadForm() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(formData) => {
        startTransition(async () => {
          const result = await uploadDocumentAction(formData);
          setMessage(result.ok
            ? { ok: true, text: result.message }
            : { ok: false, text: result.error });
          if (result.ok) formRef.current?.reset();
        });
      }}
      className="flex items-center gap-3 flex-wrap"
    >
      <input
        type="file" name="files" multiple
        accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.tif,.tiff,.heic,.txt,.csv,.xlsx"
        className="text-[12px] file:mr-2 file:px-2.5 file:py-1 file:rounded file:border
          file:border-line-strong file:bg-surface file:text-ink file:text-[12px]
          file:font-medium file:cursor-pointer"
      />
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Reading…' : 'Upload and read'}
      </Button>
      {message && (
        <span className={`text-[12px] ${message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
        </span>
      )}
    </form>
  );
}

export function RematchButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {message && <span className="text-[12px] text-ink-muted">{message}</span>}
      <Button
        disabled={pending}
        onClick={() => startTransition(async () => {
          const result = await rematchAllAction();
          setMessage(result.ok ? result.message : result.error);
        })}
      >
        {pending ? 'Matching…' : 'Re-run matching'}
      </Button>
    </div>
  );
}

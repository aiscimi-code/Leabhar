'use client';

import { useState, useTransition, useRef } from 'react';
import { uploadDocumentAction, rematchAllAction, scanWatchFolderAction } from '@/app/actions';
import { Button } from './primitives';

export function UploadForm() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(formData) => {
        const files = formData.getAll('files').filter((f): f is File => f instanceof File);
        if (files.length === 0) {
          setMessage({ ok: false, text: 'Choose at least one file.' });
          setWarnings([]);
          return;
        }
        // One file per request: a batch sent as a single Server Action body
        // hits the body size limit and fails the whole upload.
        startTransition(async () => {
          let stored = 0;
          const failures: string[] = [];
          const collectedWarnings: string[] = [];
          for (const [index, file] of files.entries()) {
            setProgress(`Reading ${index + 1} of ${files.length}…`);
            const single = new FormData();
            single.append('files', file);
            const result = await uploadDocumentAction(single);
            if (result.ok) {
              stored += 1;
              if (result.warnings) collectedWarnings.push(...result.warnings);
            } else {
              failures.push(`${file.name}: ${result.error}`);
            }
          }
          setProgress(null);
          formRef.current?.reset();
          setWarnings(collectedWarnings);
          if (failures.length > 0) {
            setMessage({
              ok: stored === 0,
              text: `${stored} of ${files.length} stored.`
                + ` Failed: ${failures.join('; ')}`,
            });
          } else {
            setMessage({
              ok: true,
              text: `${stored} document${stored === 1 ? '' : 's'} stored and read.`,
            });
          }
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
        {pending ? (progress ?? 'Reading…') : 'Upload and read'}
      </Button>
      {message && (
        <span className={`text-[12px] ${message.ok ? 'text-positive' : 'text-negative'}`}>
          {message.text}
        </span>
      )}
      {warnings.length > 0 && (
        <ul className="w-full space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="text-[12px] leading-snug text-caution flex gap-1.5">
              <span aria-hidden="true">!</span>
              <span>{warning}</span>
            </li>
          ))}
        </ul>
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

export function WatchFolderButton({ hasWatchPath }: { hasWatchPath: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Button
        disabled={pending || !hasWatchPath}
        onClick={() => startTransition(async () => {
          setWarnings([]);
          const result = await scanWatchFolderAction();
          setMessage(result.ok ? result.message : result.error);
          setWarnings(result.ok && result.warnings ? result.warnings : []);
        })}
      >
        {pending ? 'Scanning…' : 'Refresh from folder'}
      </Button>
      {message && (
        <span className="text-[12px] text-ink-muted">{message}</span>
      )}
      {warnings.length > 0 && (
        <ul className="w-full space-y-1">
          {warnings.map((warning) => (
            <li key={warning} className="text-[12px] leading-snug text-caution flex gap-1.5">
              <span aria-hidden="true">!</span>
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}
      {!hasWatchPath && (
        <span className="text-[12px] text-ink-faint">
          Set a document watch folder in Settings → Company to enable this.
        </span>
      )}
    </div>
  );
}

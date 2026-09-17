import {
  readdirSync, readFileSync, statSync, existsSync, mkdirSync, renameSync,
} from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { AppDatabase } from '@/db';
import { storeDocument, storageRoot } from './storage';
import { extractDocument } from '../extraction/service';
import { findMatchesForDocument } from '../matching/service';
import { LocalExtractionProvider } from '../extraction/localProvider';

/**
 * On-demand watch-folder ingest (README §11, §14).
 *
 * The user points Leabhar at a folder and clicks "Refresh from folder". This
 * scans that folder for new invoice/receipt documents, stores each one through
 * the same pipeline as a manual upload, reads it with the LOCAL provider only
 * (no unattended paid API calls), and moves the original into a `processed/`
 * subfolder so a second click does not re-ingest it.
 *
 * It is on-demand, not a polling loop: nothing here runs unless the user asks.
 * Dedup is automatic — `storeDocument` is content-addressed by SHA-256, so a
 * file that is somehow still in the folder after a successful ingest is
 * flagged as a duplicate rather than stored twice.
 */

/**
 * Accepted extensions, kept in sync with the upload form's `accept` list
 * (`DocumentActions.tsx`). A real Downloads/Scans folder contains junk the
 * user does not want ingested; filtering here keeps the review queue clean.
 */
export const ACCEPTED_EXTENSIONS = [
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.tif', '.tiff', '.heic', '.txt', '.csv', '.xlsx',
];

/** Originals are moved here after a successful store, inside the watch path. */
export const PROCESSED_SUBFOLDER = 'processed';

/** A scan never reads more than this many files in one pass (challenge #8). */
export const DEFAULT_MAX_FILES = 50;

/** How long to wait between the two stability samples (challenge #1). */
export const DEFAULT_STABILITY_MS = 1500;

/**
 * Injectable filesystem so the scan logic is deterministic and testable. The
 * real implementation is a thin wrapper around node:fs; tests pass a fake and
 * an injectable clock so the stability check never waits on real time.
 */
export interface WatchFileSystem {
  readdir(path: string): string[];
  readFile(path: string): Buffer;
  stat(path: string): { size: number; mtimeMs: number };
  exists(path: string): boolean;
  mkdir(path: string, opts: { recursive: boolean }): void;
  rename(from: string, to: string): void;
}

export const realFileSystem: WatchFileSystem = {
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p),
  stat: (p) => statSync(p),
  exists: (p) => existsSync(p),
  mkdir: (p, opts) => mkdirSync(p, opts),
  rename: (from, to) => renameSync(from, to),
};

export interface ScanWatchFolderInput {
  companyId: string;
  watchPath: string;
  /** Document storage root. Defaults to the configured storage path. */
  storageRootPath?: string;
  /** Cap on files read per pass. Defaults to {@link DEFAULT_MAX_FILES}. */
  maxFiles?: number;
  /** Stability sample interval in ms. Defaults to {@link DEFAULT_STABILITY_MS}. */
  stabilityMs?: number;
  /** Injectable for tests. Defaults to the real node:fs. */
  fs?: WatchFileSystem;
  /**
   * Injectable delay between the two stability samples. Defaults to a real
   * setTimeout; tests pass a no-op so no wall-clock time is spent.
   */
  delay?: (ms: number) => Promise<void>;
}

export interface ScanWatchFolderOutcome {
  /** Files stored and read for the first time this pass. */
  ingested: number;
  /** Files whose content was already on file (flagged as duplicates). */
  duplicates: number;
  /** Files skipped because they were still being written. */
  inProgress: number;
  /** Files that could not be moved to processed/ (kept where they are). */
  moveFailed: number;
  /** Documents that landed in the review queue (low confidence or failures). */
  toReview: number;
  /** Per-file notes for the ingest summary shown to the user. */
  notes: string[];
  /** Names of files that were processed this pass, for the summary. */
  processedFiles: string[];
}

export async function scanWatchFolder(
  db: AppDatabase,
  input: ScanWatchFolderInput,
): Promise<ScanWatchFolderOutcome> {
  const fs = input.fs ?? realFileSystem;
  const root = input.storageRootPath ?? storageRoot();
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const stabilityMs = input.stabilityMs ?? DEFAULT_STABILITY_MS;
  const delay = input.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (!fs.exists(input.watchPath)) {
    throw new Error(
      `The watch folder "${input.watchPath}" does not exist or is not readable. `
        + 'Check the path in Settings, or reconnect the drive or share it lives on.',
    );
  }

  const outcome: ScanWatchFolderOutcome = {
    ingested: 0, duplicates: 0, inProgress: 0, moveFailed: 0,
    toReview: 0, notes: [], processedFiles: [],
  };

  // A folder is a flat list: we read the top level only, never recursing into
  // subfolders (which would pull in processed/ itself and anything else).
  const entries = fs.readdir(input.watchPath)
    .filter((name) => isCandidate(name))
    .slice(0, maxFiles);

  for (const name of entries) {
    const sourcePath = join(input.watchPath, name);

    // Challenge #1: a file being written by a scanner or email client must not
    // be read half-done. Sample size and mtime twice; if either moved, the file
    // is still in flux — skip it and let the next Refresh pick it up.
    const first = fs.stat(sourcePath);
    if (stabilityMs > 0) await delay(stabilityMs);
    const second = fs.stat(sourcePath);
    if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) {
      outcome.inProgress += 1;
      outcome.notes.push(`Skipped "${name}": still being written. It will be picked up next refresh.`);
      continue;
    }

    const content = fs.readFile(sourcePath);
    const result = storeDocument(db, {
      companyId: input.companyId, filename: name, content,
      uploadedBy: 'auto-watch', root,
    });

    if (result.isDuplicate) outcome.duplicates += 1;
    else outcome.ingested += 1;

    // Local provider only: auto-ingest never spends on a paid API. The local
    // extractor reports honestly; anything it cannot parse becomes a review
    // item, exactly as a manual upload of the same file would.
    const extraction = await extractDocument(db, {
      companyId: input.companyId, documentId: result.documentId,
      storageRootPath: root, providers: [new LocalExtractionProvider()],
      actor: 'auto-watch',
    });
    if (extraction.needsReview) outcome.toReview += 1;

    findMatchesForDocument(db, { companyId: input.companyId, documentId: result.documentId });

    // Move the original into processed/ only AFTER the store succeeded, so a
    // failed ingest never loses the user's file. A move failure leaves the
    // original in place — we never delete what we could not move.
    const moved = moveToProcessed(fs, input.watchPath, name);
    if (moved) outcome.processedFiles.push(name);
    else {
      outcome.moveFailed += 1;
      outcome.notes.push(
        `Could not move "${name}" to processed/ — it is stored, but the original was left `
          + 'in place. Move it yourself if you want it out of the watch folder.',
      );
    }
  }

  return outcome;
}

/**
 * A file is a candidate for ingest if it has an accepted extension and is not
 * hidden or a temp file. Hidden files (dotfiles), Office lock files (~$), and
 * `.tmp`/`.part` downloads are excluded so the review queue is not flooded.
 */
export function isCandidate(name: string): boolean {
  if (name.startsWith('.')) return false;
  if (name.startsWith('~$')) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith('.tmp') || lower.endsWith('.part') || lower.endsWith('.crdownload')) {
    return false;
  }
  return ACCEPTED_EXTENSIONS.includes(extname(lower));
}

/**
 * Move a successfully-stored original into `<watchPath>/processed/`, creating
 * the subfolder if it does not exist. On a name collision, append `-1`, `-2`…
 * before the extension. Returns false if the move could not be completed; the
 * caller leaves the original in place in that case.
 */
export function moveToProcessed(
  fs: WatchFileSystem, watchPath: string, name: string,
): boolean {
  const processedDir = join(watchPath, PROCESSED_SUBFOLDER);
  if (!fs.exists(processedDir)) {
    try {
      fs.mkdir(processedDir, { recursive: true });
    } catch {
      return false;
    }
  }

  const target = uniqueTargetName(fs, processedDir, name);
  try {
    fs.rename(join(watchPath, name), join(processedDir, target));
    return true;
  } catch {
    return false;
  }
}

function uniqueTargetName(fs: WatchFileSystem, dir: string, name: string): string {
  const candidate = join(dir, name);
  if (!fs.exists(candidate)) return name;

  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 1; i < 1000; i++) {
    const proposal = `${stem}-${i}${ext}`;
    if (!fs.exists(join(dir, proposal))) return proposal;
  }
  // Exhausted suffixes; fall back to the original name and let rename fail.
  return name;
}

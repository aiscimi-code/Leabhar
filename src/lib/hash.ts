import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a string. Used to content-address ingested statute. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

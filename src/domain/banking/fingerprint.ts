import { createHash } from 'node:crypto';

/**
 * Transaction fingerprinting (README §13).
 *
 * The requirement is that importing the same statement twice adds nothing,
 * while two genuinely distinct transactions are both kept. Those two goals
 * conflict in one specific case: a supplier billing the same amount twice on
 * the same day with the same description. That is a real thing — two identical
 * app-store charges, two identical taxi fares — and discarding the second would
 * silently lose money from the books.
 *
 * The resolution: the fingerprint covers the transaction's identifying content,
 * and duplicates within a single import are distinguished by an occurrence
 * index. Re-importing the same file produces the same fingerprints AND the same
 * occurrence indices, so nothing is added. A file containing a genuinely new
 * third identical charge produces occurrence index 2, which is new, so it is
 * added.
 *
 * Where the bank supplies its own transaction id, that is used instead and the
 * problem disappears entirely — which is why README §13 asks for it to be kept.
 */

export interface FingerprintInput {
  bankAccountId: string;
  transactionDate: string;
  amountMinor: number;
  currency: string;
  description: string;
  bankReference?: string | null;
  /** The bank's own id, where the statement provides one. */
  bankTransactionId?: string | null;
}

/**
 * Normalise a description before hashing.
 *
 * Banks re-render the same transaction differently between exports — extra
 * spacing, changed casing, a trailing reference that appears only once settled.
 * Without normalisation a re-import of an overlapping statement would create
 * duplicates that look, to the user, like the system inventing transactions.
 */
export function normaliseDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function transactionFingerprint(input: FingerprintInput): string {
  // A bank-supplied id is authoritative and needs nothing else.
  if (input.bankTransactionId && input.bankTransactionId.trim() !== '') {
    return createHash('sha256')
      .update(`bankid|${input.bankAccountId}|${input.bankTransactionId.trim()}`)
      .digest('hex')
      .slice(0, 32);
  }

  const parts = [
    input.bankAccountId,
    input.transactionDate,
    String(input.amountMinor),
    input.currency.toUpperCase(),
    (input.bankReference ?? '').trim().toLowerCase(),
    normaliseDescription(input.description),
  ];

  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/**
 * Assign occurrence indices within a batch of rows sharing a fingerprint.
 * Deterministic in file order, which is what makes a re-import produce
 * identical indices and therefore collide with what is already stored.
 */
export function assignOccurrenceIndices<T extends { fingerprint: string }>(
  rows: T[],
): Array<T & { occurrenceIndex: number }> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const next = seen.get(row.fingerprint) ?? 0;
    seen.set(row.fingerprint, next + 1);
    return { ...row, occurrenceIndex: next };
  });
}

/** Hash a statement file, so an identical file can be recognised on sight. */
export function fileHash(contents: Buffer | string): string {
  return createHash('sha256').update(contents).digest('hex');
}

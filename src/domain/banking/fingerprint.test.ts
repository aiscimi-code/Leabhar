import { describe, it, expect } from 'vitest';
import {
  transactionFingerprint, normaliseDescription, assignOccurrenceIndices, fileHash,
} from './fingerprint';

const base = {
  bankAccountId: 'ba_1',
  transactionDate: '2025-03-15',
  amountMinor: -4217,
  currency: 'EUR',
  description: 'VERCEL INC',
};

describe('transactionFingerprint', () => {
  it('is stable for identical input', () => {
    expect(transactionFingerprint(base)).toBe(transactionFingerprint(base));
  });

  it('changes when any identifying field changes', () => {
    const original = transactionFingerprint(base);
    expect(transactionFingerprint({ ...base, amountMinor: -4218 })).not.toBe(original);
    expect(transactionFingerprint({ ...base, transactionDate: '2025-03-16' })).not.toBe(original);
    expect(transactionFingerprint({ ...base, currency: 'USD' })).not.toBe(original);
    expect(transactionFingerprint({ ...base, bankAccountId: 'ba_2' })).not.toBe(original);
    expect(transactionFingerprint({ ...base, description: 'STRIPE' })).not.toBe(original);
    expect(transactionFingerprint({ ...base, bankReference: 'REF1' })).not.toBe(original);
  });

  it('survives cosmetic re-rendering of the description by the bank', () => {
    const original = transactionFingerprint(base);
    expect(transactionFingerprint({ ...base, description: 'Vercel Inc' })).toBe(original);
    expect(transactionFingerprint({ ...base, description: 'VERCEL  INC' })).toBe(original);
    expect(transactionFingerprint({ ...base, description: ' VERCEL INC ' })).toBe(original);
    expect(transactionFingerprint({ ...base, description: 'VERCEL, INC.' })).toBe(original);
  });

  it('prefers the bank’s own transaction id when present', () => {
    const withId = { ...base, bankTransactionId: 'TX-99' };
    // Same bank id means the same transaction even if the description was re-rendered.
    expect(transactionFingerprint(withId))
      .toBe(transactionFingerprint({ ...withId, description: 'COMPLETELY DIFFERENT' }));
    // Different bank ids are different transactions even when everything else matches.
    expect(transactionFingerprint(withId))
      .not.toBe(transactionFingerprint({ ...base, bankTransactionId: 'TX-100' }));
  });

  it('distinguishes the sign of an amount', () => {
    expect(transactionFingerprint({ ...base, amountMinor: 4217 }))
      .not.toBe(transactionFingerprint({ ...base, amountMinor: -4217 }));
  });
});

describe('normaliseDescription', () => {
  it('collapses punctuation, case and spacing', () => {
    expect(normaliseDescription('VERCEL, INC.')).toBe('vercel inc');
    expect(normaliseDescription('POS  12/03  DUBLIN')).toBe('pos 12 03 dublin');
    expect(normaliseDescription('  Stripe’s Payout  ')).toBe('stripe s payout');
  });
});

describe('assignOccurrenceIndices', () => {
  it('keeps two genuinely identical same-day charges as separate transactions', () => {
    const rows = [
      { fingerprint: 'a' }, { fingerprint: 'a' }, { fingerprint: 'b' },
    ];
    expect(assignOccurrenceIndices(rows)).toEqual([
      { fingerprint: 'a', occurrenceIndex: 0 },
      { fingerprint: 'a', occurrenceIndex: 1 },
      { fingerprint: 'b', occurrenceIndex: 0 },
    ]);
  });

  it('is deterministic, so a re-import collides rather than duplicating', () => {
    const rows = [{ fingerprint: 'a' }, { fingerprint: 'a' }];
    expect(assignOccurrenceIndices(rows)).toEqual(assignOccurrenceIndices(rows));
  });
});

describe('fileHash', () => {
  it('detects an identical file', () => {
    expect(fileHash('date,amount\n2025-01-01,10')).toBe(fileHash('date,amount\n2025-01-01,10'));
    expect(fileHash('a')).not.toBe(fileHash('b'));
  });
});

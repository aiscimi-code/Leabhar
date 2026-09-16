import { describe, it, expect } from 'vitest';
import {
  scoreMatch, rankCandidates, MATCH_THRESHOLDS,
  type DocumentForMatching, type TransactionForMatching,
} from './scoring';

const doc = (over: Partial<DocumentForMatching> = {}): DocumentForMatching => ({
  id: 'doc_1',
  grossMinor: 4217,
  currency: 'EUR',
  documentDate: '2025-03-14',
  invoiceNumber: null,
  supplierId: null,
  supplierName: 'Vercel Inc',
  supplierAliases: [],
  ...over,
});

const tx = (over: Partial<TransactionForMatching> = {}): TransactionForMatching => ({
  id: 'btx_1',
  amountMinor: -4217,
  currency: 'EUR',
  transactionDate: '2025-03-15',
  description: 'VERCEL INC',
  bankReference: null,
  counterpartyName: null,
  supplierId: null,
  ...over,
});

describe('scoreMatch', () => {
  // README §16's own example: Vercel €42.17, bank €42.17, 1 day apart.
  it('scores the README example as a confident match', () => {
    const result = scoreMatch(doc(), tx());
    expect(result.score).toBeGreaterThanOrEqual(MATCH_THRESHOLDS.matched);
    expect(result.matchType).toBe('matched');
    expect(result.amountDifferenceMinor).toBe(0);
    expect(result.dateDifferenceDays).toBe(1);
    expect(result.currencyMatches).toBe(true);
  });

  it('explains itself rather than just giving a number', () => {
    const result = scoreMatch(doc(), tx());
    expect(result.explanation).toContain('Match:');
    expect(result.explanation).toContain('amounts match exactly');
    expect(result.factors.map((f) => f.factor)).toContain('amount');
    expect(result.factors.every((f) => f.detail.length > 0)).toBe(true);
  });

  it('matches regardless of the sign on the bank line', () => {
    const outgoing = scoreMatch(doc(), tx({ amountMinor: -4217 }));
    const incoming = scoreMatch(doc(), tx({ amountMinor: 4217 }));
    expect(outgoing.score).toBe(incoming.score);
  });

  it('refuses to match when the amounts are far apart, however else they agree', () => {
    const result = scoreMatch(
      doc({ grossMinor: 4217 }),
      tx({ amountMinor: -99_999, transactionDate: '2025-03-14' }),
    );
    expect(result.matchType).not.toBe('matched');
    expect(result.score).toBeLessThanOrEqual(20);
    expect(result.explanation).toContain('amounts are too far apart');
  });

  it('tolerates a small difference as possible rounding or FX', () => {
    const result = scoreMatch(doc({ grossMinor: 4217 }), tx({ amountMinor: -4215 }));
    const amount = result.factors.find((f) => f.factor === 'amount')!;
    expect(amount.score).toBeGreaterThan(50);
    expect(amount.detail).toContain('foreign-exchange');
  });

  it('applies tolerance proportionally, not as a flat cent amount', () => {
    // 2 cents on €42 is significant; 2 cents on €10,000 is nothing.
    const small = scoreMatch(doc({ grossMinor: 4217 }), tx({ amountMinor: -4217 + 200 }));
    const large = scoreMatch(doc({ grossMinor: 1_000_000 }), tx({ amountMinor: -1_000_000 + 200 }));
    const smallAmount = small.factors.find((f) => f.factor === 'amount')!;
    const largeAmount = large.factors.find((f) => f.factor === 'amount')!;
    expect(largeAmount.score).toBeGreaterThan(smallAmount.score);
  });

  it('never auto-matches across different currencies', () => {
    const result = scoreMatch(doc({ currency: 'USD' }), tx({ currency: 'EUR' }));
    expect(result.matchType).not.toBe('matched');
    expect(result.currencyMatches).toBe(false);
    expect(result.explanation).toContain('currencies differ');
  });

  it('degrades with distance in time', () => {
    const sameDay = scoreMatch(doc({ documentDate: '2025-03-15' }), tx());
    const oneWeek = scoreMatch(doc({ documentDate: '2025-03-08' }), tx());
    const oneMonth = scoreMatch(doc({ documentDate: '2025-02-13' }), tx());
    expect(sameDay.score).toBeGreaterThan(oneWeek.score);
    expect(oneWeek.score).toBeGreaterThan(oneMonth.score);
  });

  it('refuses a match separated by more than three months', () => {
    const result = scoreMatch(doc({ documentDate: '2024-11-01' }), tx());
    expect(result.matchType).not.toBe('matched');
    expect(result.explanation).toContain('dates are too far apart');
  });

  it('penalises a payment that precedes its invoice', () => {
    const after = scoreMatch(doc({ documentDate: '2025-03-01' }), tx({ transactionDate: '2025-03-15' }));
    const before = scoreMatch(doc({ documentDate: '2025-03-29' }), tx({ transactionDate: '2025-03-15' }));
    expect(after.score).toBeGreaterThan(before.score);
    expect(before.factors.find((f) => f.factor === 'date')!.detail).toContain('unusual');
  });

  it('rewards a gap matching the supplier’s known payment pattern', () => {
    const withPattern = scoreMatch(
      doc({ documentDate: '2025-02-13', typicalPaymentDays: 30 }),
      tx({ transactionDate: '2025-03-15' }),
    );
    const withoutPattern = scoreMatch(
      doc({ documentDate: '2025-02-13' }),
      tx({ transactionDate: '2025-03-15' }),
    );
    expect(withPattern.score).toBeGreaterThan(withoutPattern.score);
    expect(withPattern.factors.find((f) => f.factor === 'date')!.detail)
      .toContain('usual 30-day pattern');
  });

  it('finds the supplier name in the bank narrative', () => {
    const result = scoreMatch(doc(), tx({ description: 'CARD PAYMENT VERCEL INC 1234' }));
    expect(result.factors.find((f) => f.factor === 'supplier')!.score).toBe(100);
  });

  it('matches a supplier alias', () => {
    const result = scoreMatch(
      doc({ supplierName: 'Amazon Web Services', supplierAliases: ['AWS EMEA'] }),
      tx({ description: 'AWS EMEA SARL' }),
    );
    expect(result.factors.find((f) => f.factor === 'supplier')!.score).toBeGreaterThan(60);
  });

  it('prefers a confirmed supplier link over name matching', () => {
    const result = scoreMatch(
      doc({ supplierId: 'sup_1', supplierName: 'Nothing Like It' }),
      tx({ supplierId: 'sup_1', description: 'OPAQUE BANK NARRATIVE' }),
    );
    expect(result.factors.find((f) => f.factor === 'supplier')!.score).toBe(100);
  });

  it('scores a mismatched supplier link at zero', () => {
    const result = scoreMatch(
      doc({ supplierId: 'sup_1' }), tx({ supplierId: 'sup_2' }),
    );
    expect(result.factors.find((f) => f.factor === 'supplier')!.score).toBe(0);
  });

  it('boosts the score when the invoice number is in the bank narrative', () => {
    const withNumber = scoreMatch(
      doc({ invoiceNumber: 'INV-2025-0041' }),
      tx({ description: 'TRANSFER', bankReference: 'INV-2025-0041' }),
    );
    expect(withNumber.factors.find((f) => f.factor === 'invoice_number')!.score).toBe(100);
  });

  it('matches on the digits of an invoice number', () => {
    const result = scoreMatch(
      doc({ invoiceNumber: 'INV-2025-0041' }),
      tx({ bankReference: 'PAYMENT 20250041' }),
    );
    expect(result.factors.find((f) => f.factor === 'invoice_number')!.score).toBe(75);
  });

  // Card payments almost never carry an invoice number in the narrative.
  it('does not count a missing invoice number against a match', () => {
    const withNumber = scoreMatch(doc({ invoiceNumber: 'INV-2025-0041' }), tx());
    const withoutNumberField = scoreMatch(doc({ invoiceNumber: null }), tx());
    expect(withNumber.score).toBe(withoutNumberField.score);

    const factor = withNumber.factors.find((f) => f.factor === 'invoice_number')!;
    expect(factor.weight).toBe(0);
    expect(factor.detail).toContain('not counted against this match');
  });

  it('still auto-matches an exact same-supplier payment with no invoice number', () => {
    const result = scoreMatch(
      doc({ invoiceNumber: 'INV-1', supplierId: 'sup_1' }),
      tx({ supplierId: 'sup_1', description: 'CARD PAYMENT' }),
    );
    expect(result.matchType).toBe('matched');
    expect(result.score).toBeGreaterThanOrEqual(MATCH_THRESHOLDS.matched);
  });

  it('handles a document with no total honestly', () => {
    const result = scoreMatch(doc({ grossMinor: null }), tx());
    const amount = result.factors.find((f) => f.factor === 'amount')!;
    expect(amount.score).toBe(0);
    expect(amount.detail).toContain('no total');
    expect(result.matchType).not.toBe('matched');
  });

  it('handles a document with no date honestly', () => {
    const result = scoreMatch(doc({ documentDate: null }), tx());
    expect(result.dateDifferenceDays).toBeNull();
    expect(result.matchType).not.toBe('matched');
  });
});

describe('rankCandidates', () => {
  it('picks the highest scorer', () => {
    const candidates = [
      scoreMatch(doc(), tx({ id: 'btx_1', transactionDate: '2025-03-20' })),
      scoreMatch(doc(), tx({ id: 'btx_2', transactionDate: '2025-03-15' })),
    ];
    const ranked = rankCandidates(candidates);
    expect(ranked.best!.bankTransactionId).toBe('btx_2');
  });

  // Two identical charges on the same day: picking one would attach the invoice
  // to the wrong payment.
  it('flags two equally good candidates as ambiguous rather than guessing', () => {
    const candidates = [
      scoreMatch(doc(), tx({ id: 'btx_1' })),
      scoreMatch(doc(), tx({ id: 'btx_2' })),
    ];
    const ranked = rankCandidates(candidates);
    expect(ranked.ambiguous).toBe(true);
    expect(ranked.runnerUp).not.toBeNull();
  });

  it('is not ambiguous when one candidate is clearly better', () => {
    const candidates = [
      scoreMatch(doc(), tx({ id: 'btx_1' })),
      scoreMatch(doc(), tx({ id: 'btx_2', amountMinor: -9999, description: 'SOMETHING ELSE' })),
    ];
    expect(rankCandidates(candidates).ambiguous).toBe(false);
  });

  it('handles no candidates', () => {
    const ranked = rankCandidates([]);
    expect(ranked.best).toBeNull();
    expect(ranked.ambiguous).toBe(false);
  });
});

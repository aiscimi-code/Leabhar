import { daysBetween, asIsoDate, type IsoDate } from '../dates';
import { normaliseDescription } from '../banking/fingerprint';

/**
 * Document-to-transaction match scoring (README §16).
 *
 * Scores are built from named, weighted factors, and every factor's
 * contribution is kept. "MATCH: 98%" is useless to a user who cannot see why,
 * and README §43 requires that any important figure be explainable — a match
 * confidence is exactly such a figure, because the user is being asked to
 * approve it.
 *
 * Nothing here decides anything. It produces a score and its reasoning; the
 * caller decides what to do with it, and README §16's rule that an uncertain
 * match is never silently forced is enforced by the thresholds below.
 */

export interface MatchFactor {
  factor: string;
  /** Relative importance of this factor. */
  weight: number;
  /** 0-100 for this factor alone. */
  score: number;
  detail: string;
}

export interface MatchCandidate {
  documentId: string;
  bankTransactionId: string;
  score: number;
  matchType: 'matched' | 'probable' | 'possible' | 'no_match' | 'conflict';
  factors: MatchFactor[];
  amountDifferenceMinor: number | null;
  dateDifferenceDays: number | null;
  currencyMatches: boolean | null;
  explanation: string;
}

export interface DocumentForMatching {
  id: string;
  grossMinor: number | null;
  currency: string | null;
  documentDate: string | null;
  invoiceNumber: string | null;
  supplierId: string | null;
  supplierName?: string | null;
  supplierAliases?: string[];
  /** Typical days between this supplier's invoice date and payment. */
  typicalPaymentDays?: number | null;
}

export interface TransactionForMatching {
  id: string;
  amountMinor: number;
  currency: string;
  transactionDate: string;
  description: string;
  bankReference: string | null;
  counterpartyName: string | null;
  supplierId: string | null;
  /** Base-currency equivalent, when the statement captured it (§13). */
  baseAmountMinor: number | null;
  baseCurrency: string | null;
}

/**
 * Thresholds. Deliberately conservative: a wrong auto-accepted match puts VAT
 * in the wrong period against the wrong evidence, and the cost of that is much
 * higher than the cost of one extra click.
 */
export const MATCH_THRESHOLDS = {
  /** At or above: safe to apply without asking, if auto-accept is enabled. */
  matched: 90,
  probable: 70,
  possible: 45,
} as const;

/**
 * How many days apart a document and its payment can plausibly be.
 * Card payments settle within days; invoices on terms can be 30+.
 */
const MAX_DATE_DISTANCE_DAYS = 90;

export function scoreMatch(
  document: DocumentForMatching,
  transaction: TransactionForMatching,
): MatchCandidate {
  const factors: MatchFactor[] = [];

  // ---- Amount: the strongest single signal ----
  const transactionAmount = Math.abs(transaction.amountMinor);
  let amountDifferenceMinor: number | null = null;

  // When the document and transaction are in different currencies, the raw
  // amounts cannot be compared directly. But if both have a base-currency
  // equivalent (the document's gross booked in base, the transaction's settled
  // amount from the statement), those two base figures are the same money and
  // can be compared. Without base amounts on both sides the factor is
  // unassessable, exactly as when the document has no gross.
  const differentCurrencies = document.currency && transaction.currency
    && document.currency.toUpperCase() !== transaction.currency.toUpperCase();

  const canCompareAmounts = document.grossMinor !== null
    && (!differentCurrencies
      || (document.grossMinor !== null
        && transaction.baseAmountMinor !== null
        && transaction.baseCurrency !== null
        && document.currency !== null
        && document.currency.toUpperCase() === transaction.baseCurrency.toUpperCase()));

  if (!canCompareAmounts) {
    if (document.grossMinor === null) {
      factors.push({
        factor: 'amount', weight: 0, score: 0,
        detail: 'The document has no total, so the amounts cannot be compared.',
      });
    } else {
      factors.push({
        factor: 'amount', weight: 0, score: 0,
        detail: 'The document and transaction are in different currencies and no '
          + 'comparable base-currency figure is available, so the amounts '
          + 'cannot be compared.',
      });
    }
  } else if (differentCurrencies && transaction.baseAmountMinor !== null) {
    // Compare in base currency. This branch only runs when the document's own
    // currency equals the transaction's base currency (enforced by
    // canCompareAmounts above) — e.g. a EUR invoice paid by a USD bank charge
    // whose statement reports the EUR settled amount. Comparing a
    // foreign-currency document gross to a base-currency settled amount would
    // be an apples-to-oranges comparison.
    const documentBase = document.grossMinor!;
    const transactionBase = Math.abs(transaction.baseAmountMinor);
    amountDifferenceMinor = documentBase - transactionBase;
    const difference = Math.abs(amountDifferenceMinor);
    const proportion = difference / Math.max(documentBase, 1);
    const score = difference === 0 ? 80
      : proportion <= 0.001 ? 75
      : proportion <= 0.01 ? 60
      : proportion <= 0.05 ? 35
      : 0;
    factors.push({
      factor: 'amount', weight: 40, score,
      detail: score === 0
        ? 'The base-currency amounts differ too much to be the same payment.'
        : `The amounts match in base currency (${(difference / 100).toFixed(2)} apart), `
          + 'though the document and transaction are in different currencies.',
    });
  } else {
    const documentAmount = Math.abs(document.grossMinor!);
    amountDifferenceMinor = documentAmount - transactionAmount;
    const difference = Math.abs(amountDifferenceMinor);

    if (difference === 0) {
      factors.push({
        factor: 'amount', weight: 40, score: 100,
        detail: 'The amounts match exactly.',
      });
    } else {
      // Proportional tolerance, because a €2 difference means something very
      // different on a €10 receipt than on a €10,000 invoice.
      const proportion = difference / Math.max(documentAmount, 1);
      const score = proportion <= 0.001 ? 92
        : proportion <= 0.01 ? 70
        : proportion <= 0.05 ? 40
        : proportion <= 0.15 ? 15
        : 0;
      factors.push({
        factor: 'amount', weight: 40, score,
        detail: score === 0
          ? `The amounts differ by ${(difference / 100).toFixed(2)}, too much to be the same payment.`
          : `The amounts differ by ${(difference / 100).toFixed(2)}`
            + (proportion <= 0.01
              ? ', which could be a rounding or foreign-exchange difference.'
              : '.'),
      });
    }
  }

  // ---- Currency ----
  let currencyMatches: boolean | null = null;
  if (document.currency && transaction.currency) {
    currencyMatches = document.currency.toUpperCase() === transaction.currency.toUpperCase();
    factors.push({
      factor: 'currency', weight: 15, score: currencyMatches ? 100 : 0,
      detail: currencyMatches
        ? `Both are in ${transaction.currency.toUpperCase()}.`
        : `The document is in ${document.currency.toUpperCase()} but the transaction is `
          + `in ${transaction.currency.toUpperCase()}.`,
    });
  } else {
    factors.push({
      factor: 'currency', weight: 0, score: 0,
      detail: 'The document does not state a currency, so this could not be checked.',
    });
  }

  // ---- Date proximity ----
  let dateDifferenceDays: number | null = null;
  if (document.documentDate) {
    dateDifferenceDays = daysBetween(
      asIsoDate(document.documentDate), asIsoDate(transaction.transactionDate),
    );
    const distance = Math.abs(dateDifferenceDays);

    // A payment before its invoice date is possible (prepayment) but unusual,
    // so it scores lower than the same gap the other way round.
    const paidBeforeInvoiced = dateDifferenceDays < 0;
    const expected = document.typicalPaymentDays ?? null;

    let score: number;
    let detail: string;

    if (distance === 0) {
      score = 100; detail = 'Same date.';
    } else if (expected !== null && Math.abs(distance - expected) <= 3) {
      score = 95;
      detail = `${distance} day${distance === 1 ? '' : 's'} apart, which matches this `
        + `supplier's usual ${expected}-day pattern.`;
    } else if (distance <= 3) {
      score = 90; detail = `${distance} day${distance === 1 ? '' : 's'} apart.`;
    } else if (distance <= 10) {
      score = 70; detail = `${distance} days apart.`;
    } else if (distance <= 35) {
      score = 45; detail = `${distance} days apart, consistent with payment terms.`;
    } else if (distance <= MAX_DATE_DISTANCE_DAYS) {
      score = 15; detail = `${distance} days apart, which is a long gap.`;
    } else {
      score = 0;
      detail = `${distance} days apart, too far to be related.`;
    }

    if (paidBeforeInvoiced && distance > 3) {
      score = Math.round(score * 0.6);
      detail += ' The payment precedes the document date, which is unusual.';
    }

    factors.push({ factor: 'date', weight: 25, score, detail });
  } else {
    factors.push({
      factor: 'date', weight: 0, score: 0,
      detail: 'The document has no date, so the dates cannot be compared.',
    });
  }

  // ---- Supplier identity ----
  if (document.supplierId && transaction.supplierId) {
    const same = document.supplierId === transaction.supplierId;
    factors.push({
      factor: 'supplier', weight: 20, score: same ? 100 : 0,
      detail: same
        ? 'Both are assigned to the same supplier.'
        : 'They are assigned to different suppliers.',
    });
  } else {
    const nameScore = scoreNameAgainstDescription(document, transaction);
    factors.push(nameScore);
  }

  // ---- Invoice number appearing in the bank narrative ----
  if (document.invoiceNumber) {
    const reference = normaliseDescription(
      `${transaction.description} ${transaction.bankReference ?? ''}`,
    );
    const invoiceNumber = normaliseDescription(document.invoiceNumber);
    const digits = document.invoiceNumber.replace(/\D/g, '');

    const fullMatch = invoiceNumber.length >= 3 && reference.includes(invoiceNumber);
    const digitMatch = digits.length >= 4 && reference.replace(/\D/g, '').includes(digits);

    /**
     * An invoice number in the bank narrative is strong evidence. Its ABSENCE
     * is not evidence of anything: card payments and direct debits almost never
     * carry one, so scoring the absence as zero against a weight would stop
     * almost any card payment from ever matching automatically. Absent means
     * not assessed, exactly as for the other factors.
     */
    factors.push({
      factor: 'invoice_number',
      weight: fullMatch || digitMatch ? 20 : 0,
      score: fullMatch ? 100 : digitMatch ? 75 : 0,
      detail: fullMatch
        ? `The invoice number "${document.invoiceNumber}" appears in the bank narrative.`
        : digitMatch
          ? `The digits of invoice "${document.invoiceNumber}" appear in the bank narrative.`
          : 'The invoice number does not appear in the bank narrative, which is normal for '
            + 'a card payment and is not counted against this match.',
    });
  }

  // ---- Weighted total ----
  // A factor that could not be assessed carries zero weight and is excluded
  // entirely, rather than being scored as half-right. "Unknown" is not
  // "partially true", and averaging it in would let a missing supplier quietly
  // drag down an otherwise exact match — or, worse, let three weak signals
  // average up into a confident one.
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  const weightedScore = factors.reduce((sum, f) => sum + f.score * f.weight, 0);
  let score = totalWeight === 0 ? 0 : Math.round(weightedScore / totalWeight);

  // ---- Hard disqualifiers ----
  // These override the weighted score, because no amount of corroboration from
  // other factors makes a mismatched amount the same payment.
  const amountFactor = factors.find((f) => f.factor === 'amount')!;
  const dateFactor = factors.find((f) => f.factor === 'date')!;
  let matchType: MatchCandidate['matchType'];
  let disqualified: string | null = null;

  if (amountFactor.score === 0 && amountFactor.weight > 0 && document.grossMinor !== null) {
    disqualified = 'the amounts are too far apart';
    score = Math.min(score, 20);
  } else if (dateFactor.score === 0 && document.documentDate !== null) {
    disqualified = 'the dates are too far apart';
    score = Math.min(score, 20);
  } else if (currencyMatches === false && amountFactor.weight === 0) {
    // Different currencies where the amounts could not be compared at all (no
    // base-currency equivalent) is never an automatic match. When the amounts
    // were compared in base currency, the currency mismatch is already
    // reflected in its own factor and is not a disqualifier.
    disqualified = 'the currencies differ';
    score = Math.min(score, 44);
  }

  /**
   * Corroborating identity evidence: something tying this document to this
   * counterparty, as opposed to merely to an amount on a date.
   *
   * Excluding unassessable factors from the average means a document with only
   * an amount, a currency and a date can reach a very high score while nothing
   * actually connects it to the transaction. Two suppliers billing the same
   * round figure in the same week is ordinary, so an exact amount alone is not
   * identity. Auto-matching therefore requires a name, a confirmed supplier
   * link, or an invoice number in the narrative.
   */
  const supplierFactor = factors.find((f) => f.factor === 'supplier');
  const invoiceFactor = factors.find((f) => f.factor === 'invoice_number');
  const hasIdentityEvidence =
    (supplierFactor !== undefined && supplierFactor.weight > 0 && supplierFactor.score >= 65)
    || (invoiceFactor !== undefined && invoiceFactor.score >= 75);

  /**
   * An automatic match needs all three legs: how much, when, and who. Each
   * alone is ordinary coincidence — plenty of payments share an amount, plenty
   * share a date, and a supplier bills more than once. Only together do they
   * identify a particular payment, so a missing leg caps the result at
   * "probable" and the user decides.
   */
  const missingLegs: string[] = [];
  if (amountFactor.weight === 0) missingLegs.push('the document has no total');
  if (dateFactor.weight === 0) missingLegs.push('the document has no date');
  if (!hasIdentityEvidence) {
    missingLegs.push(
      'nothing identifies the counterparty \u2014 no supplier name or invoice number '
        + 'connects this document to this transaction',
    );
  }
  const canAutoMatch = missingLegs.length === 0;

  if (disqualified) {
    matchType = score >= MATCH_THRESHOLDS.possible ? 'conflict' : 'no_match';
  } else if (score >= MATCH_THRESHOLDS.matched && canAutoMatch) {
    matchType = 'matched';
  } else if (score >= MATCH_THRESHOLDS.probable
             || (score >= MATCH_THRESHOLDS.matched && !canAutoMatch)) {
    matchType = 'probable';
  } else if (score >= MATCH_THRESHOLDS.possible) {
    matchType = 'possible';
  } else {
    matchType = 'no_match';
  }

  const heldBack = !disqualified && score >= MATCH_THRESHOLDS.matched && !canAutoMatch
    ? missingLegs.join(', and ')
    : null;

  return {
    documentId: document.id,
    bankTransactionId: transaction.id,
    score,
    matchType,
    factors,
    amountDifferenceMinor,
    dateDifferenceDays,
    currencyMatches,
    explanation: buildExplanation(score, matchType, factors, disqualified ?? heldBack),
  };
}

function scoreNameAgainstDescription(
  document: DocumentForMatching, transaction: TransactionForMatching,
): MatchFactor {
  const names = [document.supplierName, ...(document.supplierAliases ?? [])]
    .filter((n): n is string => typeof n === 'string' && n.trim().length >= 3);

  if (names.length === 0) {
    return {
      factor: 'supplier', weight: 0, score: 0,
      detail: 'No supplier is recorded on the document, so this could not be checked.',
    };
  }

  const haystack = normaliseDescription(
    `${transaction.description} ${transaction.counterpartyName ?? ''}`,
  );

  for (const name of names) {
    const needle = normaliseDescription(name);
    if (needle.length >= 3 && haystack.includes(needle)) {
      return {
        factor: 'supplier', weight: 20, score: 100,
        detail: `"${name}" appears in the bank narrative.`,
      };
    }
  }

  // Partial: a distinctive word from the supplier name appears.
  for (const name of names) {
    const words = normaliseDescription(name).split(' ').filter((w) => w.length >= 4);
    const hit = words.find((w) => haystack.includes(w));
    if (hit) {
      return {
        factor: 'supplier', weight: 20, score: 65,
        detail: `"${hit}" from the supplier name appears in the bank narrative.`,
      };
    }
  }

  return {
    factor: 'supplier', weight: 20, score: 0,
    detail: `The supplier name does not appear in the bank narrative "${transaction.description}".`,
  };
}

function buildExplanation(
  score: number,
  matchType: MatchCandidate['matchType'],
  factors: MatchFactor[],
  disqualified: string | null,
): string {
  const heading = matchType === 'matched' ? `Match: ${score}%`
    : matchType === 'probable' ? `Probable match: ${score}%`
    : matchType === 'possible' ? `Possible match: ${score}%`
    : matchType === 'conflict' ? `Conflicting evidence: ${score}%`
    : `No match: ${score}%`;

  const reasons = factors
    .filter((f) => f.score > 0)
    .sort((a, b) => (b.score * b.weight) - (a.score * a.weight))
    .map((f) => f.detail);

  const against = factors.filter((f) => f.score === 0 && f.weight > 0).map((f) => f.detail);
  const unknown = factors.filter((f) => f.weight === 0).map((f) => f.detail);

  const parts = [heading];
  if (disqualified) parts.push(`This cannot be an automatic match because ${disqualified}.`);
  if (reasons.length > 0) parts.push(`In favour: ${reasons.join(' ')}`);
  if (against.length > 0) parts.push(`Against: ${against.join(' ')}`);
  if (unknown.length > 0) parts.push(`Could not be checked: ${unknown.join(' ')}`);
  return parts.join(' ');
}

/**
 * Rank candidates and detect ambiguity.
 *
 * Two transactions that both match a document equally well is a conflict, not a
 * coin flip. Picking one would attach the invoice to the wrong payment and put
 * its VAT against the wrong evidence, so the pair is surfaced instead.
 */
export function rankCandidates(candidates: MatchCandidate[]): {
  best: MatchCandidate | null;
  ambiguous: boolean;
  runnerUp: MatchCandidate | null;
  all: MatchCandidate[];
} {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const best = sorted[0] ?? null;
  const runnerUp = sorted[1] ?? null;

  const ambiguous = best !== null && runnerUp !== null
    && best.score >= MATCH_THRESHOLDS.possible
    && best.score - runnerUp.score < 10;

  return { best, ambiguous, runnerUp, all: sorted };
}

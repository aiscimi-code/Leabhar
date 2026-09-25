import { and, eq, lte, gte, isNull, or, desc } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { vatTreatments, taxRates, vatPeriods, vatEntries, companies, reviewItems } from '@/db/schema';
import { ids } from '@/lib/ids';
import {
  asMinor, vatFromNet, vatFromGross, netFromGross, multiplyRational, type Minor,
} from '../money';
import type { IsoDate } from '../dates';
import { AccountingError } from '../accounting/errors';

export class VatError extends AccountingError {}

/** A VAT entry would change a return that is locked for filing or already filed (issue #226). */
export class VatPeriodClosedError extends VatError {}

/**
 * The VAT period a date falls in, refused when that period is locked or
 * submitted (issue #226). A filed return is never changed, and a locked one is
 * not changed without unlocking it first. `what` names the thing being
 * recorded, for the message. Every path that writes VAT entries calls this
 * before it writes anything — journals included — so a refusal leaves no
 * half-posted change behind.
 */
export function assertVatPeriodWritable(
  db: AppDatabase, companyId: string, date: IsoDate, what: string,
): typeof vatPeriods.$inferSelect | undefined {
  const period = findVatPeriod(db, companyId, date);
  if (period && (period.status === 'locked' || period.status === 'submitted')) {
    throw new VatPeriodClosedError(
      `${what} falls on ${date}, in the VAT period "${period.name}", which is ${period.status}. `
        + (period.status === 'submitted'
          ? 'Its return has been filed and is never changed. '
          : 'It is locked for filing; unlock it first if this belongs in that return. ')
        + 'To correct it in a later return instead, give the date of an open VAT period to declare it in.',
      { vatPeriodId: period.id, status: period.status, date },
    );
  }
  return period;
}

export type VatDirection = 'sales' | 'purchases';

export interface ResolvedTreatment {
  treatment: typeof vatTreatments.$inferSelect;
  rate: typeof taxRates.$inferSelect | null;
  rateBasisPoints: number;
}

/**
 * Resolve the VAT treatment and rate that applied on a given date.
 *
 * README §6 requires historical rates: changing a rate today must not alter a
 * historical transaction. That is achieved by resolving configuration as of the
 * entry's own tax point rather than as of now, and by snapshotting the resolved
 * values onto the VAT entry so even a later re-resolution cannot move them.
 */
export function resolveTreatment(
  db: AppDatabase,
  params: { companyId: string; treatmentId: string; onDate: IsoDate; rateOverrideId?: string },
): ResolvedTreatment {
  const treatment = db.select().from(vatTreatments)
    .where(and(
      eq(vatTreatments.id, params.treatmentId),
      eq(vatTreatments.companyId, params.companyId),
    )).get();

  if (!treatment) {
    throw new VatError(`VAT treatment ${params.treatmentId} not found.`);
  }
  if (treatment.effectiveFrom > params.onDate) {
    throw new VatError(
      `VAT treatment "${treatment.name}" only takes effect from ${treatment.effectiveFrom}, `
        + `after the transaction date ${params.onDate}.`,
      { treatmentId: treatment.id },
    );
  }
  if (treatment.effectiveTo && treatment.effectiveTo < params.onDate) {
    throw new VatError(
      `VAT treatment "${treatment.name}" ceased to apply on ${treatment.effectiveTo}, `
        + `before the transaction date ${params.onDate}.`,
      { treatmentId: treatment.id },
    );
  }

  if (!treatment.appliesRate) {
    return { treatment, rate: null, rateBasisPoints: 0 };
  }

  const rateId = params.rateOverrideId ?? treatment.defaultTaxRateId;
  if (!rateId) {
    throw new VatError(
      `VAT treatment "${treatment.name}" applies a rate but has no rate configured.`,
      { treatmentId: treatment.id },
    );
  }

  const rate = resolveRate(db, {
    companyId: params.companyId, rateId, onDate: params.onDate,
  });

  return { treatment, rate, rateBasisPoints: rate.rateBasisPoints };
}

/**
 * Resolve a rate as of a date.
 *
 * Rates are superseded rather than overwritten, so several rows can share a
 * code with different effective windows. The row whose window contains the date
 * is the one that applied.
 */
export function resolveRate(
  db: AppDatabase,
  params: { companyId: string; rateId: string; onDate: IsoDate },
): typeof taxRates.$inferSelect {
  const direct = db.select().from(taxRates)
    .where(and(eq(taxRates.id, params.rateId), eq(taxRates.companyId, params.companyId)))
    .get();
  if (!direct) throw new VatError(`Tax rate ${params.rateId} not found.`);

  const withinWindow = direct.effectiveFrom <= params.onDate
    && (!direct.effectiveTo || direct.effectiveTo >= params.onDate);
  if (withinWindow) return direct;

  // Superseded: find the row for the same code whose window covers the date.
  const historical = db.select().from(taxRates)
    .where(and(
      eq(taxRates.companyId, params.companyId),
      eq(taxRates.code, direct.code),
      lte(taxRates.effectiveFrom, params.onDate),
      or(isNull(taxRates.effectiveTo), gte(taxRates.effectiveTo, params.onDate)),
    ))
    .orderBy(desc(taxRates.effectiveFrom))
    .get();

  if (!historical) {
    throw new VatError(
      `No "${direct.name}" rate was in force on ${params.onDate}. `
        + 'Historical rates must be configured before posting into that period.',
      { rateCode: direct.code, onDate: params.onDate },
    );
  }
  return historical;
}

export interface VatCalculation {
  netMinor: Minor;
  vatMinor: Minor;
  grossMinor: Minor;
  recoverableVatMinor: Minor;
  rateBasisPoints: number;
}

export interface CalculateVatInput {
  treatment: typeof vatTreatments.$inferSelect;
  rateBasisPoints: number;
  direction: VatDirection;
  /** Supply exactly one of these three. */
  netMinor?: number;
  grossMinor?: number;
  /** When the document states the VAT explicitly, trust it over recomputing. */
  statedVatMinor?: number;
  /**
   * Override `computeRecoverable`'s result. Set when a caller has already
   * decided this line's input VAT cannot yet be trusted as reclaimable —
   * e.g. it disagrees with the treatment's rate, or the supplier is not
   * established in the State under a treatment that isn't reverse-charge
   * (issue #145) — and wants the review item, not the ledger, to carry the
   * open question. The net/VAT/gross figures still reflect the evidence;
   * only the recoverable slice is held back.
   */
  recoverableOverrideMinor?: number;
}

/**
 * Calculate the net/VAT/gross triple for one line under one treatment.
 *
 * Where the document states a VAT amount, that amount is used rather than a
 * recomputed one, and any disagreement is reported by `vatDiscrepancy` instead
 * of being quietly overwritten. Suppliers round per line, apply rounding
 * adjustments, and occasionally just get it wrong; silently "correcting" their
 * figure would make the books disagree with the evidence behind them.
 *
 * The one exception is a reverse-charge treatment: a supplier who is not
 * Irish-VAT-registered is not entitled to charge Irish VAT at all, so a
 * figure printed on their document is not evidence of anything and is never
 * used as the self-assessed amount — that amount is always the treatment's
 * own rate applied to the net (issue #145 defects 1 and 3). Whether the
 * document also states an unexpected VAT figure is for the caller to raise
 * as a review item; this function only ever self-assesses.
 */
export function calculateVat(input: CalculateVatInput): VatCalculation {
  const { treatment, rateBasisPoints, direction } = input;
  const appliesRate = treatment.appliesRate;
  const effectiveRate = appliesRate ? rateBasisPoints : 0;
  const trustStated = input.statedVatMinor !== undefined && !treatment.isReverseCharge;

  let netMinor: Minor;
  let vatMinor: Minor;

  if (input.netMinor !== undefined) {
    netMinor = asMinor(input.netMinor);
    vatMinor = trustStated
      ? asMinor(input.statedVatMinor!)
      : vatFromNet(netMinor, effectiveRate);
  } else if (input.grossMinor !== undefined) {
    if (trustStated) {
      vatMinor = asMinor(input.statedVatMinor!);
      netMinor = asMinor(input.grossMinor - vatMinor);
    } else if (treatment.isReverseCharge) {
      // Under reverse charge the supplier charges no VAT, so the invoice total
      // IS the net amount. Treating it as gross would understate the cost and
      // the VAT — this is the single most common reverse-charge mistake.
      netMinor = asMinor(input.grossMinor);
      vatMinor = vatFromNet(netMinor, effectiveRate);
    } else {
      netMinor = netFromGross(asMinor(input.grossMinor), effectiveRate);
      vatMinor = vatFromGross(asMinor(input.grossMinor), effectiveRate);
    }
  } else {
    throw new VatError('Supply a net or a gross amount to calculate VAT.');
  }

  const grossMinor = treatment.isReverseCharge
    // The reverse-charge "gross" is what you actually pay the supplier: the net.
    ? netMinor
    : asMinor(netMinor + vatMinor);

  const recoverableVatMinor = input.recoverableOverrideMinor !== undefined
    ? asMinor(input.recoverableOverrideMinor)
    : computeRecoverable(treatment, direction, vatMinor);

  return {
    netMinor,
    vatMinor,
    grossMinor,
    recoverableVatMinor,
    rateBasisPoints: effectiveRate,
  };
}

function computeRecoverable(
  treatment: typeof vatTreatments.$inferSelect,
  direction: VatDirection,
  vatMinor: Minor,
): Minor {
  // Output VAT is never "recoverable"; it is owed.
  if (direction === 'sales') return asMinor(0);
  if (!treatment.isRecoverable) return asMinor(0);
  if (treatment.recoverableBasisPoints >= 10_000) return vatMinor;
  return multiplyRational(vatMinor, treatment.recoverableBasisPoints, 10_000);
}

/**
 * Compare a stated VAT amount with what the rate implies.
 * Returns null when they agree, or the difference when they do not, so the
 * caller can raise a review item rather than silently adopting either figure.
 */
export function vatDiscrepancy(
  netMinor: number, statedVatMinor: number, rateBasisPoints: number,
): { expectedMinor: number; statedMinor: number; differenceMinor: number } | null {
  const expected = vatFromNet(asMinor(netMinor), rateBasisPoints);
  const difference = statedVatMinor - expected;
  if (difference === 0) return null;
  return { expectedMinor: expected, statedMinor: statedVatMinor, differenceMinor: difference };
}

/**
 * Determine the tax point — the date that decides which VAT period a
 * transaction falls into (docs/DOMAIN_MODEL.md §6).
 *
 * The asymmetry here is the substance of the cash receipts basis and is easy to
 * get wrong: it applies to VAT on SALES only. Input VAT on purchases is
 * reclaimed by reference to the supplier's invoice date under both bases.
 */
export function determineTaxPoint(params: {
  basis: 'invoice' | 'cash_receipts';
  direction: VatDirection;
  invoiceDate: IsoDate;
  supplyDate?: IsoDate | null;
  paymentDate?: IsoDate | null;
}): { taxPointDate: IsoDate; reason: string } {
  const documentDate = params.supplyDate ?? params.invoiceDate;

  if (params.direction === 'purchases') {
    return {
      taxPointDate: documentDate,
      reason: 'Input VAT is reclaimed by reference to the supplier’s invoice date '
        + 'under both the invoice basis and the cash receipts basis.',
    };
  }

  if (params.basis === 'invoice') {
    return {
      taxPointDate: documentDate,
      reason: 'On the invoice basis, output VAT arises when the invoice is issued, '
        + 'whether or not it has been paid.',
    };
  }

  if (!params.paymentDate) {
    throw new VatError(
      'On the cash receipts basis, output VAT on a sale arises when payment is '
        + 'received. This invoice has not been paid, so no VAT entry arises yet.',
      { invoiceDate: params.invoiceDate },
    );
  }

  return {
    taxPointDate: params.paymentDate,
    reason: 'On the cash receipts basis, output VAT on a sale arises on the date '
      + 'payment is received, not the date the invoice was issued.',
  };
}

/** Find the VAT period containing a tax point. Null is an exception, not a default. */
export function findVatPeriod(
  db: AppDatabase, companyId: string, taxPointDate: IsoDate,
): typeof vatPeriods.$inferSelect | undefined {
  return db.select().from(vatPeriods)
    .where(and(
      eq(vatPeriods.companyId, companyId),
      lte(vatPeriods.startDate, taxPointDate),
      gte(vatPeriods.endDate, taxPointDate),
    )).get();
}

export interface CreateVatEntriesInput {
  companyId: string;
  journalEntryId?: string | null;
  sourceType: typeof vatEntries.$inferInsert['sourceType'];
  sourceId?: string | null;
  /**
   * Declare the entry in the VAT period covering this date rather than the one
   * covering its tax point (issue #226): a correction or a late document whose
   * own period's return is locked or filed. The tax point stays true; the
   * choice is recorded on the entry and flagged for review. Never automatic.
   */
  declarationDate?: IsoDate;
  /** The invoice line this entry arises from, for the trace (issue #203). */
  invoiceLineId?: string | null;
  direction: VatDirection;
  treatmentId: string;
  rateOverrideId?: string;
  taxPointDate: IsoDate;
  netMinor?: number;
  grossMinor?: number;
  statedVatMinor?: number;
  /** See `CalculateVatInput.recoverableOverrideMinor` — threaded through so the
   *  posted VAT entry (and hence the VAT3 T2 box) agrees with the journal. */
  recoverableOverrideMinor?: number;
  currency: string;
  baseCurrency: string;
  fxRate?: { numerator: number; denominator: number };
  counterpartyVatNumber?: string | null;
  counterpartyCountry?: string | null;
  source?: 'ai' | 'rule' | 'user' | 'import' | 'system' | 'derived';
  confidence?: number;
  provenanceStatus?: typeof vatEntries.$inferInsert['provenanceStatus'];
  notes?: string | null;
}

export interface CreatedVatEntries {
  entries: Array<typeof vatEntries.$inferSelect>;
  calculation: VatCalculation;
  /** Both legs of a reverse charge, where one applies. */
  isReverseCharge: boolean;
}

/**
 * Create the VAT entries arising from one transaction line.
 *
 * A reverse-charge treatment produces TWO entries from one document: an output
 * entry (T1) and an input entry (T2). This is the reason VAT entries are rows
 * rather than columns on a transaction — a column-based design cannot express
 * one invoice yielding two VAT positions, and it is not an edge case: it is the
 * normal treatment for every EU and US SaaS supplier an Irish company uses.
 */
export function createVatEntries(
  db: AppDatabase, input: CreateVatEntriesInput,
): CreatedVatEntries {
  const resolved = resolveTreatment(db, {
    companyId: input.companyId,
    treatmentId: input.treatmentId,
    onDate: input.taxPointDate,
    rateOverrideId: input.rateOverrideId,
  });

  const calculation = calculateVat({
    treatment: resolved.treatment,
    rateBasisPoints: resolved.rateBasisPoints,
    direction: input.direction,
    netMinor: input.netMinor,
    grossMinor: input.grossMinor,
    statedVatMinor: input.statedVatMinor,
    recoverableOverrideMinor: input.recoverableOverrideMinor,
  });

  const declaredOn = input.declarationDate ?? input.taxPointDate;
  const period = assertVatPeriodWritable(db, input.companyId, declaredOn, 'This VAT');
  const declaredLate = input.declarationDate !== undefined
    && findVatPeriod(db, input.companyId, input.taxPointDate)?.id !== period?.id;
  const toBase = (amount: number): number =>
    input.fxRate ? multiplyRational(asMinor(amount), input.fxRate.numerator, input.fxRate.denominator) : amount;

  const treatment = resolved.treatment;
  const currency = input.currency.toUpperCase();
  const baseCurrency = input.baseCurrency.toUpperCase();

  const common = {
    companyId: input.companyId,
    journalEntryId: input.journalEntryId ?? null,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    invoiceLineId: input.invoiceLineId ?? null,
    vatTreatmentId: treatment.id,
    taxRateId: resolved.rate?.id ?? null,
    // Snapshotted so a later edit to the rate row cannot rewrite history.
    rateBasisPoints: calculation.rateBasisPoints,
    currency,
    baseCurrency,
    taxPointDate: input.taxPointDate,
    vatPeriodId: period?.id ?? null,
    counterpartyVatNumber: input.counterpartyVatNumber ?? null,
    counterpartyCountry: input.counterpartyCountry ?? null,
    source: input.source ?? 'system',
    confidence: input.confidence ?? null,
    provenanceStatus: input.provenanceStatus ?? 'manually_entered',
    notes: declaredLate
      ? [input.notes, `Tax point ${input.taxPointDate}; declared in ${period?.name ?? declaredOn} because its own `
        + 'period\'s return is locked or filed.'].filter(Boolean).join(' ')
      : input.notes ?? null,
  } as const;

  const created: Array<typeof vatEntries.$inferSelect> = [];

  db.transaction((tx) => {
    if (treatment.isReverseCharge) {
      // Leg 1: output VAT, as though we had charged ourselves.
      const outputId = ids.vatEntry();
      const output = tx.insert(vatEntries).values({
        ...common,
        id: outputId,
        direction: 'sales',
        netMinor: calculation.netMinor,
        vatMinor: calculation.vatMinor,
        grossMinor: calculation.grossMinor,
        baseNetMinor: toBase(calculation.netMinor),
        baseVatMinor: toBase(calculation.vatMinor),
        baseGrossMinor: toBase(calculation.grossMinor),
        recoverableVatMinor: 0,
        baseRecoverableVatMinor: 0,
        vatBox: treatment.salesVatBox,
        netBox: treatment.netSalesBox,
        isReverseChargeLeg: true,
      }).returning().get();
      created.push(output);

      // Leg 2: input VAT, reclaimed to the extent the treatment allows.
      const recoverable = input.recoverableOverrideMinor !== undefined
        ? asMinor(input.recoverableOverrideMinor)
        : computeRecoverable(treatment, 'purchases', calculation.vatMinor);
      const input2 = tx.insert(vatEntries).values({
        ...common,
        id: ids.vatEntry(),
        direction: 'purchases',
        netMinor: calculation.netMinor,
        vatMinor: calculation.vatMinor,
        grossMinor: calculation.grossMinor,
        baseNetMinor: toBase(calculation.netMinor),
        baseVatMinor: toBase(calculation.vatMinor),
        baseGrossMinor: toBase(calculation.grossMinor),
        recoverableVatMinor: recoverable,
        baseRecoverableVatMinor: toBase(recoverable),
        vatBox: treatment.purchasesVatBox,
        netBox: treatment.netPurchasesBox,
        isReverseChargeLeg: true,
        pairedEntryId: outputId,
      }).returning().get();
      created.push(input2);

      tx.update(vatEntries).set({ pairedEntryId: input2.id })
        .where(eq(vatEntries.id, outputId)).run();
    } else {
      const entry = tx.insert(vatEntries).values({
        ...common,
        id: ids.vatEntry(),
        direction: input.direction,
        netMinor: calculation.netMinor,
        vatMinor: calculation.vatMinor,
        grossMinor: calculation.grossMinor,
        baseNetMinor: toBase(calculation.netMinor),
        baseVatMinor: toBase(calculation.vatMinor),
        baseGrossMinor: toBase(calculation.grossMinor),
        recoverableVatMinor: calculation.recoverableVatMinor,
        baseRecoverableVatMinor: toBase(calculation.recoverableVatMinor),
        vatBox: input.direction === 'sales' ? treatment.salesVatBox : treatment.purchasesVatBox,
        netBox: input.direction === 'sales' ? treatment.netSalesBox : treatment.netPurchasesBox,
      }).returning().get();
      created.push(entry);
    }
  });

  if (declaredLate && created[0]) {
    // Declaring VAT outside its own period is a judgement an accountant checks.
    db.insert(reviewItems).values({
      id: ids.reviewItem(),
      companyId: input.companyId,
      kind: 'period_validation',
      severity: 'warning',
      title: `VAT with tax point ${input.taxPointDate} declared in ${period?.name ?? declaredOn}`,
      detail: 'The return for the period covering the tax point is locked or filed, so this VAT was declared in a '
        + 'later open period at the person\'s choice. Confirm the correction is made the right way (for an '
        + 'underdeclaration, whether a supplementary return is needed instead).',
      entityType: 'vat_entry',
      entityId: created[0].id,
      dedupeKey: `vat_entry:${created[0].id}:declared_late`,
    }).run();
  }

  return { entries: created, calculation, isReverseCharge: treatment.isReverseCharge };
}

/** The company's configured VAT basis. */
export function vatBasis(db: AppDatabase, companyId: string): 'invoice' | 'cash_receipts' {
  const company = db.select({ basis: companies.vatAccountingBasis }).from(companies)
    .where(eq(companies.id, companyId)).get();
  if (!company) throw new VatError(`Company ${companyId} not found.`);
  return company.basis;
}

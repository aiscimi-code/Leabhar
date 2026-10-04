import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { accounts, vatTreatments } from '@/db/schema';
import { asIsoDate, isIsoDate } from '../dates';
import { asMinor, multiplyRational, vatFromNet, type Minor } from '../money';
import { createAdjustment } from '../accounting/adjustments';
import { upsertReviewItem } from '../extraction/service';
import { resolveTreatment } from './engine';

/**
 * Deemed supplies: output VAT on an event with no sale invoice (issue #645).
 *
 *  - Goods given away or taken out of the business (VATCA s.19(1)(g)) are
 *    deemed supplied for consideration (s.21), on their cost excluding tax
 *    (s.42(1)(a)). A gift that is not one of a series to the same person and
 *    costs the donor no more than €20 excluding tax is not (s.21(a), S.I.
 *    639/2010 reg.5), nor is a reasonable quantity of industrial samples
 *    (s.21(b)). Neither is goods whose tax was not deductible in whole or in
 *    part, unless they came in a s.20(2) transfer of a business.
 *  - Private or non-business use of immovable goods acquired or developed
 *    before 1 January 2011 is a supply of services (s.27(2), (3)) on, for each
 *    taxable period, one sixth of one twentieth of the cost, adjusted for the
 *    private use (s.44(1)): C x D / (20 x 6), D being the private floor area
 *    over the total (reg.7(2), (3)), at the standard rate (reg.7(4)).
 *
 * The person states the facts; the taxable amount and the VAT are calculated
 * here, never typed. Each posts as a VAT adjustment through
 * `createAdjustment`, so a locked or filed period is refused before anything
 * is written, and raises a review item so an accountant sees it.
 *
 * Not covered: a supply of services deemed by regulations under s.27(1),
 * such as free catering for staff (reg.8), and goods sent to another Member
 * State (s.19(1)(h)), which takes its own taxable amount (s.42(2)).
 */

export class DeemedSupplyError extends Error {}

/** S.I. 639/2010 reg.5: the most a gift may cost the donor, exclusive of tax, and not be a supply. */
export const BUSINESS_GIFT_LIMIT_MINOR = asMinor(2_000);

/** VATCA s.27(3): s.27(2) does not apply to immovable goods acquired or developed on or after this date. */
export const SELF_SUPPLY_IMMOVABLE_CUTOFF = '2011-01-01';

export type DeemedSupplyInput = {
  companyId: string;
  /** The day the goods were given or taken, or the last day of the period the property was used in. */
  date: string;
  /** The account the cost of the VAT is charged to: drawings, a director's loan, gifts and entertainment. */
  accountId: string;
  description: string;
  recordedBy: string;
} & (
  | {
      kind: 'goods';
      /** s.19(1)(g): a disposal free of charge, or an appropriation for a non-business purpose. */
      use: 'gift' | 'private_use';
      /** The cost to the business, excluding VAT (s.42(1)(a)). */
      costMinor: number;
      /** The rate the goods would bear if sold: an Irish sales treatment. */
      treatmentCode: string;
      /** The VAT on the goods was deducted in whole or in part, or they came in a s.20(2) business transfer. */
      taxDeductedOrTransferred: boolean;
      /** A gift only: one of a series or succession of gifts to the same person (s.21(a)). */
      partOfSeriesToSamePerson?: boolean;
      /** A gift only: industrial samples in reasonable quantity, in a form not ordinarily sold to the public (s.21(b)). */
      industrialSamples?: boolean;
    }
  | {
      kind: 'immovable_private_use';
      /** When the business acquired or developed the property. */
      acquiredOn: string;
      /** C: the amount on which tax was chargeable on the acquisition or development (reg.7(3)). */
      acquisitionTaxableAmountMinor: number;
      /** A: the floor area used for private or non-business purposes in the period (reg.7(2)). */
      privateFloorArea: number;
      /** B: the total floor area (reg.7(2)). */
      totalFloorArea: number;
      /** The property was treated as a business asset when acquired or developed (s.27(2)(ii)). */
      treatedAsBusinessAsset: boolean;
    }
);

export type DeemedSupplyResult =
  | { posted: true; journalEntryId: string; taxableAmountMinor: Minor; vatMinor: Minor; working: string }
  | { posted: false; reason: string };

function requireText(value: string | undefined, what: string): string {
  const text = value?.trim();
  if (!text) throw new DeemedSupplyError(`Say ${what}.`);
  return text;
}

function requireAmount(value: number, what: string): Minor {
  if (!Number.isInteger(value) || value <= 0) throw new DeemedSupplyError(`${what} must be a positive amount in cent.`);
  return asMinor(value);
}

function treatmentByCode(db: AppDatabase, companyId: string, code: string): typeof vatTreatments.$inferSelect {
  const row = db.select().from(vatTreatments)
    .where(and(eq(vatTreatments.companyId, companyId), eq(vatTreatments.code, code))).get();
  if (!row) throw new DeemedSupplyError(`The VAT treatment ${code} is missing.`);
  return row;
}

const euro = (minor: number): string => `€${(minor / 100).toFixed(2)}`;

/** Why a goods event is not a supply, or null when it is one. */
function goodsNotSupplied(input: Extract<DeemedSupplyInput, { kind: 'goods' }>, cost: Minor): string | null {
  if (!input.taxDeductedOrTransferred) {
    return 'The VAT on these goods was not deductible and they did not come in a business transfer, so giving or '
      + 'taking them is not a supply (VATCA s.19(1)(g)): no VAT is due.';
  }
  if (input.use !== 'gift') return null;
  if (input.industrialSamples) {
    return 'A reasonable quantity of industrial samples, in a form not ordinarily available for sale to the public, '
      + 'is not a supply (VATCA s.21(b)): no VAT is due.';
  }
  if (!input.partOfSeriesToSamePerson && cost <= BUSINESS_GIFT_LIMIT_MINOR) {
    return `A gift costing ${euro(cost)} excluding VAT, not one of a series to the same person, is not a supply: `
      + `the limit is ${euro(BUSINESS_GIFT_LIMIT_MINOR)} (VATCA s.21(a), S.I. 639/2010 reg.5). No VAT is due.`;
  }
  return null;
}

/**
 * Record a deemed supply and post its output VAT, or say why there is none.
 * The VAT is due when the goods are given or taken (s.74(1)(d)); private use
 * of property is charged for the period it is used in (s.44(1)).
 */
export function recordDeemedSupply(db: AppDatabase, input: DeemedSupplyInput): DeemedSupplyResult {
  const who = requireText(input.recordedBy, 'who is recording this: a deemed supply is a person\'s statement');
  const description = requireText(input.description, 'what was given or used');
  if (!isIsoDate(input.date)) throw new DeemedSupplyError('The date must be a date (YYYY-MM-DD).');
  const date = asIsoDate(input.date);
  const account = db.select().from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, input.companyId))).get();
  if (!account) throw new DeemedSupplyError('Name the account the cost of the VAT is charged to.');

  let treatment: typeof vatTreatments.$inferSelect;
  let taxableAmount: Minor;
  let provision: string;
  let working: string;

  if (input.kind === 'goods') {
    const cost = requireAmount(input.costMinor, 'The cost of the goods');
    const reason = goodsNotSupplied(input, cost);
    if (reason) return { posted: false, reason };
    treatment = treatmentByCode(db, input.companyId, input.treatmentCode);
    if (treatment.jurisdiction !== 'IE' || treatment.direction === 'purchases' || treatment.isReverseCharge
      || !treatment.appliesRate) {
      throw new DeemedSupplyError(`${treatment.code} is not a rate an Irish sale of these goods would bear: choose the `
        + 'rate the goods would be sold at.');
    }
    taxableAmount = cost;
    provision = input.use === 'gift' ? 'VATCA s.19(1)(g), s.21' : 'VATCA s.19(1)(g)';
    working = `${input.use === 'gift' ? 'Gift' : 'Goods taken for a non-business purpose'}: taxable amount is the cost `
      + `excluding VAT, ${euro(cost)} (s.42(1)(a))`;
  } else {
    if (!isIsoDate(input.acquiredOn)) throw new DeemedSupplyError('The date the property was acquired must be a date (YYYY-MM-DD).');
    if (input.acquiredOn >= SELF_SUPPLY_IMMOVABLE_CUTOFF) {
      return { posted: false, reason: 'Property acquired or developed on or after 1 January 2011 is outside VATCA s.27(2) '
        + '(s.27(3)): private use of it is not a supply under that section.' };
    }
    if (!input.treatedAsBusinessAsset) {
      return { posted: false, reason: 'The property was not treated as a business asset when acquired or developed, so '
        + 'private use of it is not a supply (VATCA s.27(2)(ii)).' };
    }
    const twentyYearsOn = `${Number(input.acquiredOn.slice(0, 4)) + 20}${input.acquiredOn.slice(4)}`;
    if (date >= twentyYearsOn) {
      return { posted: false, reason: `The use is more than 20 years after the property was acquired on ${input.acquiredOn}, `
        + 'so it is not a supply (VATCA s.27(2)(i)).' };
    }
    const c = requireAmount(input.acquisitionTaxableAmountMinor, 'The amount on which tax was charged on the acquisition');
    const a = input.privateFloorArea;
    const b = input.totalFloorArea;
    if (!Number.isInteger(a) || !Number.isInteger(b) || b <= 0 || a <= 0 || a > b) {
      throw new DeemedSupplyError('The private floor area must be more than none and no more than the total floor area, '
        + 'in whole units (S.I. 639/2010 reg.7(2)).');
    }
    treatment = treatmentByCode(db, input.companyId, 'IE_STD');
    // reg.7(3): C x (A / B) / (20 x 6), one rounding to the cent.
    taxableAmount = multiplyRational(c, a, b * 120);
    provision = 'VATCA s.27(2), s.44';
    working = `Private use of property: ${euro(c)} x ${a}/${b} floor area / (20 x 6) = ${euro(taxableAmount)} `
      + '(s.44(1), S.I. 639/2010 reg.7), at the standard rate (reg.7(4))';
  }

  const rate = resolveTreatment(db, { companyId: input.companyId, treatmentId: treatment.id, onDate: date });
  const vat = vatFromNet(taxableAmount, treatment.appliesRate ? rate.rateBasisPoints : 0);
  working = `${working}; VAT ${euro(vat)}.`;
  if (vat === 0) {
    return { posted: false, reason: `${working} A zero-rated deemed supply gives no VAT to post.` };
  }

  const vatControl = db.select().from(accounts)
    .where(and(eq(accounts.companyId, input.companyId), eq(accounts.systemKey, 'vat_control'))).get();
  if (!vatControl) throw new DeemedSupplyError('The VAT control account is missing.');

  const created = createAdjustment(db, {
    companyId: input.companyId, date, description: `Deemed supply (${provision}): ${description}`,
    reason: `${working} Recorded by ${who}.`,
    lines: [{ accountId: account.id, debitMinor: vat }, { accountId: vatControl.id, creditMinor: vat }],
    vat: { treatmentId: treatment.id, direction: 'sales', netMinor: taxableAmount, statedVatMinor: vat, taxPointDate: date },
    actor: who,
  });
  upsertReviewItem(db, {
    companyId: input.companyId, kind: 'uncertain_vat_treatment', severity: 'info',
    title: `Deemed supply recorded: ${description}`.slice(0, 200),
    detail: `Output VAT of ${euro(vat)} on a supply with no sale invoice (${provision}). ${working} Check the facts `
      + 'stated against the records: the cost, the rate, and for a gift that it is not one of a series to the same person.',
    entityType: 'journal_entry', entityId: created.journalEntryId,
    dedupeKey: `journal_entry:${created.journalEntryId}:deemed_supply`,
  });
  return { posted: true, journalEntryId: created.journalEntryId, taxableAmountMinor: taxableAmount, vatMinor: vat, working };
}

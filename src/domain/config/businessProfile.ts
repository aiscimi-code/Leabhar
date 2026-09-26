import { and, desc, eq, isNull, gt } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import {
  companies, companyTradingNames, companyTradingActivities, companyRegistrations,
  auditEvents, reviewItems, journalEntries,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso, isIsoDate } from '../dates';
import { ConfigurationError } from './mutations';

/**
 * The business behind the books (issue #297, EPIC 02): the names it trades
 * under, the activities it trades in (a farm is one sector among them), the
 * registrations it holds besides VAT and corporation tax, its cross-border
 * identifiers (the EU VAT identification number and the EORI number), and the
 * two lifecycle ends — the trade ceasing and the books being archived.
 *
 * The rules from AGENTS.md that shape this module:
 *
 *  - Everything here is effective-dated, never overwritten. A name, activity
 *    or registration stops on a date; the row stays.
 *  - Facts a person records need that person's name and what the fact rests
 *    on. Nothing is inferred, and every change is audited with the value it
 *    replaced.
 *  - Nothing is silently repaired. Where recording one fact exposes a
 *    problem (the trade has ceased but the VAT registration is still open,
 *    entries posted after the day the trade ceased), a review item is raised
 *    for a person to look at — the system does not decide.
 */

/** The transaction handle inside `db.transaction`, so helpers can share it without casts. */
type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

type CompanyRow = typeof companies.$inferSelect;
type TradingNameRow = typeof companyTradingNames.$inferSelect;
type ActivityRow = typeof companyTradingActivities.$inferSelect;
type RegistrationRow = typeof companyRegistrations.$inferSelect;

export type TradingSector = ActivityRow['sector'];
export type RegistrationType = RegistrationRow['registrationType'];

export const TRADING_SECTORS: TradingSector[] = [
  'farming', 'retail', 'construction', 'professional_services', 'hospitality',
  'transport', 'manufacturing', 'other',
];

export const REGISTRATION_TYPES: RegistrationType[] = ['income_tax', 'paye', 'rct', 'other'];

function load(db: AppDatabase, companyId: string): CompanyRow {
  const row = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!row) throw new ConfigurationError(`Company ${companyId} not found.`);
  return row;
}

function requirePerson(who: string | null | undefined): string {
  const name = who?.trim();
  if (!name) throw new ConfigurationError('Say who is recording this: it is a person\'s decision, not the system\'s.');
  return name;
}

function requireBasis(basis: string | null | undefined, what: string): string {
  const value = basis?.trim();
  if (!value) throw new ConfigurationError(`Say what this rests on: ${what}`);
  return value;
}

function requireDate(value: string | null | undefined, what: string): string {
  if (!value || !isIsoDate(value)) throw new ConfigurationError(`${what} must be a date (YYYY-MM-DD).`);
  return value;
}

type AuditAction = typeof auditEvents.$inferInsert['action'];

function audit(
  tx: Tx,
  params: {
    companyId: string; entityType: string; entityId: string; action: AuditAction; field: string;
    previous: unknown; next: unknown; actor: string; at: string;
  },
): void {
  tx.insert(auditEvents).values({
    id: ids.audit(), companyId: params.companyId, occurredAt: params.at,
    entityType: params.entityType, entityId: params.entityId, action: params.action,
    field: params.field,
    previousValue: params.previous == null ? null : JSON.stringify(params.previous),
    newValue: JSON.stringify(params.next), source: 'user', actor: params.actor,
  }).run();
}

/** Raise a review item (README §20): a detected problem goes to a person. */
function raise(
  tx: Tx,
  params: {
    companyId: string; entityType: string; entityId: string; kind: string;
    severity: 'info' | 'warning' | 'error'; title: string; detail: string;
    dedupeKey: string; context?: Record<string, unknown>;
  },
): void {
  // One open item per problem: recording the same fact again (a corrected
  // cessation date, say) must not stack duplicates in the review queue. The
  // open item is brought up to date instead, so it describes the facts as
  // they are now recorded.
  const open = tx.select({ id: reviewItems.id }).from(reviewItems).where(and(
    eq(reviewItems.companyId, params.companyId), eq(reviewItems.dedupeKey, params.dedupeKey),
    eq(reviewItems.status, 'open'),
  )).get();
  if (open) {
    tx.update(reviewItems).set({
      title: params.title, detail: params.detail, severity: params.severity, context: params.context ?? {},
    }).where(eq(reviewItems.id, open.id)).run();
    return;
  }
  tx.insert(reviewItems).values({
    id: ids.reviewItem(), companyId: params.companyId,
    kind: params.kind as typeof reviewItems.$inferInsert.kind,
    severity: params.severity, title: params.title, detail: params.detail,
    entityType: params.entityType, entityId: params.entityId,
    context: params.context ?? {}, dedupeKey: params.dedupeKey, status: 'open',
  }).run();
}

// ---------------------------------------------------------------------------
// Trading names
// ---------------------------------------------------------------------------

/**
 * Record a name the business trades under. It becomes the current trading name
 * (`companies.tradingName`), updated in the same transaction as the row, so
 * screens keep working off one value while the history of names stays on
 * record. Several names can be in force at once.
 */
export function recordTradingName(db: AppDatabase, params: {
  companyId: string;
  name: string;
  effectiveFrom: string;
  notes?: string | null;
  recordedBy: string;
}): TradingNameRow {
  const who = requirePerson(params.recordedBy);
  const name = params.name?.trim();
  if (!name) throw new ConfigurationError('Give the trading name.');
  const from = requireDate(params.effectiveFrom, 'The date the name is used from');
  const company = load(db, params.companyId);
  const at = nowIso();

  const open = db.select().from(companyTradingNames).where(and(
    eq(companyTradingNames.companyId, params.companyId), isNull(companyTradingNames.effectiveTo),
  )).all();
  if (open.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
    throw new ConfigurationError(`"${name}" is already on record as a current trading name.`);
  }

  const row = db.transaction((tx) => {
    const id = ids.tradingName();
    tx.insert(companyTradingNames).values({
      id, companyId: params.companyId, name, effectiveFrom: from,
      notes: params.notes?.trim() || null, recordedBy: who,
    }).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'trading_name', entityId: id,
      action: 'created', field: 'trading_name', previous: null,
      next: { name, effectiveFrom: from }, actor: who, at,
    });
    if (company.tradingName !== name) {
      tx.update(companies).set({ tradingName: name, updatedAt: at })
        .where(eq(companies.id, params.companyId)).run();
      audit(tx, {
        companyId: params.companyId, entityType: 'company', entityId: params.companyId,
        action: 'settings_changed', field: 'tradingName', previous: company.tradingName,
        next: name, actor: who, at,
      });
    }
    return tx.select().from(companyTradingNames).where(eq(companyTradingNames.id, id)).get()!;
  });
  return row;
}

/**
 * Record when a business stops trading under a name. If it was the current
 * name, the current name passes to the most recent name still in force — or to
 * nothing, if none is.
 */
export function endTradingName(db: AppDatabase, params: {
  companyId: string;
  tradingNameId: string;
  effectiveTo: string;
  recordedBy: string;
}): TradingNameRow {
  const who = requirePerson(params.recordedBy);
  const to = requireDate(params.effectiveTo, 'The date the name stopped being used');
  const row = db.select().from(companyTradingNames).where(and(
    eq(companyTradingNames.id, params.tradingNameId), eq(companyTradingNames.companyId, params.companyId),
  )).get();
  if (!row) throw new ConfigurationError('That trading name is not on record.');
  if (row.effectiveTo) throw new ConfigurationError(`"${row.name}" already stopped being used on ${row.effectiveTo}.`);
  if (to < row.effectiveFrom) {
    throw new ConfigurationError('A name cannot stop being used before it started.');
  }
  const company = load(db, params.companyId);
  const at = nowIso();

  return db.transaction((tx) => {
    tx.update(companyTradingNames).set({ effectiveTo: to, updatedAt: at })
      .where(eq(companyTradingNames.id, row.id)).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'trading_name', entityId: row.id,
      action: 'settings_changed', field: 'effective_to',
      previous: { name: row.name, effectiveTo: null },
      next: { name: row.name, effectiveTo: to }, actor: who, at,
    });
    if (company.tradingName === row.name) {
      const next = tx.select().from(companyTradingNames).where(and(
        eq(companyTradingNames.companyId, params.companyId), isNull(companyTradingNames.effectiveTo),
      )).orderBy(desc(companyTradingNames.effectiveFrom)).get();
      tx.update(companies).set({ tradingName: next?.name ?? null, updatedAt: at })
        .where(eq(companies.id, params.companyId)).run();
      audit(tx, {
        companyId: params.companyId, entityType: 'company', entityId: params.companyId,
        action: 'settings_changed', field: 'tradingName', previous: company.tradingName,
        next: next?.name ?? null, actor: who, at,
      });
    }
    return { ...row, effectiveTo: to };
  });
}

// ---------------------------------------------------------------------------
// Trading activities
// ---------------------------------------------------------------------------

/**
 * Record an activity the business trades in. A business can run several, each
 * with its own dates; farming carries the Department of Agriculture herd
 * number, which stock relief and the herd basis turn on.
 */
export function recordTradingActivity(db: AppDatabase, params: {
  companyId: string;
  name: string;
  sector: TradingSector;
  commencedOn: string;
  /** Department of Agriculture herd number. Farming only. */
  herdNumber?: string | null;
  notes?: string | null;
  recordedBy: string;
}): ActivityRow {
  const who = requirePerson(params.recordedBy);
  const name = params.name?.trim();
  if (!name) throw new ConfigurationError('Give the name of the activity.');
  if (!TRADING_SECTORS.includes(params.sector)) {
    throw new ConfigurationError('Choose the sector this activity trades in.');
  }
  const from = requireDate(params.commencedOn, 'The date the activity commenced');
  const herd = params.herdNumber?.trim() || null;
  if (herd && params.sector !== 'farming') {
    throw new ConfigurationError('A herd number is recorded for farming only.');
  }

  const open = db.select().from(companyTradingActivities).where(and(
    eq(companyTradingActivities.companyId, params.companyId), isNull(companyTradingActivities.ceasedOn),
  )).all();
  if (open.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
    throw new ConfigurationError(`"${name}" is already on record as a current activity.`);
  }

  const at = nowIso();
  return db.transaction((tx) => {
    const id = ids.tradingActivity();
    tx.insert(companyTradingActivities).values({
      id, companyId: params.companyId, name, sector: params.sector, commencedOn: from,
      herdNumber: herd, notes: params.notes?.trim() || null, recordedBy: who,
    }).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'trading_activity', entityId: id,
      action: 'created', field: 'trading_activity', previous: null,
      next: { name, sector: params.sector, commencedOn: from, herdNumber: herd }, actor: who, at,
    });
    return tx.select().from(companyTradingActivities).where(eq(companyTradingActivities.id, id)).get()!;
  });
}

/** Record when an activity stopped. The row stays; its window closes. */
export function ceaseTradingActivity(db: AppDatabase, params: {
  companyId: string;
  activityId: string;
  ceasedOn: string;
  recordedBy: string;
}): ActivityRow {
  const who = requirePerson(params.recordedBy);
  const ceasedOn = requireDate(params.ceasedOn, 'The date the activity ceased');
  const row = db.select().from(companyTradingActivities).where(and(
    eq(companyTradingActivities.id, params.activityId), eq(companyTradingActivities.companyId, params.companyId),
  )).get();
  if (!row) throw new ConfigurationError('That trading activity is not on record.');
  if (row.ceasedOn) throw new ConfigurationError(`"${row.name}" already ceased on ${row.ceasedOn}.`);
  if (ceasedOn < row.commencedOn) throw new ConfigurationError('An activity cannot cease before it commenced.');

  const at = nowIso();
  return db.transaction((tx) => {
    tx.update(companyTradingActivities).set({ ceasedOn, updatedAt: at })
      .where(eq(companyTradingActivities.id, row.id)).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'trading_activity', entityId: row.id,
      action: 'settings_changed', field: 'ceased_on',
      previous: { name: row.name, ceasedOn: null },
      next: { name: row.name, ceasedOn }, actor: who, at,
    });
    return { ...row, ceasedOn };
  });
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

/**
 * Record a registration the books need to know about: income tax (a sole
 * trader's or partnership's own), PAYE (the employer registration payroll
 * runs against, EPIC 20, #315), RCT, or anything else. VAT and corporation tax are not
 * recorded here; they are dated columns on the company because VAT turns on
 * them everywhere.
 */
export function recordRegistration(db: AppDatabase, params: {
  companyId: string;
  registrationType: RegistrationType;
  /** What the registration is, required when the type is 'other'. */
  label?: string | null;
  registrationNumber?: string | null;
  registeredFrom: string;
  notes?: string | null;
  recordedBy: string;
}): { registration: RegistrationRow; warnings: string[] } {
  const who = requirePerson(params.recordedBy);
  if (!REGISTRATION_TYPES.includes(params.registrationType)) {
    throw new ConfigurationError('Choose what kind of registration this is.');
  }
  const company = load(db, params.companyId);
  const label = params.label?.trim() || null;
  if (params.registrationType === 'other' && !label) {
    throw new ConfigurationError('Name this registration: "other" is not a description a person can check later.');
  }
  const from = requireDate(params.registeredFrom, 'The date the registration took effect');
  const number = params.registrationNumber?.trim() || null;
  if (!number && params.registrationType !== 'other') {
    throw new ConfigurationError(
      'Record the registration number: without it this is a note, not a registration.',
    );
  }
  if (params.registrationType === 'income_tax' && company.entityType === 'company') {
    throw new ConfigurationError(
      'A company registers for corporation tax, not income tax: its profits are charged under TCA Part 4. ' +
      'Income tax registration belongs to a sole trader or the partners in a partnership.',
    );
  }

  const open = db.select().from(companyRegistrations).where(and(
    eq(companyRegistrations.companyId, params.companyId), isNull(companyRegistrations.deregisteredOn),
  )).all();
  const clashes = (row: RegistrationRow) => params.registrationType === 'other'
    ? row.registrationType === 'other' && row.label?.toLowerCase() === label?.toLowerCase()
    : row.registrationType === params.registrationType;
  if (open.some(clashes)) {
    throw new ConfigurationError(
      params.registrationType === 'other'
        ? `"${label}" is already on record as a current registration.`
        : `A current ${params.registrationType.replace(/_/g, ' ')} registration is already on record.`,
    );
  }

  const warnings: string[] = [];

  const at = nowIso();
  const registration = db.transaction((tx) => {
    const id = ids.registration();
    tx.insert(companyRegistrations).values({
      id, companyId: params.companyId, registrationType: params.registrationType,
      label, registrationNumber: number, registeredFrom: from,
      notes: params.notes?.trim() || null, recordedBy: who,
    }).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'registration', entityId: id,
      action: 'created', field: 'registration', previous: null,
      next: { type: params.registrationType, label, number, registeredFrom: from }, actor: who, at,
    });
    return tx.select().from(companyRegistrations).where(eq(companyRegistrations.id, id)).get()!;
  });
  return { registration, warnings };
}

/** Record when a registration ended. The row stays; its window closes. */
export function endRegistration(db: AppDatabase, params: {
  companyId: string;
  registrationId: string;
  deregisteredOn: string;
  recordedBy: string;
}): RegistrationRow {
  const who = requirePerson(params.recordedBy);
  const deregisteredOn = requireDate(params.deregisteredOn, 'The date the registration ended');
  const row = db.select().from(companyRegistrations).where(and(
    eq(companyRegistrations.id, params.registrationId), eq(companyRegistrations.companyId, params.companyId),
  )).get();
  if (!row) throw new ConfigurationError('That registration is not on record.');
  if (row.deregisteredOn) throw new ConfigurationError('This registration is already recorded as ended.');
  if (deregisteredOn < row.registeredFrom) {
    throw new ConfigurationError('A registration cannot end before it took effect.');
  }

  const at = nowIso();
  return db.transaction((tx) => {
    tx.update(companyRegistrations).set({ deregisteredOn, updatedAt: at })
      .where(eq(companyRegistrations.id, row.id)).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'registration', entityId: row.id,
      action: 'settings_changed', field: 'deregistered_on',
      previous: { type: row.registrationType, label: row.label, deregisteredOn: null },
      next: { type: row.registrationType, label: row.label, deregisteredOn }, actor: who, at,
    });
    return { ...row, deregisteredOn };
  });
}

// ---------------------------------------------------------------------------
// Cross-border identifiers: EU VAT identification number, EORI
// ---------------------------------------------------------------------------

const EU_VAT_PATTERN = /^[A-Z]{2}[A-Z0-9+*]{2,13}$/;
const EORI_PATTERN = /^[A-Z]{2}[A-Z0-9]{1,15}$/;

/**
 * Record the business's VAT identification number for intra-Community
 * transactions (VIES): the VAT registration number with its Member State
 * prefix (`IE1234567T` for an Irish registration). It is kept beside
 * `vatNumber` because it is what customers in other Member States quote and
 * what VIES validates; the compliance profile flags it when it does not match
 * the registration number. A person records it and says what they checked it
 * against.
 */
export function recordEuVatNumber(db: AppDatabase, params: {
  companyId: string;
  vatNumber: string;
  registeredFrom: string;
  /** What was relied on, e.g. "checked on VIES" or "as issued on ROS". */
  basis: string;
  confirmedBy: string;
}): void {
  const who = requirePerson(params.confirmedBy);
  const basis = requireBasis(
    params.basis,
    'say what it was checked against (VIES, or the Revenue correspondence that issued it).',
  );
  const number = params.vatNumber?.replace(/\s+/g, '').toUpperCase() ?? '';
  if (!EU_VAT_PATTERN.test(number)) {
    throw new ConfigurationError(
      `"${params.vatNumber}" is not a VAT identification number: it starts with a Member State's two-letter ` +
      'code followed by the number that state issued.',
    );
  }
  const from = requireDate(params.registeredFrom, 'The date the number has applied from');
  const company = load(db, params.companyId);
  const at = nowIso();
  db.transaction((tx) => {
    tx.update(companies).set({
      euVatNumber: number, euVatRegisteredFrom: from, euVatBasis: basis,
      euVatConfirmedBy: who, euVatConfirmedAt: at, updatedAt: at,
    }).where(eq(companies.id, params.companyId)).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'company', entityId: params.companyId,
      action: 'user_confirmed', field: 'eu_vat_number',
      previous: company.euVatNumber
        ? { number: company.euVatNumber, from: company.euVatRegisteredFrom, basis: company.euVatBasis }
        : null,
      next: { number, from, basis }, actor: who, at,
    });
  });
}

/**
 * Record the business's EORI number for customs. A person records it and says
 * what they checked it against; the confirmation is kept beside the number so
 * the two travel together.
 */
export function recordEoriNumber(db: AppDatabase, params: {
  companyId: string;
  eoriNumber: string;
  /** What was relied on, e.g. "validated on the EU EORI portal". */
  basis: string;
  confirmedBy: string;
}): void {
  const who = requirePerson(params.confirmedBy);
  const basis = requireBasis(params.basis, 'say what it was checked against (the EU EORI validation portal, say).');
  const number = params.eoriNumber?.replace(/\s+/g, '').toUpperCase() ?? '';
  if (!EORI_PATTERN.test(number)) {
    throw new ConfigurationError(
      `"${params.eoriNumber}" is not an EORI number: it starts with a country's two-letter code followed by up ` +
      'to fifteen letters and digits.',
    );
  }
  const company = load(db, params.companyId);
  const at = nowIso();
  db.transaction((tx) => {
    tx.update(companies).set({
      eoriNumber: number, eoriBasis: basis, eoriConfirmedBy: who, eoriConfirmedAt: at, updatedAt: at,
    }).where(eq(companies.id, params.companyId)).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'company', entityId: params.companyId,
      action: 'user_confirmed', field: 'eori_number',
      previous: company.eoriNumber
        ? { number: company.eoriNumber, basis: company.eoriBasis }
        : null,
      next: { number, basis }, actor: who, at,
    });
  });
}

// ---------------------------------------------------------------------------
// Lifecycle: ceasing trade, archiving
// ---------------------------------------------------------------------------

/**
 * Record that the trade ceased (issue #297). This is the fact the income tax
 * basis periods turn on (TCA ss.66-67), so it is recorded by a person, from a
 * date, with what is known about why. It does not close the books: periods and
 * filings after that day are a person's decision, and anything the date
 * exposes is raised for review rather than decided here.
 *
 * Where the VAT registration is known to have ended, its date is given here and
 * recorded; where it has not, a review item says so, because ceasing to trade
 * normally ends the registration but nothing here cancels it for you.
 */
export function ceaseTrade(db: AppDatabase, params: {
  companyId: string;
  ceasedOn: string;
  /** What is known: "sold the trade", "retired", "dissolved". */
  basis: string;
  /** The date Revenue cancelled the VAT registration, if known. */
  vatDeregistrationOn?: string | null;
  confirmedBy: string;
}): { warnings: string[] } {
  const who = requirePerson(params.confirmedBy);
  const basis = requireBasis(params.basis, 'say what is known about why the trade ceased.');
  const ceasedOn = requireDate(params.ceasedOn, 'The date the trade ceased');
  const company = load(db, params.companyId);
  if (company.tradeCommencedOn && ceasedOn < company.tradeCommencedOn) {
    throw new ConfigurationError('The trade cannot cease before it commenced.');
  }
  const vatDeregistrationOn = params.vatDeregistrationOn
    ? requireDate(params.vatDeregistrationOn, 'The VAT deregistration date')
    : null;
  if (vatDeregistrationOn && company.vatRegistrationStatus === 'not_registered') {
    throw new ConfigurationError('The company is not registered for VAT, so there is no registration to cancel.');
  }

  const warnings: string[] = [];
  if (company.tradeCeasedOn && company.tradeCeasedOn !== ceasedOn) {
    warnings.push(
      `The trade was previously recorded as ceasing on ${company.tradeCeasedOn}; this replaces that date and the ` +
      'audit trail keeps both. If anything was filed on the strength of the old date, check it still stands.',
    );
  }

  const at = nowIso();
  db.transaction((tx) => {
    tx.update(companies).set({ tradeCeasedOn: ceasedOn, updatedAt: at })
      .where(eq(companies.id, params.companyId)).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'company', entityId: params.companyId,
      action: 'user_confirmed', field: 'trade_ceased_on', previous: company.tradeCeasedOn,
      next: { date: ceasedOn, basis }, actor: who, at,
    });

    if (vatDeregistrationOn) {
      tx.update(companies).set({
        vatDeregistrationDate: vatDeregistrationOn,
        vatRegistrationStatus: 'deregistered', updatedAt: at,
      }).where(eq(companies.id, params.companyId)).run();
      audit(tx, {
        companyId: params.companyId, entityType: 'company', entityId: params.companyId,
        action: 'user_confirmed', field: 'vat_deregistration_date',
        previous: company.vatDeregistrationDate, next: vatDeregistrationOn, actor: who, at,
      });
    } else if (company.vatRegistrationStatus === 'registered') {
      raise(tx, {
        companyId: params.companyId, entityType: 'company', entityId: params.companyId,
        kind: 'other', severity: 'warning',
        title: `Trade ceased on ${ceasedOn} but the VAT registration is still recorded as registered`,
        detail: 'Ceasing to trade normally ends the VAT registration, but this application will not cancel it for ' +
          'you: the date Revenue cancels it decides the final return and any VAT still due. When you have the ' +
          'date, record it on the closure form.',
        dedupeKey: `vat_registration_open_after_cease:${params.companyId}`,
        context: { ceasedOn },
      });
    }

    // Entries posted after the day the trade ceased may be right (final
    // invoices, winding-up costs) or may be mis-dated. A person decides.
    const after = tx.select({ id: journalEntries.id, entryDate: journalEntries.entryDate })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, params.companyId), gt(journalEntries.entryDate, ceasedOn)))
      .limit(1).get();
    if (after) {
      raise(tx, {
        companyId: params.companyId, entityType: 'company', entityId: params.companyId,
        kind: 'transaction_outside_period', severity: 'warning',
        title: 'Posted entries are dated after the day the trade ceased',
        detail: `The trade is recorded as ceasing on ${ceasedOn}, and entries exist dated after it. Some may be ` +
          'right — final invoices, professional fees for winding up — but posted entries are immutable, so a ' +
          'mis-dated one is corrected by a reversing entry, never by editing it.',
        dedupeKey: `entries_after_trade_ceased:${params.companyId}`,
        context: { ceasedOn, firstEntryDate: after.entryDate },
      });
    }
  });
  return { warnings };
}

/**
 * Take the business out of the working set without deleting anything
 * (issue #297). An archived business is no longer the active one, but it can
 * be brought back, and its books, documents and audit trail are untouched.
 */
export function archiveCompany(db: AppDatabase, params: {
  companyId: string;
  /** Why: sold, dissolved, moved to another system, simply finished with. */
  basis: string;
  confirmedBy: string;
}): { warnings: string[] } {
  const who = requirePerson(params.confirmedBy);
  const basis = requireBasis(params.basis, 'say why these books are being archived.');
  const company = load(db, params.companyId);
  if (company.archivedAt) throw new ConfigurationError('This business is already archived.');

  const warnings: string[] = [];
  if (!company.tradeCeasedOn) {
    warnings.push(
      'These books are archived with no trade cessation recorded. If the trade has in fact ended, record the ' +
      'closure date as well so the tax basis periods are right.',
    );
  }

  const at = nowIso();
  db.transaction((tx) => {
    tx.update(companies).set({
      archivedAt: at, archivedBy: who, archiveBasis: basis, updatedAt: at,
    }).where(eq(companies.id, params.companyId)).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'company', entityId: params.companyId,
      action: 'user_confirmed', field: 'archived_at', previous: null,
      next: { at, basis }, actor: who, at,
    });
  });
  return { warnings };
}

/** Bring an archived business back into the working set. */
export function unarchiveCompany(db: AppDatabase, params: {
  companyId: string;
  confirmedBy: string;
}): void {
  const who = requirePerson(params.confirmedBy);
  const company = load(db, params.companyId);
  if (!company.archivedAt) throw new ConfigurationError('This business is not archived.');
  const at = nowIso();
  db.transaction((tx) => {
    tx.update(companies).set({
      archivedAt: null, archivedBy: null, archiveBasis: null, updatedAt: at,
    }).where(eq(companies.id, params.companyId)).run();
    audit(tx, {
      companyId: params.companyId, entityType: 'company', entityId: params.companyId,
      action: 'user_confirmed', field: 'archived_at',
      previous: { at: company.archivedAt, basis: company.archiveBasis }, next: null, actor: who, at,
    });
  });
}

// ---------------------------------------------------------------------------
// The compliance profile
// ---------------------------------------------------------------------------

export interface ComplianceGap {
  code: string;
  /** 'gap' — something the books need is not recorded; 'check' — recorded facts disagree. */
  kind: 'gap' | 'check';
  message: string;
}

export interface ComplianceProfile {
  companyId: string;
  legalName: string;
  entityType: CompanyRow['entityType'];
  tradeCommencedOn: string | null;
  tradeCeasedOn: string | null;
  archivedAt: string | null;
  vat: {
    status: CompanyRow['vatRegistrationStatus'];
    number: string | null;
    registeredFrom: string | null;
    deregisteredOn: string | null;
    euVatNumber: string | null;
    basis: 'invoice' | 'cash_receipts';
  };
  corporationTax: { registered: boolean; registeredFrom: string | null };
  eori: { number: string | null; confirmedBy: string | null; confirmedAt: string | null } | null;
  tradingNames: TradingNameRow[];
  tradingActivities: ActivityRow[];
  registrations: RegistrationRow[];
  gaps: ComplianceGap[];
}

/**
 * One view of every registration the business holds and where each fact is
 * still missing (issue #297). Nothing here writes; it assembles the recorded
 * facts and names the gaps, so the person working through them sees the whole
 * profile on one screen instead of hunting through settings.
 */
export function complianceProfile(db: AppDatabase, companyId: string): ComplianceProfile {
  const company = load(db, companyId);
  const [tradingNames, tradingActivities, registrations] = [
    db.select().from(companyTradingNames).where(eq(companyTradingNames.companyId, companyId))
      .orderBy(companyTradingNames.effectiveFrom).all(),
    db.select().from(companyTradingActivities).where(eq(companyTradingActivities.companyId, companyId))
      .orderBy(companyTradingActivities.commencedOn).all(),
    db.select().from(companyRegistrations).where(eq(companyRegistrations.companyId, companyId))
      .orderBy(companyRegistrations.registeredFrom).all(),
  ];

  const gaps: ComplianceGap[] = [];
  const ownsIncomeTax = company.entityType === 'sole_trader' || company.entityType === 'partnership';
  const incomeTax = registrations.find(
    (r) => r.registrationType === 'income_tax' && !r.deregisteredOn,
  );
  if (ownsIncomeTax && !incomeTax) {
    gaps.push({
      code: 'income_tax_registration_missing',
      kind: 'gap',
      message: 'The business is a ' + company.entityType.replace(/_/g, ' ') + ' and its profits are charged to ' +
        'income tax on the owner' + (company.entityType === 'partnership' ? 's' : '') +
        ', but no income tax registration is recorded. The tax reference is what a Form 11 (and a partnership\'s ' +
        'Form 1 (Firms)) is filed against.',
    });
  }
  if (company.entityType === 'company' && !company.corporationTaxRegistered) {
    gaps.push({
      code: 'corporation_tax_registration_missing',
      kind: 'gap',
      message: 'A company\'s profits are charged to corporation tax, but no corporation tax registration is ' +
        'recorded. The CT1 is filed against it.',
    });
  }
  if (company.vatRegistrationStatus === 'registered' && !company.vatNumber) {
    gaps.push({
      code: 'vat_number_missing',
      kind: 'gap',
      message: 'The company is recorded as registered for VAT with no VAT number. Returns and the VIES statement ' +
        'are filed against the number.',
    });
  }
  const compact = (v: string) => v.replace(/\s+/g, '').toUpperCase();
  if (company.euVatNumber && company.vatNumber) {
    const registration = compact(company.vatNumber).replace(/^IE/, '');
    if (compact(company.euVatNumber) !== `IE${registration}`) {
      gaps.push({
        code: 'eu_vat_number_mismatch',
        kind: 'check',
        message: `The EU VAT identification number (${company.euVatNumber}) is not the VAT registration number ` +
          `(${company.vatNumber}) with the IE prefix. Customers in other Member States quote the identification ` +
          'number and VIES validates it, so check which one is right.',
      });
    }
  }
  if (company.tradeCeasedOn && company.vatRegistrationStatus === 'registered') {
    gaps.push({
      code: 'vat_registration_open_after_cease',
      kind: 'check',
      message: `The trade is recorded as ceasing on ${company.tradeCeasedOn}, but the VAT registration is still ` +
        'recorded as registered. When Revenue cancels it, record the date so the final return is right.',
    });
  }
  const farming = tradingActivities.filter(
    (a) => a.sector === 'farming' && !a.ceasedOn,
  );
  if (farming.some((a) => !a.herdNumber)) {
    gaps.push({
      code: 'herd_number_missing',
      kind: 'gap',
      message: 'A farming activity is recorded with no herd number. The Department of Agriculture herd number ' +
        'identifies the holding; stock relief and the herd basis are worked per herd.',
    });
  }
  const liveActivities = tradingActivities.filter((a) => !a.ceasedOn);
  if (tradingActivities.length === 0) {
    gaps.push({
      code: 'trading_activities_missing',
      kind: 'gap',
      message: 'No trading activity is recorded. What the business trades in decides which rules apply — ' +
        'farming, construction, professional services each turn on their own.',
    });
  } else if (tradingActivities.every((a) => a.ceasedOn) && !company.tradeCeasedOn) {
    gaps.push({
      code: 'activities_ceased_trade_open',
      kind: 'check',
      message: 'Every recorded trading activity has ceased, but the trade itself is not recorded as ceased. If ' +
        'nothing is being traded, record the closure.',
    });
  }

  return {
    companyId,
    legalName: company.legalName,
    entityType: company.entityType,
    tradeCommencedOn: company.tradeCommencedOn,
    tradeCeasedOn: company.tradeCeasedOn,
    archivedAt: company.archivedAt,
    vat: {
      status: company.vatRegistrationStatus,
      number: company.vatNumber,
      registeredFrom: company.vatRegistrationDate,
      deregisteredOn: company.vatDeregistrationDate,
      euVatNumber: company.euVatNumber,
      basis: company.vatAccountingBasis,
    },
    corporationTax: {
      registered: company.corporationTaxRegistered,
      registeredFrom: company.corporationTaxRegistrationDate,
    },
    eori: company.eoriNumber
      ? { number: company.eoriNumber, confirmedBy: company.eoriConfirmedBy, confirmedAt: company.eoriConfirmedAt }
      : null,
    tradingNames,
    tradingActivities,
    registrations,
    gaps,
  };
}

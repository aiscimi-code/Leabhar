import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { suppliers, customers, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { parseVatNumber } from '../extraction/vatNumbers';

/**
 * Facts about a supplier or customer that VAT turns on and that no document
 * or country code proves (issue #207): where it is established (EU Reg
 * 282/2011 arts.10-11), whether a customer buys as a taxable person (art.18),
 * and whether its VAT number is valid (VIES). A person confirms the first
 * two and says what they relied on; the third is checked with the European
 * Commission's VIES service and the answer stored as evidence. Each change
 * is audited.
 */

export type PartyKind = 'supplier' | 'customer';

function partyTable(kind: PartyKind) {
  return kind === 'supplier' ? suppliers : customers;
}

function loadParty(db: AppDatabase, companyId: string, kind: PartyKind, partyId: string) {
  const table = partyTable(kind);
  const row = db.select().from(table).where(and(eq(table.id, partyId), eq(table.companyId, companyId))).get();
  if (!row) throw new Error(`${kind === 'supplier' ? 'Supplier' : 'Customer'} ${partyId} not found.`);
  return row;
}

function requirePerson(confirmedBy: string): string {
  const who = confirmedBy?.trim();
  if (!who) throw new Error('Say who is confirming this: establishment and taxable status are a person\'s decision.');
  return who;
}

export function confirmEstablishment(db: AppDatabase, params: {
  companyId: string; party: PartyKind; partyId: string;
  establishment: 'in_state' | 'outside_state';
  /** What was relied on, e.g. "seat in Germany; no branch or staff in Ireland". */
  basis: string;
  confirmedBy: string;
}): void {
  const who = requirePerson(params.confirmedBy);
  const basis = params.basis?.trim();
  if (!basis) {
    throw new Error('Say what the establishment rests on (its seat of economic activity, or a fixed establishment '
      + 'with staff and equipment; EU Reg 282/2011 arts.10-11). A country or an address is not enough on its own.');
  }
  const before = loadParty(db, params.companyId, params.party, params.partyId);
  const table = partyTable(params.party);
  const at = nowIso();
  db.transaction((tx) => {
    tx.update(table).set({
      establishment: params.establishment, establishmentBasis: basis,
      establishmentConfirmedBy: who, establishmentConfirmedAt: at, updatedAt: at,
    }).where(eq(table.id, params.partyId)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: at,
      entityType: params.party, entityId: params.partyId, action: 'user_confirmed', field: 'establishment',
      previousValue: before.establishment ? JSON.stringify({ establishment: before.establishment, basis: before.establishmentBasis }) : null,
      newValue: JSON.stringify({ establishment: params.establishment, basis }),
      source: 'user', actor: who,
    }).run();
  });
}

export function confirmCustomerTaxableStatus(db: AppDatabase, params: {
  companyId: string; customerId: string;
  taxableStatus: 'taxable_person' | 'non_taxable_person';
  confirmedBy: string;
}): void {
  const who = requirePerson(params.confirmedBy);
  const before = loadParty(db, params.companyId, 'customer', params.customerId) as typeof customers.$inferSelect;
  const at = nowIso();
  db.transaction((tx) => {
    tx.update(customers).set({
      taxableStatus: params.taxableStatus, taxableStatusConfirmedBy: who, taxableStatusConfirmedAt: at, updatedAt: at,
    }).where(eq(customers.id, params.customerId)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: at,
      entityType: 'customer', entityId: params.customerId, action: 'user_confirmed', field: 'taxable_status',
      previousValue: before.taxableStatus, newValue: params.taxableStatus, source: 'user', actor: who,
    }).run();
  });
}

// ---- VIES ----

export const VIES_CHECK_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number';

export interface ViesResult {
  status: 'valid' | 'invalid' | 'unavailable';
  checkedVatNumber: string;
  name: string | null;
  address: string | null;
  requestIdentifier: string | null;
  /** Why the answer is 'unavailable', when it is. */
  detail: string | null;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Check a party's VAT number with VIES and store the answer (issue #207).
 *
 * Only an EU VAT number can be checked. The request names the company's own
 * VAT number when it has one, so VIES returns a consultation number: the
 * proof the check was made. Anything but a clear yes or no ("service
 * unavailable", a network error) is stored as 'unavailable', never as valid.
 */
export async function checkVatNumberWithVies(db: AppDatabase, params: {
  companyId: string; party: PartyKind; partyId: string;
  /** The company's own VAT number, for a consultation number. */
  requesterVatNumber?: string | null;
  actor: string;
  fetchImpl?: Fetch;
}): Promise<ViesResult> {
  const party = loadParty(db, params.companyId, params.party, params.partyId);
  if (!party.vatNumber) throw new Error(`${party.name} has no VAT number to check.`);
  const parsed = parseVatNumber(party.vatNumber);
  if (!parsed.isEu || !parsed.structurallyValid) {
    throw new Error(`${parsed.normalised} is not a well-formed EU VAT number, so VIES cannot check it.`);
  }
  const prefix = parsed.normalised.slice(0, 2);
  const number = parsed.normalised.slice(2);
  const requester = params.requesterVatNumber ? parseVatNumber(params.requesterVatNumber) : null;
  const body: Record<string, string> = { countryCode: prefix, vatNumber: number };
  if (requester?.structurallyValid && requester.isEu) {
    body.requesterMemberStateCode = requester.normalised.slice(0, 2);
    body.requesterNumber = requester.normalised.slice(2);
  }

  const doFetch = params.fetchImpl ?? (fetch as unknown as Fetch);
  let result: ViesResult;
  try {
    const response = await doFetch(VIES_CHECK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    const json = await response.json() as Record<string, unknown>;
    if (response.ok && typeof json.valid === 'boolean') {
      const text = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim() !== '---' ? v.trim() : null);
      result = {
        status: json.valid ? 'valid' : 'invalid', checkedVatNumber: parsed.normalised,
        name: text(json.name), address: text(json.address), requestIdentifier: text(json.requestIdentifier), detail: null,
      };
    } else {
      const errors = Array.isArray(json.errorWrappers)
        ? json.errorWrappers.map((e) => (e as { error?: string }).error).filter(Boolean).join(', ') : '';
      result = {
        status: 'unavailable', checkedVatNumber: parsed.normalised, name: null, address: null, requestIdentifier: null,
        detail: errors || `VIES answered HTTP ${response.status}`,
      };
    }
  } catch (err) {
    result = {
      status: 'unavailable', checkedVatNumber: parsed.normalised, name: null, address: null, requestIdentifier: null,
      detail: `VIES could not be reached: ${(err as Error).message}`,
    };
  }

  const table = partyTable(params.party);
  const at = nowIso();
  db.transaction((tx) => {
    tx.update(table).set({
      viesStatus: result.status, viesCheckedAt: at, viesCheckedVatNumber: result.checkedVatNumber,
      viesName: result.name, viesAddress: result.address, viesRequestIdentifier: result.requestIdentifier,
      vatNumberValidated: result.status === 'valid', updatedAt: at,
    }).where(eq(table.id, params.partyId)).run();
    tx.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: at,
      entityType: params.party, entityId: params.partyId, action: 'updated', field: 'vies_status',
      previousValue: party.viesStatus ?? null,
      newValue: JSON.stringify({ status: result.status, vatNumber: result.checkedVatNumber, requestIdentifier: result.requestIdentifier }),
      source: 'system', actor: params.actor, reason: result.detail,
    }).run();
  });
  return result;
}

/** Whether the stored VIES answer still applies to the VAT number on record. */
export function viesCurrent(party: { vatNumber: string | null; viesStatus: string | null; viesCheckedVatNumber: string | null }): boolean {
  if (!party.vatNumber || !party.viesStatus || !party.viesCheckedVatNumber) return false;
  return parseVatNumber(party.vatNumber).normalised === party.viesCheckedVatNumber;
}

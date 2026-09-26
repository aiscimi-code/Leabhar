import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { suppliers, customers, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { loadStatutoryKnowledgeBase } from '../rules/knowledgeBase';
import { suggestVatTreatment } from '../rules/vatSuggestion';
import { confirmEstablishment, confirmCustomerTaxableStatus, checkVatNumberWithVies, viesCurrent, VIES_CHECK_URL } from './status';
import type { AppDatabase } from '@/db';

/** Issue #207: establishment and customer status are confirmed by a person; VAT numbers are checked with VIES. */

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let tr: Record<string, string>;

beforeAll(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Parties Ltd', vatRegistrationStatus: 'registered', seedYears: [2026] });
  companyId = created.companyId;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2026-01-01', accountId: created.accountsByKey['bank_control']!,
  });
  loadStatutoryKnowledgeBase(db, { companyId });
});

const supplier = (name: string, over: Partial<typeof suppliers.$inferInsert> = {}) => {
  const id = ids.supplier();
  db.insert(suppliers).values({ id, companyId, name, matchKey: name.toLowerCase(), ...over }).run();
  return id;
};
const customer = (name: string, over: Partial<typeof customers.$inferInsert> = {}) => {
  const id = ids.customer();
  db.insert(customers).values({ id, companyId, name, matchKey: name.toLowerCase(), ...over }).run();
  return id;
};
const tx = (description: string, amountMinor: number, over: Record<string, unknown> = {}) => insertTestBankTransaction(db, {
  companyId, bankAccountId, transactionDate: '2026-03-15', description, amountMinor, ...over,
});
const answer = (status: number, json: unknown) => async () => ({ ok: status < 300, status, json: async () => json });

describe('confirming establishment', () => {
  it('requires a person and a basis, stores both, and audits the change', () => {
    const id = supplier('Anthropic PBC', { countryCode: 'US' });
    expect(() => confirmEstablishment(db, { companyId, party: 'supplier', partyId: id, establishment: 'outside_state', basis: '', confirmedBy: 'joe' }))
      .toThrow(/what the establishment rests on/);
    expect(() => confirmEstablishment(db, { companyId, party: 'supplier', partyId: id, establishment: 'outside_state', basis: 'seat in the US', confirmedBy: ' ' }))
      .toThrow(/who is confirming/);
    confirmEstablishment(db, {
      companyId, party: 'supplier', partyId: id, establishment: 'outside_state',
      basis: 'Seat of economic activity in San Francisco; no branch or staff in Ireland', confirmedBy: 'joe',
    });
    const row = db.select().from(suppliers).where(eq(suppliers.id, id)).get()!;
    expect(row).toMatchObject({ establishment: 'outside_state', establishmentConfirmedBy: 'joe' });
    const audit = db.select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.field, 'establishment'))).get()!;
    expect(audit).toMatchObject({ action: 'user_confirmed', actor: 'joe', source: 'user' });
  });

  it('once confirmed, a US SaaS charge gets the s.12 reverse charge; before, it is flagged', () => {
    const id = supplier('Claude Tools Inc', { countryCode: 'US', defaultVatTreatmentId: tr['NON_EU_SERVICES_RCV'] });
    const before = suggestVatTreatment(db, { companyId, bankTransactionId: tx('CLAUDE TOOLS INC', -2_000, { supplierId: id }) })!;
    expect(before.decidingRule?.ruleKey).not.toBe('vat.reverse_charge_services_from_abroad');
    expect(before.reviewReasons.join(' ')).toMatch(/has not been confirmed/);

    confirmEstablishment(db, { companyId, party: 'supplier', partyId: id, establishment: 'outside_state', basis: 'US seat', confirmedBy: 'joe' });
    const after = suggestVatTreatment(db, { companyId, bankTransactionId: tx('CLAUDE TOOLS INC', -2_000, { supplierId: id }) })!;
    expect(after.treatment?.code).toBe('NON_EU_SERVICES_RCV');
    expect(after.factSources.supplierEstablishedOutsideState).toMatch(/confirmed by joe/);
  });

  it('a supplier with a foreign address confirmed as established in the State gets no reverse charge', () => {
    const id = supplier('Irish Branch GmbH', { countryCode: 'DE', defaultVatTreatmentId: tr['EU_SERVICES_RCV'] });
    confirmEstablishment(db, { companyId, party: 'supplier', partyId: id, establishment: 'in_state', basis: 'Dublin branch supplies', confirmedBy: 'joe' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('IRISH BRANCH GMBH', -2_000, { supplierId: id }) })!;
    expect(s.decidingRule?.ruleKey).not.toBe('vat.reverse_charge_services_from_abroad');
  });

  it('records a customer\'s taxable status with who confirmed it', () => {
    const id = customer('Redwood Inc', { countryCode: 'US' });
    confirmCustomerTaxableStatus(db, { companyId, customerId: id, taxableStatus: 'taxable_person', confirmedBy: 'joe' });
    expect(db.select().from(customers).where(eq(customers.id, id)).get()).toMatchObject({
      taxableStatus: 'taxable_person', taxableStatusConfirmedBy: 'joe',
    });
  });
});

describe('checking a VAT number with VIES', () => {
  it('stores a valid answer with its consultation number, and marks the number validated', async () => {
    const id = customer('Continental SRL', { vatNumber: 'IT12345678901' });
    const calls: Array<{ url: string; body: string }> = [];
    const r = await checkVatNumberWithVies(db, {
      companyId, party: 'customer', partyId: id, requesterVatNumber: 'IE6388047V', actor: 'joe',
      fetchImpl: async (url, init) => {
        calls.push({ url, body: init.body });
        return { ok: true, status: 200, json: async () => ({ valid: true, name: 'CONTINENTAL SRL', address: 'VIA ROMA 1', requestIdentifier: 'WAPIAAAAX' }) };
      },
    });
    expect(calls[0]!.url).toBe(VIES_CHECK_URL);
    expect(JSON.parse(calls[0]!.body)).toEqual({ countryCode: 'IT', vatNumber: '12345678901', requesterMemberStateCode: 'IE', requesterNumber: '6388047V' });
    expect(r).toMatchObject({ status: 'valid', requestIdentifier: 'WAPIAAAAX' });
    const row = db.select().from(customers).where(eq(customers.id, id)).get()!;
    expect(row).toMatchObject({ viesStatus: 'valid', vatNumberValidated: true, viesName: 'CONTINENTAL SRL', viesCheckedVatNumber: 'IT12345678901' });
    expect(viesCurrent(row)).toBe(true);
    db.update(customers).set({ vatNumber: 'IT10987654321' }).where(eq(customers.id, id)).run();
    expect(viesCurrent(db.select().from(customers).where(eq(customers.id, id)).get()!)).toBe(false);
  });

  it('an invalid answer is stored, and the number stops counting as evidence of a business customer', async () => {
    const id = customer('Fake Business SRL', { vatNumber: 'IT12345678901', countryCode: 'IT' });
    confirmEstablishment(db, { companyId, party: 'customer', partyId: id, establishment: 'outside_state', basis: 'Milan seat', confirmedBy: 'joe' });
    const before = suggestVatTreatment(db, { companyId, bankTransactionId: tx('FAKE BUSINESS', 50_000, { customerId: id }) })!;
    expect(before.factSources.customerIsTaxablePerson).toMatch(/not checked with VIES/);

    await checkVatNumberWithVies(db, { companyId, party: 'customer', partyId: id, actor: 'joe', fetchImpl: answer(200, { valid: false }) });
    const after = suggestVatTreatment(db, { companyId, bankTransactionId: tx('FAKE BUSINESS', 50_000, { customerId: id }) })!;
    expect(after.facts.customerIsTaxablePerson).toBeUndefined();
    expect(after.factSources.customerIsTaxablePerson).toMatch(/INVALID by VIES/);
    expect(after.decidingRule?.ruleKey).not.toBe('vat.place_of_supply_services_to_business_abroad');
  });

  it('a service error or a network failure is "unavailable", never valid', async () => {
    const id = customer('Greek SA', { vatNumber: 'EL094259216' });
    const r1 = await checkVatNumberWithVies(db, {
      companyId, party: 'customer', partyId: id, actor: 'joe',
      fetchImpl: answer(200, { actionSucceed: false, errorWrappers: [{ error: 'MS_UNAVAILABLE' }] }),
    });
    expect(r1).toMatchObject({ status: 'unavailable', detail: 'MS_UNAVAILABLE', checkedVatNumber: 'EL094259216' });
    const r2 = await checkVatNumberWithVies(db, {
      companyId, party: 'customer', partyId: id, actor: 'joe', fetchImpl: async () => { throw new Error('offline'); },
    });
    expect(r2).toMatchObject({ status: 'unavailable' });
    expect(r2.detail).toMatch(/offline/);
    expect(db.select().from(customers).where(eq(customers.id, id)).get()!.vatNumberValidated).toBe(false);
  });

  it('refuses a number that is not a well-formed EU VAT number', async () => {
    const id = customer('US Corp', { vatNumber: '12-3456789' });
    await expect(checkVatNumberWithVies(db, { companyId, party: 'customer', partyId: id, actor: 'joe', fetchImpl: answer(200, {}) }))
      .rejects.toThrow(/not a well-formed EU VAT number/);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { suppliers, customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { suggestVatTreatment } from './vatSuggestion';
import { confirmEstablishment, confirmCustomerTaxableStatus } from '../parties/status';
import type { AppDatabase } from '@/db';

/**
 * Issue #207: acquisitions, imports, distance sales, exports and the
 * place-of-supply exceptions. Only an acquisition is decided; everything
 * that turns on evidence the books do not hold is flagged with why.
 */

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let tr: Record<string, string>;

beforeAll(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Borders Ltd', vatRegistrationStatus: 'registered', seedYears: [2026] });
  companyId = created.companyId;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2026-01-01', accountId: created.accountsByKey['bank_control']!,
  });
  loadStatutoryKnowledgeBase(db, { companyId });
});

const supplier = (name: string, countryCode: string, treatment: string, establishment?: 'in_state' | 'outside_state') => {
  const id = ids.supplier();
  db.insert(suppliers).values({
    id, companyId, name, matchKey: name.toLowerCase(), countryCode, defaultVatTreatmentId: tr[treatment],
  }).run();
  if (establishment) confirmEstablishment(db, { companyId, party: 'supplier', partyId: id, establishment, basis: 'test', confirmedBy: 'joe' });
  return id;
};
const customer = (name: string, countryCode: string, treatment: string) => {
  const id = ids.customer();
  db.insert(customers).values({
    id, companyId, name, matchKey: name.toLowerCase(), countryCode, defaultVatTreatmentId: tr[treatment],
  }).run();
  confirmEstablishment(db, { companyId, party: 'customer', partyId: id, establishment: 'outside_state', basis: 'test', confirmedBy: 'joe' });
  return id;
};
const suggest = (description: string, amountMinor: number, party: { supplierId?: string; customerId?: string }) =>
  suggestVatTreatment(db, {
    companyId,
    bankTransactionId: insertTestBankTransaction(db, {
      companyId, bankAccountId, transactionDate: '2026-03-15', description, amountMinor, ...party,
    }),
  })!;

describe('goods from another Member State', () => {
  it('an acquisition (s.9) from a supplier confirmed as established there', () => {
    const s = suggest('SEPA WIDGETWERK GMBH', -40_000, { supplierId: supplier('Widgetwerk GmbH', 'DE', 'EU_GOODS_ACQ', 'outside_state') });
    expect(s.decidingRule?.ruleKey).toBe('vat.intra_community_acquisition_goods');
    expect(s.treatment?.code).toBe('EU_GOODS_ACQ');
    expect(s.reviewRequired).toBe(true);
  });

  it('is not decided while the establishment is unconfirmed', () => {
    const s = suggest('SEPA TEILE GMBH', -40_000, { supplierId: supplier('Teile GmbH', 'DE', 'EU_GOODS_ACQ') });
    expect(s.decidingRule?.ruleKey).not.toBe('vat.intra_community_acquisition_goods');
    expect(s.reviewReasons.join(' ')).toMatch(/has not been confirmed/);
  });

  it('a supplier confirmed as established in the State makes it a domestic purchase', () => {
    const s = suggest('SEPA LAGER GMBH', -40_000, { supplierId: supplier('Lager GmbH', 'DE', 'EU_GOODS_ACQ', 'in_state') });
    expect(s.decidingRule?.ruleKey).not.toBe('vat.intra_community_acquisition_goods');
  });
});

describe('goods from outside the EU (s.3 importation)', () => {
  it('without the customs entry, both import treatments are offered and nothing is chosen', () => {
    const s = suggest('SHENZHEN PARTS CO', -90_000, { supplierId: supplier('Shenzhen Parts Co', 'CN', 'IMPORT_PA', 'outside_state') });
    expect(s.decidingRule?.ruleKey).toBe('vat.import_of_goods');
    expect(s.status).toBe('no_treatment');
    expect(s.treatment).toBeNull();
    expect(s.offeredTreatmentCodes).toEqual(['IMPORT_PA', 'IMPORT_VAT_PAID']);
    expect(s.reviewReasons.join(' ')).toMatch(/customs import entry/);
  });

  it('"IEPOSTPONED" on the entry means postponed accounting', () => {
    const id = supplier('Osaka Tools KK', 'JP', 'IMPORT_PA', 'outside_state');
    expect(suggest('OSAKA TOOLS IEPOSTPONED', -90_000, { supplierId: id }).treatment?.code).toBe('IMPORT_PA');
  });

  it('tax type B00 means VAT was paid at entry', () => {
    const id = supplier('Boston Kit Inc', 'US', 'IMPORT_VAT_PAID', 'outside_state');
    expect(suggest('BOSTON KIT B00 ENTRY', -90_000, { supplierId: id }).treatment?.code).toBe('IMPORT_VAT_PAID');
  });
});

describe('place-of-supply exceptions outrank the general rules', () => {
  it('a foreign conference ticket is not a s.12 reverse charge: s.34(g), flagged', () => {
    const id = supplier('Web Summit Lisboa', 'PT', 'EU_SERVICES_RCV', 'outside_state');
    const s = suggest('WEB SUMMIT CONFERENCE TICKETS', -120_000, { supplierId: id });
    expect(s.decidingRule?.ruleKey).toBe('vat.place_of_supply_event_admission');
    expect(s.status).toBe('no_treatment');
    expect(s.reviewReasons.join(' ')).toMatch(/event/i);
  });

  it('a foreign hotel is supplied where the property is (s.34(c)), flagged', () => {
    const id = supplier('Hotel Adlon Berlin', 'DE', 'EU_SERVICES_RCV', 'outside_state');
    const s = suggest('HOTEL ADLON ACCOMMODATION', -30_000, { supplierId: id });
    expect(s.decidingRule?.ruleKey).toBe('vat.place_of_supply_immovable_goods');
    expect(s.treatment).toBeNull();
  });

  it('an ordinary foreign service still gets the reverse charge', () => {
    const id = supplier('Figma Inc', 'US', 'NON_EU_SERVICES_RCV', 'outside_state');
    expect(suggest('FIGMA DESIGN SEATS', -5_000, { supplierId: id }).treatment?.code).toBe('NON_EU_SERVICES_RCV');
  });
});

describe('sales abroad', () => {
  it('goods sent to a consumer in another Member State are a distance sale (s.30), flagged', () => {
    const id = customer('Marie Dupont', 'FR', 'EU_GOODS_SUPPLY');
    confirmCustomerTaxableStatus(db, { companyId, customerId: id, taxableStatus: 'non_taxable_person', confirmedBy: 'joe' });
    const s = suggest('MARIE DUPONT ORDER 1182', 8_000, { customerId: id });
    expect(s.decidingRule?.ruleKey).toBe('vat.distance_sales_goods_eu_consumers');
    expect(s.treatment).toBeNull();
    expect(s.reviewReasons.join(' ')).toMatch(/One-Stop Shop|threshold/);
  });

  it('an export is zero-rated only with proof that the goods left the EU', () => {
    const id = customer('Toronto Retail Ltd', 'CA', 'EU_GOODS_SUPPLY');
    const s = suggest('TORONTO RETAIL INV 55', 60_000, { customerId: id });
    expect(s.decidingRule?.ruleKey).toBe('vat.zero_rate_export_outside_community');
    expect(s.reviewReasons.join(' ')).toMatch(/proof that the goods were transported outside the EU/);
  });
});

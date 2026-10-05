import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { suppliers, customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { suggestVatTreatment } from './vatSuggestion';
import { normaliseTransactionContext } from './transactionLookup';
import { confirmEstablishment } from '../parties/status';
import { ukWasMemberStateOn, UK_LEFT_EU_VAT_REGIME } from '../extraction/vatNumbers';
import type { AppDatabase } from '@/db';

/**
 * Issue #617: "From 1st January 2021, EU VAT legislation no longer applies to
 * the UK" (VIES Traders Manual, Appendix 9). Before that date a counterparty in
 * Great Britain or Northern Ireland was in another Member State, for goods and
 * services alike; from it, Great Britain is outside the EU and Northern Ireland
 * is inside for goods only (#610).
 */

describe('ukWasMemberStateOn', () => {
  it('is true for GB and XI before 1 January 2021, and false from that date', () => {
    expect(UK_LEFT_EU_VAT_REGIME).toBe('2021-01-01');
    for (const c of ['GB', 'gb', 'XI']) {
      expect(ukWasMemberStateOn(c, '2020-12-31')).toBe(true);
      expect(ukWasMemberStateOn(c, '2021-01-01')).toBe(false);
    }
    expect(ukWasMemberStateOn('US', '2020-06-15')).toBe(false);
    expect(ukWasMemberStateOn('GB', null)).toBe(false);
  });
});

describe('counterpartyInEu for a UK party', () => {
  const ctx = (transactionDate: string, supplyType: 'goods' | 'services' | null, ni = false) => normaliseTransactionContext({
    transactionDate, amountMinor: 1_000, direction: 'purchase', supplierCountry: 'GB',
    counterpartyNorthernIreland: ni, supplyType,
  }).counterpartyInEu;

  it('Great Britain is in the EU on 31 December 2020 and outside it on 1 January 2021', () => {
    expect(ctx('2020-12-31', 'services')).toBe(true);
    expect(ctx('2020-12-31', 'goods')).toBe(true);
    expect(ctx('2020-12-31', null)).toBe(true);
    expect(ctx('2021-01-01', 'services')).toBe(false);
    expect(ctx('2021-01-01', 'goods')).toBe(false);
  });

  it('Northern Ireland is in the EU for services too before 2021', () => {
    expect(ctx('2020-06-15', 'services', true)).toBe(true);
    expect(ctx('2021-06-15', 'services', true)).toBe(false);
    expect(ctx('2021-06-15', 'goods', true)).toBe(true);
  });
});

describe('treatments for UK trade either side of 1 January 2021', () => {
  let db: AppDatabase;
  let companyId: string;
  let bankAccountId: string;
  let tr: Record<string, string>;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Channel Trade Ltd', vatRegistrationStatus: 'registered', seedYears: [2020, 2021] });
    companyId = created.companyId;
    tr = created.treatmentsByCode;
    bankAccountId = addBankAccount(db, {
      companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2020-01-01', accountId: created.accountsByKey['bank_control']!,
    });
    loadStatutoryKnowledgeBase(db, { companyId });
  });

  const party = (kind: 'supplier' | 'customer', name: string, treatment: string) => {
    const id = kind === 'supplier' ? ids.supplier() : ids.customer();
    const values = { id, companyId, name, matchKey: name.toLowerCase(), countryCode: 'GB', vatNumber: 'GB123456789', defaultVatTreatmentId: tr[treatment] };
    if (kind === 'supplier') db.insert(suppliers).values(values).run(); else db.insert(customers).values(values).run();
    confirmEstablishment(db, { companyId, party: kind, partyId: id, establishment: 'outside_state', basis: 'test', confirmedBy: 'joe' });
    return id;
  };
  const suggest = (transactionDate: string, description: string, amountMinor: number, link: { supplierId?: string; customerId?: string }) =>
    suggestVatTreatment(db, {
      companyId,
      bankTransactionId: insertTestBankTransaction(db, { companyId, bankAccountId, transactionDate, description, amountMinor, ...link }),
    })!;

  it('services bought from Great Britain are EU services received in 2020 and non-EU services in 2021', () => {
    const supplierId = party('supplier', 'London Consulting', 'EU_SERVICES_RCV');
    expect(suggest('2020-06-15', 'LONDON CONSULTING', -5_000, { supplierId }).treatment?.code).toBe('EU_SERVICES_RCV');
    expect(suggest('2021-06-15', 'LONDON CONSULTING', -5_000, { supplierId }).treatment?.code).toBe('NON_EU_SERVICES_RCV');
  });

  it('goods sold to Great Britain are not an export in 2020, and are in 2021', () => {
    const customerId = party('customer', 'Leeds Retail Ltd', 'EU_GOODS_SUPPLY');
    // Not an export. Nor yet an intra-Community supply: that needs the
    // customer's EU VAT number, and a GB number is not read as one on any
    // date, so the 2020 sale is left for a person to decide.
    expect(suggest('2020-06-15', 'LEEDS RETAIL LTD', 60_000, { customerId }).decidingRule?.ruleKey).toBeUndefined();
    expect(suggest('2021-06-15', 'LEEDS RETAIL LTD', 60_000, { customerId }).decidingRule?.ruleKey)
      .toBe('vat.zero_rate_export_outside_community');
  });
});

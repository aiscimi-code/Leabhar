import { describe, it, expect, beforeAll } from 'vitest';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { suppliers, customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import { suggestVatTreatment } from './vatSuggestion';
import { normaliseTransactionContext } from './transactionLookup';
import { confirmEstablishment } from '../parties/status';
import { createInvoice } from '../invoicing/invoices';
import { buildViesStatement } from '../vat/vies';
import {
  parseVatNumber, findVatNumbers, otherMemberStateForGoods, suggestPurchaseTreatment,
} from '../extraction/vatNumbers';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

/**
 * Issue #610: Northern Ireland is subject to the EU VAT rules on goods but not
 * on services, and its traders in goods hold `XI` VAT numbers (VIES Traders
 * Manual, Appendix 9; VATCA s.2 as revised). So an XI trader is a Member State
 * party for goods and a non-EU party for services.
 */

describe('XI VAT numbers', () => {
  it('are recognised as Northern Ireland, nine digits or twelve for a group member', () => {
    for (const n of ['XI123456789', 'XI 123 4567 89', 'XI123456789001']) {
      const info = parseVatNumber(n);
      expect(info).toMatchObject({ countryCode: 'XI', isNorthernIreland: true, isEu: false, isIrish: false, structurallyValid: true });
      expect(info.note).toMatch(/Northern Ireland/);
    }
    expect(parseVatNumber('XI12345').structurallyValid).toBe(false);
    expect(parseVatNumber('GB123456789')).toMatchObject({ isNorthernIreland: false, isEu: false, countryCode: null });
  });

  it('are found in invoice text', () => {
    expect(findVatNumbers('Belfast Widgets Ltd VAT No: XI 123456789 Invoice 22').map((v) => v.normalised)).toEqual(['XI123456789']);
  });

  it('XI is another Member State for goods; GB and Ireland are not', () => {
    expect(otherMemberStateForGoods('XI')).toBe(true);
    expect(otherMemberStateForGoods('DE')).toBe(true);
    expect(otherMemberStateForGoods('EL')).toBe(true);
    expect(otherMemberStateForGoods('IE')).toBe(false);
    expect(otherMemberStateForGoods('GB')).toBe(false);
    expect(otherMemberStateForGoods('US')).toBe(false);
  });

  it('the offline purchase suggestion: goods from XI are an acquisition, services from XI are from outside the EU', () => {
    expect(suggestPurchaseTreatment({ supplierVatNumber: 'XI123456789', isGoods: true }).code).toBe('EU_GOODS_ACQ');
    expect(suggestPurchaseTreatment({ supplierVatNumber: 'XI123456789', isGoods: false }).code).toBe('NON_EU_SERVICES_RCV');
  });
});

describe('counterpartyInEu for a Northern Ireland party', () => {
  const ctx = (supplyType: 'goods' | 'services' | null) => normaliseTransactionContext({
    transactionDate: '2026-03-15', amountMinor: 1_000, direction: 'purchase', supplierCountry: 'GB',
    counterpartyNorthernIreland: true, supplyType,
  });

  it('is true for goods, false for services, and unresolved when the supply kind is unknown', () => {
    expect(ctx('goods').counterpartyInEu).toBe(true);
    expect(ctx('services').counterpartyInEu).toBe(false);
    expect(ctx(null).counterpartyInEu).toBeNull();
  });

  it('XI given as the country reads the same as an XI number', () => {
    expect(normaliseTransactionContext({
      transactionDate: '2026-03-15', amountMinor: 1_000, direction: 'sale', customerCountry: 'XI', supplyType: 'goods',
    }).counterpartyInEu).toBe(true);
  });

  it('a GB party with no XI marker stays outside the EU', () => {
    expect(normaliseTransactionContext({
      transactionDate: '2026-03-15', amountMinor: 1_000, direction: 'purchase', supplierCountry: 'GB', supplyType: 'goods',
    }).counterpartyInEu).toBe(false);
  });
});

describe('treatments for Northern Ireland trade', () => {
  let db: AppDatabase;
  let companyId: string;
  let bankAccountId: string;
  let tr: Record<string, string>;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Border Trade Ltd', vatRegistrationStatus: 'registered', seedYears: [2026] });
    companyId = created.companyId;
    tr = created.treatmentsByCode;
    bankAccountId = addBankAccount(db, {
      companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2026-01-01', accountId: created.accountsByKey['bank_control']!,
    });
  });

  const party = (kind: 'supplier' | 'customer', name: string, vatNumber: string, treatment: string) => {
    const id = kind === 'supplier' ? ids.supplier() : ids.customer();
    const values = { id, companyId, name, matchKey: name.toLowerCase(), countryCode: 'GB', vatNumber, defaultVatTreatmentId: tr[treatment] };
    if (kind === 'supplier') db.insert(suppliers).values(values).run(); else db.insert(customers).values(values).run();
    confirmEstablishment(db, { companyId, party: kind, partyId: id, establishment: 'outside_state', basis: 'test', confirmedBy: 'joe' });
    return id;
  };
  const suggest = (description: string, amountMinor: number, link: { supplierId?: string; customerId?: string }) =>
    suggestVatTreatment(db, {
      companyId,
      bankTransactionId: insertTestBankTransaction(db, {
        companyId, bankAccountId, transactionDate: '2026-03-15', description, amountMinor, ...link,
      }),
    })!;

  it('goods bought from a Northern Ireland trader are an intra-Community acquisition (E2), not an import', () => {
    const s = suggest('BELFAST WIDGETS LTD', -40_000, { supplierId: party('supplier', 'Belfast Widgets Ltd', 'XI123456789', 'EU_GOODS_ACQ') });
    expect(s.decidingRule?.ruleKey).toBe('vat.intra_community_acquisition_goods');
    expect(s.treatment?.code).toBe('EU_GOODS_ACQ');
  });

  it('services bought from a Northern Ireland trader are from outside the EU', () => {
    const s = suggest('NEWRY CONSULTING', -5_000, { supplierId: party('supplier', 'Newry Consulting', 'XI987654321', 'NON_EU_SERVICES_RCV') });
    expect(s.treatment?.code).toBe('NON_EU_SERVICES_RCV');
  });

  it('goods sold to a Northern Ireland trader are an intra-Community supply (E1), not an export', () => {
    const s = suggest('DERRY RETAIL LTD', 60_000, { customerId: party('customer', 'Derry Retail Ltd', 'XI111222333', 'EU_GOODS_SUPPLY') });
    expect(s.decidingRule?.ruleKey).toBe('vat.zero_rate_intra_community_goods');
    expect(s.treatment?.code).toBe('EU_GOODS_SUPPLY');
  });

  it('goods sold to a Great Britain trader are still an export', () => {
    const s = suggest('LEEDS RETAIL LTD', 60_000, { customerId: party('customer', 'Leeds Retail Ltd', 'GB123456789', 'EU_GOODS_SUPPLY') });
    expect(s.decidingRule?.ruleKey).toBe('vat.zero_rate_export_outside_community');
  });
});

describe('VIES and Northern Ireland', () => {
  let db: AppDatabase;
  let companyId: string;
  let byCode: Record<string, string>;
  let tr: Record<string, string>;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Vies Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    companyId = created.companyId;
    byCode = created.accountsByCode;
    tr = created.treatmentsByCode;
  });

  let n = 0;
  const sale = (vatNumber: string, code: string) => {
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: `Customer ${vatNumber}`, matchKey: vatNumber.toLowerCase(), countryCode: 'GB', vatNumber }).run();
    createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: makeDate(2025, 3, 10), invoiceNumber: `NI-${++n}`, customerId,
      lines: [{ description: 'Line', netMinor: 10_000, accountId: byCode['4020']!, vatTreatmentId: tr[code]! }],
    });
  };

  it('reports goods to an XI number, and flags services to an XI number and anything to a GB number', () => {
    sale('XI123456789', 'EU_GOODS_SUPPLY');
    sale('XI987654321', 'EU_SERVICES_SUPPLY');
    sale('GB123456789', 'EU_GOODS_SUPPLY');
    const vies = buildViesStatement(db, { companyId, frequency: 'Q', year: 2025, month: 3 });
    const goodsLine = vies.lines.find((l) => l.customerVatNumber === 'XI123456789')!;
    expect(goodsLine.flag).toBe('');
    const codes = vies.findings.map((f) => f.code);
    expect(codes).toContain('vies_services_to_northern_ireland');
    expect(codes).toContain('vies_great_britain_customer');
    expect(vies.findings.some((f) => f.code === 'vies_customer_vat_number_invalid' && f.message.includes('XI123456789'))).toBe(false);
  });
});

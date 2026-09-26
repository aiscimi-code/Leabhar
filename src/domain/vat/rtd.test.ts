import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { buildRtdReturn, RTD_BOXES } from './rtd';
import { buildViesStatement, viesChargeableDate } from './vies';
import { customers, suppliers } from '@/db/schema';
import { makeDate } from '../dates';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
const party: Record<string, string> = {};

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025],
  });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  const supplier = (key: string, name: string, countryCode: string, vatNumber: string | null) => {
    party[key] = ids.supplier();
    db.insert(suppliers).values({ id: party[key]!, companyId, name, matchKey: name.toLowerCase(), countryCode, vatNumber }).run();
  };
  const customer = (key: string, name: string, countryCode: string, vatNumber: string | null) => {
    party[key] = ids.customer();
    db.insert(customers).values({ id: party[key]!, companyId, name, matchKey: name.toLowerCase(), countryCode, vatNumber }).run();
  };
  supplier('sIE', 'Byrne Supplies', 'IE', 'IE9876543W');
  supplier('sEU', 'Berlin GmbH', 'DE', 'DE123456789');
  supplier('sUS', 'Austin Inc', 'US', null);
  customer('ie', 'Mulligan Digital', 'IE', 'IE6543217L');
  customer('fr', 'Paris SARL', 'FR', 'FR12345678901');
  customer('nl', 'Delft BV', 'NL', 'NL123456789B01');
  customer('us', 'Boston LLC', 'US', null);
});

let n = 0;
const post = (direction: 'sales' | 'purchase', code: string, netMinor: number, partyKey: string, opts: {
  account?: string; date?: string; supplyDate?: string; isCreditNote?: boolean;
} = {}) => createInvoice(db, {
  companyId, direction, invoiceDate: (opts.date ?? makeDate(2025, 3, 10)) as ReturnType<typeof makeDate>, invoiceNumber: `R-${++n}`,
  supplyDate: opts.supplyDate as ReturnType<typeof makeDate> | undefined,
  isCreditNote: opts.isCreditNote,
  ...(direction === 'sales' ? { customerId: party[partyKey] } : { supplierId: party[partyKey] }),
  lines: [{
    description: `${code} line`, netMinor,
    accountId: byCode[opts.account ?? (direction === 'sales' ? '4020' : '6070')]!, vatTreatmentId: tr[code]!,
  }],
});

describe('buildRtdReturn', () => {
  it('places each treatment in the boxes of Revenue\'s grid', () => {
    post('sales', 'IE_STD', 100_000, 'ie');
    post('sales', 'IE_RED', 20_000, 'ie');
    post('sales', 'IE_SECOND_RED', 10_000, 'ie');
    post('sales', 'IE_ZERO', 5_000, 'ie');
    post('sales', 'IE_LIVESTOCK', 50_000, 'ie');
    post('sales', 'IE_EXEMPT', 7_000, 'ie');
    post('sales', 'OUT_OF_SCOPE', 3_000, 'ie');
    post('sales', 'EU_GOODS_SUPPLY', 40_000, 'fr');
    post('sales', 'EU_SERVICES_SUPPLY', 30_000, 'fr');
    post('purchase', 'IE_STD', 60_000, 'sIE', { account: '5030' });  // for resale
    post('purchase', 'IE_STD', 8_000, 'sIE');                         // overhead
    post('purchase', 'IE_RED', 4_000, 'sIE');
    post('purchase', 'IE_EXEMPT', 1_500, 'sIE');                     // exempt input: E6
    post('purchase', 'NON_DEDUCTIBLE', 5_000, 'sIE');                 // not deductible: nowhere
    post('purchase', 'RC_CONSTRUCTION', 12_000, 'sIE', { account: '5010' });
    post('purchase', 'EU_GOODS_ACQ', 15_000, 'sEU', { account: '5030' });
    post('purchase', 'EU_SERVICES_RCV', 11_000, 'sEU');
    post('purchase', 'NON_EU_SERVICES_RCV', 6_000, 'sUS');
    post('purchase', 'IMPORT_PA', 13_000, 'sUS', { account: '5030' });

    const rtd = buildRtdReturn(db, { companyId, date: '2025-06-30' });
    expect(rtd.yearStart).toBe('2025-01-01');
    expect(rtd.yearEnd).toBe('2025-12-31');
    expect(rtd.dueDate).toBe('2026-01-23');
    const b = rtd.boxes;
    // Section 1: supplies, plus self-accounted received services (§2.2(e), §4 Q4-Q5).
    expect(b['P1']).toBe(100_000 + 12_000 + 6_000);
    expect(b['AC5']).toBe(20_000);
    expect(b['BC5']).toBe(10_000);
    expect(b['D1']).toBe(5_000);
    expect(b['C5']).toBe(50_000);
    expect(b['E3']).toBe(7_000);
    expect(b['D4']).toBe(70_000);
    expect(b['Z1']).toBe(118_000 + 20_000 + 10_000 + 5_000 + 50_000 + 7_000 + 70_000);
    // Section 2: the E2, ES2 and PA1 transactions (§2.3).
    expect(b['P2']).toBe(15_000 + 11_000 + 13_000);
    expect(b['PA2']).toBe(13_000);
    expect(b['Z2']).toBe(39_000);
    // Sections 3 and 4: deductible inputs, split by the account's subtype.
    expect(b['R1']).toBe(60_000 + 12_000 + 15_000 + 13_000);
    expect(b['PA3']).toBe(13_000);
    expect(b['R2']).toBe(8_000 + 11_000 + 6_000);
    expect(b['AH6']).toBe(4_000);
    expect(b['Z3']).toBe(100_000);
    expect(b['E6']).toBe(1_500);
    expect(b['Z5']).toBe(30_500);
    expect(rtd.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['rtd_resale_by_account', 'rtd_returns_not_filed']));
  });

  it('flags a box that nets negative rather than hiding it', () => {
    post('sales', 'IE_STD', 1_000, 'ie');
    post('sales', 'IE_STD', 5_000, 'ie', { isCreditNote: true });
    const rtd = buildRtdReturn(db, { companyId, date: '2025-06-30' });
    expect(rtd.boxes['P1']).toBe(-4_000);
    expect(rtd.findings.some((f) => f.code === 'rtd_negative_box' && f.message.includes('P1'))).toBe(true);
  });

  it('has a box for every row of every section in the grid', () => {
    const all = Object.values(RTD_BOXES).flatMap((s) => Object.values(s));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(expect.arrayContaining(['E3', 'D4', 'Z1', 'Z2', 'Z3', 'Z5', 'PA2', 'PA3', 'PA4']));
  });
});

describe('buildViesStatement', () => {
  it('aggregates per customer VAT number, flags services and nets credit notes', () => {
    post('sales', 'EU_GOODS_SUPPLY', 40_049, 'fr');
    post('sales', 'EU_GOODS_SUPPLY', 10_000, 'fr', { date: '2025-02-01' });
    post('sales', 'EU_GOODS_SUPPLY', 2_000, 'fr', { isCreditNote: true });
    post('sales', 'EU_SERVICES_SUPPLY', 30_000, 'fr');
    post('sales', 'EU_SERVICES_SUPPLY', 25_050, 'nl');
    post('sales', 'IE_STD', 99_999, 'ie');
    const vies = buildViesStatement(db, { companyId, frequency: 'Q', year: 2025, month: 3 });
    expect(vies.periodCode).toBe('2503');
    expect(vies.dueDate).toBe('2025-04-23');
    expect(vies.lines.map((l) => [l.customerVatNumber, l.flag, l.valueEuro])).toEqual([
      ['FR12345678901', '', 480],   // 400.49 + 100.00 - 20.00 = 480.49
      ['FR12345678901', 'S', 300],
      ['NL123456789B01', 'S', 251], // 250.50 rounds up
    ]);
    expect(vies.totalEuro).toBe(1_031);
    expect(vies.nil).toBe(false);
  });

  it('dates a supply by the invoice or the 15th of the next month, whichever is sooner', () => {
    expect(viesChargeableDate('2025-03-31', '2025-02-10')).toBe('2025-03-15');
    expect(viesChargeableDate('2025-03-02', '2025-02-10')).toBe('2025-03-02');
    post('sales', 'EU_GOODS_SUPPLY', 10_000, 'fr', { date: '2025-04-20', supplyDate: '2025-03-05' });
    expect(buildViesStatement(db, { companyId, frequency: 'M', year: 2025, month: 4 }).lines).toHaveLength(1);
    expect(buildViesStatement(db, { companyId, frequency: 'M', year: 2025, month: 3 }).nil).toBe(true);
  });

  it('flags the monthly threshold and a missing or Irish VAT number', () => {
    post('sales', 'EU_GOODS_SUPPLY', 6_000_000, 'fr');
    post('sales', 'EU_GOODS_SUPPLY', 1_000, 'us');
    post('sales', 'EU_SERVICES_SUPPLY', 1_000, 'ie');
    const codes = buildViesStatement(db, { companyId, frequency: 'Q', year: 2025, month: 3 }).findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining([
      'vies_monthly_required', 'vies_customer_vat_number_missing', 'vies_customer_vat_number_invalid',
    ]));
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { reconcileVatReturn } from './reconcile';
import { createVatEntries } from './engine';
import { buildVat3Return } from './report';
import { VAT3_BOX_DEFINITIONS, VAT3_GUIDANCE_PATH, normaliseSpace, treatmentBoxCitations } from './boxDefinitions';
import { DEFAULT_VAT_TREATMENTS } from '../config/vatTreatments';
import { customers, suppliers, vatPeriods } from '@/db/schema';
import { makeDate } from '../dates';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

describe('VAT3 box definitions', () => {
  const guidance = normaliseSpace(readFileSync(VAT3_GUIDANCE_PATH, 'utf8'));

  it("quotes Revenue's guidance verbatim for every box", () => {
    for (const d of Object.values(VAT3_BOX_DEFINITIONS)) {
      expect(guidance, `${d.box} quote`).toContain(normaliseSpace(d.quote));
    }
  });

  it('defines every box a treatment reports into', () => {
    for (const t of DEFAULT_VAT_TREATMENTS) {
      for (const box of [t.salesVatBox, t.purchasesVatBox, t.netSalesBox, t.netPurchasesBox]) {
        if (box) expect(VAT3_BOX_DEFINITIONS[box], `${t.code} → ${box}`).toBeDefined();
      }
    }
  });

  it('maps the intra-EU and postponed-accounting treatments to their statistical boxes', () => {
    const net = (code: string) => {
      const t = DEFAULT_VAT_TREATMENTS.find((x) => x.code === code)!;
      return t.netSalesBox ?? t.netPurchasesBox;
    };
    expect(net('EU_GOODS_SUPPLY')).toBe('E1');
    expect(net('EU_GOODS_ACQ')).toBe('E2');
    expect(net('EU_SERVICES_SUPPLY')).toBe('ES1');
    expect(net('EU_SERVICES_RCV')).toBe('ES2');
    expect(net('IMPORT_PA')).toBe('PA1');
    const pa = DEFAULT_VAT_TREATMENTS.find((x) => x.code === 'IMPORT_PA')!;
    expect(treatmentBoxCitations(pa).map((d) => d.box)).toEqual(['T1', 'T2', 'PA1']);
  });
});

describe('reconcileVatReturn', () => {
  let db: AppDatabase;
  let companyId: string;
  let byCode: Record<string, string>;
  let tr: Record<string, string>;
  let periodId: string;
  const party: Record<string, string> = {};

  beforeEach(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, {
      legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025],
    });
    companyId = created.companyId;
    byCode = created.accountsByCode;
    tr = created.treatmentsByCode;
    periodId = db.select().from(vatPeriods).where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
    const addSupplier = (key: string, name: string, countryCode: string, vatNumber: string | null) => {
      party[key] = ids.supplier();
      db.insert(suppliers).values({ id: party[key]!, companyId, name, matchKey: name.toLowerCase(), countryCode, vatNumber }).run();
    };
    const addCustomer = (key: string, name: string, countryCode: string, vatNumber: string | null) => {
      party[key] = ids.customer();
      db.insert(customers).values({ id: party[key]!, companyId, name, matchKey: name.toLowerCase(), countryCode, vatNumber }).run();
    };
    addSupplier('ieSupplier', 'Byrne Supplies', 'IE', 'IE9876543W');
    addSupplier('euSupplier', 'Berlin GmbH', 'DE', 'DE123456789');
    addSupplier('usSupplier', 'Austin Inc', 'US', null);
    addCustomer('ieCustomer', 'Mulligan Digital', 'IE', 'IE6543217L');
    addCustomer('euCustomer', 'Paris SARL', 'FR', 'FR12345678901');
    addCustomer('usCustomer', 'Boston LLC', 'US', null);
  });

  let n = 0;
  const post = (direction: 'sales' | 'purchase', code: string, netMinor: number, partyKey: string) =>
    createInvoice(db, {
      companyId, direction, invoiceDate: makeDate(2025, 3, 10), invoiceNumber: `R-${++n}`,
      ...(direction === 'sales' ? { customerId: party[partyKey] } : { supplierId: party[partyKey] }),
      lines: [{
        description: `${code} line`, netMinor,
        accountId: byCode[direction === 'sales' ? '4020' : '6070']!, vatTreatmentId: tr[code]!,
      }],
    });

  const postEveryTreatment = () => {
    // Sales, on each treatment that can apply to a sale.
    post('sales', 'IE_STD', 100_000, 'ieCustomer');
    post('sales', 'IE_RED', 20_000, 'ieCustomer');
    post('sales', 'IE_SECOND_RED', 10_000, 'ieCustomer');
    post('sales', 'IE_ZERO', 5_000, 'ieCustomer');
    post('sales', 'IE_LIVESTOCK', 50_000, 'ieCustomer');
    post('sales', 'IE_EXEMPT', 7_000, 'ieCustomer');
    post('sales', 'OUT_OF_SCOPE', 3_000, 'ieCustomer');
    post('sales', 'EU_GOODS_SUPPLY', 40_000, 'euCustomer');
    post('sales', 'EU_SERVICES_SUPPLY', 30_000, 'euCustomer');
    post('sales', 'NON_EU_SERVICES_SUPPLY', 25_000, 'usCustomer');
    // Purchases.
    post('purchase', 'IE_STD', 60_000, 'ieSupplier');
    post('purchase', 'IE_RED', 8_000, 'ieSupplier');
    post('purchase', 'IE_SECOND_RED', 4_000, 'ieSupplier');
    post('purchase', 'IE_ZERO', 2_000, 'ieSupplier');
    post('purchase', 'IE_LIVESTOCK', 9_000, 'ieSupplier');
    post('purchase', 'IE_EXEMPT', 1_500, 'ieSupplier');
    post('purchase', 'OUT_OF_SCOPE', 1_000, 'ieSupplier');
    post('purchase', 'NON_DEDUCTIBLE', 5_000, 'ieSupplier');
    post('purchase', 'RC_CONSTRUCTION', 12_000, 'ieSupplier');
    post('purchase', 'EU_GOODS_ACQ', 15_000, 'euSupplier');
    post('purchase', 'EU_SERVICES_RCV', 11_000, 'euSupplier');
    post('purchase', 'NON_EU_SERVICES_RCV', 6_000, 'usSupplier');
    post('purchase', 'IMPORT_PA', 13_000, 'usSupplier');
    post('purchase', 'IMPORT_VAT_PAID', 3_000, 'usSupplier');
  };

  it('agrees box by box and with the ledger across every treatment', () => {
    postEveryTreatment();
    const rec = reconcileVatReturn(db, { companyId, vatPeriodId: periodId });
    expect(rec.boxes.filter((b) => !b.agrees)).toEqual([]);
    expect(rec.ledger.agrees).toBe(true);
    expect(rec.ledger.journalCount).toBeGreaterThan(0);
    expect(rec.agrees).toBe(true);

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    const box = (b: string) => rec.boxes.find((x) => x.box === b)!.fromEntries;
    expect(box('E1')).toBe(40_000);
    expect(box('E2')).toBe(15_000);
    expect(box('ES1')).toBe(30_000);
    expect(box('ES2')).toBe(11_000);
    expect(box('PA1')).toBe(13_000);
    expect(box('T1')).toBe(report.T1.amountMinor);
    expect(box('T2')).toBe(report.T2.amountMinor);
  });

  it('lists what the return cannot include yet', () => {
    post('sales', 'IE_STD', 100_000, 'ieCustomer');
    const bankAccountId = addBankAccount(db, { companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01' });
    insertTestBankTransaction(db, { companyId, bankAccountId, transactionDate: '2025-03-20', amountMinor: -4_500, description: 'CARD ACME HARDWARE' });
    insertTestBankTransaction(db, { companyId, bankAccountId, transactionDate: '2025-06-20', amountMinor: -1_000, description: 'CARD OUT OF PERIOD' });
    const rec = reconcileVatReturn(db, { companyId, vatPeriodId: periodId });
    expect(rec.excluded.unclassifiedBankLines.map((l) => l.description)).toEqual(['CARD ACME HARDWARE']);
    expect(rec.agrees).toBe(true);
  });

  it('disagrees with the ledger when VAT has no journal behind it', () => {
    post('sales', 'IE_STD', 100_000, 'ieCustomer');
    createVatEntries(db, {
      companyId, sourceType: 'manual_adjustment', direction: 'sales', treatmentId: tr['IE_STD']!,
      taxPointDate: makeDate(2025, 3, 12), currency: 'EUR', baseCurrency: 'EUR', netMinor: 10_000,
    });
    const rec = reconcileVatReturn(db, { companyId, vatPeriodId: periodId });
    expect(rec.boxes.every((b) => b.agrees)).toBe(true);
    expect(rec.ledger.vatAccountsMovementMinor).toBe(23_000);
    expect(rec.ledger.netPositionMinor).toBe(25_300);
    expect(rec.agrees).toBe(false);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertTestBankTransaction, insertConfirmedDocument } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { createVatEntries } from './engine';
import { buildVat3Return, drillIntoBox, vatPositionSummary } from './report';
import { validateVatPeriod, transitionVatPeriod } from './periodClose';
import { classifyTransaction } from '../banking/classify';
import { createInvoice } from '../invoicing/invoices';
import { recordPayment } from '../invoicing/payments';
import { vatPeriods, reviewItems, rules, customers } from '@/db/schema';
import { makeDate } from '../dates';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let tr: Record<string, string>;
let byCode: Record<string, string>;
let periodId: string;
let bankAccountId: string;

const MAR_APR = makeDate(2025, 3, 15);

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Test Ltd', vatRegistrationStatus: 'registered', seedYears: [2025],
  });
  companyId = created.companyId;
  tr = created.treatmentsByCode;
  byCode = created.accountsByCode;
  periodId = db.select().from(vatPeriods)
    .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01',
  });
});

const addVat = (treatmentCode: string, opts: Record<string, unknown> = {}) =>
  createVatEntries(db, {
    companyId,
    sourceType: 'purchase_invoice',
    direction: 'purchases',
    treatmentId: tr[treatmentCode]!,
    taxPointDate: MAR_APR,
    currency: 'EUR',
    baseCurrency: 'EUR',
    netMinor: 10_000,
    ...opts,
  });

describe('buildVat3Return', () => {
  it('puts sales VAT in T1 and purchase VAT in T2', () => {
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 100_000 });
    addVat('IE_STD', { netMinor: 40_000 });

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(23_000);
    expect(report.T2.amountMinor).toBe(9_200);
    expect(report.T3.amountMinor).toBe(13_800);
    expect(report.T4.amountMinor).toBe(0);
    expect(report.netPositionMinor).toBe(13_800);
  });

  it('reports a repayment position in T4, leaving T3 at zero', () => {
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 10_000 });
    addVat('IE_STD', { netMinor: 100_000 });

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T3.amountMinor).toBe(0);
    expect(report.T4.amountMinor).toBe(20_700);
    expect(report.netPositionMinor).toBe(-20_700);
  });

  it('nets a reverse charge to zero across T1 and T2', () => {
    addVat('NON_EU_SERVICES_RCV', { netMinor: 12_000 });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(2_760);
    expect(report.T2.amountMinor).toBe(2_760);
    expect(report.netPositionMinor).toBe(0);
    expect(report.reverseChargeVatMinor).toBe(2_760);
  });

  // T2 must sum RECOVERABLE VAT, not VAT charged.
  it('excludes non-recoverable VAT from T2', () => {
    addVat('IE_STD', { netMinor: 10_000 });        // 2300 recoverable
    addVat('NON_DEDUCTIBLE', { netMinor: 10_000 }); // 2300 charged, 0 recoverable

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.amountMinor).toBe(2_300);
    expect(report.nonRecoverableVatMinor).toBe(2_300);
  });

  it('populates the statistical net boxes', () => {
    addVat('EU_SERVICES_RCV', { netMinor: 50_000 });
    addVat('EU_GOODS_ACQ', { netMinor: 30_000 });
    addVat('IMPORT_PA', { netMinor: 20_000 });
    addVat('EU_GOODS_SUPPLY', {
      direction: 'sales', sourceType: 'sales_invoice', netMinor: 70_000,
    });
    addVat('EU_SERVICES_SUPPLY', {
      direction: 'sales', sourceType: 'sales_invoice', netMinor: 60_000,
    });

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.ES2.amountMinor).toBe(50_000);
    expect(report.E2.amountMinor).toBe(30_000);
    expect(report.PA1.amountMinor).toBe(20_000);
    expect(report.E1.amountMinor).toBe(70_000);
    expect(report.ES1.amountMinor).toBe(60_000);
  });

  it('excludes exempt and outside-scope transactions from every box', () => {
    addVat('IE_EXEMPT', { netMinor: 50_000 });
    addVat('OUT_OF_SCOPE', { netMinor: 90_000 });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T1.amountMinor).toBe(0);
    expect(report.T2.amountMinor).toBe(0);
    expect(report.E1.amountMinor).toBe(0);
    expect(report.E2.amountMinor).toBe(0);
  });

  it('includes zero-rated purchases in T2 at zero, unlike exempt', () => {
    addVat('IE_ZERO', { netMinor: 50_000 });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.amountMinor).toBe(0);
    // ...but the entry IS in the box, which is what distinguishes it from exempt.
    expect(report.T2.entryCount).toBe(1);
  });

  it('excludes entries from other periods', () => {
    addVat('IE_STD', { netMinor: 10_000 });
    addVat('IE_STD', { netMinor: 99_999, taxPointDate: makeDate(2025, 7, 15) });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.amountMinor).toBe(2_300);
    expect(report.entryCount).toBe(1);
  });

  it('sums in base currency for foreign-currency entries', () => {
    addVat('IE_STD', {
      netMinor: 10_000, currency: 'USD', fxRate: { numerator: 92, denominator: 100 },
    });
    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.amountMinor).toBe(2_116);
  });
});

describe('drill-down', () => {
  it('drills from a box to the entries that make it up', () => {
    addVat('IE_STD', { netMinor: 10_000 });
    addVat('IE_STD', { netMinor: 20_000 });
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 50_000 });

    const report = buildVat3Return(db, { companyId, vatPeriodId: periodId });
    expect(report.T2.entryCount).toBe(2);

    const rows = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T2' });
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.baseRecoverableVatMinor, 0)).toBe(report.T2.amountMinor);
    expect(rows[0]!.treatmentCode).toBe('IE_STD');
  });

  it('drills into T3 through everything behind T1 and T2', () => {
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 100_000 });
    addVat('IE_STD', { netMinor: 10_000 });
    const rows = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T3' });
    expect(rows).toHaveLength(2);
  });

  it('shows both legs of a reverse charge separately', () => {
    addVat('EU_SERVICES_RCV', { netMinor: 10_000 });
    const t1 = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T1' });
    const t2 = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T2' });
    expect(t1).toHaveLength(1);
    expect(t2).toHaveLength(1);
    expect(t1[0]!.isReverseChargeLeg).toBe(true);
    expect(t1[0]!.entryId).not.toBe(t2[0]!.entryId);
  });

  it('returns nothing for an empty box rather than failing', () => {
    expect(drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'E1' })).toEqual([]);
  });

  it('summarises every period for the dashboard', () => {
    addVat('IE_STD', { direction: 'sales', sourceType: 'sales_invoice', netMinor: 100_000 });
    const summary = vatPositionSummary(db, companyId);
    expect(summary).toHaveLength(6);
    const marApr = summary.find((s) => s.name === 'Mar–Apr 2025')!;
    expect(marApr.netPositionMinor).toBe(23_000);
    expect(summary.find((s) => s.name === 'Jan–Feb 2025')!.netPositionMinor).toBe(0);
  });

  // The chain README §53 demands, end to end: a VAT3 figure back to the
  // journal entry, the bank line, the rule that classified it and the source
  // the treatment rests on. Each test walks one real posting path.
  describe('chain to the evidence', () => {
    it('carries the journal entry, rule and document behind a bank-classified entry', () => {
      const txId = insertTestBankTransaction(db, {
        companyId, bankAccountId, transactionDate: '2025-03-15',
        description: 'CARD SALES', amountMinor: 12_300, counterpartyName: 'TILL BATCH',
      });
      const ruleId = ids.rule();
      db.insert(rules).values({
        id: ruleId, companyId, name: 'Card sales are standard-rate sales',
        conditions: [{ field: 'description', operator: 'contains', value: 'CARD SALES' }],
        actions: [{ field: 'accountId', value: byCode['4020']! }],
      }).run();

      const result = classifyTransaction(db, {
        companyId, bankTransactionId: txId, accountId: byCode['4020']!,
        vatTreatmentId: tr['IE_STD']!, source: 'rule', appliedRuleId: ruleId,
      });
      expect(result.entryNumber).toBe(1);

      // The receipt is matched to its till Z-report afterwards.
      const documentId = insertConfirmedDocument(db, companyId, {
        documentType: 'sales_record', matchedTransactionId: txId,
      });

      const rows = drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T1' });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.journalEntryId).toBe(result.journalEntryId);
      expect(row.journalEntryNumber).toBe(1);
      expect(row.journalNarrative).toContain('CARD SALES');
      expect(row.bankTransactionId).toBe(txId);
      expect(row.ruleId).toBe(ruleId);
      expect(row.ruleName).toBe('Card sales are standard-rate sales');
      expect(row.documentId).toBe(documentId);
      expect(row.treatmentSourceNote).toContain('Irish standard-rated supply');
    });

    it('carries the settling bank line behind an invoice-sourced entry', () => {
      // An invoice-basis book: the tax point is the invoice date, so the VAT
      // entry belongs to the invoice, and the bank line is the settlement.
      const invoiceDb = createTestDatabase();
      const created = createCompany(invoiceDb.db, {
        legalName: 'Invoice Ltd', vatRegistrationStatus: 'registered',
        vatAccountingBasis: 'invoice', seedYears: [2025],
      });
      const invoiceCompanyId = created.companyId;
      const invoicePeriodId = invoiceDb.db.select().from(vatPeriods)
        .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
      const invoiceBankAccountId = addBankAccount(invoiceDb.db, {
        companyId: invoiceCompanyId, bankName: 'BOI',
        accountName: 'Current', openingDate: '2025-01-01',
      });
      const customerId = ids.customer();
      invoiceDb.db.insert(customers).values({
        id: customerId, companyId: invoiceCompanyId, name: 'Mulligan Digital',
        matchKey: 'mulligan digital', countryCode: 'IE',
      }).run();

      const invoice = createInvoice(invoiceDb.db, {
        companyId: invoiceCompanyId, direction: 'sales',
        invoiceDate: MAR_APR, invoiceNumber: 'S-1', customerId,
        lines: [{
          description: 'Website build', netMinor: 100_000,
          accountId: created.accountsByCode['4020']!,
          vatTreatmentId: created.treatmentsByCode['IE_STD']!,
        }],
      });

      const receiptId = insertTestBankTransaction(invoiceDb.db, {
        companyId: invoiceCompanyId, bankAccountId: invoiceBankAccountId,
        transactionDate: '2025-03-20',
        description: 'MULLIGAN DIGITAL TRANSFER', amountMinor: 123_000,
      });
      recordPayment(invoiceDb.db, {
        companyId: invoiceCompanyId, direction: 'received',
        paymentDate: makeDate(2025, 3, 20), amountMinor: 123_000,
        bankTransactionId: receiptId,
        allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 123_000 }],
      });

      const rows = drillIntoBox(invoiceDb.db, {
        companyId: invoiceCompanyId, vatPeriodId: invoicePeriodId, box: 'T1',
      });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.sourceType).toBe('sales_invoice');
      expect(row.invoiceId).toBe(invoice.invoiceId);
      expect(row.bankTransactionId).toBe(receiptId);
      expect(row.journalEntryId).toBe(invoice.journalEntryId);
      expect(row.journalEntryNumber).toBe(1);
      expect(row.counterpartyName).toBe('Mulligan Digital');
      // No rule classified anything on this path — an honest null, not a guess.
      expect(row.ruleId).toBeNull();
      expect(row.ruleName).toBeNull();
    });

    it('carries the bank line and invoice behind a cash-receipts payment entry', () => {
      // A second book on the cash receipts basis: the tax point is the payment.
      const cash = createTestDatabase();
      const created = createCompany(cash.db, {
        legalName: 'Cash Ltd', vatRegistrationStatus: 'registered',
        vatAccountingBasis: 'cash_receipts', seedYears: [2025],
      });
      const cashPeriodId = cash.db.select().from(vatPeriods)
        .where(eq(vatPeriods.name, 'Mar–Apr 2025')).get()!.id;
      const cashBankAccountId = addBankAccount(cash.db, {
        companyId: created.companyId, bankName: 'BOI',
        accountName: 'Current', openingDate: '2025-01-01',
      });
      const customerId = ids.customer();
      cash.db.insert(customers).values({
        id: customerId, companyId: created.companyId, name: 'Paris SARL',
        matchKey: 'paris sarl', countryCode: 'FR',
      }).run();

      const invoice = createInvoice(cash.db, {
        companyId: created.companyId, direction: 'sales',
        invoiceDate: makeDate(2025, 1, 10), invoiceNumber: 'C-1', customerId,
        lines: [{
          description: 'Consulting', netMinor: 50_000,
          accountId: created.accountsByCode['4020']!,
          vatTreatmentId: created.treatmentsByCode['IE_STD']!,
        }],
      });
      // On the cash basis nothing is recognised until the money arrives.
      expect(buildVat3Return(cash.db, {
        companyId: created.companyId, vatPeriodId: cashPeriodId,
      }).T1.entryCount).toBe(0);

      const receiptId = insertTestBankTransaction(cash.db, {
        companyId: created.companyId, bankAccountId: cashBankAccountId,
        transactionDate: '2025-04-01', description: 'PARIS SARL',
        amountMinor: 61_500,
      });
      recordPayment(cash.db, {
        companyId: created.companyId, direction: 'received',
        paymentDate: makeDate(2025, 4, 1), amountMinor: 61_500,
        bankTransactionId: receiptId,
        allocations: [{ invoiceId: invoice.invoiceId, allocatedMinor: 61_500 }],
      });

      const rows = drillIntoBox(cash.db, {
        companyId: created.companyId, vatPeriodId: cashPeriodId, box: 'T1',
      });
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.sourceType).toBe('payment');
      expect(row.bankTransactionId).toBe(receiptId);
      expect(row.invoiceId).toBe(invoice.invoiceId);
      expect(row.counterpartyName).toBe('Paris SARL');
      expect(row.journalEntryId).not.toBeNull();
      expect(row.journalEntryNumber).toBe(2); // invoice journal, then payment journal
    });

    it('leaves the invoice leg null when a payment settled several invoices', () => {
      const first = ids.customer();
      const second = ids.customer();
      db.insert(customers).values([
        { id: first, companyId, name: 'One Ltd', matchKey: 'one ltd', countryCode: 'IE' },
        { id: second, companyId, name: 'Two Ltd', matchKey: 'two ltd', countryCode: 'IE' },
      ]).run();
      const invoiceA = createInvoice(db, {
        companyId, direction: 'sales', invoiceDate: MAR_APR,
        invoiceNumber: 'S-2', customerId: first,
        lines: [{
          description: 'Work', netMinor: 40_000,
          accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']!,
        }],
      });
      const invoiceB = createInvoice(db, {
        companyId, direction: 'sales', invoiceDate: MAR_APR,
        invoiceNumber: 'S-3', customerId: second,
        lines: [{
          description: 'More work', netMinor: 60_000,
          accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']!,
        }],
      });
      const lumpId = insertTestBankTransaction(db, {
        companyId, bankAccountId, transactionDate: '2025-03-25',
        description: 'BULK RECEIPT', amountMinor: 123_000,
      });
      recordPayment(db, {
        companyId, direction: 'received', paymentDate: makeDate(2025, 3, 25),
        amountMinor: 123_000, bankTransactionId: lumpId,
        allocations: [
          { invoiceId: invoiceA.invoiceId, allocatedMinor: 49_200 },
          { invoiceId: invoiceB.invoiceId, allocatedMinor: 73_800 },
        ],
      });

      // The bank line is still evidence; the invoice it belongs to is not
      // asserted, because one payment settled two.
      for (const row of drillIntoBox(db, { companyId, vatPeriodId: periodId, box: 'T1' })) {
        expect(row.bankTransactionId).toBe(lumpId);
        expect(row.invoiceId).toBeNull();
      }
    });
  });
});

describe('period validation', () => {
  it('says NOT READY, never that a filing is compliant', () => {
    insertTestBankTransaction(db, {
      id: 'btx_1', companyId, bankAccountId, transactionDate: '2025-03-15',
      description: 'UNKNOWN', amountMinor: -1000, status: 'unclassified',
    });

    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    expect(validation.verdict).toBe('NOT READY');
    expect(validation.ready).toBe(false);
    // README §48: never claim compliance. The verdict is one of two fixed
    // strings, and neither the verdict nor the summary asserts correctness.
    expect(['Internal checks passed', 'NOT READY']).toContain(validation.verdict);
    expect(validation.summary.toLowerCase()).not.toContain('compliant');
    expect(validation.summary.toLowerCase()).not.toContain('correct');
    // The disclaimer mentions compliance only to disclaim it.
    expect(validation.disclaimer).toContain('not a statement that your VAT return is correct');
    expect(validation.disclaimer).toMatch(/not a statement.*compliant/s);
  });

  it('says "Internal checks passed" when nothing blocks', () => {
    addVat('IE_STD', { netMinor: 10_000 });
    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    expect(validation.verdict).toBe('Internal checks passed');
    expect(validation.ready).toBe(true);
  });

  it('blocks on unclassified transactions', () => {
    insertTestBankTransaction(db, {
      id: 'btx_2', companyId, bankAccountId, transactionDate: '2025-04-01',
      description: 'MYSTERY', amountMinor: -5000, status: 'unclassified',
    });

    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    const finding = validation.findings.find((f) => f.code === 'unclassified_transactions')!;
    expect(finding.severity).toBe('blocking');
    expect(finding.entityIds).toContain('btx_2');
  });

  it('blocks on unconfirmed AI suggestions', () => {
    insertTestBankTransaction(db, {
      id: 'btx_3', companyId, bankAccountId, transactionDate: '2025-03-20',
      description: 'AI GUESS', amountMinor: -5000, status: 'suggested', source: 'ai',
      provenanceStatus: 'ai_suggestion',
    });

    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    expect(validation.findings.some((f) => f.code === 'unresolved_ai_suggestions')).toBe(true);
    expect(validation.ready).toBe(false);
  });

  it('flags a repayment position for a deliberate look', () => {
    addVat('IE_STD', { netMinor: 100_000 });
    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    const finding = validation.findings.find((f) => f.code === 'repayment_position')!;
    expect(finding.severity).toBe('info');
    // Informational findings do not block.
    expect(validation.ready).toBe(true);
  });

  it('warns on an empty period rather than silently filing a nil return', () => {
    const validation = validateVatPeriod(db, { companyId, vatPeriodId: periodId });
    expect(validation.findings.some((f) => f.code === 'no_entries')).toBe(true);
  });
});

describe('period lifecycle', () => {
  beforeEach(() => { addVat('IE_STD', { netMinor: 10_000 }); });

  it('moves open -> review -> ready -> locked -> submitted', () => {
    expect(transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' }).status)
      .toBe('review');
    expect(transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' }).status)
      .toBe('ready');
    expect(transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'locked' }).status)
      .toBe('locked');
    expect(transitionVatPeriod(db, {
      companyId, vatPeriodId: periodId, to: 'submitted', submissionReference: 'ROS-123',
    }).status).toBe('submitted');
  });

  it('refuses to skip straight from open to locked', () => {
    expect(() => transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'locked' }))
      .toThrow(/cannot go from "open" to "locked"/);
  });

  it('refuses to mark ready while a blocking issue stands', () => {
    insertTestBankTransaction(db, {
      id: 'btx_4', companyId, bankAccountId, transactionDate: '2025-03-15',
      description: 'UNCLASSIFIED', amountMinor: -1000, status: 'unclassified',
    });

    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' });
    expect(() => transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' }))
      .toThrow(/NOT READY/);
    expect(db.select().from(vatPeriods).where(eq(vatPeriods.id, periodId)).get()!.status)
      .toBe('review');
  });

  it('writes blocking findings into the review queue', () => {
    insertTestBankTransaction(db, {
      id: 'btx_5', companyId, bankAccountId, transactionDate: '2025-03-15',
      description: 'UNCLASSIFIED', amountMinor: -1000, status: 'unclassified',
    });

    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' });
    try { transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' }); } catch { /* expected */ }

    const items = db.select().from(reviewItems).all();
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.title.includes('unclassified'))).toBe(true);
  });

  it('snapshots the figures as filed on submission', () => {
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'locked' });
    transitionVatPeriod(db, {
      companyId, vatPeriodId: periodId, to: 'submitted', submissionReference: 'ROS-1',
    });

    const period = db.select().from(vatPeriods).where(eq(vatPeriods.id, periodId)).get()!;
    expect(period.filedT2Minor).toBe(2_300);
    expect(period.submissionReference).toBe('ROS-1');

    // A later entry into the filed period is refused (issue #226): the live
    // return stays equal to what was filed.
    expect(() => addVat('IE_STD', { netMinor: 50_000 })).toThrow(/submitted/);
    const after = db.select().from(vatPeriods).where(eq(vatPeriods.id, periodId)).get()!;
    expect(after.filedT2Minor).toBe(2_300);
    expect(buildVat3Return(db, { companyId, vatPeriodId: periodId }).T2.amountMinor)
      .toBe(2_300);
  });

  it('refuses any transition out of submitted', () => {
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'review' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'ready' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'locked' });
    transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'submitted' });
    expect(() => transitionVatPeriod(db, { companyId, vatPeriodId: periodId, to: 'open' }))
      .toThrow(/cannot go from "submitted"/);
  });
});

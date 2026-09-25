import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from '../banking/import';
import { classifyTransaction, reclassifyTransaction, ClassificationError } from '../banking/classify';
import { createInvoice, voidInvoice } from '../invoicing/invoices';
import { PeriodLockedError } from './errors';
import { atomically, postJournalEntry } from './journal';
import { trialBalance } from './ledger';
import { asIsoDate, makeDate } from '../dates';
import {
  accountingPeriods, bankTransactions, customers, journalEntries, vatEntries, auditEvents, invoices,
} from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

/**
 * Issue #231: a posting path with more than one step either completes or
 * writes nothing. A step refused after an earlier step posted — a new
 * classification in a locked accounting period after the old one was
 * reversed in an open one — must not leave the earlier step behind.
 */

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025, 2026],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'BOI', accountName: 'Current', openingDate: '2025-01-01', accountId: acc['bank_control'],
  });
});

const lockYear = (year: number) => db.update(accountingPeriods).set({ status: 'locked' })
  .where(and(eq(accountingPeriods.companyId, companyId), eq(accountingPeriods.startDate, `${year}-01-01`))).run();

/** Everything a half-done path could leave behind. */
const snapshot = () => ({
  journals: db.select().from(journalEntries).all().length,
  vat: db.select().from(vatEntries).all().length,
  audit: db.select().from(auditEvents).all().length,
  lines: db.select().from(bankTransactions).all()
    .map((t) => ({ id: t.id, status: t.status, journalEntryId: t.journalEntryId, accountId: t.accountId })),
});

async function classifiedInMarch() {
  await importStatement(db, {
    companyId, bankAccountId, filename: 's.csv',
    content: 'Date,Description,Amount\n14/03/2025,CARD SALES,123.00',
    fileFormat: 'csv', columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
  });
  const tx = db.select().from(bankTransactions).get()!;
  classifyTransaction(db, {
    companyId, bankTransactionId: tx.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']!,
  });
  return tx;
}

describe('reclassifying in a locked accounting period', () => {
  it('refuses with nothing written when the transaction’s own period is locked, even with an open reversal date', async () => {
    const tx = await classifiedInMarch();
    lockYear(2025);
    const before = snapshot();

    expect(() => reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id, accountId: byCode['4000']!, vatTreatmentId: tr['IE_ZERO']!,
      reason: 'Wrong treatment', reversalDate: asIsoDate('2026-01-15'),
    })).toThrow(ClassificationError);

    expect(snapshot()).toEqual(before);
    expect(trialBalance(db, { companyId, asOf: makeDate(2026, 12, 31) }).balanced).toBe(true);
  });

  it('refuses with nothing written when the reversal date is in a locked period', async () => {
    const tx = await classifiedInMarch();
    lockYear(2026);
    const before = snapshot();
    expect(() => reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id, accountId: byCode['4000']!, vatTreatmentId: tr['OUT_OF_SCOPE']!,
      reason: 'Wrong treatment', reversalDate: asIsoDate('2026-01-15'),
    })).toThrow(PeriodLockedError);
    expect(snapshot()).toEqual(before);
  });

  it('completes fully when both periods are open', async () => {
    const tx = await classifiedInMarch();
    const result = reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id, accountId: byCode['4000']!, vatTreatmentId: tr['OUT_OF_SCOPE']!,
      reason: 'Wrong treatment', reversalDate: asIsoDate('2026-01-15'),
    });
    const after = db.select().from(bankTransactions).where(eq(bankTransactions.id, tx.id)).get()!;
    expect(after).toMatchObject({ status: 'posted', journalEntryId: result.journalEntryId });
  });

  it('rolls the reversal back when the new classification fails for any other reason', async () => {
    const tx = await classifiedInMarch();
    const before = snapshot();
    expect(() => reclassifyTransaction(db, {
      companyId, bankTransactionId: tx.id, accountId: 'acc_does_not_exist', vatTreatmentId: tr['OUT_OF_SCOPE']!,
      reason: 'Wrong account',
    })).toThrow();
    expect(snapshot()).toEqual(before);
  });
});

describe('voiding an invoice', () => {
  it('writes nothing when the void date is in a locked period', () => {
    const customerId = ids.customer();
    db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
    const inv = createInvoice(db, {
      companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-14'), customerId,
      lines: [{ description: 'Consulting', netMinor: 10_000, accountId: byCode['4000']!, vatTreatmentId: tr['IE_STD']! }],
    });
    lockYear(2025);
    const before = snapshot();
    expect(() => voidInvoice(db, {
      companyId, invoiceId: inv.invoiceId, reason: 'Issued in error', voidDate: asIsoDate('2025-03-20'),
    })).toThrow(PeriodLockedError);
    expect(snapshot()).toEqual(before);
    expect(db.select().from(invoices).where(eq(invoices.id, inv.invoiceId)).get()!.status).not.toBe('void');
  });
});

describe('atomically', () => {
  it('rolls back an earlier posting when a later step throws', () => {
    const before = snapshot();
    expect(() => atomically(db, () => {
      postJournalEntry(db, {
        companyId, entryDate: asIsoDate('2025-03-14'), narrative: 'Step one', sourceType: 'manual_adjustment',
        baseCurrency: 'EUR', createdBy: 'test', createdVia: 'user',
        lines: [
          { accountId: acc['bank_control']!, debitMinor: 100 },
          { accountId: byCode['4000']!, creditMinor: 100 },
        ],
      });
      throw new Error('step two refused');
    })).toThrow('step two refused');
    expect(snapshot()).toEqual(before);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { bankTransactions, companies, customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany, addBankAccount } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { createAdjustment } from '../accounting/adjustments';
import { trialBalance } from '../accounting/ledger';
import { profitAndLoss } from '../reports/financial';
import { unmatchedTransactions } from '../matching/service';
import { agedAnalysis } from '../invoicing/payments';
import { listAdjustments } from '../accounting/adjustments';
import { asIsoDate } from '../dates';

/**
 * Company scoping (issue #298) — the local-first reading of "row-level
 * security". There is no server, so there is no database-level RLS to lean
 * on: every domain path takes a `companyId` and must filter by it. This test
 * puts two companies in one database, books figures into both, and proves
 * that no read or write path consulted for one company ever returns the
 * other's rows.
 */

let db: AppDatabase;
let alpha: { companyId: string; accountsByCode: Record<string, string>; treatmentsByCode: Record<string, string> };
let beta: { companyId: string; accountsByCode: Record<string, string>; treatmentsByCode: Record<string, string> };

beforeEach(() => {
  ({ db } = createTestDatabase());
  alpha = createCompany(db, { legalName: 'Alpha Ltd', seedYears: [2025] });
  beta = createCompany(db, { legalName: 'Beta Ltd', seedYears: [2025] });
});

/** A sale for one company: its own customer, its own chart, a distinctive amount. */
function sale(
  co: typeof alpha,
  invoiceNumber: string,
  netMinor: number,
): ReturnType<typeof createInvoice> {
  const customerId = ids.customer();
  db.insert(customers).values({
    id: customerId, companyId: co.companyId, name: invoiceNumber, matchKey: invoiceNumber.toLowerCase(), countryCode: 'IE',
  }).run();
  return createInvoice(db, {
    companyId: co.companyId, direction: 'sales', invoiceDate: asIsoDate('2025-06-01'),
    customerId, invoiceNumber,
    lines: [{ description: `${invoiceNumber} consulting`, netMinor, accountId: co.accountsByCode['4020']!, vatTreatmentId: co.treatmentsByCode['IE_STD']! }],
  });
}

describe('company scoping', () => {
  it('starts from two distinct companies in one book', () => {
    const rows = db.select().from(companies).all();
    expect(rows.map((c) => c.legalName).sort()).toEqual(['Alpha Ltd', 'Beta Ltd']);
    expect(alpha.companyId).not.toBe(beta.companyId);
  });

  it('scopes the trial balance to the company asked about', () => {
    sale(alpha, 'A-1', 1_000);
    sale(beta, 'B-1', 777_777);

    const tbAlpha = trialBalance(db, { companyId: alpha.companyId, asOf: asIsoDate('2025-12-31') });
    const tbBeta = trialBalance(db, { companyId: beta.companyId, asOf: asIsoDate('2025-12-31') });

    const alphaAccounts = new Set(Object.values(alpha.accountsByCode));
    const betaAccounts = new Set(Object.values(beta.accountsByCode));
    expect(tbAlpha.rows.every((r) => alphaAccounts.has(r.accountId))).toBe(true);
    expect(tbAlpha.rows.some((r) => betaAccounts.has(r.accountId))).toBe(false);
    expect(tbBeta.rows.every((r) => betaAccounts.has(r.accountId))).toBe(true);
    expect(tbBeta.rows.some((r) => alphaAccounts.has(r.accountId))).toBe(false);

    // The figures are the company's own: no row of Alpha's carries Beta's amount.
    expect(JSON.stringify(tbAlpha)).not.toContain('777777');
    expect(JSON.stringify(tbBeta)).not.toContain('1230');
  });

  it('scopes profit and loss: one company never sees the other\'s figures', () => {
    sale(alpha, 'A-1', 1_000);
    sale(beta, 'B-1', 777_777);

    const from = asIsoDate('2025-01-01');
    const to = asIsoDate('2025-12-31');
    const plAlpha = profitAndLoss(db, { companyId: alpha.companyId, from, to });
    const plBeta = profitAndLoss(db, { companyId: beta.companyId, from, to });

    const alphaFigures = JSON.stringify(plAlpha);
    expect(alphaFigures).toContain('1000');
    expect(alphaFigures).not.toContain('777777');
    expect(JSON.stringify(plBeta)).toContain('777777');
    expect(JSON.stringify(plBeta)).not.toContain('1000');
  });

  it('scopes unmatched bank transactions', () => {
    insertTestBankTransaction(db, {
      companyId: alpha.companyId, bankAccountId: addBankAccount(db, {
        companyId: alpha.companyId, bankName: 'AIB', accountName: 'Current',
        openingDate: '2025-01-01', accountId: alpha.accountsByCode['bank_control']!,
      }), amountMinor: -5_000,
    });
    insertTestBankTransaction(db, {
      companyId: beta.companyId, bankAccountId: addBankAccount(db, {
        companyId: beta.companyId, bankName: 'BOI', accountName: 'Current',
        openingDate: '2025-01-01', accountId: beta.accountsByCode['bank_control']!,
      }), amountMinor: -6_000,
    });

    const alphaIds = unmatchedTransactions(db, { companyId: alpha.companyId }).map((t) => t.id);
    const betaIds = unmatchedTransactions(db, { companyId: beta.companyId }).map((t) => t.id);
    const all = db.select().from(bankTransactions).all();

    expect(all).toHaveLength(2);
    expect(alphaIds).toHaveLength(1);
    expect(betaIds).toHaveLength(1);
    expect(alphaIds).not.toEqual(betaIds);
    const alphaTx = db.select().from(bankTransactions).where(eq(bankTransactions.id, alphaIds[0]!)).get()!;
    expect(alphaTx.companyId).toBe(alpha.companyId);
  });

  it('scopes adjustments: a write for one company never reaches the other', () => {
    createAdjustment(db, {
      companyId: alpha.companyId,
      date: asIsoDate('2025-06-01'),
      description: 'Alpha accrual',
      reason: 'Alpha year-end accrual',
      lines: [
        { accountId: alpha.accountsByCode['6120']!, debitMinor: 1_000 },
        { accountId: alpha.accountsByCode['2100']!, creditMinor: 1_000 },
      ],
    });
    createAdjustment(db, {
      companyId: beta.companyId,
      date: asIsoDate('2025-06-01'),
      description: 'Beta accrual',
      reason: 'Beta year-end accrual',
      lines: [
        { accountId: beta.accountsByCode['6120']!, debitMinor: 2_000 },
        { accountId: beta.accountsByCode['2100']!, creditMinor: 2_000 },
      ],
    });

    const alphaList = listAdjustments(db, { companyId: alpha.companyId });
    const betaList = listAdjustments(db, { companyId: beta.companyId });

    expect(alphaList.map((a) => a.description)).toEqual(['Alpha accrual']);
    expect(betaList.map((a) => a.description)).toEqual(['Beta accrual']);
  });

  it('scopes the aged analysis to the company\'s own debtors', () => {
    sale(alpha, 'A-1', 1_000);
    sale(beta, 'B-1', 777_777);

    const asOf = asIsoDate('2025-12-31');
    const alphaAged = agedAnalysis(db, { companyId: alpha.companyId, direction: 'sales', asOf });
    const betaAged = agedAnalysis(db, { companyId: beta.companyId, direction: 'sales', asOf });

    expect(alphaAged.rows.every((r) => r.invoice.companyId === alpha.companyId)).toBe(true);
    expect(betaAged.rows.every((r) => r.invoice.companyId === beta.companyId)).toBe(true);
    expect(alphaAged.totalMinor).not.toBe(betaAged.totalMinor);
  });
});

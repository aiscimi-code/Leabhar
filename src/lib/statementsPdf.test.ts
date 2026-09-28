import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { postJournalEntry } from '@/domain/accounting/journal';
import { trialBalance } from '@/domain/accounting/ledger';
import { profitAndLoss, balanceSheet } from '@/domain/reports/financial';
import { cashFlowStatement } from '@/domain/reports/cashFlow';
import { asIsoDate } from '@/domain/dates';
import { profitAndLossBlock, balanceSheetBlock, cashFlowBlock, trialBalanceBlock } from './statementLines';
import { renderStatementsPdf } from './statementsPdf';

/** Issue #553: the PDF and spreadsheet exports lay out the domain's figures, unchanged. */
describe('statement blocks and the PDF export', () => {
  it('carries the domain figures into the lines and renders every block', async () => {
    const { db } = createTestDatabase();
    const { companyId, accountsByKey: acc, accountsByCode: byCode } = createCompany(db, { legalName: 'Tuairisc Ltd', seedYears: [2026] });
    postJournalEntry(db, { companyId, entryDate: asIsoDate('2026-02-01'), narrative: 'Sale', sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [{ accountId: acc['bank_control']!, debitMinor: 250_000 }, { accountId: byCode['4020']!, creditMinor: 250_000 }] });
    const from = asIsoDate('2026-01-01'), to = asIsoDate('2026-12-31');
    const pl = profitAndLoss(db, { companyId, from, to });
    const bs = balanceSheet(db, { companyId, asOf: to, financialYearStart: from });
    const cf = cashFlowStatement(db, { companyId, from, to });
    const tb = trialBalance(db, { companyId, asOf: to, baseCurrency: 'EUR' });
    const blocks = [profitAndLossBlock(pl), balanceSheetBlock(bs), cashFlowBlock(cf), trialBalanceBlock(tb, 'EUR')];
    expect(blocks[0]!.lines.find((l) => l.label === 'Net profit')!.values).toEqual([250_000]);
    expect(blocks[2]!.lines.find((l) => l.label === 'Net increase/(decrease) in cash')!.values).toEqual([250_000]);
    expect(blocks[3]!.lines.at(-1)!.values).toEqual([250_000, 250_000]);

    const bytes = await renderStatementsPdf({ companyName: 'Tuairisc Ltd', period: '2026', currency: 'EUR', generatedOn: '2026-09-28', blocks });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(4);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { seedDemoCompany } from './demo';
import {
  companies, bankTransactions, documents, vatPeriods, reviewItems,
  suppliers, fixedAssets, rules, taxDeadlines, payments,
} from '@/db/schema';
import { trialBalance } from '@/domain/accounting/ledger';
import { balanceSheet, profitAndLoss } from '@/domain/reports/financial';
import { buildVat3Return } from '@/domain/vat/report';
import { validateVatPeriod } from '@/domain/vat/periodClose';
import { makeDate } from '@/domain/dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let root: string;

beforeAll(async () => {
  ({ db } = createTestDatabase());
  root = mkdtempSync(join(tmpdir(), 'seed-'));
  ({ companyId } = await seedDemoCompany(db, { storageRoot: root }));
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('demo data', () => {
  it('is unmistakably labelled as demo data', () => {
    const company = db.select().from(companies).where(eq(companies.id, companyId)).get()!;
    expect(company.isDemo).toBe(true);
    expect(company.legalName).toBe('Acme Software Limited');
  });

  it('leaves the books balanced', () => {
    const tb = trialBalance(db, { companyId, asOf: makeDate(2025, 12, 31) });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0);
  });

  it('produces a balance sheet that balances', () => {
    const bs = balanceSheet(db, {
      companyId, asOf: makeDate(2025, 12, 31), financialYearStart: makeDate(2025, 1, 1),
    });
    expect(bs.balances).toBe(true);
  });

  it('imports the duplicate statement without adding transactions', () => {
    const all = db.select().from(bankTransactions)
      .where(eq(bankTransactions.companyId, companyId)).all();
    // 22 statement lines, imported twice.
    expect(all).toHaveLength(22);
    expect(new Set(all.map((t) => t.fingerprint)).size).toBe(22);
  });

  it('includes the awkward cases the system exists to handle', () => {
    const all = db.select().from(bankTransactions)
      .where(eq(bankTransactions.companyId, companyId)).all();

    // Reverse charge (US), EU acquisition, exempt, zero-rated, capital purchase.
    expect(all.some((t) => t.description.includes('ANTHROPIC'))).toBe(true);
    expect(all.some((t) => t.description.includes('AWS EMEA'))).toBe(true);
    expect(all.some((t) => t.description.includes('INSURANCE'))).toBe(true);
    expect(all.some((t) => t.description.includes('IARNROD'))).toBe(true);
    expect(all.some((t) => t.description.includes('APPLE STORE'))).toBe(true);

    // At least one unclassified transaction, so the review queue is not empty.
    expect(all.some((t) => t.status === 'unclassified')).toBe(true);
  });

  it('has suppliers spanning Ireland, the EU and outside the EU', () => {
    const rows = db.select().from(suppliers).where(eq(suppliers.companyId, companyId)).all();
    const countries = new Set(rows.map((s) => s.countryCode));
    expect(countries).toContain('IE');
    expect(countries).toContain('LU');
    expect(countries).toContain('DE');
    expect(countries).toContain('US');
  });

  it('records a director-paid expense and a capital purchase', () => {
    // Paid on the director's personal card, against its confirmed invoice
    // (issue #221): the reverse charge is self-assessed from the invoice.
    const directorPayment = db.select().from(payments)
      .where(and(eq(payments.companyId, companyId), eq(payments.method, 'director_personal'))).get();
    expect(directorPayment?.officerId).toBeTruthy();
    expect(directorPayment?.amountMinor).toBe(8_400);

    const assets = db.select().from(fixedAssets)
      .where(eq(fixedAssets.companyId, companyId)).all();
    expect(assets).toHaveLength(1);
    expect(assets[0]!.name).toBe('MacBook Pro 14-inch');
    // Accounting depreciation and capital allowances are tracked separately.
    expect(assets[0]!.usefulLifeMonths).toBe(36);
    expect(assets[0]!.capitalAllowanceRateBasisPoints).toBe(1250);
  });

  it('extracts the demo documents', () => {
    const rows = db.select().from(documents).where(eq(documents.companyId, companyId)).all();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const extracted = rows.filter((d) => d.extractionStatus === 'extracted');
    expect(extracted.length).toBeGreaterThan(5);
    const byrne = rows.find((d) => d.originalFilename.includes('byrne'))!;
    expect(byrne.grossMinor).toBe(61_500);
    expect(byrne.vatMinor).toBe(11_500);
  });

  it('flags the duplicate document without overwriting the original', () => {
    const rows = db.select().from(documents).where(eq(documents.companyId, companyId)).all();
    const duplicate = rows.find((d) => d.originalFilename.includes('copy'))!;
    expect(duplicate.isDuplicateOf).toBeTruthy();
  });

  it('produces a VAT return with both reverse-charge legs', () => {
    const period = db.select().from(vatPeriods)
      .where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, 'Jan–Feb 2025')))
      .get()!;
    const report = buildVat3Return(db, { companyId, vatPeriodId: period.id });

    // Sales VAT from the Irish customer, plus self-accounted reverse charge.
    expect(report.T1.amountMinor).toBeGreaterThan(0);
    expect(report.T2.amountMinor).toBeGreaterThan(0);
    expect(report.reverseChargeVatMinor).toBeGreaterThan(0);
    // EU services received are reported in ES2.
    expect(report.ES2.amountMinor).toBeGreaterThan(0);
  });

  it('reports the EU supply in ES1', () => {
    const period = db.select().from(vatPeriods)
      .where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, 'Mar–Apr 2025')))
      .get()!;
    const report = buildVat3Return(db, { companyId, vatPeriodId: period.id });
    expect(report.ES1.amountMinor).toBe(600_000);
  });

  it('has a review queue with real work in it', () => {
    const items = db.select().from(reviewItems)
      .where(and(eq(reviewItems.companyId, companyId), eq(reviewItems.status, 'open'))).all();
    expect(items.length).toBeGreaterThan(0);
  });

  it('reports the VAT period as NOT READY while work remains', () => {
    const period = db.select().from(vatPeriods)
      .where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, 'Mar–Apr 2025')))
      .get()!;
    const validation = validateVatPeriod(db, { companyId, vatPeriodId: period.id });
    expect(validation.verdict).toBe('NOT READY');
    expect(validation.findings.some((f) => f.code === 'unclassified_transactions')).toBe(true);
  });

  it('ships inspectable rules, including one that flags rather than decides', () => {
    const rows = db.select().from(rules).where(eq(rules.companyId, companyId)).all();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const capital = rows.find((r) => r.name.includes('capital review'))!;
    expect(capital.autoApply).toBe(false);
    expect(capital.description).toContain('flags it for a decision rather than making one');
  });

  it('populates the tax calendar with sourced, non-assumed deadlines', () => {
    const rows = db.select().from(taxDeadlines)
      .where(eq(taxDeadlines.companyId, companyId)).all();
    expect(rows.length).toBeGreaterThan(6);
    expect(rows.every((d) => d.sourceNote !== null)).toBe(true);
    expect(rows.find((d) => d.kind === 'corporation_tax_return')!.sourceNote)
      .toContain('Confirm your own filing deadline');
  });

  it('produces a sensible profit and loss', () => {
    const pl = profitAndLoss(db, {
      companyId, from: makeDate(2025, 1, 1), to: makeDate(2025, 12, 31),
    });
    expect(pl.revenue.valueMinor).toBeGreaterThan(0);
    expect(pl.operatingExpenses.valueMinor).toBeGreaterThan(0);
    // Revenue exceeds costs on this dataset.
    expect(pl.netProfit.valueMinor).toBeGreaterThan(0);
  });
});

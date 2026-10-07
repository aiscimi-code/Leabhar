import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import { computeCorporationTax } from '../corporationTax/computation';
import { computeIncomeTax } from '../incomeTax/computation';
import { PayrollFigures } from '../payroll/figures';
import { companies, invoiceLines, suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import { makeDate } from '../dates';
import { appliedRuleVersions, ruleVersionId } from './irishRules';
import type { AppDatabase } from '@/db';

describe('rule versions recorded where a rule is applied (ADR-0020 §2, issue #686 step 7)', () => {
  let db: AppDatabase;
  let companyId: string;
  let soleId: string;
  let byCode: Record<string, string>;
  let tr: Record<string, string>;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    const created = createCompany(db, { legalName: 'Versions Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    ({ companyId } = created);
    byCode = created.accountsByCode;
    tr = created.treatmentsByCode;
    soleId = createCompany(db, { legalName: 'Sole', entityType: 'sole_trader', vatRegistrationStatus: 'not_registered', seedYears: [2025] }).companyId;
    db.update(companies).set({ tradeCommencedOn: '2024-01-01' }).where(eq(companies.id, soleId)).run();
  });

  it('names a version as key@version', () => {
    expect(ruleVersionId('vat.rate_standard_current', 3)).toBe('vat.rate_standard_current@3');
  });

  it('gives the version in force on the date, and leaves out a key the book does not hold', () => {
    const on = (d: string) => appliedRuleVersions(db, { companyId, ruleKeys: ['vat.rate_standard_current', 'vat.no_such_rule'], asOfDate: d });
    expect(on('2020-10-01')).toEqual(['vat.rate_standard_current@2']); // 21%
    expect(on('2025-06-01')).toEqual(['vat.rate_standard_current@3']);
  });

  it('records the versions on an invoice line beside the keys', () => {
    const supplierId = ids.supplier();
    db.insert(suppliers).values({ id: supplierId, companyId, name: 'Byrne', matchKey: 'byrne', countryCode: 'IE' }).run();
    const { invoiceId } = createInvoice(db, {
      companyId, direction: 'purchase', invoiceDate: makeDate(2025, 3, 10), invoiceNumber: 'V-1', supplierId,
      lines: [{
        description: 'Stationery', netMinor: 10_000, accountId: byCode['6070']!, vatTreatmentId: tr['IE_STD']!,
        vatRuleKeys: ['vat.rate_standard_current', 'vat.no_such_rule'],
      }],
    });
    const [line] = db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId)).all();
    expect(line!.vatRuleKeys).toEqual(['vat.rate_standard_current', 'vat.no_such_rule']);
    expect(line!.vatRuleVersions).toEqual(['vat.rate_standard_current@3']);
  });

  it('snapshots the version on each payslip figure', () => {
    const figures = new PayrollFigures(db, companyId, '2025-06-30');
    figures.value('usc.band_2pct');
    expect(figures.snapshot()[0]!.versionId).toMatch(/^usc\.band_2pct@\d+$/);
  });

  it('lists the versions a corporation tax and an income tax computation read', () => {
    const ct = computeCorporationTax(db, { companyId, from: makeDate(2025, 1, 1), to: makeDate(2025, 12, 31) });
    expect(ct.ruleVersions).toContain('ct.rate_standard@1');
    expect(ct.ruleVersions.every((v) => /^[a-z0-9_.]+@\d+$/.test(v))).toBe(true);
    const it_ = computeIncomeTax(db, { companyId: soleId, year: 2025 });
    expect(it_.ruleVersions.some((v) => v.startsWith('income_tax.'))).toBe(true);
  });
});

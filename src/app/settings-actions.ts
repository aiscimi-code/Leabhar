'use server';

import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import {
  updateCompany, supersedeTaxRate, createTaxRate, deactivateTaxRate,
  updateVatTreatment, createAccount, updateAccount,
  generateVatPeriodsForYear, generateFinancialYearPeriod, updateVatPeriod,
  updateBankAccount, upsertSupplier, type CompanyUpdate,
} from '@/domain/config/mutations';
import { createCompany as createNewCompany, addBankAccount } from '@/domain/config/setup';
import { completeReconciliation } from '@/domain/banking/reconciliation';
import { createAdjustment, reverseAdjustment } from '@/domain/accounting/adjustments';
import { postDepreciation } from '@/domain/assets/depreciation';
import { scanForAnomalies, syncAnomaliesToReviewQueue } from '@/domain/review/anomalies';
import { createInvoice } from '@/domain/invoicing/invoices';
import { recordPayment } from '@/domain/invoicing/payments';
import { parseAmount, parseRate } from '@/domain/money';
import { asIsoDate } from '@/domain/dates';
import type { VatFrequency } from '@/domain/config/periods';

/**
 * Configuration and accounting mutations.
 *
 * Each delegates to the domain layer, so the rules that protect history —
 * superseding rather than overwriting, deactivating rather than deleting — hold
 * regardless of which screen the change came from. Warnings from the domain are
 * passed through to the user rather than swallowed.
 */

export type ActionResult =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };

function fail(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

const text = (formData: FormData, key: string): string | undefined => {
  const value = formData.get(key);
  if (value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
};

const optional = (formData: FormData, key: string): string | null | undefined => {
  const value = formData.get(key);
  if (value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

export async function updateCompanyAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const changes: CompanyUpdate = {};

    const stringFields = [
      'legalName', 'tradingName', 'croNumber', 'companyType', 'dateIncorporated',
      'registeredOffice', 'principalBusinessAddress', 'recordsAddress',
      'taxReferenceNumber', 'vatNumber', 'vatRegistrationDate', 'eoriNumber', 'notes',
    ] as const;

    for (const field of stringFields) {
      const value = optional(formData, field);
      if (value !== undefined) (changes as Record<string, unknown>)[field] = value;
    }

    const status = text(formData, 'vatRegistrationStatus');
    if (status) changes.vatRegistrationStatus = status as CompanyUpdate['vatRegistrationStatus'];

    const basis = text(formData, 'vatAccountingBasis');
    if (basis) changes.vatAccountingBasis = basis as 'invoice' | 'cash_receipts';

    const frequency = text(formData, 'vatPeriodFrequency');
    if (frequency) changes.vatPeriodFrequency = frequency as VatFrequency;

    const day = text(formData, 'financialYearEndDay');
    if (day) changes.financialYearEndDay = Number(day);
    const month = text(formData, 'financialYearEndMonth');
    if (month) changes.financialYearEndMonth = Number(month);

    const currency = text(formData, 'baseCurrency');
    if (currency) changes.baseCurrency = currency.toUpperCase();

    // Only a form that actually carries the checkbox may change it. Without
    // this marker an unrelated form — the identity fields, say — would post an
    // absent checkbox and silently deregister the company for corporation tax.
    if (formData.get('taxSection') !== null) {
      changes.corporationTaxRegistered = formData.get('corporationTaxRegistered') === 'on';
    }

    const result = updateCompany(getDb(), {
      companyId: company.id, changes, actor: 'user',
      reason: text(formData, 'reason'),
    });

    revalidatePath('/settings/company');
    revalidatePath('/');

    return result.changed.length === 0
      ? { ok: true, message: 'Nothing changed.' }
      : {
          ok: true,
          message: `Saved ${result.changed.length} change${result.changed.length === 1 ? '' : 's'}.`,
          warnings: result.warnings,
        };
  } catch (error) {
    return fail(error);
  }
}

export async function createCompanyAction(formData: FormData): Promise<ActionResult> {
  try {
    const db = getDb();
    const legalName = text(formData, 'legalName');
    if (!legalName) return { ok: false, error: 'A legal company name is required.' };

    const year = Number(text(formData, 'seedYear') ?? new Date().getFullYear());

    const created = createNewCompany(db, {
      legalName,
      tradingName: text(formData, 'tradingName'),
      croNumber: text(formData, 'croNumber'),
      dateIncorporated: text(formData, 'dateIncorporated'),
      registeredOffice: text(formData, 'registeredOffice'),
      vatNumber: text(formData, 'vatNumber'),
      vatRegistrationDate: text(formData, 'vatRegistrationDate'),
      vatRegistrationStatus: (text(formData, 'vatRegistrationStatus') ?? 'not_registered') as
        'not_registered' | 'registered',
      taxReferenceNumber: text(formData, 'taxReferenceNumber'),
      vatAccountingBasis: (text(formData, 'vatAccountingBasis') ?? 'cash_receipts') as
        'invoice' | 'cash_receipts',
      vatPeriodFrequency: (text(formData, 'vatPeriodFrequency') ?? 'bi_monthly') as VatFrequency,
      financialYearEndDay: Number(text(formData, 'financialYearEndDay') ?? 31),
      financialYearEndMonth: Number(text(formData, 'financialYearEndMonth') ?? 12),
      baseCurrency: (text(formData, 'baseCurrency') ?? 'EUR').toUpperCase(),
      seedYears: [year - 1, year],
    });

    const bankName = text(formData, 'bankName');
    if (bankName) {
      addBankAccount(db, {
        companyId: created.companyId,
        bankName,
        accountName: text(formData, 'accountName') ?? 'Current account',
        iban: text(formData, 'iban'),
        currency: (text(formData, 'baseCurrency') ?? 'EUR').toUpperCase(),
        openingBalanceMinor: text(formData, 'openingBalance')
          ? parseAmount(text(formData, 'openingBalance')!, 'EUR') : 0,
        openingDate: asIsoDate(text(formData, 'openingDate') ?? `${year}-01-01`),
      });
    }

    revalidatePath('/');
    revalidatePath('/settings/company');
    return {
      ok: true,
      message: `${legalName} created, with a chart of accounts, Irish VAT treatments and `
        + `periods for ${year}. Review the seeded tax rates before relying on them.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function supersedeTaxRateAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const rateText = text(formData, 'newRate');
    const effectiveFrom = text(formData, 'effectiveFrom');
    if (!rateText || !effectiveFrom) {
      return { ok: false, error: 'Give the new rate and the date it takes effect.' };
    }

    supersedeTaxRate(getDb(), {
      companyId: company.id,
      taxRateId: String(formData.get('taxRateId')),
      newRateBasisPoints: parseRate(rateText),
      effectiveFrom: asIsoDate(effectiveFrom),
      sourceNote: text(formData, 'sourceNote'),
      actor: 'user',
    });

    revalidatePath('/settings/rates');
    return {
      ok: true,
      message: `New rate takes effect from ${effectiveFrom}. Transactions before that date `
        + 'keep the old rate.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function createTaxRateAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const rateText = text(formData, 'rate');
    if (!rateText) return { ok: false, error: 'A rate is required.' };

    createTaxRate(getDb(), {
      companyId: company.id,
      code: text(formData, 'code') ?? 'CUSTOM',
      name: text(formData, 'name') ?? 'Custom rate',
      rateBasisPoints: parseRate(rateText),
      taxType: (text(formData, 'taxType') ?? 'vat') as 'vat',
      effectiveFrom: asIsoDate(text(formData, 'effectiveFrom') ?? '2025-01-01'),
      sourceNote: text(formData, 'sourceNote'),
      actor: 'user',
    });

    revalidatePath('/settings/rates');
    return { ok: true, message: 'Rate added.' };
  } catch (error) {
    return fail(error);
  }
}

export async function deactivateTaxRateAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const result = deactivateTaxRate(getDb(), {
      companyId: company.id,
      taxRateId: String(formData.get('taxRateId')),
      actor: 'user',
    });
    revalidatePath('/settings/rates');
    return {
      ok: true,
      message: result.referencedBy > 0
        ? `Deactivated. ${result.referencedBy} historical VAT `
          + `${result.referencedBy === 1 ? 'entry still references' : 'entries still reference'} `
          + 'it and are unaffected.'
        : 'Deactivated.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function updateTreatmentAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const result = updateVatTreatment(getDb(), {
      companyId: company.id,
      treatmentId: String(formData.get('treatmentId')),
      changes: {
        name: text(formData, 'name'),
        description: optional(formData, 'description'),
        sourceNote: optional(formData, 'sourceNote'),
        active: formData.get('active') === 'on',
      },
      actor: 'user',
    });
    revalidatePath('/settings/rates');
    return {
      ok: true,
      message: result.changed.length === 0 ? 'Nothing changed.' : 'Saved.',
      warnings: result.warnings,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function createAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const code = text(formData, 'code');
    const name = text(formData, 'name');
    const type = text(formData, 'type');
    if (!code || !name || !type) {
      return { ok: false, error: 'Code, name and type are all required.' };
    }

    createAccount(getDb(), {
      companyId: company.id,
      code, name,
      type: type as 'expense',
      subtype: text(formData, 'subtype'),
      reportSection: text(formData, 'reportSection') ?? 'operating_expenses',
      description: text(formData, 'description'),
      vatApplicable: formData.get('vatApplicable') === 'on',
      actor: 'user',
    });

    revalidatePath('/settings/accounts');
    return { ok: true, message: `Account ${code} added.` };
  } catch (error) {
    return fail(error);
  }
}

export async function updateAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const result = updateAccount(getDb(), {
      companyId: company.id,
      accountId: String(formData.get('accountId')),
      changes: {
        name: text(formData, 'name'),
        description: optional(formData, 'description'),
        active: formData.get('active') === 'on',
      },
      actor: 'user',
    });
    revalidatePath('/settings/accounts');
    return {
      ok: true,
      message: result.changed.length === 0 ? 'Nothing changed.' : 'Saved.',
      warnings: result.warnings,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function generatePeriodsAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const kind = String(formData.get('kind'));
    const year = Number(text(formData, 'year') ?? new Date().getFullYear());

    if (kind === 'financial_year') {
      const result = generateFinancialYearPeriod(getDb(), {
        companyId: company.id, endYear: year, actor: 'user',
      });
      revalidatePath('/settings/company');
      revalidatePath('/settings/periods');
      return {
        ok: true,
        message: `${result.name} created, covering ${result.startDate} to ${result.endDate}.`,
        warnings: result.issues,
      };
    }

    const result = generateVatPeriodsForYear(getDb(), {
      companyId: company.id, year,
      frequency: (text(formData, 'frequency') ?? company.vatPeriodFrequency) as VatFrequency,
      actor: 'user',
    });
    revalidatePath('/vat');
    revalidatePath('/settings/periods');
    return {
      ok: true,
      message: result.skipped > 0
        ? `${result.created} created. ${result.skipped} skipped because they would have `
          + 'overlapped periods you already have — existing periods are never moved.'
        : `${result.created} VAT periods created for ${year}.`,
      warnings: result.issues,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function updateVatPeriodAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    updateVatPeriod(getDb(), {
      companyId: company.id,
      vatPeriodId: String(formData.get('vatPeriodId')),
      changes: {
        name: text(formData, 'name'),
        startDate: text(formData, 'startDate'),
        endDate: text(formData, 'endDate'),
        filingDeadline: optional(formData, 'filingDeadline'),
      },
      actor: 'user',
    });
    revalidatePath('/vat');
    revalidatePath('/settings/periods');
    return { ok: true, message: 'Period updated.' };
  } catch (error) {
    return fail(error);
  }
}

export async function addBankAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const bankName = text(formData, 'bankName');
    if (!bankName) return { ok: false, error: 'A bank name is required.' };

    const currency = (text(formData, 'currency') ?? company.baseCurrency).toUpperCase();
    addBankAccount(getDb(), {
      companyId: company.id,
      bankName,
      accountName: text(formData, 'accountName') ?? 'Current account',
      iban: text(formData, 'iban'),
      bic: text(formData, 'bic'),
      currency,
      accountType: (text(formData, 'accountType') ?? 'current') as 'current',
      openingBalanceMinor: text(formData, 'openingBalance')
        ? parseAmount(text(formData, 'openingBalance')!, currency) : 0,
      openingDate: asIsoDate(text(formData, 'openingDate') ?? '2025-01-01'),
    });

    revalidatePath('/settings/company');
    revalidatePath('/import');
    return { ok: true, message: `${bankName} added.` };
  } catch (error) {
    return fail(error);
  }
}

export async function updateBankAccountAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const currency = text(formData, 'currency') ?? company.baseCurrency;
    const result = updateBankAccount(getDb(), {
      companyId: company.id,
      bankAccountId: String(formData.get('bankAccountId')),
      changes: {
        bankName: text(formData, 'bankName'),
        accountName: text(formData, 'accountName'),
        iban: optional(formData, 'iban'),
        bic: optional(formData, 'bic'),
        openingBalanceMinor: text(formData, 'openingBalance')
          ? parseAmount(text(formData, 'openingBalance')!, currency) : undefined,
        openingDate: text(formData, 'openingDate'),
        active: formData.get('active') === 'on',
      },
      actor: 'user',
    });
    revalidatePath('/settings/company');
    return {
      ok: true,
      message: result.changed.length === 0 ? 'Nothing changed.' : 'Saved.',
      warnings: result.warnings,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function saveSupplierAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const name = text(formData, 'name');
    if (!name) return { ok: false, error: 'A supplier name is required.' };

    upsertSupplier(getDb(), {
      companyId: company.id,
      supplierId: text(formData, 'supplierId'),
      name,
      countryCode: optional(formData, 'countryCode'),
      vatNumber: optional(formData, 'vatNumber'),
      defaultAccountId: optional(formData, 'defaultAccountId'),
      defaultVatTreatmentId: optional(formData, 'defaultVatTreatmentId'),
      aliases: (text(formData, 'aliases') ?? '').split(',')
        .map((a) => a.trim()).filter(Boolean),
      notes: optional(formData, 'notes'),
      actor: 'user',
    });

    revalidatePath('/suppliers');
    return { ok: true, message: `${name} saved.` };
  } catch (error) {
    return fail(error);
  }
}

export async function reconcileAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const currency = text(formData, 'currency') ?? company.baseCurrency;
    const closing = text(formData, 'statementClosingBalance');
    const reason = text(formData, 'acceptReason');

    const { result } = completeReconciliation(getDb(), {
      companyId: company.id,
      bankAccountId: String(formData.get('bankAccountId')),
      periodStart: asIsoDate(String(formData.get('periodStart'))),
      periodEnd: asIsoDate(String(formData.get('periodEnd'))),
      statementClosingBalanceMinor: closing ? parseAmount(closing, currency) : undefined,
      acceptDifference: reason ? { reason } : undefined,
      actor: 'user',
    });

    revalidatePath('/reconcile');
    revalidatePath('/transactions');
    return { ok: true, message: `Reconciliation recorded. ${result.summary}` };
  } catch (error) {
    return fail(error);
  }
}

export async function createAdjustmentAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const currency = company.baseCurrency;

    const debitAccountId = text(formData, 'debitAccountId');
    const creditAccountId = text(formData, 'creditAccountId');
    const amountText = text(formData, 'amount');
    const reason = text(formData, 'reason');
    const description = text(formData, 'description');

    if (!debitAccountId || !creditAccountId || !amountText || !description) {
      return { ok: false, error: 'Description, both accounts and an amount are required.' };
    }
    if (!reason) {
      return {
        ok: false,
        error: 'A reason is required. It is the only record of why this figure was entered '
          + 'by hand, and it is what an accountant will ask about first.',
      };
    }
    if (debitAccountId === creditAccountId) {
      return {
        ok: false,
        error: 'The debit and credit sides cannot be the same account — that would post '
          + 'nothing at all.',
      };
    }

    const amountMinor = parseAmount(amountText, currency);
    const result = createAdjustment(getDb(), {
      companyId: company.id,
      date: asIsoDate(text(formData, 'date') ?? new Date().toISOString().slice(0, 10)),
      description,
      reason,
      lines: [
        { accountId: debitAccountId, debitMinor: amountMinor },
        { accountId: creditAccountId, creditMinor: amountMinor },
      ],
      overrideLock: text(formData, 'overrideReason')
        ? { reason: text(formData, 'overrideReason')! } : undefined,
      actor: 'user',
    });

    revalidatePath('/adjustments');
    revalidatePath('/reports');
    return { ok: true, message: `Adjustment posted as entry #${result.entryNumber}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function reverseAdjustmentAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const reason = text(formData, 'reason');
    if (!reason) return { ok: false, error: 'A reason is required to reverse an adjustment.' };

    const result = reverseAdjustment(getDb(), {
      companyId: company.id,
      journalEntryId: String(formData.get('journalEntryId')),
      reversalDate: asIsoDate(text(formData, 'reversalDate')
        ?? new Date().toISOString().slice(0, 10)),
      reason,
      actor: 'user',
    });

    revalidatePath('/adjustments');
    return {
      ok: true,
      message: `Reversed as entry #${result.entryNumber}. The original stays in the books.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function postDepreciationAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const result = postDepreciation(getDb(), {
      companyId: company.id,
      upTo: asIsoDate(text(formData, 'upTo') ?? new Date().toISOString().slice(0, 10)),
      actor: 'user',
    });

    revalidatePath('/assets');
    revalidatePath('/reports');

    const parts = [
      `${result.periodsPosted} ${result.periodsPosted === 1 ? 'period' : 'periods'} posted `
        + `across ${result.assetsProcessed} ${result.assetsProcessed === 1 ? 'asset' : 'assets'}.`,
    ];
    for (const skipped of result.skipped) {
      parts.push(`${skipped.assetName}: ${skipped.reason}`);
    }
    return { ok: true, message: parts.join(' ') };
  } catch (error) {
    return fail(error);
  }
}

export async function scanAnomaliesAction(): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const db = getDb();
    const scan = scanForAnomalies(db, { companyId: company.id });
    syncAnomaliesToReviewQueue(db, { companyId: company.id, scan });

    revalidatePath('/review');
    revalidatePath('/');
    return { ok: true, message: scan.summary };
  } catch (error) {
    return fail(error);
  }
}

export async function createInvoiceAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const currency = (text(formData, 'currency') ?? company.baseCurrency).toUpperCase();
    const direction = String(formData.get('direction')) as 'sales' | 'purchase';
    const netText = text(formData, 'net');
    if (!netText) return { ok: false, error: 'A net amount is required.' };

    const result = createInvoice(getDb(), {
      companyId: company.id,
      direction,
      invoiceDate: asIsoDate(text(formData, 'invoiceDate')
        ?? new Date().toISOString().slice(0, 10)),
      dueDate: text(formData, 'dueDate') ? asIsoDate(text(formData, 'dueDate')!) : null,
      supplierId: direction === 'purchase' ? text(formData, 'partyId') : null,
      customerId: direction === 'sales' ? text(formData, 'partyId') : null,
      invoiceNumber: text(formData, 'invoiceNumber'),
      currency,
      lines: [{
        description: text(formData, 'description') ?? 'Invoice',
        netMinor: parseAmount(netText, currency),
        accountId: String(formData.get('accountId')),
        vatTreatmentId: String(formData.get('vatTreatmentId')),
      }],
      actor: 'user',
    });

    revalidatePath('/invoices');
    revalidatePath('/reports');
    return {
      ok: true,
      message: result.vatDeferred
        ? `Invoice posted. Its VAT is deferred until the customer pays, under the cash `
          + 'receipts basis.'
        : 'Invoice posted.',
    };
  } catch (error) {
    return fail(error);
  }
}

export async function recordPaymentAction(formData: FormData): Promise<ActionResult> {
  try {
    const company = requireCompany();
    const currency = (text(formData, 'currency') ?? company.baseCurrency).toUpperCase();
    const amountText = text(formData, 'amount');
    const invoiceId = text(formData, 'invoiceId');
    if (!amountText || !invoiceId) {
      return { ok: false, error: 'An invoice and an amount are required.' };
    }

    const amountMinor = parseAmount(amountText, currency);
    const result = recordPayment(getDb(), {
      companyId: company.id,
      direction: String(formData.get('direction')) as 'received' | 'made',
      paymentDate: asIsoDate(text(formData, 'paymentDate')
        ?? new Date().toISOString().slice(0, 10)),
      amountMinor,
      currency,
      bankTransactionId: text(formData, 'bankTransactionId'),
      reference: text(formData, 'reference'),
      allocations: [{ invoiceId, allocatedMinor: amountMinor }],
      actor: 'user',
    });

    revalidatePath('/invoices');
    revalidatePath('/vat');

    const parts = ['Payment recorded.'];
    if (result.vatReleasedMinor !== 0) {
      parts.push(`${(result.vatReleasedMinor / 100).toFixed(2)} of VAT became due on this `
        + 'receipt under the cash receipts basis.');
    }
    if (result.fxDifferenceMinor !== 0) {
      parts.push(`An exchange difference of ${(result.fxDifferenceMinor / 100).toFixed(2)} `
        + 'was posted.');
    }
    return { ok: true, message: parts.join(' ') };
  } catch (error) {
    return fail(error);
  }
}

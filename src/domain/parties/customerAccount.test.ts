import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { createInvoice } from '../invoicing/invoices';
import {
  setCustomerTerms, customerExposure, addCustomerContact, setBillingContact, deactivateCustomerContact,
  listCustomerContacts, billingContact,
} from './customerAccount';
import { asIsoDate } from '../dates';
import { customers, invoices, reviewItems, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let customerId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  customerId = ids.customer();
  db.insert(customers).values({ id: customerId, companyId, name: 'Mulligan', matchKey: 'mulligan', countryCode: 'IE' }).run();
});

const sale = (net: number, over: Partial<Parameters<typeof createInvoice>[1]> = {}) => createInvoice(db, {
  companyId, direction: 'sales', invoiceDate: asIsoDate('2025-03-10'), customerId,
  lines: [{ description: 'Consulting', netMinor: net, accountId: byCode['4020']!, vatTreatmentId: tr['IE_STD']! }],
  ...over,
});
const row = (id: string) => db.select().from(invoices).where(eq(invoices.id, id)).get()!;

describe('payment terms (#392)', () => {
  it('derives a sales invoice due date from the customer terms, and a stated one wins', () => {
    const none = sale(1_000);
    expect([row(none.invoiceId).dueDate, row(none.invoiceId).dueDateSource]).toEqual([null, null]);

    setCustomerTerms(db, { companyId, customerId, paymentTermsDays: 30, actor: 'Joe' });
    const derived = sale(1_000);
    expect(derived.dueDate).toBe('2025-04-09');
    expect(row(derived.invoiceId).dueDateSource).toBe('customer_terms');

    const stated = sale(1_000, { dueDate: asIsoDate('2025-03-17') });
    expect([row(stated.invoiceId).dueDate, row(stated.invoiceId).dueDateSource]).toEqual(['2025-03-17', 'stated']);
  });

  it('audits a change of terms and refuses nonsense', () => {
    setCustomerTerms(db, { companyId, customerId, paymentTermsDays: 14, creditLimitMinor: 500_000, actor: 'Joe', reason: 'Agreed' });
    const events = db.select().from(auditEvents).where(and(eq(auditEvents.entityId, customerId), eq(auditEvents.action, 'settings_changed'))).all();
    expect(events.map((e) => [e.field, e.newValue]).sort()).toEqual([['credit_limit_minor', '500000'], ['payment_terms_days', '14']]);
    expect(() => setCustomerTerms(db, { companyId, customerId, paymentTermsDays: -1, actor: 'Joe' })).toThrow(/0 to 365/);
    expect(() => setCustomerTerms(db, { companyId, customerId, creditLimitMinor: 1.5, actor: 'Joe' })).toThrow(/minor units/);
  });
});

describe('credit limits (#392)', () => {
  it('posts an invoice that goes over the limit, warns, and raises one review item', () => {
    setCustomerTerms(db, { companyId, customerId, creditLimitMinor: 20_000, actor: 'Joe' });
    const first = sale(10_000); // 123.00
    expect(first.warnings).toEqual([]);
    const second = sale(10_000); // takes it to 246.00
    expect(second.warnings[0]).toMatch(/over the credit limit of 200.00/);
    expect(row(second.invoiceId).status).toBe('issued');
    const third = sale(1_000);
    expect(third.warnings).toHaveLength(1);
    const items = db.select().from(reviewItems).where(eq(reviewItems.dedupeKey, `customer:${customerId}:over_credit_limit`)).all();
    expect(items).toHaveLength(1);

    expect(customerExposure(db, { companyId, customerId })).toEqual({
      outstandingBaseMinor: 12_300 + 12_300 + 1_230, creditLimitMinor: 20_000, headroomMinor: 20_000 - 25_830,
    });
  });

  it('does not flag a credit note, and a customer without a limit is never over it', () => {
    sale(100_000);
    expect(customerExposure(db, { companyId, customerId }).headroomMinor).toBeNull();
    setCustomerTerms(db, { companyId, customerId, creditLimitMinor: 1_000, actor: 'Joe' });
    const credit = sale(500, { isCreditNote: true });
    expect(credit.warnings).toEqual([]);
  });
});

describe('customer contacts (#392)', () => {
  it('keeps one billing contact, and a departed contact stays on record', () => {
    const a = addCustomerContact(db, { companyId, customerId, name: 'Aoife', email: 'aoife@mulligan.ie', isBilling: true, actor: 'Joe' });
    const b = addCustomerContact(db, { companyId, customerId, name: 'Brian', role: 'Director', actor: 'Joe' });
    expect(billingContact(db, { companyId, customerId })?.id).toBe(a.contactId);
    expect(() => setBillingContact(db, { companyId, contactId: b.contactId, actor: 'Joe' })).toThrow(/email/);

    const c = addCustomerContact(db, { companyId, customerId, name: 'Ciara', email: 'accounts@mulligan.ie', isBilling: true, actor: 'Joe' });
    expect(billingContact(db, { companyId, customerId })?.id).toBe(c.contactId);
    expect(listCustomerContacts(db, { companyId, customerId }).filter((x) => x.isBilling)).toHaveLength(1);

    deactivateCustomerContact(db, { companyId, contactId: c.contactId, actor: 'Joe' });
    expect(billingContact(db, { companyId, customerId })).toBeNull();
    expect(listCustomerContacts(db, { companyId, customerId }).map((x) => x.name)).toEqual(['Aoife', 'Brian']);
    expect(listCustomerContacts(db, { companyId, customerId, includeInactive: true })).toHaveLength(3);
    expect(() => addCustomerContact(db, { companyId, customerId, name: 'X', email: 'not-an-email', actor: 'Joe' })).toThrow(/not an email/);
  });
});

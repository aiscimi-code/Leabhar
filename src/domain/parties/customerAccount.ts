import { and, eq, ne } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { customers, customerContacts, invoices, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { asMinor, multiplyRational } from '../money';
import { AccountingError } from '../accounting/errors';

/**
 * A customer's account terms and people (issue #392): payment terms, a credit
 * limit, and contacts. None of it is an accounting fact; each change is
 * audited so it can be seen who changed a limit and when.
 */

export class CustomerAccountError extends AccountingError {}

function loadCustomer(db: AppDatabase, companyId: string, customerId: string) {
  const customer = db.select().from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId))).get();
  if (!customer) throw new CustomerAccountError(`Customer ${customerId} not found.`);
  return customer;
}

function audit(
  db: AppDatabase, companyId: string, entityType: string, entityId: string,
  field: string, previous: unknown, next: unknown, actor: string, reason?: string | null,
): void {
  db.insert(auditEvents).values({
    id: ids.audit(), companyId, occurredAt: nowIso(), entityType, entityId,
    action: 'settings_changed', field,
    previousValue: previous === undefined ? null : JSON.stringify(previous),
    newValue: next === undefined ? null : JSON.stringify(next),
    source: 'user', actor, reason: reason ?? null,
  }).run();
}

/**
 * Set a customer's payment terms (days after the invoice date) and credit limit
 * (base currency, minor units; null removes it). Only the fields given change.
 */
export function setCustomerTerms(
  db: AppDatabase,
  params: {
    companyId: string; customerId: string; actor: string; reason?: string | null;
    paymentTermsDays?: number; creditLimitMinor?: number | null;
  },
): void {
  const customer = loadCustomer(db, params.companyId, params.customerId);
  if (!params.actor.trim()) throw new CustomerAccountError('Say who is changing these terms.');
  const changes: Partial<typeof customers.$inferInsert> = {};
  if (params.paymentTermsDays !== undefined) {
    if (!Number.isInteger(params.paymentTermsDays) || params.paymentTermsDays < 0 || params.paymentTermsDays > 365) {
      throw new CustomerAccountError('Payment terms are a whole number of days from 0 to 365.');
    }
    changes.defaultPaymentTermsDays = params.paymentTermsDays;
  }
  if (params.creditLimitMinor !== undefined) {
    if (params.creditLimitMinor !== null && (!Number.isInteger(params.creditLimitMinor) || params.creditLimitMinor < 0)) {
      throw new CustomerAccountError('A credit limit is a positive amount in minor units, or none.');
    }
    changes.creditLimitMinor = params.creditLimitMinor;
  }
  if (Object.keys(changes).length === 0) return;
  db.transaction(() => {
    db.update(customers).set({ ...changes, updatedAt: nowIso() }).where(eq(customers.id, customer.id)).run();
    if (changes.defaultPaymentTermsDays !== undefined && changes.defaultPaymentTermsDays !== customer.defaultPaymentTermsDays) {
      audit(db, params.companyId, 'customer', customer.id, 'payment_terms_days',
        customer.defaultPaymentTermsDays, changes.defaultPaymentTermsDays, params.actor, params.reason);
    }
    if (changes.creditLimitMinor !== undefined && changes.creditLimitMinor !== customer.creditLimitMinor) {
      audit(db, params.companyId, 'customer', customer.id, 'credit_limit_minor',
        customer.creditLimitMinor, changes.creditLimitMinor, params.actor, params.reason);
    }
  });
}

export interface CustomerExposure {
  /** What the customer owes on open invoices, net of open credit notes, in base currency. */
  outstandingBaseMinor: number;
  creditLimitMinor: number | null;
  /** How much headroom is left under the limit; negative when over it. Null with no limit. */
  headroomMinor: number | null;
}

/**
 * What a customer owes, converted to base at each invoice's own rate, against
 * its credit limit. Money held on account is not netted off: it has not been
 * applied to anything yet.
 */
export function customerExposure(
  db: AppDatabase, params: { companyId: string; customerId: string },
): CustomerExposure {
  const customer = loadCustomer(db, params.companyId, params.customerId);
  const open = db.select().from(invoices).where(and(
    eq(invoices.companyId, params.companyId), eq(invoices.customerId, customer.id),
    eq(invoices.direction, 'sales'), ne(invoices.status, 'void'), ne(invoices.outstandingMinor, 0),
  )).all();
  const outstandingBaseMinor = open.reduce((sum, invoice) => sum + (
    invoice.fxRateNumerator && invoice.fxRateDenominator
      ? multiplyRational(asMinor(invoice.outstandingMinor), invoice.fxRateNumerator, invoice.fxRateDenominator)
      : invoice.outstandingMinor
  ), 0);
  return {
    outstandingBaseMinor,
    creditLimitMinor: customer.creditLimitMinor,
    headroomMinor: customer.creditLimitMinor === null ? null : customer.creditLimitMinor - outstandingBaseMinor,
  };
}

export type CustomerContact = typeof customerContacts.$inferSelect;

export function listCustomerContacts(
  db: AppDatabase, params: { companyId: string; customerId: string; includeInactive?: boolean },
): CustomerContact[] {
  return db.select().from(customerContacts).where(and(
    eq(customerContacts.companyId, params.companyId), eq(customerContacts.customerId, params.customerId),
    params.includeInactive ? undefined : eq(customerContacts.active, true),
  )).orderBy(customerContacts.name).all()
    .sort((a, b) => Number(b.isBilling) - Number(a.isBilling));
}

/** The active billing contact, if one is marked. */
export function billingContact(db: AppDatabase, params: { companyId: string; customerId: string }): CustomerContact | null {
  return listCustomerContacts(db, params).find((c) => c.isBilling) ?? null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function addCustomerContact(
  db: AppDatabase,
  params: {
    companyId: string; customerId: string; name: string; role?: string | null;
    email?: string | null; phone?: string | null; isBilling?: boolean; actor: string;
  },
): { contactId: string } {
  const customer = loadCustomer(db, params.companyId, params.customerId);
  const name = params.name.trim();
  if (!name) throw new CustomerAccountError('A contact needs a name.');
  const email = params.email?.trim() || null;
  if (email && !EMAIL.test(email)) throw new CustomerAccountError(`"${email}" is not an email address.`);
  if (params.isBilling && !email) {
    throw new CustomerAccountError('The billing contact needs an email address: invoices are addressed to it.');
  }
  const contactId = ids.customerContact();
  db.transaction(() => {
    if (params.isBilling) {
      db.update(customerContacts).set({ isBilling: false, updatedAt: nowIso() })
        .where(eq(customerContacts.customerId, customer.id)).run();
    }
    db.insert(customerContacts).values({
      id: contactId, companyId: params.companyId, customerId: customer.id, name,
      role: params.role?.trim() || null, email, phone: params.phone?.trim() || null,
      isBilling: params.isBilling ?? false,
    }).run();
    audit(db, params.companyId, 'customer', customer.id, 'contact_added', undefined,
      { contactId, name, email, isBilling: params.isBilling ?? false }, params.actor);
  });
  return { contactId };
}

function loadContact(db: AppDatabase, companyId: string, contactId: string): CustomerContact {
  const contact = db.select().from(customerContacts)
    .where(and(eq(customerContacts.id, contactId), eq(customerContacts.companyId, companyId))).get();
  if (!contact) throw new CustomerAccountError(`Contact ${contactId} not found.`);
  return contact;
}

/** Make this contact the one invoices are addressed to; the previous one stops being it. */
export function setBillingContact(
  db: AppDatabase, params: { companyId: string; contactId: string; actor: string },
): void {
  const contact = loadContact(db, params.companyId, params.contactId);
  if (!contact.active) throw new CustomerAccountError('That contact is no longer active.');
  if (!contact.email) throw new CustomerAccountError('The billing contact needs an email address.');
  db.transaction(() => {
    db.update(customerContacts).set({ isBilling: false, updatedAt: nowIso() })
      .where(eq(customerContacts.customerId, contact.customerId)).run();
    db.update(customerContacts).set({ isBilling: true, updatedAt: nowIso() })
      .where(eq(customerContacts.id, contact.id)).run();
    audit(db, params.companyId, 'customer', contact.customerId, 'billing_contact', undefined, contact.id, params.actor);
  });
}

/** A contact who has left: kept on record, no longer offered. */
export function deactivateCustomerContact(
  db: AppDatabase, params: { companyId: string; contactId: string; actor: string },
): void {
  const contact = loadContact(db, params.companyId, params.contactId);
  db.transaction(() => {
    db.update(customerContacts).set({ active: false, isBilling: false, updatedAt: nowIso() })
      .where(eq(customerContacts.id, contact.id)).run();
    audit(db, params.companyId, 'customer', contact.customerId, 'contact_deactivated', contact.id, undefined, params.actor);
  });
}

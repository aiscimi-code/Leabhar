import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { suppliers, auditEvents } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { CustomerAccountError } from './customerAccount';

/**
 * A supplier's payment terms (issue #410): a bill with no due date of its own
 * is due this many days after its invoice date. Audited like a customer's.
 */
export function setSupplierTerms(
  db: AppDatabase,
  params: { companyId: string; supplierId: string; paymentTermsDays: number; actor: string; reason?: string | null },
): void {
  const supplier = db.select().from(suppliers)
    .where(and(eq(suppliers.id, params.supplierId), eq(suppliers.companyId, params.companyId))).get();
  if (!supplier) throw new CustomerAccountError(`Supplier ${params.supplierId} not found.`);
  if (!params.actor.trim()) throw new CustomerAccountError('Say who is changing these terms.');
  if (!Number.isInteger(params.paymentTermsDays) || params.paymentTermsDays < 0 || params.paymentTermsDays > 365) {
    throw new CustomerAccountError('Payment terms are a whole number of days from 0 to 365.');
  }
  if (params.paymentTermsDays === supplier.defaultPaymentTermsDays) return;
  db.transaction(() => {
    db.update(suppliers).set({ defaultPaymentTermsDays: params.paymentTermsDays, updatedAt: nowIso() })
      .where(eq(suppliers.id, supplier.id)).run();
    db.insert(auditEvents).values({
      id: ids.audit(), companyId: params.companyId, occurredAt: nowIso(),
      entityType: 'supplier', entityId: supplier.id, action: 'settings_changed', field: 'payment_terms_days',
      previousValue: JSON.stringify(supplier.defaultPaymentTermsDays), newValue: JSON.stringify(params.paymentTermsDays),
      source: 'user', actor: params.actor, reason: params.reason ?? null,
    }).run();
  });
}

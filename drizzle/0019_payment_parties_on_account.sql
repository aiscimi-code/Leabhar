ALTER TABLE `payment_allocations` ADD `allocation_type` text DEFAULT 'settlement' NOT NULL;--> statement-breakpoint
ALTER TABLE `payment_allocations` ADD `write_off_account_id` text REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `payments` ADD `supplier_id` text REFERENCES suppliers(id);--> statement-breakpoint
ALTER TABLE `payments` ADD `customer_id` text REFERENCES customers(id);--> statement-breakpoint
-- Backfill (issue #386): a payment whose allocations all belong to one customer
-- (or one supplier) is that party's money. Mixed or party-less payments stay null.
UPDATE `payments` SET `customer_id` = (
  SELECT MIN(i.customer_id) FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
  WHERE a.payment_id = payments.id
) WHERE (
  SELECT COUNT(DISTINCT i.customer_id) FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
  WHERE a.payment_id = payments.id
) = 1 AND NOT EXISTS (
  SELECT 1 FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
  WHERE a.payment_id = payments.id AND (i.customer_id IS NULL OR i.supplier_id IS NOT NULL)
);--> statement-breakpoint
UPDATE `payments` SET `supplier_id` = (
  SELECT MIN(i.supplier_id) FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
  WHERE a.payment_id = payments.id
) WHERE (
  SELECT COUNT(DISTINCT i.supplier_id) FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
  WHERE a.payment_id = payments.id
) = 1 AND NOT EXISTS (
  SELECT 1 FROM payment_allocations a JOIN invoices i ON i.id = a.invoice_id
  WHERE a.payment_id = payments.id AND (i.supplier_id IS NULL OR i.customer_id IS NOT NULL)
);

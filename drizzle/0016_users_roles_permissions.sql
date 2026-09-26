CREATE TABLE `company_members` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_members_unique_idx` ON `company_members` (`company_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `company_members_user_idx` ON `company_members` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `must_change_password` integer DEFAULT false NOT NULL;--> statement-breakpoint
/*
 * Issue #298: the old 'user' role was the day-to-day working role. The named
 * equivalent in the new role set is bookkeeper, so an existing book keeps the
 * same person with the same practical access rather than silently gaining or
 * losing it. 'owner' and 'readonly' rows already mean what the new set means.
 */
UPDATE `users` SET `role` = 'bookkeeper' WHERE `role` = 'user';--> statement-breakpoint
/*
 * Business membership for a book created before it existed: every active user
 * already had access to every company in the book, so each keeps it. Without
 * this, an upgraded book's non-owners would be refused every write, and its
 * owner would be locked out as soon as the first invitation added a row.
 */
INSERT INTO `company_members` (`id`, `company_id`, `user_id`)
  SELECT 'mem_' || lower(hex(randomblob(12))), `companies`.`id`, `users`.`id`
  FROM `companies` CROSS JOIN `users`
  WHERE `users`.`active` = 1;

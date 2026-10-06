CREATE TABLE `irish_rule_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`rule_version` integer NOT NULL,
	`rule_id` text,
	`status` text NOT NULL,
	`decided_by` text NOT NULL,
	`decided_at` text NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `irish_rule_decisions_version_idx` ON `irish_rule_decisions` (`company_id`,`rule_key`,`rule_version`,`decided_at`);
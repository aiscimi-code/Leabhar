CREATE TABLE `irish_rule_links` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`from_key` text NOT NULL,
	`kind` text NOT NULL,
	`to_key` text,
	`to_provision_id` text,
	`note` text,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`active` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`source_note` text,
	`source_date` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_provision_id`) REFERENCES `irish_act_provisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `irish_rule_links_from_idx` ON `irish_rule_links` (`company_id`,`from_key`,`kind`);--> statement-breakpoint
CREATE INDEX `irish_rule_links_to_idx` ON `irish_rule_links` (`company_id`,`to_key`,`kind`);--> statement-breakpoint
CREATE INDEX `irish_rule_links_provision_idx` ON `irish_rule_links` (`to_provision_id`);
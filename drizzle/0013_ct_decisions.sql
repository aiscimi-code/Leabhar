CREATE TABLE `ct_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`period_end` text NOT NULL,
	`choice` text NOT NULL,
	`decided_by` text NOT NULL,
	`decided_at` text NOT NULL,
	`note` text,
	`superseded_by_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ct_decisions_subject_idx` ON `ct_decisions` (`company_id`,`subject_type`,`subject_id`);
CREATE TABLE `reportable_benefits` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`category` text NOT NULL,
	`subcategory` text,
	`provided_on` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`days_hundredths` integer,
	`description` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`source_line_id` text,
	`status` text DEFAULT 'prepared' NOT NULL,
	`supersedes_id` text,
	`superseded_reason` text,
	`submitted_on` text,
	`submission_reference` text,
	`submitted_by` text,
	`recorded_by` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reportable_benefits_company_idx` ON `reportable_benefits` (`company_id`,`provided_on`);--> statement-breakpoint
CREATE INDEX `reportable_benefits_employee_idx` ON `reportable_benefits` (`employee_id`,`category`);--> statement-breakpoint
CREATE INDEX `reportable_benefits_source_idx` ON `reportable_benefits` (`source_type`,`source_id`);--> statement-breakpoint
ALTER TABLE `employees` ADD `user_id` text REFERENCES users(id);
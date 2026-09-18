-- Irish accounting/tax rules knowledge base, v1 (docs/RULES_KB.md).
--
-- Source of authority: Irish Statute Book, Finance Act 2024 (2024 Act 43),
-- docs/statutes/2024-act-43/2024-act-43-enacted.md.
--
-- Additive to the existing schema: these tables reference `companies`,
-- `tax_rates` and `vat_treatments` rather than re-stating them, and reuse the
-- project's `provenance`/`effective_from`/`effective_to` conventions. No table
-- stores an invented rule: `provision_text` is a verbatim, offset-addressable
-- slice of the source, and any plain-language gloss is stored separately and
-- tagged `provenance_status = 'ai_suggestion'` until a user confirms it.
--
-- No Redis. No secrets. Configuration is effective-dated per invariant #6.

CREATE TABLE `irish_knowledge_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text,
	`source_type` text NOT NULL,
	`title` text NOT NULL,
	`citation` text NOT NULL,
	`jurisdiction` text DEFAULT 'IE' NOT NULL,
	`source_url` text NOT NULL,
	`local_path` text,
	`sha256` text NOT NULL,
	`ingest_version` text NOT NULL,
	`publication_date` text,
	`retrieved_at` text NOT NULL,
	`effective_from` text NOT NULL,
	`effective_to` text,
	`active` integer DEFAULT true NOT NULL,
	`source_note` text,
	`source_date` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `irish_knowledge_sources_citation_sha256_unique` ON `irish_knowledge_sources` (`citation`,`sha256`);--> statement-breakpoint
CREATE INDEX `irish_knowledge_sources_type_idx` ON `irish_knowledge_sources` (`source_type`);--> statement-breakpoint
CREATE TABLE `irish_act_provisions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text,
	`source_id` text NOT NULL,
	`section_number` text NOT NULL,
	`part` text,
	`chapter` text,
	`slug` text NOT NULL,
	`heading` text NOT NULL,
	`principal_act` text,
	`provision_text` text,
	`source_start` integer,
	`source_end` integer,
	`human_explanation` text,
	`category` text DEFAULT 'other' NOT NULL,
	`amends_section` text,
	`effective_clue` text,
	`cited_acts` text DEFAULT '[]' NOT NULL,
	`relevant` integer DEFAULT true NOT NULL,
	`relevance_reason` text,
	`source` text DEFAULT 'user' NOT NULL,
	`confidence` integer,
	`provenance_status` text DEFAULT 'manually_entered' NOT NULL,
	`source_note` text,
	`source_date` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `irish_knowledge_sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `irish_act_provisions_source_section_unique` ON `irish_act_provisions` (`source_id`,`section_number`);--> statement-breakpoint
CREATE INDEX `irish_act_provisions_category_idx` ON `irish_act_provisions` (`category`);--> statement-breakpoint
CREATE INDEX `irish_act_provisions_principal_idx` ON `irish_act_provisions` (`principal_act`);--> statement-breakpoint
CREATE INDEX `irish_act_provisions_amends_idx` ON `irish_act_provisions` (`amends_section`);--> statement-breakpoint
CREATE INDEX `irish_act_provisions_relevant_idx` ON `irish_act_provisions` (`relevant`);--> statement-breakpoint
CREATE TABLE `irish_tax_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text NOT NULL,
	`provision_id` text NOT NULL,
	`tax_rate_id` text,
	`vat_treatment_id` text,
	`rule_key` text NOT NULL,
	`rule_type` text DEFAULT 'other' NOT NULL,
	`topic` text NOT NULL,
	`name` text NOT NULL,
	`statement` text,
	`extracted_fact` text,
	`human_explanation` text,
	`numeric_value` integer,
	`unit` text,
	`qualifier` text,
	`conditions` text DEFAULT '[]' NOT NULL,
	`exceptions` text DEFAULT '[]' NOT NULL,
	`cross_references` text DEFAULT '[]' NOT NULL,
	`accounting_effect` text,
	`tax_effect` text,
	`vat_effect` text,
	`reporting_effect` text,
	`requires_guidance` integer DEFAULT false NOT NULL,
	`human_review_required` integer DEFAULT true NOT NULL,
	`review_status` text DEFAULT 'draft' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`review_notes` text,
	`rule_version` integer DEFAULT 1 NOT NULL,
	`supersedes_rule_id` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
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
	FOREIGN KEY (`provision_id`) REFERENCES `irish_act_provisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tax_rate_id`) REFERENCES `tax_rates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vat_treatment_id`) REFERENCES `vat_treatments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `irish_tax_rules_key_version_unique` ON `irish_tax_rules` (`company_id`,`rule_key`,`rule_version`);--> statement-breakpoint
CREATE INDEX `irish_tax_rules_provision_idx` ON `irish_tax_rules` (`provision_id`);--> statement-breakpoint
CREATE INDEX `irish_tax_rules_lookup_idx` ON `irish_tax_rules` (`company_id`,`rule_key`,`effective_from`);--> statement-breakpoint
CREATE INDEX `irish_tax_rules_topic_idx` ON `irish_tax_rules` (`company_id`,`topic`,`active`);--> statement-breakpoint
CREATE INDEX `irish_tax_rules_review_idx` ON `irish_tax_rules` (`review_status`);--> statement-breakpoint
CREATE TABLE `irish_tax_rule_tests` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`test_type` text NOT NULL,
	`description` text NOT NULL,
	`input` text NOT NULL,
	`expected` text NOT NULL,
	`last_run_at` text,
	`last_run_passed` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `irish_tax_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `irish_tax_rule_tests_rule_idx` ON `irish_tax_rule_tests` (`rule_id`);

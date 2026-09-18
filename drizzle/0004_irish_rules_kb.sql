-- Irish accounting/tax rules knowledge base, v1.
--
-- Source of authority: Irish Statute Book, Finance Act 2024 (2024 Act 43),
-- docs/statutes/2024-act-43/2024-act-43-enacted.md on branch docs/2024-act-43-statute-pdf-md.
--
-- The tables here are an extension of the existing rules engine. They never
-- store invented rules: `provision_text` is a verbatim, offset-addressable
-- slice of the statute, and any plain-language gloss is stored separately and
-- tagged `provenance_status = 'ai_suggestion'` until a user confirms it.
--
-- No Redis. No secrets. Configuration is effective-dated per invariant #6.

CREATE TABLE `irish_statute_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text REFERENCES `companies`(`id`),
  `title` text NOT NULL,
  `citation` text NOT NULL,
  `source_url` text NOT NULL,
  `local_path` text,
  `sha256` text NOT NULL,
  `ingest_version` text NOT NULL,
  `ingested_at` text NOT NULL,
  `source_note` text,
  `source_date` text
);

CREATE UNIQUE INDEX `irish_statute_sources_citation_unique` ON `irish_statute_sources`(`citation`);

CREATE TABLE `irish_act_provisions` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text REFERENCES `companies`(`id`),
  `statute_source_id` text NOT NULL REFERENCES `irish_statute_sources`(`id`),
  `section_number` text NOT NULL,
  `slug` text NOT NULL,
  `heading` text NOT NULL,
  `principal_act` text,
  `provision_text` text,
  `source_start` integer,
  `source_end` integer,
  `human_explanation` text,
  `category` text NOT NULL DEFAULT 'other',
  `amends_section` text,
  `effective_clue` text,
  `cited_acts` text,
  `source` text NOT NULL DEFAULT 'import',
  `confidence` integer,
  `provenance_status` text NOT NULL DEFAULT 'imported',
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX `irish_act_provisions_source_section_unique`
  ON `irish_act_provisions`(`statute_source_id`, `section_number`);
CREATE INDEX `irish_act_provisions_category_idx` ON `irish_act_provisions`(`category`);
CREATE INDEX `irish_act_provisions_principal_idx` ON `irish_act_provisions`(`principal_act`);
CREATE INDEX `irish_act_provisions_amends_idx` ON `irish_act_provisions`(`amends_section`);

CREATE TABLE `irish_tax_rules` (
  `id` text PRIMARY KEY NOT NULL,
  `company_id` text NOT NULL REFERENCES `companies`(`id`),
  `provision_id` text NOT NULL REFERENCES `irish_act_provisions`(`id`),
  `tax_rate_id` text REFERENCES `tax_rates`(`id`),
  `vat_treatment_id` text REFERENCES `vat_treatments`(`id`),
  `rule_key` text NOT NULL,
  `name` text NOT NULL,
  `extracted_fact` text,
  `human_explanation` text,
  `numeric_value` integer,
  `unit` text,
  `qualifier` text,
  `priority` integer NOT NULL DEFAULT 100,
  `enabled` integer NOT NULL DEFAULT 1,
  `source` text NOT NULL DEFAULT 'ai',
  `confidence` integer,
  `provenance_status` text NOT NULL DEFAULT 'ai_suggestion',
  `source_note` text,
  `source_date` text,
  `created_at` text NOT NULL DEFAULT (datetime('now')),
  `updated_at` text NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX `irish_tax_rules_key_unique` ON `irish_tax_rules`(`company_id`, `rule_key`);
CREATE INDEX `irish_tax_rules_provision_idx` ON `irish_tax_rules`(`provision_id`);
CREATE INDEX `irish_tax_rules_lookup_idx` ON `irish_tax_rules`(`company_id`, `rule_key`);

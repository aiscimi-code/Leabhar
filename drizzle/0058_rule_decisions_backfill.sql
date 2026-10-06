-- Carry each book's existing review decisions into irish_rule_decisions
-- (issue #686 step 11). The rule rows keep their columns; nothing is lost.
INSERT INTO `irish_rule_decisions` (`id`, `company_id`, `rule_key`, `rule_version`, `rule_id`, `status`, `decided_by`, `decided_at`, `reason`)
SELECT 'rd_migrated_' || `id`, `company_id`, `rule_key`, `rule_version`, `id`, `review_status`, `reviewed_by`, coalesce(`reviewed_at`, `updated_at`), `review_notes`
FROM `irish_tax_rules`
WHERE `reviewed_by` IS NOT NULL;

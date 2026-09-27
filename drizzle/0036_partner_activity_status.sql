/*
 * A partner's activity status (issue #493): active in the firm, or sleeping.
 * A sleeping partner's share is not earned income (TCA s.1008(5)), so the
 * income tax computation gives no earned income credit on it. Existing rows
 * are left null — not recorded — and the computation flags those rather than
 * guessing.
 */
ALTER TABLE `partners` ADD `activity_status` text;

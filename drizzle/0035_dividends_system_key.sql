/*
 * The dividends account (3200) gets the `dividends_paid` system key, so the
 * close-company surcharge resolves it by key (issue #489) instead of reading
 * whatever account happens to carry code 3200. Existing books are promoted in
 * place — same row, same history — the way migration 0018 promoted the timing
 * accounts. Only rows that have not been given a system key, and that are
 * still the equity account the default chart seeded, are touched.
 */
UPDATE `accounts` SET `system_key` = 'dividends_paid', `is_system` = 1
  WHERE `code` = '3200' AND `type` = 'equity' AND `system_key` IS NULL;

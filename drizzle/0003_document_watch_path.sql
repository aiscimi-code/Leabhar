-- Add a per-company document watch path for on-demand folder ingest.
-- The "Refresh from folder" action scans this path for new invoices/receipts,
-- stores them content-addressed, reads them with the local provider only, and
-- moves the originals into a `processed/` subfolder. One path maps to one
-- company, so an auto-pulled file always knows which books it belongs to.

ALTER TABLE `companies` ADD COLUMN `document_watch_path` text;

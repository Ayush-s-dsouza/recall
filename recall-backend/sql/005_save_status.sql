-- Adds a status column to saves so a row can exist as a "pending" placeholder
-- (inserted immediately on save) before background enrichment fills in the
-- real title/tag/embedding and flips it to "ready".
alter table saves add column status text not null default 'ready';

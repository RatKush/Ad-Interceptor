-- Fix: one subscription could mint several licences.
--
-- Paddle sends subscription.created / subscription.activated /
-- transaction.completed CONCURRENTLY. The old non-unique index let two racing
-- handlers each pass a "does a row exist?" check and each INSERT, producing
-- duplicate valid licences for a single payment. Observed on the first real
-- sandbox purchase, 2026-09-08.
--
-- Run once against an existing database:
--   npx wrangler d1 execute ad-interceptor-licenses --remote \
--     --file=migrations/001-unique-subscription.sql
--
-- Dedupe keeps, per subscription, the row carrying a paddle_transaction_id —
-- that is the row the buyer's browser looked up, so it holds the key they
-- actually have. Ties break to the oldest row.

DROP INDEX IF EXISTS idx_licenses_subscription;

DELETE FROM licenses
WHERE paddle_subscription_id IS NOT NULL
  AND key NOT IN (
    SELECT key FROM (
      SELECT key,
             ROW_NUMBER() OVER (
               PARTITION BY paddle_subscription_id
               ORDER BY (paddle_transaction_id IS NULL), created_at
             ) AS rn
      FROM licenses
      WHERE paddle_subscription_id IS NOT NULL
    )
    WHERE rn = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_subscription ON licenses(paddle_subscription_id);

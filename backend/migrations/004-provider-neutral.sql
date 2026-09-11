-- Make the payment-provider columns vendor-neutral.
--
-- Paddle refused the account on 2026-09-10 because ad blockers fall outside
-- its Acceptable Use Policy, so the integration moved to Dodo Payments. The
-- schema had `paddle_` baked into five column names, none of which describe
-- anything Paddle-specific — they are just "the provider's id for this thing".
-- Renaming them to the vendor of the week would only repeat the mistake, so
-- they become provider-neutral and a `provider` column records which vendor a
-- row came from.
--
--   npx wrangler d1 execute ad-interceptor-licenses --remote \
--     --file=migrations/004-provider-neutral.sql
--
-- The index is dropped FIRST and recreated last. SQLite carries indexes
-- through a RENAME COLUMN, but the recreated one is deliberately different:
-- see the composite note below.

DROP INDEX IF EXISTS idx_licenses_subscription;

ALTER TABLE licenses RENAME COLUMN paddle_customer_id     TO provider_customer_id;
ALTER TABLE licenses RENAME COLUMN paddle_subscription_id TO provider_subscription_id;
ALTER TABLE licenses RENAME COLUMN paddle_transaction_id  TO provider_payment_id;

-- Defaults to 'paddle' rather than 'dodo' on purpose: every row that exists
-- when this migration runs was created by the Paddle integration, and a
-- default that rewrites history to say otherwise is a lie in the audit trail.
-- All new inserts name the provider explicitly.
ALTER TABLE licenses  ADD COLUMN provider TEXT NOT NULL DEFAULT 'paddle';

ALTER TABLE customers RENAME COLUMN paddle_customer_id TO provider_customer_id;
ALTER TABLE customers ADD COLUMN provider TEXT NOT NULL DEFAULT 'paddle';

-- COMPOSITE, where the old index was on the subscription id alone.
--
-- This still does the job it was added for in 001 — stopping concurrent
-- webhooks for one purchase from minting two licences — because within a
-- single provider the pair is as unique as the id was. What it adds is that
-- two providers can never collide on an opaque id string, which matters the
-- moment a second migration happens.
--
-- SQLite treats NULLs as distinct in a unique index, so admin-issued keys
-- (NULL subscription) remain unconstrained, exactly as before.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_subscription
  ON licenses(provider, provider_subscription_id);

CREATE INDEX IF NOT EXISTS idx_licenses_provider_customer
  ON licenses(provider, provider_customer_id);

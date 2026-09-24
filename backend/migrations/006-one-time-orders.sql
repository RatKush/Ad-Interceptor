-- One-time Pro payments (PayPal Orders API), from 2026-09-24.
--
-- PayPal allows paying by card without an account only for one-time
-- payments, so Pro moved from a yearly subscription to one payment per
-- 12 months. Each row is one captured payment. order_id being the PRIMARY
-- KEY is what stops a payment granting twice: the capture handler writes
-- the licence change and this row in one transaction, conditioned on the
-- row not existing yet.
--
--   npx wrangler d1 execute ad-interceptor-licenses --remote \
--     --file=migrations/006-one-time-orders.sql

CREATE TABLE IF NOT EXISTS orders (
  order_id     TEXT PRIMARY KEY,        -- PayPal order id; one row per payment
  license_key  TEXT NOT NULL,           -- the key this payment created or extended
  kind         TEXT NOT NULL,           -- 'new' | 'renew'
  capture_id   TEXT,                    -- what refunds and disputes refer to
  amount       TEXT,
  currency     TEXT,
  payer_email  TEXT,
  payer_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'completed',  -- 'completed' | 'reversed'
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_capture ON orders (capture_id);
CREATE INDEX IF NOT EXISTS idx_orders_key     ON orders (license_key);

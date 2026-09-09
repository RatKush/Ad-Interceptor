-- Capture the buyer's email reliably, in either event order.
--
-- Paddle's subscription and transaction payloads carry only `customer_id`,
-- never the email, so the address arrives solely on customer.created /
-- customer.updated. But `customer.created` fires BEFORE the subscription
-- exists, so backfilling licences on that event alone updates zero rows and
-- the email is lost — a fix that looks right and does nothing.
--
-- Storing customers separately makes the order irrelevant: whichever event
-- lands first, the other side can find what it needs.
--
--   npx wrangler d1 execute ad-interceptor-licenses --remote \
--     --file=migrations/002-customers.sql

CREATE TABLE IF NOT EXISTS customers (
  paddle_customer_id TEXT PRIMARY KEY,
  email              TEXT,
  updated_at         INTEGER NOT NULL
);

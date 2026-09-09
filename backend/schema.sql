-- D1 schema for the Ad Interceptor licence backend.
--
-- Apply with:
--   npx wrangler d1 execute ad-interceptor-licenses --remote --file=backend/schema.sql

-- One row per issued licence key.
--
-- The key is stored in plaintext, deliberately. It is a bearer entitlement
-- token, not a password: it grants access to a filter list and nothing else,
-- it is attached to no payment credential, and license.js already states that
-- client-side Pro gating is not a security boundary. Storing it plainly is what
-- makes "I lost my key" a solvable support request instead of a refund. The
-- tradeoff is that a database leak lets people use Pro for free — which is the
-- same outcome as someone editing isPro() in their own copy, so it buys no real
-- attacker anything.
CREATE TABLE IF NOT EXISTS licenses (
  key                TEXT PRIMARY KEY,
  plan               TEXT NOT NULL DEFAULT 'pro',      -- 'pro' | 'free'
  status             TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'canceled' | 'past_due' | 'revoked'
  expires_at         INTEGER,                          -- epoch ms; NULL = perpetual
  activation_limit   INTEGER NOT NULL DEFAULT 3,
  email              TEXT,
  paddle_customer_id     TEXT,
  paddle_subscription_id TEXT,
  paddle_transaction_id  TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,

  -- Set once the "here is your key" email is accepted for delivery. Paddle
  -- delivers several events per purchase and retries them, so the send path
  -- runs repeatedly for one sale; without this marker the buyer receives
  -- duplicate key emails, which reads as a compromised account.
  key_sent_at        INTEGER,
  key_send_error     TEXT
);

-- UNIQUE, not just indexed. This is a correctness constraint, not a
-- performance one.
--
-- Paddle delivers subscription.created, subscription.activated and
-- transaction.completed for a single purchase CONCURRENTLY. Application-level
-- "SELECT then INSERT if absent" dedup loses that race: two handlers both see
-- no row and both insert, minting two valid licences for one payment. That
-- happened on the first real sandbox purchase (2026-09-08) and sequential
-- tests could never have caught it.
--
-- SQLite treats NULLs as distinct in a unique index, so admin-issued keys and
-- one-off transactions (both NULL here) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_subscription ON licenses(paddle_subscription_id);
CREATE INDEX IF NOT EXISTS idx_licenses_email        ON licenses(email);

-- One row per (key, install). This is what makes activation limits real:
-- without a per-install identifier a single key validates from unlimited
-- machines and the limit is decorative.
CREATE TABLE IF NOT EXISTS activations (
  key         TEXT NOT NULL,
  install_id  TEXT NOT NULL,
  version     TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (key, install_id),
  FOREIGN KEY (key) REFERENCES licenses(key) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activations_last_seen ON activations(last_seen);

-- Buyers, keyed by Paddle's customer id.
--
-- Exists because Paddle only ever sends the email on customer.created /
-- customer.updated, and those can arrive BEFORE the subscription they belong
-- to. Backfilling licences directly from that event would update zero rows.
-- Keeping customers separately makes event order irrelevant.
CREATE TABLE IF NOT EXISTS customers (
  paddle_customer_id TEXT PRIMARY KEY,
  email              TEXT,
  updated_at         INTEGER NOT NULL
);

-- Every webhook Paddle delivers, recorded before it is acted on. Paddle
-- retries on non-2xx, so events must be idempotent; this table is how we
-- recognise a replay. It is also the only audit trail of why a key changed.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  payload     TEXT NOT NULL
);

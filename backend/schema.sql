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
  -- Provider-neutral on purpose. These held `paddle_` names until 2026-09-10,
  -- when Paddle refused the account over its ad-blocker policy and the whole
  -- integration moved to Dodo Payments. Nothing about an opaque vendor id is
  -- vendor-specific, so the vendor lives in one column instead of five names.
  provider               TEXT NOT NULL DEFAULT 'dodo',
  provider_customer_id     TEXT,
  provider_subscription_id TEXT,
  provider_payment_id      TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,

  -- Set once the "here is your key" email is accepted for delivery. Dodo
  -- delivers several events per purchase and retries them, so the send path
  -- runs repeatedly for one sale; without this marker the buyer receives
  -- duplicate key emails, which reads as a compromised account.
  key_sent_at        INTEGER,
  key_send_error     TEXT
);

-- UNIQUE, not just indexed. This is a correctness constraint, not a
-- performance one.
--
-- A provider delivers several events for a single purchase CONCURRENTLY
-- (Dodo: subscription.active and payment.succeeded). Application-level
-- "SELECT then INSERT if absent" dedup loses that race: two handlers both see
-- no row and both insert, minting two valid licences for one payment. That
-- happened on the first real sandbox purchase (2026-09-08) and sequential
-- tests could never have caught it.
--
-- Composite so two providers can never collide on an opaque id string.
-- SQLite treats NULLs as distinct in a unique index, so admin-issued keys and
-- one-off payments (both NULL here) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_subscription
  ON licenses(provider, provider_subscription_id);
CREATE INDEX IF NOT EXISTS idx_licenses_provider_customer
  ON licenses(provider, provider_customer_id);
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

-- Buyers, keyed by the provider's customer id.
--
-- This existed because Paddle sent the email ONLY on customer.created /
-- customer.updated, which could arrive before the subscription they belonged
-- to. Dodo puts `customer.email` on every payload, so the table is no longer
-- load-bearing for address capture — it is kept as the record of who bought
-- what, and because key recovery looks buyers up by email.
CREATE TABLE IF NOT EXISTS customers (
  provider             TEXT NOT NULL DEFAULT 'dodo',
  provider_customer_id TEXT PRIMARY KEY,
  email                TEXT,
  updated_at           INTEGER NOT NULL
);

-- Every webhook the provider delivers, recorded AFTER it is acted on (see the
-- ordering note in index.js — writing it first loses paid events). Providers
-- retry on non-2xx, so events must be idempotent; this table is how we
-- recognise a replay. It is also the only audit trail of why a key changed.
--
-- For Dodo the event id is the `webhook-id` HEADER, not a body field.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  payload     TEXT NOT NULL
);

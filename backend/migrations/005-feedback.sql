-- Uninstall feedback, posted by the page Chrome opens after an uninstall.
--
-- The page used to offer mailto: links, which need a mail app and a press of
-- send — too much to ask of someone who is leaving. One tap now records the
-- reason here.
-- No IP address and no identifier are stored — see the privacy policy.
--
--   npx wrangler d1 execute ad-interceptor-licenses --remote \
--     --file=migrations/005-feedback.sql

CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,         -- random UUID, lets the page attach its note
  product     TEXT NOT NULL,
  reason      TEXT NOT NULL,            -- one of FEEDBACK_REASONS in index.js
  comment     TEXT,                     -- optional, at most 1,000 characters
  version     TEXT,                     -- extension version, from the uninstall URL
  country     TEXT,                     -- Cloudflare two-letter code; no IP is kept
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at);

-- Track licence-key emails so a buyer is never mailed the same key twice.
--
-- Paddle retries webhooks and delivers several events per purchase, so the
-- send path runs more than once for one sale. Without a marker the buyer gets
-- duplicate "here is your key" emails, which reads as a compromised account.
--
--   npx wrangler d1 execute ad-interceptor-licenses --remote \
--     --file=migrations/003-key-delivery.sql

ALTER TABLE licenses ADD COLUMN key_sent_at INTEGER;
ALTER TABLE licenses ADD COLUMN key_send_error TEXT;

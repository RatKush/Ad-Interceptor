# Ad Interceptor licence API

Cloudflare Worker backing the Pro tier. Deliberately small: it authenticates
licence keys and serves a filter set. It does not try to be DRM.

## What is actually enforceable

Pro's code-based features — video ad removal, anti-adblock bypass — ship inside
the extension package to every user, because Manifest V3 forbids
remotely-hosted code. There is no way to withhold them, and anyone can flip
`isPro()` in their own copy. That is accepted, and stated plainly in
`license.js`.

The one benefit this server genuinely gates is the **daily filter feed**: those
rules are not in the package, the request is authenticated, and the server
decides. That is what a Pro subscription actually buys, and it is the thing
worth building properly.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/license/validate` | none (rate limited) | `{key, version, installId}` → `{valid, plan, expiresAt, reason?}` |
| `GET`  | `/v1/filters/latest` | `Bearer <licence key>` | the Pro filter set, with ETag |
| `POST` | `/v1/paddle/webhook` | Paddle signature | issue / update / revoke keys |
| `POST` | `/v1/admin/filters` | `Bearer <ADMIN_TOKEN>` | publish a filter build |
| `POST` | `/v1/admin/license` | `Bearer <ADMIN_TOKEN>` | issue a key by hand (support, comps) |
| `GET`  | `/health` | none | liveness |

## First deploy

Run from this directory. The account has **no workers.dev subdomain yet**, so
step 4 is where the real hostname first appears — wrangler will offer to
register one.

```bash
npm install

# 1. Licence store
npx wrangler d1 create ad-interceptor-licenses
#    → paste database_id into wrangler.jsonc

# 2. Filter store
npx wrangler kv namespace create ad-interceptor-filters
#    → paste id into wrangler.jsonc

# 3. Schema
npm run schema

# 4. Secrets
openssl rand -hex 32                        # use this as ADMIN_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put PADDLE_WEBHOOK_SECRET   # from Paddle → Notifications

# 5. Deploy — note the URL it prints
npm run deploy
```

Then, back in the extension root:

1. Put that URL in `config.js` as `API_BASE` (no trailing slash). It is the
   only place it appears.
2. Publish a first filter build:
   ```bash
   API_BASE=https://... ADMIN_TOKEN=... npm run publish-filters -- --build
   ```
3. Only now flip `PRO_ENABLED = true`. `scripts/check-pro-config.mjs` blocks
   the package if `API_BASE` is unset or still a placeholder.

## Paddle setup

In Paddle → Developer tools → Notifications, add a destination pointing at
`https://<your-worker>/v1/paddle/webhook` and subscribe to:

- `subscription.created`, `subscription.activated` — issue a key
- `subscription.updated`, `subscription.resumed` — extend `expires_at`
- `subscription.canceled`, `subscription.paused` — access runs to period end
- `subscription.past_due` — mark, do not revoke
- `adjustment.created` — refund or chargeback, revoke immediately
- `transaction.completed` — one-off purchases

Copy that destination's secret into `PADDLE_WEBHOOK_SECRET`.

**Key delivery is not built here.** The webhook mints the key and stores it;
getting it to the buyer is a separate step (Paddle's post-purchase workflow, or
a fulfilment email). Until that exists, use `/v1/admin/license` to issue keys
manually — which is fine for the first handful of customers and worth doing
deliberately, because early buyers are the ones worth talking to anyway.

## Paddle's delivery contract

Every choice below follows from how Paddle actually delivers, confirmed against
Paddle's own integration skill:

- **Only a 2xx within 5 seconds counts as delivered.** Every other response —
  400, 401, 500, a redirect, a timeout — is a failed delivery and gets retried.
  There is no status that means "stop retrying". The only response that loses
  an event is a 2xx.
- **Retries:** sandbox 3 attempts over ~15 min; live 60 attempts over ~3 days
  with exponential backoff. Past that window the event is gone and has to be
  replayed from the dashboard notification log.
- **The same `event_id` arrives on every retry**, with a fresh signature
  timestamp — which is why the 5-minute skew check does not break retries.
- **Events are not ordered.** `subscription.updated` can arrive before
  `subscription.created`. Handlers converge on latest state rather than
  assuming sequence.
- **Redirects are not followed.** The destination URL must be final.

## Design notes

- **Keys are stored in plaintext.** A key grants a filter list and nothing
  else; it is attached to no payment credential. Storing it plainly makes "I
  lost my key" answerable. A DB leak lets people use Pro free — the same
  outcome as editing `isPro()` locally, so it buys an attacker nothing.
- **Cancelled ≠ revoked.** Paddle cancels at period end, so `canceled` keeps
  working until `expires_at`. Only refunds and chargebacks (`revoked`) cut
  access immediately.
- **Webhooks are idempotent.** Paddle sends both `subscription.created` and
  `subscription.activated` for one purchase and retries any non-2xx, so
  `webhook_events` dedupes by `event_id` and key minting dedupes by
  `paddle_subscription_id`. Duplicates return 200, or Paddle retries forever.
- **The ledger row is written LAST, after the event has been acted on.** This
  ordering is load-bearing and was originally wrong. Recording first means a
  throw mid-processing returns 500, Paddle retries, the retry hits the dedup
  check and receives 200/duplicate — so Paddle marks it delivered and stops,
  leaving a paying customer with no key and nothing reporting a failure.
  Recording last turns that same crash into a replay, which is safe because
  every handler is idempotent.
- **Known gap: the buyer's email may be null.** `issueKeyFor` reads
  `data.customer.email`, but real `subscription.*` payloads often carry only
  `customer_id` and no nested customer object. Key delivery therefore cannot
  rely on this column — it will need to resolve the email from `customer_id`
  via the API (queued, not inline: the handler has a 5-second budget), or
  subscribe to `customer.created` / `customer.updated` and store it.
- **Activations expire after 60 days** (daily cron). Without that, a customer
  who changes laptop twice is locked out by their own history.
- **The client fails open, then closed.** `license.js` honours a stored
  entitlement for 7 days when this server is unreachable, so an outage here
  does not take Pro away from people who paid. After 7 days it fails closed.

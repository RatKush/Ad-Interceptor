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
| `POST` | `/v1/dodo/webhook` | Dodo signature | issue / update / revoke keys |
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
npx wrangler secret put DODO_WEBHOOK_SECRET     # from Dodo → Developer → Webhooks

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

## PayPal setup

The live provider since 2026-09-17. Do the whole thing in **sandbox** first;
`PAYPAL_ENV` defaults to sandbox and anything other than the literal `"live"`
stays sandbox, so a typo costs test traffic rather than real charges.

**1. Create a REST app.** <https://developer.paypal.com/dashboard/applications/sandbox>
→ Create App. Copy the **Client ID** and **Secret**.

The client ID is *public* — it ends up in the browser's PayPal SDK URL, and
belongs in `store-listing/web/seller.json`. The secret is not, and belongs only
in a Worker secret.

**2. Create the product and plan.** From the repo root:

```sh
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-setup.mjs
```

Idempotent — it lists before it creates, so a second run does not leave two
plans. That matters because a PayPal plan cannot be deleted, only deactivated.
It prints the plan id.

**3. Set the Worker secrets.** Interactive, so they never land in a file:

```sh
cd backend
npx wrangler secret put PAYPAL_CLIENT_ID
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler deploy
```

**4. Register the webhook.** Run the script rather than clicking:

```sh
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-webhook-setup.mjs
```

It points the webhook at:

```
https://ad-interceptor-api.ad-interceptor-api.workers.dev/v1/paypal/webhook
```

and subscribes it to all fourteen events below. It is idempotent in a stronger
sense than `paypal-setup.mjs`: if a webhook for that URL already exists with a
different event list, it PATCHes the list back into line. Prefer it to the
dashboard — a webhook subscribed to the wrong events fails **silently**, and the
symptom surfaces months later as a licence that did not renew.

The authoritative list is the one in that script, which is in turn taken from
the event sets in `src/paypal.js`. Ticking these by hand means fourteen exact
strings, with no wildcard available in the dashboard:

| Event | Effect |
|---|---|
| `BILLING.SUBSCRIPTION.ACTIVATED` | mints the licence |
| `BILLING.SUBSCRIPTION.RE-ACTIVATED` | restores it (note the hyphen) |
| `PAYMENT.SALE.COMPLETED` | **the renewal event** — extends the expiry |
| `BILLING.SUBSCRIPTION.UPDATED` | plan change / un-suspend |
| `BILLING.SUBSCRIPTION.SUSPENDED` | `past_due`, recoverable |
| `BILLING.SUBSCRIPTION.PAYMENT.FAILED` | `past_due`, recoverable |
| `PAYMENT.SALE.DENIED` | `past_due`, recoverable |
| `BILLING.SUBSCRIPTION.CANCELLED` | access runs to the paid-for date |
| `BILLING.SUBSCRIPTION.EXPIRED` | same |
| `PAYMENT.SALE.REFUNDED` | revoked immediately |
| `PAYMENT.SALE.REVERSED` | revoked immediately |
| `CUSTOMER.DISPUTE.CREATED` | revoked — see the dispute note in index.js |
| `CUSTOMER.DISPUTE.UPDATED` | same |
| `CUSTOMER.DISPUTE.RESOLVED` | same |

The wildcard rows this table used to carry (`PAYMENT.SALE.REFUNDED / .REVERSED`
and `CUSTOMER.DISPUTE.*`) read fine but could not be ticked, and they hid the
omission of `PAYMENT.SALE.DENIED` entirely.

The script prints the **Webhook ID**. Verification needs it:

```sh
npx wrangler secret put PAYPAL_WEBHOOK_ID
```

Without it **every delivery is rejected**, not accepted unchecked — see
`verifyPayPalSignature`. There is a second slot, `PAYPAL_WEBHOOK_ID_TEST`, so a
sandbox app and a live app can be configured at the same time.

**5. Buy it once, in sandbox.** This is the only step that proves any of the
above. Watch `npx wrangler tail` and confirm, in order: the signature verifies,
a key is minted, and `/v1/license/by-transaction?subscription_id=...` returns
it. PayPal hands the buyer's browser a *subscription* id, not the sale id —
that is why the endpoint takes both.

## Dodo setup

> Moved here from Paddle on 2026-09-12. Paddle refused the account on
> 2026-09-10 because ad blockers fall outside its Acceptable Use Policy. The
> old `/v1/paddle/webhook` path now returns **410 Gone** rather than 404, so a
> stray delivery is diagnosable instead of looking like a network fault.

In Dodo → Developer → Webhooks, add an endpoint pointing at
`https://<your-worker>/v1/dodo/webhook` and subscribe to:

- `subscription.active`, `subscription.renewed`, `payment.succeeded` — issue a
  key, and on renewal extend `expires_at`
- `subscription.updated`, `subscription.unpaused` — restore access, move expiry
- `subscription.cancelled`, `subscription.expired` — access runs to period end
- `subscription.past_due`, `on_hold`, `paused`, `failed` — mark, do not revoke
- `refund.succeeded` — revoke immediately
- `dispute.*` — chargeback, revoke immediately

Copy that endpoint's signing secret into `DODO_WEBHOOK_SECRET`. It looks like
`whsec_<base64>` and the **bytes behind the base64 are the key** — see below.

`DODO_WEBHOOK_SECRET_TEST` is an optional second slot so test and live
endpoints can both be accepted, and so a secret can be rotated without a
window where deliveries fail.

**Key delivery** now has two paths: the buyer is redirected back to
`/pricing?payment_id=...` and the page trades that for the key, and the email
in `mail.js` sends it (needs a domain). `/v1/admin/license` still issues keys
by hand.

## Dodo's delivery contract

Every choice below follows from how the provider actually delivers. Three
differ from Paddle in ways that fail SILENTLY if assumed:

- **The signing secret is base64.** `whsec_<base64>` — decode to bytes before
  using it as the HMAC key. Using the string verifies nothing and rejects every
  event.
- **The signed content is `id.timestamp.body`**, dot-separated, with the
  webhook id included. Paddle signed `timestamp:body`.
- **The event id is the `webhook-id` HEADER**, not a body field. The dedup
  ledger keys on it; reading `event.event_id` yields undefined, every event
  looks new, and a retry re-mints a licence. `extractSubject` takes the id as
  an argument so it cannot be forgotten silently.
- **`cancelled_at` has two Ls.** Paddle used `canceled_at`. Reading the
  American spelling returns undefined forever.

Verified by `node test/dodo-signature.mjs` (31 assertions) and the e2e suite.

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
- **Cancelled ≠ revoked.** Cancellation takes effect at period end, so `canceled` keeps
  working until `expires_at`. Only refunds and chargebacks (`revoked`) cut
  access immediately.
- **Webhooks are idempotent.** Dodo sends both `subscription.active` and
  `subscription.activated` for one purchase and retries any non-2xx, so
  `webhook_events` dedupes by `event_id` and key minting dedupes by
  `(provider, provider_subscription_id)`. Duplicates return 200, or Dodo
  retries forever.
- **The ledger row is written LAST, after the event has been acted on.** This
  ordering is load-bearing and was originally wrong. Recording first means a
  throw mid-processing returns 500, Dodo retries, the retry hits the dedup
  check and receives 200/duplicate — so Dodo marks it delivered and stops,
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

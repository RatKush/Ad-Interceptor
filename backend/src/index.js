// Ad Interceptor licence API.
//
//   POST /v1/license/validate   { key, version, installId } -> { valid, plan, expiresAt, reason? }
//   GET  /v1/filters/latest     Authorization: Bearer <key>  -> { rules: [...], builtAt }
//   POST /v1/dodo/webhook       Dodo Payments notifications
//   POST /v1/admin/filters      Authorization: Bearer <ADMIN_TOKEN>  (publish a filter build)
//   POST /v1/admin/license      Authorization: Bearer <ADMIN_TOKEN>  (issue a comp/support key)
//   GET  /health
//
// WHAT THIS DOES AND DOES NOT DEFEND
// Pro's code-based features (video ad removal, anti-adblock) ship to every
// user because MV3 forbids remotely-hosted code — they are soft-gated and
// anyone can flip the flag in their own copy. That is accepted and documented
// in license.js. The only hard-gated benefit is this API's filter set: it is
// not in the package, so the server decides who gets it. Everything below is
// built for that reality — it protects the filter feed and gives honest
// customers a clean path, and it does not pretend to be DRM.

import { generateKey, normalizeKey } from './keys.js';
import * as dodo from './dodo.js';
import * as paypal from './paypal.js';
import { sendLicenceKey } from './mail.js';

// ---------------------------------------------------------------------------
// Payment providers
// ---------------------------------------------------------------------------
// Which provider a row belongs to is STORED, not assumed — see
// migrations/004-provider-neutral. This table is the other half of that: one
// descriptor per provider, so handleWebhook contains no provider name and no
// provider-specific event string at all.
//
// Why a table and not an if: this is the THIRD provider this code has served.
// Paddle refused the account on 2026-09-10, Dodo refused it on 2026-09-11, and
// PayPal approved it on 2026-09-17. Each migration previously meant editing the
// dispatch itself; now it means adding a row and a route.
//
// Dodo's descriptor is kept although the account was declined. It is the only
// integration that has ever been exercised end to end against a real sandbox
// purchase, so it stays as the reference shape — and deleting a working
// provider to make room for an unproven one is not an improvement.
const ADAPTERS = {
  dodo: {
    provider: 'dodo',
    module: dodo,
    // Dodo signs with HMAC over the raw body; both secret slots are tried so
    // test and live endpoints can coexist and secrets can be rotated.
    verify: (raw, request, env) =>
      dodo.verifyAgainstAnySecret(raw, dodo.readWebhookHeaders(request), {
        DODO_WEBHOOK_SECRET: env.DODO_WEBHOOK_SECRET,
        DODO_WEBHOOK_SECRET_TEST: env.DODO_WEBHOOK_SECRET_TEST
      }),
    // The event id is a HEADER for Dodo, so extract needs the request.
    extract: (event, request) => dodo.extractSubject(event, dodo.readWebhookHeaders(request).id),
    enrich: null // every Dodo payload is already complete
  },

  paypal: {
    provider: 'paypal',
    module: paypal,
    // PayPal signs with RSA against a rotating cert, so verification is an API
    // call rather than a local comparison. See the note in paypal.js.
    verify: (raw, request, env) =>
      paypal.verifyAgainstAnyWebhookId(raw, paypal.readWebhookHeaders(request), env, {
        PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID,
        PAYPAL_WEBHOOK_ID_TEST: env.PAYPAL_WEBHOOK_ID_TEST
      }),
    // PayPal's event id is in the BODY, so the request is unused here.
    extract: (event) => paypal.extractSubject(event),
    // Renewal events carry neither the next billing date nor the subscriber
    // email; without this a licence lapses on its first anniversary while
    // PayPal keeps charging. See enrichFromApi.
    enrich: (env, subject) => paypal.enrichFromApi(env, subject)
  }
};

const FILTERS_KV_KEY = 'pro-filters:latest';
const ACTIVATION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra }
  });

/** Constant-time string compare, for the admin bearer token. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function requireAdmin(request, env) {
  const token = bearer(request);
  if (!env.ADMIN_TOKEN || !token || !safeEqual(token, env.ADMIN_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

const toEpochMs = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

/**
 * Decide whether a key grants Pro right now, and record the activation.
 *
 * A cancelled subscription is deliberately still valid until expires_at:
 * cancellation takes effect at period end, and someone who paid for this
 * period keeps it. Only 'revoked' (refund, chargeback, abuse) kills it
 * immediately.
 */
async function evaluateKey(env, rawKey, installId, version) {
  const key = normalizeKey(rawKey);
  if (!key) return { valid: false, plan: 'free', expiresAt: null, reason: "That doesn't look like a licence key." };

  const row = await env.DB.prepare(
    'SELECT key, plan, status, expires_at, activation_limit FROM licenses WHERE key = ?'
  ).bind(key).first();

  if (!row) {
    return { valid: false, plan: 'free', expiresAt: null, reason: 'We have no record of that key.' };
  }
  if (row.status === 'revoked') {
    return { valid: false, plan: 'free', expiresAt: null, reason: 'This licence has been revoked.' };
  }

  const now = Date.now();
  if (row.expires_at && now > row.expires_at) {
    return { valid: false, plan: 'free', expiresAt: row.expires_at, reason: 'This licence has expired.' };
  }

  // Activation accounting. A client that sends no installId still validates —
  // it just cannot be counted, and an uncountable install is better than a
  // paying customer locked out by a client bug.
  if (installId) {
    const existing = await env.DB.prepare(
      'SELECT install_id FROM activations WHERE key = ? AND install_id = ?'
    ).bind(key, installId).first();

    if (existing) {
      await env.DB.prepare(
        'UPDATE activations SET last_seen = ?, version = ? WHERE key = ? AND install_id = ?'
      ).bind(now, version ?? null, key, installId).run();
    } else {
      const { c } = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM activations WHERE key = ?'
      ).bind(key).first();

      const limit = row.activation_limit ?? 3;
      if (c >= limit) {
        return {
          valid: false,
          plan: 'free',
          expiresAt: row.expires_at ?? null,
          reason: `This key is already in use on ${limit} devices. Remove one, or contact support.`
        };
      }
      await env.DB.prepare(
        'INSERT INTO activations (key, install_id, version, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)'
      ).bind(key, installId, version ?? null, now, now).run();
    }
  }

  return { valid: true, plan: row.plan === 'pro' ? 'pro' : 'free', expiresAt: row.expires_at ?? null };
}

// ---------------------------------------------------------------------------
// Dodo Payments webhook
// ---------------------------------------------------------------------------

async function issueKeyFor(env, subject, provider) {
  const now = Date.now();

  // Idempotency at the subscription level: Dodo sends subscription.active and
  // payment.succeeded for one purchase, and retries anything we fail. One
  // subscription must never mint two keys.
  if (subject.subscriptionId) {
    const existing = await env.DB.prepare(
      `SELECT key, provider_payment_id, expires_at FROM licenses
        WHERE provider = ? AND provider_subscription_id = ?`
    ).bind(provider, subject.subscriptionId).first();

    if (existing) {
      // One purchase produces several events and their order is not
      // guaranteed: subscription.active carries no payment id, while
      // payment.succeeded carries both. Whichever lands first mints the key,
      // so backfill the payment id when the other one arrives —
      // /v1/license/by-transaction is how the buyer's browser collects the
      // key, and it can only find the row if this column is populated.
      if (subject.transactionId && !existing.provider_payment_id) {
        await env.DB.prepare(
          'UPDATE licenses SET provider_payment_id = ?, updated_at = ? WHERE key = ?'
        ).bind(subject.transactionId, now, existing.key).run();
      }
      if (subject.email) {
        await env.DB.prepare(
          'UPDATE licenses SET email = COALESCE(email, ?), updated_at = ? WHERE key = ?'
        ).bind(subject.email, now, existing.key).run();
      }

      // RENEWALS. `subscription.renewed` arrives every year for a licence that
      // already exists, so it lands here rather than in the INSERT below. If
      // this path leaves expires_at alone, the row keeps its ORIGINAL expiry
      // and every paying customer silently loses Pro one year in, while Dodo
      // keeps charging them. Under Paddle this was handled by a separate
      // subscription.updated branch; Dodo folds renewal into the granting
      // events, so the extension has to happen here.
      //
      // Only ever moves the date FORWARD — a late or replayed event must not
      // shorten access that has already been paid for.
      const renewedTo = toEpochMs(subject.nextBilledAt);
      if (renewedTo && (!existing.expires_at || renewedTo > existing.expires_at)) {
        await env.DB.prepare(
          `UPDATE licenses SET expires_at = ?, status = 'active', updated_at = ?
            WHERE key = ?`
        ).bind(renewedTo, now, existing.key).run();
      }
      return existing.key;
    }
  }

  // Dodo puts customer.email on EVERY payload, so unlike Paddle the address is
  // normally present already. The customers-table fallback is kept anyway: it
  // costs one indexed read and covers an event that somehow arrives without
  // one, which is exactly the case that used to lose a buyer's address.
  let email = subject.email;
  if (!email && subject.customerId) {
    const known = await env.DB.prepare(
      'SELECT email FROM customers WHERE provider_customer_id = ?'
    ).bind(subject.customerId).first();
    email = known?.email ?? null;
  }

  const key = generateKey();

  // ON CONFLICT DO NOTHING against the UNIQUE index on
  // (provider, provider_subscription_id).
  //
  // The SELECT above is a fast path, not the guarantee. Dodo delivers
  // subscription.active and payment.succeeded CONCURRENTLY, so two handlers
  // can both pass that check and both arrive here. Under Paddle that minted
  // two valid licences for one payment on the first real sandbox purchase — a
  // free Pro key nobody bought. Only the database can arbitrate a race
  // between concurrent writers, so uniqueness lives there and this insert is
  // allowed to lose.
  await env.DB.prepare(
    `INSERT INTO licenses
       (key, plan, status, expires_at, activation_limit, email, provider,
        provider_customer_id, provider_subscription_id, provider_payment_id,
        created_at, updated_at)
     VALUES (?, 'pro', 'active', ?, 3, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_subscription_id) DO NOTHING`
  ).bind(
    key,
    toEpochMs(subject.nextBilledAt),
    email,
    provider,
    subject.customerId,
    subject.subscriptionId,
    subject.transactionId,
    now,
    now
  ).run();

  // Re-read rather than trusting our own insert: if we lost the race, the row
  // that exists is the other handler's, and its key is the one the buyer will
  // be given. Returning `key` blindly would hand out a key that was never
  // stored.
  if (subject.subscriptionId) {
    const winner = await env.DB.prepare(
      `SELECT key, provider_payment_id FROM licenses
        WHERE provider = ? AND provider_subscription_id = ?`
    ).bind(provider, subject.subscriptionId).first();

    if (winner) {
      // Whichever row won, make sure the identifiers this event carried end
      // up on it — the buyer's browser looks the licence up by payment id.
      if (subject.transactionId && !winner.provider_payment_id) {
        await env.DB.prepare(
          'UPDATE licenses SET provider_payment_id = ?, updated_at = ? WHERE key = ?'
        ).bind(subject.transactionId, now, winner.key).run();
      }
      if (subject.email) {
        await env.DB.prepare(
          'UPDATE licenses SET email = COALESCE(email, ?), updated_at = ? WHERE key = ?'
        ).bind(subject.email, now, winner.key).run();
      }
      return winner.key;
    }
  }

  return key;
}

async function handleWebhook(request, env, ctx, adapter) {
  // There is no source-IP pre-filter here, unlike the Paddle integration.
  // Paddle published a fetchable list of sender addresses; neither Dodo nor
  // PayPal does, and an allowlist that cannot be sourced is not a control. The
  // signature was always the real defence — the IP check only rejected noise
  // before spending crypto — so nothing load-bearing is lost.

  // Must be the raw body. Dodo HMACs these exact bytes; PayPal checksums them.
  // Re-serialising the parsed JSON reorders keys and both checks then fail.
  const raw = await request.text();

  // How this is verified is the adapter's business: Dodo compares an HMAC
  // locally, PayPal asks PayPal. Both return the same {ok, reason, matched}.
  const verified = await adapter.verify(raw, request, env);
  if (!verified.ok) {
    console.log(`${adapter.provider} webhook rejected: ${verified.reason}`);
    return json({ error: 'invalid signature' }, 401);
  }
  console.log(`${adapter.provider} webhook signature verified via ${verified.matched}`);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  // Dodo puts the event id in a header, PayPal in the body. The adapter knows
  // which; everything below only ever sees subject.eventId.
  let subject = adapter.extract(event, request);
  if (!subject.eventId) return json({ error: 'missing event id' }, 400);

  // Replay guard. Both providers retry on any non-2xx, so a duplicate delivery
  // is normal traffic, not an attack — swallow it with a 200 or it retries
  // forever. (PayPal retries for up to three days on an escalating schedule.)
  const seen = await env.DB.prepare(
    'SELECT event_id FROM webhook_events WHERE event_id = ?'
  ).bind(subject.eventId).first();
  if (seen) return json({ ok: true, duplicate: true });

  // NOTE: the ledger row is written AFTER the event is acted on, at the bottom
  // of this function. Writing it here — which is what this code used to do —
  // silently loses events: if the branches below throw, the outer handler
  // returns 500, the provider retries, the retry matches the dedup check above
  // and gets a 200 with duplicate:true. The provider then marks the event
  // delivered and stops. The result is a customer who paid and whose key was
  // never minted, with nothing anywhere reporting a failure.
  //
  // Recording last means a crash between acting and recording causes a REPLAY
  // instead, which is safe: issueKeyFor dedupes on the subscription id and
  // every other branch is an idempotent UPDATE. At-least-once processing with
  // idempotent handlers beats mark-then-lose.

  // Fill in anything the payload could not carry, now that we know this is a
  // real event we have not already handled. Deliberately AFTER the replay
  // guard: enrichment costs a round trip to the provider, and a retry storm
  // should not multiply that. PayPal needs it on every renewal; Dodo never
  // does, and declares `enrich: null` rather than paying for a no-op.
  if (adapter.enrich) subject = await adapter.enrich(env, subject);

  const now = Date.now();
  const type = String(subject.eventType ?? '');
  let issuedKey = null;

  // Dispatch on the adapter's event SETS rather than a switch. Dodo has 26
  // event types and PayPal has its own naming entirely, but between them they
  // mean the same five things, so the provider names live in the adapter
  // modules and this dispatch contains none of them. The sets are asserted
  // non-overlapping in test/dodo-signature.mjs and test/paypal-events.mjs.
  if (adapter.module.GRANTING_EVENTS.has(type)) {
    // subscription.active (first purchase), subscription.renewed (each year)
    // and payment.succeeded all mean "paid". They arrive concurrently for one
    // purchase; issueKeyFor is idempotent on the subscription id and extends
    // the expiry on renewal.
    issuedKey = await issueKeyFor(env, subject, adapter.provider);

  } else if (adapter.module.RESTORING_EVENTS.has(type)) {
    // A plan change or an un-pause. Restore access and move the expiry to the
    // new period end. COALESCE so an event without a date cannot blank it.
    if (subject.subscriptionId) {
      await env.DB.prepare(
        `UPDATE licenses
            SET status = 'active', expires_at = COALESCE(?, expires_at), updated_at = ?
          WHERE provider = ? AND provider_subscription_id = ?`
      ).bind(toEpochMs(subject.nextBilledAt), now, adapter.provider, subject.subscriptionId).run();
    }

  } else if (adapter.module.REVOKING_EVENTS.has(type)) {
    if (adapter.module.REFUND_EVENTS.has(type)) {
      // Money returned. Kill access immediately — this is the one case where
      // someone loses a period they nominally paid for, because they did not
      // ultimately pay for it.
      if (subject.subscriptionId) {
        await env.DB.prepare(
          `UPDATE licenses SET status = 'revoked', updated_at = ?
            WHERE provider = ? AND provider_subscription_id = ?`
        ).bind(now, adapter.provider, subject.subscriptionId).run();
      } else if (subject.transactionId) {
        // A refunded ONE-OFF payment has no subscription to match on.
        await env.DB.prepare(
          `UPDATE licenses SET status = 'revoked', updated_at = ?
            WHERE provider = ? AND provider_payment_id = ?`
        ).bind(now, adapter.provider, subject.transactionId).run();
      }
    } else if (subject.subscriptionId) {
      // subscription.cancelled / subscription.expired. Access runs to the end
      // of the period already paid for — evaluateKey honours expires_at and
      // only treats 'revoked' as immediate.
      await env.DB.prepare(
        `UPDATE licenses
            SET status = 'canceled', expires_at = COALESCE(?, expires_at), updated_at = ?
          WHERE provider = ? AND provider_subscription_id = ?`
      ).bind(toEpochMs(subject.nextBilledAt), now, adapter.provider, subject.subscriptionId).run();
    }

  } else if (adapter.module.SUSPENDING_EVENTS.has(type)) {
    // past_due / on_hold / paused / failed — recoverable, so the row keeps its
    // expiry and can be restored by a later renewal or un-pause.
    if (subject.subscriptionId) {
      await env.DB.prepare(
        `UPDATE licenses SET status = 'past_due', updated_at = ?
          WHERE provider = ? AND provider_subscription_id = ?`
      ).bind(now, adapter.provider, subject.subscriptionId).run();
    }

  } else if (adapter.module.isDispute(type)) {
    // A chargeback. `dispute.opened` already means the money is contested and
    // the card network will claw it back by default, so do not wait for
    // dispute.lost — the filter feed is cheap to restore if it resolves our
    // way, and serving a disputed licence for the length of a dispute is not.
    if (subject.subscriptionId) {
      await env.DB.prepare(
        `UPDATE licenses SET status = 'revoked', updated_at = ?
          WHERE provider = ? AND provider_subscription_id = ?`
      ).bind(now, adapter.provider, subject.subscriptionId).run();
    }
  }
  // Anything else is recorded below and acknowledged. Returning an error would
  // make Dodo retry something we will never act on.

  // The customers table is load-bearing again under PayPal.
  //
  // Dodo put customer.email on every payload, which made this table merely a
  // convenience. PayPal does not: `subscriber` exists only on
  // BILLING.SUBSCRIPTION.* events, and PAYMENT.SALE.* — the event that fires on
  // every renewal — carries no address at all. paypal.js's enrichFromApi
  // recovers it, but a lookup can fail, so recording the address from whatever
  // event does carry it is the fallback that keeps key delivery and
  // recovery-by-email working. This is the exact ordering hazard migrations/002
  // was written for, returning under a different provider.
  if (subject.customerId && subject.email) {
    await env.DB.prepare(
      `INSERT INTO customers (provider, provider_customer_id, email, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_customer_id) DO UPDATE SET email = ?, updated_at = ?`
    ).bind(adapter.provider, subject.customerId, subject.email, now, subject.email, now).run();

    await env.DB.prepare(
      `UPDATE licenses SET email = ?, updated_at = ?
        WHERE provider = ? AND provider_customer_id = ?
          AND (email IS NULL OR email = '')`
    ).bind(subject.email, now, adapter.provider, subject.customerId).run();
  }

  // Acted on successfully — only now is it safe to call this event handled.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO webhook_events (event_id, event_type, received_at, payload) VALUES (?, ?, ?, ?)'
  ).bind(subject.eventId, subject.eventType, now, raw).run();

  // Deliver the key, AFTER acknowledging. Two reasons this is deferred rather
  // than awaited: the handler has a short budget before Dodo calls the
  // delivery a timeout and retries, and a mail failure must never fail the
  // webhook — the licence work has already succeeded and a retry would redo it.
  //
  // Driven off the customer id rather than only the minting path, so that
  // whichever event completes the (licence, email) pair triggers the send.
  // sendLicenceKey claims the row so only one of them actually sends.
  if (subject.customerId) {
    ctx.waitUntil((async () => {
      try {
        const row = await env.DB.prepare(
          `SELECT key, email, activation_limit, expires_at FROM licenses
            WHERE provider = ? AND provider_customer_id = ? AND key_sent_at IS NULL
              AND email IS NOT NULL AND status != 'revoked'`
        ).bind(adapter.provider, subject.customerId).first();
        if (!row) return;
        const result = await sendLicenceKey(env, {
          key: row.key,
          email: row.email,
          deviceLimit: row.activation_limit,
          expiresAt: row.expires_at
        });
        console.log(`key delivery for ${row.key}: ${result}`);
      } catch (e) {
        console.log(`key delivery threw: ${String(e).slice(0, 200)}`);
      }
    })());
  }

  // The key still has to reach the buyer. The success panel on /pricing (which
  // polls /v1/license/by-transaction) and the email above are the delivery
  // paths; this response is only the webhook acknowledgement.
  if (issuedKey) console.log(`issued key for subscription ${subject.subscriptionId}`);

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === '/health') {
        return json({ ok: true, service: 'ad-interceptor-api' });
      }

      // --- validate ------------------------------------------------------
      if (path === '/v1/license/validate' && request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        if (env.VALIDATE_LIMITER) {
          const { success } = await env.VALIDATE_LIMITER.limit({ key: ip });
          if (!success) return json({ error: 'rate limited' }, 429, { 'Retry-After': '60' });
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'invalid json' }, 400);
        }

        const result = await evaluateKey(env, body?.key, body?.installId, body?.version);
        return json(result);
      }

      // --- collect a key with the payment id from checkout ----------------
      // This is how a buyer receives their key without an email pipeline
      // existing: the provider hands the payment id to their browser when
      // checkout completes, and they trade it for the key here.
      //
      // The payment id is the bearer credential. That is acceptable: it is an
      // unguessable id disclosed only to the purchasing browser, and the thing
      // it unlocks is a filter-list subscription. It is rate limited, and it is
      // NOT a substitute for emailing the key as well — a closed tab loses this
      // route.
      //
      // The path keeps its `by-transaction` name and `transaction_id` parameter
      // so already-shipped clients and saved success URLs keep working; only
      // the id FORMAT changed with the provider.
      if (path === '/v1/license/by-transaction' && request.method === 'GET') {
        // TWO id shapes, because the providers hand the buyer's BROWSER
        // different things on return from checkout:
        //
        //   Dodo   ?payment_id=...       — a payment id, matched on
        //                                  provider_payment_id
        //   PayPal ?subscription_id=...  — a subscription id. PayPal's sale id
        //                                  exists only inside the webhook and
        //                                  the browser never sees it, so
        //                                  looking up by payment id would find
        //                                  nothing and a paying customer would
        //                                  be shown "no key" forever.
        //
        // Both are opaque and high-entropy, so which column a value is checked
        // against is decided by WHICH PARAMETER was sent, never by guessing
        // from the value's shape.
        const txn = url.searchParams.get('transaction_id')
          ?? url.searchParams.get('payment_id') ?? '';
        const sub = url.searchParams.get('subscription_id') ?? '';
        const lookup = txn ? { id: txn, by: 'payment' } : { id: sub, by: 'subscription' };
        // Was `^txn_[a-z0-9]{26}$` — Paddle's exact format, which rejects every
        // A payment id from whichever provider sold the licence. Their shapes
        // are opaque and documented as stable by none of them, so this
        // validates the character set and a sane length rather than inventing
        // a prefix a future id might not carry. PayPal sale ids and Dodo
        // payment ids both satisfy it. It still blocks anything that is not an
        // identifier.
        if (!/^[A-Za-z0-9_-]{8,80}$/.test(lookup.id)) {
          return json({ error: 'malformed payment or subscription id' }, 400);
        }

        if (env.VALIDATE_LIMITER) {
          const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
          const { success } = await env.VALIDATE_LIMITER.limit({ key: `txn:${ip}` });
          if (!success) return json({ error: 'rate limited' }, 429, { 'Retry-After': '60' });
        }

        // NOT scoped to a provider any more. The buyer's browser knows its
        // payment id and nothing else — it has no idea which processor minted
        // it, and asking it to would leak an implementation detail into a URL
        // the buyer can see. Payment ids are opaque and high-entropy, so a
        // collision across providers is not a practical concern; the composite
        // UNIQUE index still keeps the two namespaces apart where it matters,
        // on the subscription id.
        // Two literal statements rather than interpolating a column name.
        // The column is chosen from this fixed pair and never built from
        // input, so there is nothing for a crafted parameter to reach.
        const row = lookup.by === 'payment'
          ? await env.DB.prepare(
            `SELECT key, expires_at FROM licenses
              WHERE provider_payment_id = ? AND status != 'revoked'`
          ).bind(lookup.id).first()
          : await env.DB.prepare(
            `SELECT key, expires_at FROM licenses
              WHERE provider_subscription_id = ? AND status != 'revoked'`
          ).bind(lookup.id).first();

        // 404 here is usually "the webhook has not landed yet" rather than
        // "no such purchase" — the two are indistinguishable from here, so say
        // so and let the caller decide how long to keep asking.
        if (!row) return json({ ready: false, retryable: true }, 404);

        return json({ ready: true, key: row.key, expiresAt: row.expires_at ?? null });
      }

      // --- pro filter feed (the one hard-gated benefit) -------------------
      if (path === '/v1/filters/latest' && request.method === 'GET') {
        const key = bearer(request);
        if (!key) return json({ error: 'missing bearer token' }, 401);

        const result = await evaluateKey(env, key, request.headers.get('X-Install-Id'), null);
        if (!result.valid || result.plan !== 'pro') {
          return json({ error: 'not entitled', reason: result.reason ?? null }, 403);
        }

        const stored = await env.FILTERS.get(FILTERS_KV_KEY, 'json');
        if (!stored) return json({ error: 'no filter build published yet' }, 503);

        // ETag lets a daily-polling client skip the payload when nothing
        // changed, which matters because this is the largest response we serve.
        const etag = `W/"${stored.builtAt}"`;
        if (request.headers.get('If-None-Match') === etag) {
          return new Response(null, { status: 304, headers: { ETag: etag, ...CORS } });
        }
        return json(stored, 200, { ETag: etag, 'Cache-Control': 'private, max-age=3600' });
      }

      // --- PayPal ---------------------------------------------------------
      // The live provider as of 2026-09-17. Register this URL as the webhook
      // destination in the PayPal app, then put the webhook id it gives back
      // into the PAYPAL_WEBHOOK_ID secret — verification needs it, and a
      // missing id rejects every delivery rather than accepting it unchecked.
      if (path === '/v1/paypal/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env, ctx, ADAPTERS.paypal);
      }

      // --- Dodo Payments --------------------------------------------------
      // Kept live although Dodo declined the account. It is the only provider
      // ever exercised against a real sandbox purchase, and leaving the route
      // costs nothing: without DODO_WEBHOOK_SECRET set, every delivery here is
      // rejected at the signature check anyway.
      if (path === '/v1/dodo/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env, ctx, ADAPTERS.dodo);
      }

      // The Paddle endpoint is gone, not redirected. Paddle refused the
      // account on 2026-09-10, so nothing can legitimately POST here; a 410
      // says so plainly instead of letting a stray call look like a network
      // fault while a buyer waits for a key that will never come.
      if (path === '/v1/paddle/webhook') {
        return json({ error: 'gone: this integration moved to PayPal' }, 410);
      }

      // --- admin: publish a filter build ---------------------------------
      if (path === '/v1/admin/filters' && request.method === 'POST') {
        const denied = requireAdmin(request, env);
        if (denied) return denied;

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'invalid json' }, 400);
        }
        if (!Array.isArray(body?.rules) || body.rules.length === 0) {
          return json({ error: 'rules must be a non-empty array' }, 400);
        }

        const payload = { rules: body.rules, builtAt: body.builtAt ?? Date.now(), count: body.rules.length };
        await env.FILTERS.put(FILTERS_KV_KEY, JSON.stringify(payload));
        return json({ ok: true, count: payload.count, builtAt: payload.builtAt });
      }

      // --- admin: resend a key ------------------------------------------
      // Support surface. Also the manual fallback whenever automatic delivery
      // is off, which it is until a sender domain exists.
      if (path === '/v1/admin/resend' && request.method === 'POST') {
        const denied = requireAdmin(request, env);
        if (denied) return denied;

        const body = await request.json().catch(() => ({}));
        const key = normalizeKey(body.key);
        if (!key) return json({ error: 'provide a valid "key"' }, 400);

        const row = await env.DB.prepare(
          'SELECT key, email, activation_limit, expires_at FROM licenses WHERE key = ?'
        ).bind(key).first();
        if (!row) return json({ error: 'no such key' }, 404);

        const to = body.email || row.email;
        if (!to) return json({ error: 'no address on file; pass "email"' }, 400);

        // Clear any previous claim so a deliberate resend is never a no-op.
        await env.DB.prepare('UPDATE licenses SET key_sent_at = NULL WHERE key = ?').bind(key).run();

        const result = await sendLicenceKey(env, {
          key: row.key, email: to,
          deviceLimit: row.activation_limit, expiresAt: row.expires_at
        });
        const ok = result.startsWith('sent');
        return json({ ok, result }, ok ? 200 : 502);
      }

      // --- admin: issue a key by hand (support, comps, testing) ----------
      if (path === '/v1/admin/license' && request.method === 'POST') {
        const denied = requireAdmin(request, env);
        if (denied) return denied;

        const body = await request.json().catch(() => ({}));
        const now = Date.now();
        const key = generateKey();
        await env.DB.prepare(
          `INSERT INTO licenses
             (key, plan, status, expires_at, activation_limit, email, created_at, updated_at)
           VALUES (?, 'pro', 'active', ?, ?, ?, ?, ?)`
        ).bind(key, body.expiresAt ?? null, body.activationLimit ?? 3, body.email ?? null, now, now).run();

        return json({ ok: true, key });
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      // Never leak internals to the caller; the detail goes to the tail log.
      console.log(`error on ${path}: ${err?.stack ?? err}`);
      return json({ error: 'internal error' }, 500);
    }
  },

  /**
   * Daily: forget activations nobody has used in 60 days.
   *
   * Without this, a customer who changes laptops twice is permanently at their
   * device limit and has to email support — a self-inflicted support queue.
   */
  async scheduled(event, env, ctx) {
    const cutoff = Date.now() - ACTIVATION_TTL_MS;
    const { meta } = await env.DB.prepare('DELETE FROM activations WHERE last_seen < ?')
      .bind(cutoff).run();
    console.log(`pruned ${meta?.changes ?? 0} stale activations`);
  }
};

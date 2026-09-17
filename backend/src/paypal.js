// PayPal webhook verification and event mapping.
//
// PayPal differs from Dodo in four ways, each of which fails SILENTLY if the
// Dodo module is ported across by analogy:
//
//   1. VERIFICATION IS AN API CALL, not a local HMAC. PayPal signs with RSA
//      against a rotating certificate, so there is no shared secret to compare.
//   2. THE EVENT ID IS IN THE BODY (`event.id`), not a header. Dodo's is in the
//      `webhook-id` header and dodo.js warns about exactly the reverse mistake.
//   3. THE SUBSCRIPTION ID MOVES depending on event type. On a
//      BILLING.SUBSCRIPTION.* event it is `resource.id`; on a PAYMENT.SALE.*
//      event that same field is the SALE id and the subscription is in
//      `resource.billing_agreement_id`. Reading `resource.id` for a renewal
//      matches no licence row and the renewal is lost.
//   4. THE EMAIL IS NOT ON EVERY EVENT. Dodo puts customer.email on every
//      payload; PayPal only has `subscriber` on subscription events. Sale
//      events carry no address at all, which makes the customers-table
//      fallback in issueKeyFor load-bearing again, as it was under Paddle.
//
// See enrichFromApi below for how 3 and 4 stop being a problem in practice.

const LIVE_API = 'https://api-m.paypal.com';
const SANDBOX_API = 'https://api-m.sandbox.paypal.com';

export const apiBase = (env) =>
  String(env.PAYPAL_ENV ?? '').toLowerCase() === 'live' ? LIVE_API : SANDBOX_API;

// ---- OAuth ----------------------------------------------------------------
// Every PayPal API call needs a bearer token minted from the client id and
// secret. Tokens last ~9 hours; this caches one per isolate and refreshes a
// minute early.
//
// Module-level state in a Worker is best-effort by design: isolates are
// created and destroyed freely, so a cache miss is normal, not an error. It is
// worth having anyway — without it every webhook costs two round trips to
// PayPal instead of one.
let tokenCache = { value: null, expiresAt: 0 };

export async function getAccessToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const id = env.PAYPAL_CLIENT_ID;
  const secret = env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not configured');

  const res = await fetch(`${apiBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    // Deliberately does not log the body: a failed token response can echo
    // parts of the credentials back.
    throw new Error(`PayPal token request failed: HTTP ${res.status}`);
  }

  const body = await res.json();
  tokenCache = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(0, (Number(body.expires_in) || 0) - 60) * 1000
  };
  return tokenCache.value;
}

// ---- Verification ---------------------------------------------------------
/** The five headers PayPal signs a delivery with. */
export function readWebhookHeaders(request) {
  return {
    transmissionId: request.headers.get('paypal-transmission-id'),
    transmissionTime: request.headers.get('paypal-transmission-time'),
    transmissionSig: request.headers.get('paypal-transmission-sig'),
    certUrl: request.headers.get('paypal-cert-url'),
    authAlgo: request.headers.get('paypal-auth-algo')
  };
}

/**
 * Verify a delivery by asking PayPal.
 *
 * WHY NOT VERIFY OFFLINE. The local route is: fetch the certificate named by
 * `paypal-cert-url`, then RSA-SHA256-verify the signature over
 * `transmissionId|transmissionTime|webhookId|crc32(rawBody)`. That needs a
 * CRC32 implementation and X.509 parsing in a Worker, and — the part that
 * actually matters — it requires validating that `cert_url` really is a
 * paypal.com host before fetching it. Skipping that check is a well-known
 * forgery: an attacker names their own cert URL and signs whatever they like.
 * Delegating to PayPal removes that entire class of bug, at the cost of one
 * HTTPS round trip on a path that is already asynchronous and retried.
 *
 * The body must be the RAW text. Re-serialising the parsed JSON reorders keys
 * and changes the bytes PayPal checksummed.
 */
export async function verifyPayPalSignature(rawBody, headers, env, webhookId) {
  if (!webhookId) return { ok: false, reason: 'no webhook id configured' };

  const { transmissionId, transmissionTime, transmissionSig, certUrl, authAlgo } = headers ?? {};
  if (!transmissionId) return { ok: false, reason: 'missing paypal-transmission-id header' };
  if (!transmissionSig) return { ok: false, reason: 'missing paypal-transmission-sig header' };
  if (!certUrl) return { ok: false, reason: 'missing paypal-cert-url header' };

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'invalid json' };
  }

  const token = await getAccessToken(env);
  const res = await fetch(`${apiBase(env)}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transmission_id: transmissionId,
      transmission_time: transmissionTime,
      cert_url: certUrl,
      auth_algo: authAlgo,
      transmission_sig: transmissionSig,
      webhook_id: webhookId,
      // PayPal requires the event as an OBJECT here, not the raw string. It
      // recomputes the checksum from this, which is why the round trip is
      // tolerable but the raw body still had to survive to this point intact.
      webhook_event: event
    })
  });

  if (!res.ok) return { ok: false, reason: `verify call failed: HTTP ${res.status}` };

  const body = await res.json();
  return body.verification_status === 'SUCCESS'
    ? { ok: true }
    : { ok: false, reason: `verification_status ${body.verification_status}` };
}

/**
 * Try each configured webhook id.
 *
 * Same reasoning as dodo.js's multi-secret path: the sandbox and live apps
 * have different webhook ids, and a single slot means configuring live breaks
 * sandbox deliveries the same minute. Each id names an endpoint we own, so
 * accepting several weakens nothing — a forgery still has to pass PayPal's own
 * signature check.
 */
export async function verifyAgainstAnyWebhookId(rawBody, headers, env, ids) {
  const candidates = Object.entries(ids).filter(([, v]) => typeof v === 'string' && v.trim());
  if (!candidates.length) return { ok: false, reason: 'no webhook id configured' };

  let lastReason = 'verification failed';
  for (const [name, id] of candidates) {
    const r = await verifyPayPalSignature(rawBody, headers, env, id);
    if (r.ok) return { ok: true, matched: name };
    // A missing header or unparseable body is not id-specific — stop rather
    // than making the same rejected call again for every slot.
    if (!r.reason.startsWith('verification_status')) return r;
    lastReason = r.reason;
  }
  return { ok: false, reason: `${lastReason} (tried ${candidates.length})` };
}

// ---- Event mapping --------------------------------------------------------
const SUBSCRIPTION_EVENT = /^BILLING\.SUBSCRIPTION\./;
const SALE_EVENT = /^PAYMENT\.SALE\./;

/**
 * Flatten a PayPal event into the shape the licence logic already speaks.
 *
 * The event id is taken from the BODY — `event.id` — because that is where
 * PayPal puts it. It is passed through the same `subject.eventId` field the
 * Dodo path fills from a header, so index.js's replay guard does not care
 * which provider it came from.
 */
export function extractSubject(event) {
  const r = event?.resource ?? {};
  const type = String(event?.event_type ?? '');

  const isSale = SALE_EVENT.test(type);
  const isSubscription = SUBSCRIPTION_EVENT.test(type);

  // THE TRAP. See note 3 at the top of this file.
  const subscriptionId = isSale
    ? r.billing_agreement_id ?? null
    : (isSubscription ? r.id ?? null : null);

  const subscriber = r.subscriber ?? {};

  return {
    eventId: event?.id ?? null,
    eventType: type || null,
    subscriptionId,
    // The sale id, for /v1/license/by-transaction. Only a sale has one.
    transactionId: isSale ? r.id ?? null : null,
    customerId: subscriber.payer_id ?? r.payer_id ?? null,
    email: subscriber.email_address ?? null,
    status: r.status ?? null,
    // Only present on subscription events; see enrichFromApi.
    nextBilledAt: r.billing_info?.next_billing_time ?? null,
    canceledAt: r.status_update_time ?? null,
    // Set at subscription-creation time by the checkout page. This is the hook
    // for scoping a key to one product if a second product is ever sold
    // through the same PayPal account.
    productId: r.plan_id ?? null,
    custom: r.custom_id ?? null,
    metadata: {}
  };
}

/**
 * Fill in what the payload could not carry, by asking PayPal.
 *
 * This exists because of traps 3 and 4, and it is the difference between a
 * renewal working and a customer silently losing Pro one year in:
 *
 *   PAYMENT.SALE.COMPLETED is the event that fires on every renewal, and it
 *   carries NO next_billing_time and NO subscriber email. Acting on it alone
 *   leaves expires_at at its original value, so the licence lapses on its
 *   first anniversary while PayPal keeps charging the customer. That is the
 *   same failure dodo.js documents for `subscription.renewed`, arriving by a
 *   different route.
 *
 * One GET per renewal is a cheap price for that. Only called when something is
 * actually missing, so first-purchase activations (which carry everything) do
 * not pay it.
 *
 * Failure is non-fatal: it returns the subject unchanged so the caller still
 * records the payment. A licence that keeps its old expiry is recoverable; a
 * 500 that makes PayPal retry forever is not.
 */
export async function enrichFromApi(env, subject) {
  if (!subject.subscriptionId) return subject;
  if (subject.nextBilledAt && subject.email) return subject;

  try {
    const token = await getAccessToken(env);
    const res = await fetch(
      `${apiBase(env)}/v1/billing/subscriptions/${encodeURIComponent(subject.subscriptionId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      console.log(`paypal: subscription lookup failed HTTP ${res.status}`);
      return subject;
    }
    const sub = await res.json();
    return {
      ...subject,
      nextBilledAt: subject.nextBilledAt ?? sub.billing_info?.next_billing_time ?? null,
      email: subject.email ?? sub.subscriber?.email_address ?? null,
      customerId: subject.customerId ?? sub.subscriber?.payer_id ?? null,
      productId: subject.productId ?? sub.plan_id ?? null,
      custom: subject.custom ?? sub.custom_id ?? null
    };
  } catch (err) {
    console.log(`paypal: subscription lookup threw: ${err.message}`);
    return subject;
  }
}

// ---- Event sets -----------------------------------------------------------
// Note the hyphen in RE-ACTIVATED. It is PayPal's spelling, not a typo, and
// `BILLING.SUBSCRIPTION.REACTIVATED` matches nothing.
export const GRANTING_EVENTS = new Set([
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'PAYMENT.SALE.COMPLETED'
]);

/** Recoverable: the row keeps its expiry and a later payment restores it. */
export const SUSPENDING_EVENTS = new Set([
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.DENIED'
]);

/** Terminal: access ends, though cancelled still runs to the paid-for date. */
export const REVOKING_EVENTS = new Set([
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED'
]);

/** Money returned, as opposed to a subscription merely ending. */
export const REFUND_EVENTS = new Set([
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED'
]);

/**
 * A plan change or an un-suspend.
 *
 * PayPal fires BILLING.SUBSCRIPTION.UPDATED for a plan or quantity change, and
 * again when a suspended subscription is reactivated by the merchant. Both
 * mean "this should be active, with the expiry the API now reports", which is
 * the same handling Dodo's subscription.updated gets.
 */
export const RESTORING_EVENTS = new Set(['BILLING.SUBSCRIPTION.UPDATED']);

/** Chargebacks. PayPal namespaces these under CUSTOMER.DISPUTE, not DISPUTE. */
export const isDispute = (type) => String(type).startsWith('CUSTOMER.DISPUTE.');

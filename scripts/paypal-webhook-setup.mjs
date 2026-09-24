#!/usr/bin/env node
/**
 * Register the PayPal webhook and print its ID.
 *
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-webhook-setup.mjs
 *   ... PAYPAL_ENV=live node scripts/paypal-webhook-setup.mjs     (once sandbox works)
 *
 * Scripted for the same reason scripts/paypal-setup.mjs is: sandbox and live
 * each need the same webhook subscribed to the same events, and a hand-ticked
 * checkbox list of eleven events is a drift waiting to happen. Getting one
 * event wrong here fails SILENTLY — the delivery simply never arrives, and the
 * symptom shows up months later as a licence that did not renew.
 *
 * IDEMPOTENT, and it goes further than paypal-setup.mjs: if a webhook for this
 * URL already exists with the WRONG event list, it PATCHes it to match rather
 * than leaving a subtly misconfigured one in place. The event list in the code
 * is the authority.
 *
 * SECRETS: read from the environment, never logged. The webhook ID this prints
 * is not a secret in the signature sense — verification needs it alongside the
 * client credentials — but it belongs in a Worker secret, not a file, to keep
 * it out of the repo.
 */
const ENV = (process.env.PAYPAL_ENV ?? 'sandbox').toLowerCase();
const API = ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment.');
  process.exit(2);
}

// Override with WEBHOOK_URL when the Worker moves to a custom domain — which is
// pending a domain purchase, and will also fix the doubled host below.
const WEBHOOK_URL = process.env.WEBHOOK_URL
  ?? 'https://ad-interceptor-api.ad-interceptor-api.workers.dev/v1/paypal/webhook';

/**
 * Taken from backend/src/paypal.js, which is the authority — NOT from the
 * README table, which omits PAYMENT.SALE.DENIED and the dispute family.
 *
 * Note RE-ACTIVATED carries a hyphen. PayPal's own docs are inconsistent about
 * it and `BILLING.SUBSCRIPTION.REACTIVATED` matches nothing, so a webhook
 * subscribed to the unhyphenated spelling would go quiet for exactly the
 * customers who came back.
 */
const EVENTS = [
  // Granting — mint or extend the licence.
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'PAYMENT.SALE.COMPLETED',          // the RENEWAL event; without it licences lapse at one year
  // Recoverable trouble — past_due, not revoked.
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.DENIED',
  // Ending.
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  // Revoking, immediately.
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
  // Plan change / un-suspend.
  'BILLING.SUBSCRIPTION.UPDATED',
  // One-time orders (since 2026-09-24): money returned revokes the licence,
  // or takes back the 12 months a renewal added. See reverseOrder.
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  // Chargebacks. PayPal namespaces these under CUSTOMER.DISPUTE, not DISPUTE.
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED'
];

async function token() {
  const res = await fetch(`${API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  // Never echo the body — a failed token response can quote the credentials.
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}. Check the id/secret and that PAYPAL_ENV matches where they came from.`);
  return (await res.json()).access_token;
}

async function api(tok, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const detail = body?.details?.map((d) => `${d.issue}: ${d.description}`).join('; ') ?? text.slice(0, 300);
    throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${res.status}\n  ${detail}`);
  }
  return body;
}

const tok = await token();
console.log(`PayPal ${ENV} — authenticated`);
console.log(`target: ${WEBHOOK_URL}\n`);

const existing = (await api(tok, '/v1/notifications/webhooks'))?.webhooks ?? [];
let hook = existing.find((w) => w.url === WEBHOOK_URL) ?? null;

if (!hook) {
  hook = await api(tok, '/v1/notifications/webhooks', {
    method: 'POST',
    body: JSON.stringify({ url: WEBHOOK_URL, event_types: EVENTS.map((name) => ({ name })) })
  });
  console.log(`✓ webhook created: ${hook.id}`);
  console.log(`  subscribed to ${EVENTS.length} events`);
} else {
  console.log(`· webhook already exists: ${hook.id}`);

  // Compare as sets: PayPal does not promise to return the events in the order
  // they were sent, so an ordered comparison would rewrite it on every run.
  const have = new Set((hook.event_types ?? []).map((e) => e.name));
  const missing = EVENTS.filter((e) => !have.has(e));
  const extra = [...have].filter((e) => !EVENTS.includes(e));

  if (missing.length === 0 && extra.length === 0) {
    console.log(`  event list already correct (${EVENTS.length} events)`);
  } else {
    if (missing.length) console.log(`  MISSING : ${missing.join(', ')}`);
    if (extra.length) console.log(`  EXTRA   : ${extra.join(', ')}`);
    // replace, not add: the list in this file is the authority, so an event
    // subscribed by hand in the dashboard and not handled by the adapter is
    // removed rather than tolerated.
    await api(tok, `/v1/notifications/webhooks/${hook.id}`, {
      method: 'PATCH',
      body: JSON.stringify([{ op: 'replace', path: '/event_types', value: EVENTS.map((name) => ({ name })) }])
    });
    console.log(`✓ event list corrected to the ${EVENTS.length} events the adapter handles`);
  }
}

console.log(`
──────────────────────────────────────────────────────────────
  PAYPAL_ENV        ${ENV}
  webhook id        ${hook.id}

Set it as a Worker secret — WITHOUT it every delivery is REJECTED,
not accepted unchecked (see verifyPayPalSignature):

  cd backend
  npx wrangler secret put PAYPAL_WEBHOOK_ID${ENV === 'live' ? '' : '\n\n  (sandbox and live apps can coexist: there is a second slot,\n   PAYPAL_WEBHOOK_ID_TEST, if you need both configured at once)'}
──────────────────────────────────────────────────────────────`);

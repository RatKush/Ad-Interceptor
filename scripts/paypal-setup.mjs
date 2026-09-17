#!/usr/bin/env node
/**
 * Create the PayPal catalog product and the $14.99/yr subscription plan.
 *
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node scripts/paypal-setup.mjs
 *   ... PAYPAL_ENV=live node scripts/paypal-setup.mjs        (once sandbox works)
 *
 * A script rather than dashboard clicking, for the same reason
 * scripts/store-copy.mjs exists: the sandbox and live accounts each need the
 * same objects, and doing it twice by hand is how the two drift. It prints the
 * plan id to paste into store-listing/web/seller.json.
 *
 * IDEMPOTENT. It lists before it creates, so running it twice does not leave
 * two products and two plans — which would be genuinely confusing later, since
 * a plan cannot be deleted, only deactivated.
 *
 * SECRETS: read from the environment and never logged. The client SECRET must
 * never reach seller.json or the site; the client ID is different — it is
 * public by design and appears in the browser's PayPal SDK URL.
 */
const ENV = (process.env.PAYPAL_ENV ?? 'sandbox').toLowerCase();
const API = ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in the environment.');
  console.error('Get them from https://developer.paypal.com/dashboard/applications/sandbox');
  process.exit(2);
}

// Matched on exactly, so a second run finds what the first created.
const PRODUCT_NAME = 'Ad Interceptor Pro';
const PLAN_NAME = 'Ad Interceptor Pro — annual';
const PRICE = '14.99';
const CURRENCY = 'USD';

async function token() {
  const res = await fetch(`${API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) {
    // Never echo the body — a failed token response can quote the credentials.
    throw new Error(`token request failed: HTTP ${res.status}. Check the id/secret and that PAYPAL_ENV matches where they came from.`);
  }
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

async function findProduct(tok) {
  // One page is enough: this account should have a handful of products, and
  // paging blindly through a large catalogue would be slower than it is useful.
  const list = await api(tok, '/v1/catalogs/products?page_size=20');
  return (list.products ?? []).find((p) => p.name === PRODUCT_NAME) ?? null;
}

async function findPlan(tok, productId) {
  const list = await api(tok, `/v1/billing/plans?product_id=${encodeURIComponent(productId)}&page_size=20`);
  return (list.plans ?? []).find((p) => p.name === PLAN_NAME) ?? null;
}

const tok = await token();
console.log(`PayPal ${ENV} — authenticated\n`);

let product = await findProduct(tok);
if (product) {
  console.log(`· product already exists: ${product.id}`);
} else {
  product = await api(tok, '/v1/catalogs/products', {
    method: 'POST',
    body: JSON.stringify({
      name: PRODUCT_NAME,
      description: 'Pro features for the Ad Interceptor browser extension.',
      type: 'DIGITAL',
      category: 'SOFTWARE',
      home_url: 'https://ad-interceptor.pages.dev/'
    })
  });
  console.log(`✓ product created: ${product.id}`);
}

let plan = await findPlan(tok, product.id);
if (plan) {
  console.log(`· plan already exists: ${plan.id}  (status ${plan.status})`);
} else {
  plan = await api(tok, '/v1/billing/plans', {
    method: 'POST',
    body: JSON.stringify({
      product_id: product.id,
      name: PLAN_NAME,
      description: `Ad Interceptor Pro, ${CURRENCY} ${PRICE} per year.`,
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'YEAR', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        // 0 = renew forever. A finite count would silently stop billing after
        // that many years and the licence would lapse with no event to act on.
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: PRICE, currency_code: CURRENCY } }
      }],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        // After 3 failed attempts PayPal suspends the subscription, which
        // arrives as BILLING.SUBSCRIPTION.SUSPENDED — a recoverable state the
        // backend already maps to 'past_due' rather than revoking.
        payment_failure_threshold: 3
      },
      // No tax block: the seller of record is an individual in India selling
      // in USD, and PayPal is a processor, not a merchant of record. Tax
      // handling is the seller's, which is what the site already states.
      quantity_supported: false
    })
  });
  console.log(`✓ plan created: ${plan.id}`);
}

console.log(`
──────────────────────────────────────────────────────────────
  PAYPAL_ENV        ${ENV}
  product id        ${product.id}
  plan id           ${plan.id}
  price             ${CURRENCY} ${PRICE} / year, renews forever

Next:
  1. Put the plan id in store-listing/web/seller.json as "paypalPlanId",
     and the CLIENT ID (not the secret) as "paypalClientId".
     The client id is public — it appears in the browser's SDK URL.
  2. Set the Worker secrets (these never enter a file):
       cd backend
       npx wrangler secret put PAYPAL_CLIENT_ID
       npx wrangler secret put PAYPAL_CLIENT_SECRET
  3. Register the webhook and set PAYPAL_WEBHOOK_ID — see README.
──────────────────────────────────────────────────────────────`);

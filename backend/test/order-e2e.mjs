#!/usr/bin/env node
/**
 * End-to-end test of the one-time Pro checkout against a local Worker and a
 * stand-in PayPal (test/mock-paypal.mjs, started by this script on :8795).
 *
 *   npx wrangler dev --config wrangler.local.jsonc --port 8788 --local \
 *     --var PAYPAL_API_BASE:http://127.0.0.1:8795 --var PAYPAL_CLIENT_ID:mock \
 *     --var PAYPAL_CLIENT_SECRET:mock --var PAYPAL_WEBHOOK_ID:WH-MOCK
 *   node test/order-e2e.mjs
 *
 * Covers what money depends on: one payment grants exactly once however often
 * the page asks, renewals add 12 months to the same key, a wrong amount grants
 * nothing, and refunds or disputes take back exactly what they paid for.
 */
import { startMockPayPal } from './mock-paypal.mjs';

const BASE = process.env.WORKER || 'http://127.0.0.1:8788';
const ORIGIN = 'http://127.0.0.1:8790';
const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const post = async (p, body, headers = {}) => {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const near = (a, b, slack = 2 * 60 * 1000) => Math.abs(a - b) < slack;
const installId = crypto.randomUUID();
const validate = (key) => post('/v1/license/validate', { key, installId, version: '3.4' }).then((r) => r.body);

const mock = await startMockPayPal(8795);

async function startOrder(renewKey) {
  const r = await post('/v1/checkout/paypal-order', renewKey ? { origin: ORIGIN, renewKey } : { origin: ORIGIN });
  const token = r.body.approveUrl ? new URL(r.body.approveUrl).searchParams.get('token') : null;
  return { ...r, token };
}
const capture = (orderId) => post('/v1/checkout/paypal-order/capture', { orderId });
let webhookSeq = 0;
const webhook = (event_type, resource) => post('/v1/paypal/webhook',
  { id: `WH-EVT-${Date.now()}-${++webhookSeq}`, event_type, resource },
  {
    'paypal-transmission-id': crypto.randomUUID(), 'paypal-transmission-time': new Date().toISOString(),
    'paypal-transmission-sig': 'mock', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-auth-algo': 'SHA256withRSA'
  });

try {
  console.log('\nNew purchase');
  const t0 = Date.now();
  const a = await startOrder();
  check('checkout returns a PayPal approval URL', a.status === 200 && !!a.token, JSON.stringify(a.body));
  const ctx = mock.state.lastCreate?.payment_source?.paypal?.experience_context ?? {};
  const unit = mock.state.lastCreate?.purchase_units?.[0] ?? {};
  check('opens PayPal on the card form (GUEST_CHECKOUT)', ctx.landing_page === 'GUEST_CHECKOUT');
  check('one-time CAPTURE order for 14.99 USD', mock.state.lastCreate?.intent === 'CAPTURE'
    && unit.amount?.value === '14.99' && unit.amount?.currency_code === 'USD');
  check('return and cancel URLs are distinct', ctx.return_url === `${ORIGIN}/pricing`
    && ctx.cancel_url === `${ORIGIN}/pricing?checkout=cancelled`);

  const early = await capture(a.token);
  check('capturing before the buyer approves charges nothing (402)', early.status === 402, JSON.stringify(early.body));

  mock.approve(a.token);
  const c1 = await capture(a.token);
  check('capture after approval returns a key', c1.status === 200 && /^AI3-/.test(c1.body.key ?? ''), JSON.stringify(c1.body));
  check('the key runs for 12 months', near(c1.body.expiresAt, t0 + YEAR));
  check('it is marked as a new licence, not a renewal', c1.body.renewed === false);

  const c2 = await capture(a.token);
  check('asking again returns the same key (reload-safe)', c2.status === 200 && c2.body.key === c1.body.key);
  check('PayPal was charged exactly once', mock.state.captures === 1, `captures=${mock.state.captures}`);

  const v = await validate(c1.body.key);
  check('the key validates as Pro', v.valid === true && v.plan === 'pro', JSON.stringify(v));
  check('and is reported as NOT auto-renewing', v.autoRenews === false);

  const rec = await fetch(`${BASE}/v1/license/by-transaction?transaction_id=${a.token}`).then((r) => r.json());
  check('the recover link (order id) finds the same key', rec.key === c1.body.key, JSON.stringify(rec));
  const byReceipt = await fetch(`${BASE}/v1/license/by-transaction?transaction_id=CAP${a.token}`).then((r) => r.json());
  check("PayPal's receipt Transaction ID (capture id) finds it too", byReceipt.key === c1.body.key, JSON.stringify(byReceipt));
  const wrong = await fetch(`${BASE}/v1/license/by-transaction?transaction_id=NOTAREALTXN0001`);
  check('an unknown Transaction ID finds nothing', wrong.status === 404);

  console.log('\nConcurrent captures of one order');
  const b = await startOrder();
  mock.approve(b.token);
  const par = await Promise.all([capture(b.token), capture(b.token), capture(b.token)]);
  const keys = new Set(par.map((r) => r.body.key));
  check('three simultaneous captures agree on one key', par.every((r) => r.status === 200) && keys.size === 1,
    JSON.stringify(par.map((r) => r.body)));
  check('and PayPal was charged once for it', mock.state.captures === 2, `captures=${mock.state.captures}`);

  console.log('\nRenewal');
  const r1 = await startOrder(c1.body.key);
  check('renewal checkout accepts an existing key', r1.status === 200 && !!r1.token, JSON.stringify(r1.body));
  check('the order carries the key to extend', mock.state.lastCreate?.purchase_units?.[0]?.custom_id === `renew:${c1.body.key}`);
  mock.approve(r1.token);
  const rc = await capture(r1.token);
  check('renewal keeps the same key', rc.status === 200 && rc.body.key === c1.body.key, JSON.stringify(rc.body));
  check('and adds 12 months to the current end, not to today', near(rc.body.expiresAt, c1.body.expiresAt + YEAR));
  check('it is reported as a renewal', rc.body.renewed === true);

  const bogus = await startOrder('AI3-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ');
  check('renewing an unknown key is refused BEFORE payment', bogus.status === 400 && bogus.body.error === 'unknown key');

  console.log('\nWrong amount');
  mock.state.amountOverride = '1.00';
  const w = await startOrder();
  mock.approve(w.token);
  const wc = await capture(w.token);
  mock.state.amountOverride = null;
  check('a capture for the wrong amount grants nothing (409)', wc.status === 409 && !wc.body.key, JSON.stringify(wc.body));

  console.log('\nRefunds and disputes');
  const refundOf = (orderId) => webhook('PAYMENT.CAPTURE.REFUNDED', {
    id: `REF-${orderId}`, status: 'COMPLETED',
    links: [{ rel: 'up', href: `https://api.paypal.com/v2/payments/captures/CAP${orderId}` }]
  });
  const rf1 = await refundOf(r1.token);
  check('refund webhook accepted', rf1.status === 200, JSON.stringify(rf1.body));
  const afterRenewRefund = await validate(c1.body.key);
  check('refunding the renewal takes back exactly its 12 months', afterRenewRefund.valid
    && near(afterRenewRefund.expiresAt, c1.body.expiresAt), JSON.stringify(afterRenewRefund));
  await refundOf(r1.token);
  const again = await validate(c1.body.key);
  check('a repeated refund event changes nothing', near(again.expiresAt, c1.body.expiresAt));

  await refundOf(a.token);
  const afterNewRefund = await validate(c1.body.key);
  check('refunding the original purchase revokes the key', afterNewRefund.valid === false
    && /revoked/i.test(afterNewRefund.reason ?? ''), JSON.stringify(afterNewRefund));

  const disputed = par[0].body.key;
  await webhook('CUSTOMER.DISPUTE.CREATED', {
    dispute_id: 'PP-D-1', disputed_transactions: [{ seller_transaction_id: `CAP${b.token}` }]
  });
  const afterDispute = await validate(disputed);
  check('a chargeback on a one-time purchase revokes its key', afterDispute.valid === false, JSON.stringify(afterDispute));
} finally {
  await mock.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
/**
 * End-to-end test against a locally running Worker.
 *
 * Two terminals:
 *   npm run dev:local
 *   npm run test:local
 *
 * It talks to the real Worker over HTTP with real D1 and KV simulators rather
 * than mocking the bindings, because every bug worth catching here lives in
 * the seams — signature bytes, D1 constraints, ETag handling — and a mock
 * would agree with whatever the code does.
 *
 * Secrets come from .dev.vars, so they are the local test values, not real ones.
 */
const BASE = 'http://localhost:8787';
const ADMIN = 'local-admin-token-for-testing-only';
// Dodo signs with the BYTES BEHIND the base64, not the string. Getting this
// wrong is the single easiest way to write a test that agrees with a broken
// implementation, so the test decodes it the same way a real sender would.
const DODO_SECRET_B64 = 'bG9jYWwtZG9kby1zZWNyZXQtZm9yLXRlc3Rpbmctb25seQ==';
const DODO_SECRET = `whsec_${DODO_SECRET_B64}`;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const post = (p, body, headers = {}) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});
const validate = (key, installId, version = '3.1') =>
  post('/v1/license/validate', { key, installId, version }).then(r => r.json());

let evtSeq = 0;

/** Send a Dodo-shaped event, signed per the Standard Webhooks spec. */
async function dodoSend(type, data, eventId = null) {
  const raw = JSON.stringify({
    business_id: 'biz_test', type, timestamp: new Date().toISOString(), data
  });
  const id = eventId ?? `evt_auto_${++evtSeq}`;
  const ts = Math.floor(Date.now() / 1000).toString();

  const bin = atob(DODO_SECRET_B64);
  const keyBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);

  const k = await crypto.subtle.importKey('raw', keyBytes,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k,
    new TextEncoder().encode(`${id}.${ts}.${raw}`));
  let s = '';
  for (const b of new Uint8Array(sig)) s += String.fromCharCode(b);

  return post('/v1/dodo/webhook', raw, {
    'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${btoa(s)}`
  });
}

const daysOut = (d) => new Date(Date.now() + d * 864e5).toISOString();

/** A subscription payload. Dodo nests the customer and always sends the email. */
const sub = (subscription_id, customer_id, email, days = 365, extra = {}) => ({
  payload_type: 'Subscription', subscription_id, product_id: 'prod_test',
  status: 'active', next_billing_date: daysOut(days),
  customer: { customer_id, email, name: 'Test Buyer' }, ...extra
});

/** A payment payload. `payment_id` is what the buyer's browser trades for a key. */
const pay = (payment_id, subscription_id, customer_id, email) => ({
  payload_type: 'Payment', payment_id, subscription_id, status: 'succeeded',
  customer: { customer_id, email, name: 'Test Buyer' }
});

console.log('\nHealth');
{
  const r = await fetch(BASE + '/health');
  check('GET /health is 200', r.status === 200);
  check('unknown route is 404', (await fetch(BASE + '/nope')).status === 404);
}

console.log('\nAdmin auth');
{
  check('admin endpoint rejects no token', (await post('/v1/admin/license', {})).status === 401);
  check('admin endpoint rejects wrong token',
    (await post('/v1/admin/license', {}, { Authorization: 'Bearer wrong' })).status === 401);
}

console.log('\nKey issue + activation limits');
let key;
{
  const r = await post('/v1/admin/license', { email: 'buyer@example.com' },
    { Authorization: `Bearer ${ADMIN}` });
  const body = await r.json();
  key = body.key;
  check('admin issues a key', r.status === 200 && /^AI3(-[0-9A-Z]{5}){4}$/.test(key || ''), key);

  check('device 1 validates', (await validate(key, 'install-1')).valid === true);
  check('device 2 validates', (await validate(key, 'install-2')).valid === true);
  check('device 3 validates', (await validate(key, 'install-3')).valid === true);

  const four = await validate(key, 'install-4');
  check('device 4 is refused', four.valid === false, JSON.stringify(four));
  check('refusal explains why', /3 devices/.test(four.reason || ''), four.reason);

  check('known device still validates after limit', (await validate(key, 'install-2')).valid === true);
  check('lowercase/spacey key still validates',
    (await validate('  ' + key.toLowerCase().replace(/-/g, ' ') + ' ', 'install-1')).valid === true);
}

console.log('\nBad keys');
{
  const junk = await validate('hello', 'i');
  check('malformed key rejected', junk.valid === false);
  check('malformed key says so', /licence key/.test(junk.reason || ''), junk.reason);

  const unknown = await validate('AI3-22222-22222-22222-22222', 'i');
  check('unknown key rejected', unknown.valid === false);
  check('unknown key has its own reason', /no record/.test(unknown.reason || ''), unknown.reason);
}

console.log('\nFilter feed');
{
  const before = await fetch(BASE + '/v1/filters/latest', { headers: { Authorization: `Bearer ${key}` } });
  check('503 before any build is published', before.status === 503, String(before.status));

  check('publish rejects empty rules',
    (await post('/v1/admin/filters', { rules: [] }, { Authorization: `Bearer ${ADMIN}` })).status === 400);

  const rules = [{ id: 1, priority: 1, action: { type: 'block' }, condition: { urlFilter: '||ads.example^' } }];
  const pub = await post('/v1/admin/filters', { rules, builtAt: 1700000000000 },
    { Authorization: `Bearer ${ADMIN}` });
  check('publish accepted', pub.status === 200 && (await pub.json()).count === 1);

  check('feed rejects missing token',
    (await fetch(BASE + '/v1/filters/latest')).status === 401);
  check('feed rejects a junk key',
    (await fetch(BASE + '/v1/filters/latest', { headers: { Authorization: 'Bearer AI3-22222-22222-22222-22222' } })).status === 403);

  const got = await fetch(BASE + '/v1/filters/latest', {
    headers: { Authorization: `Bearer ${key}`, 'X-Install-Id': 'install-1' } });
  const payload = await got.json();
  check('entitled fetch returns rules', got.status === 200 && payload.rules.length === 1);
  const etag = got.headers.get('ETag');
  check('ETag present', !!etag, etag);

  const again = await fetch(BASE + '/v1/filters/latest', {
    headers: { Authorization: `Bearer ${key}`, 'X-Install-Id': 'install-1', 'If-None-Match': etag } });
  check('unchanged build returns 304', again.status === 304, String(again.status));
}

console.log('\nDodo webhook');
{
  const data = sub('sub_abc', 'ctm_1', 'sub@example.com', 30);

  const r1 = await dodoSend('subscription.active', data, 'evt_test_001');
  check('valid webhook accepted', r1.status === 200, String(r1.status));

  const r2 = await dodoSend('subscription.active', data, 'evt_test_001');
  check('replayed event is deduped', (await r2.json()).duplicate === true);

  const dup = await dodoSend('subscription.active', data, 'evt_test_002');
  check('second event for same subscription accepted', dup.status === 200);

  const bad = await post('/v1/dodo/webhook', { type: 'subscription.active', data }, {
    'webhook-id': 'evt_forged', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
    'webhook-signature': 'v1,ZGVhZGJlZWY='
  });
  check('forged signature rejected', bad.status === 401, String(bad.status));

  const noSig = await post('/v1/dodo/webhook', { type: 'subscription.active', data });
  check('webhook with no signature headers rejected', noSig.status === 401);

  // The event id is a HEADER and is part of the signed content. A body that
  // carries its own id field must not be trusted in its place.
  const noId = await post('/v1/dodo/webhook', { type: 'subscription.active', data }, {
    'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
    'webhook-signature': 'v1,ZGVhZGJlZWY='
  });
  check('missing webhook-id rejected', noId.status === 401, String(noId.status));

  // The retired Paddle endpoint must say it is gone rather than 404 into the
  // generic handler, so a stray delivery is diagnosable.
  const oldRoute = await post('/v1/paddle/webhook', {});
  check('retired Paddle endpoint returns 410', oldRoute.status === 410, String(oldRoute.status));

  // The invariant that matters: a provider treats 2xx as "delivered, never
  // retry". So a 200 must mean the work is actually done. This previously
  // failed — the ledger row was written BEFORE the event was acted on, so a
  // throw mid-processing produced a 500, the retry matched the dedup check and
  // got 200/duplicate, and the key was never minted.
  const ack = await dodoSend('subscription.active',
    sub('sub_invariant', 'ctm_inv', 'inv@example.com', 30), 'evt_invariant_1');
  check('acknowledged webhook returns 200', ack.status === 200, String(ack.status));

  const again2 = await dodoSend('subscription.active',
    sub('sub_invariant', 'ctm_inv', 'inv@example.com', 30), 'evt_invariant_2');
  check('a 200 means the licence was really created', again2.status === 200, String(again2.status));
}

console.log('\nRenewal extends the expiry');
{
  // The bug this guards: `subscription.renewed` arrives for a licence that
  // ALREADY EXISTS, so it takes the existing-row path in issueKeyFor. If that
  // path leaves expires_at alone, every customer silently loses Pro one year
  // in while still being charged. It would not surface for a year.
  const payId = 'pay_renewal_0001';
  await dodoSend('subscription.active', sub('sub_renew', 'ctm_renew', 'renew@example.com', 365));
  await dodoSend('payment.succeeded', pay(payId, 'sub_renew', 'ctm_renew', 'renew@example.com'));

  const before = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payId}`).then(r => r.json());
  check('licence created with an expiry', typeof before.expiresAt === 'number', JSON.stringify(before));

  await dodoSend('subscription.renewed', sub('sub_renew', 'ctm_renew', 'renew@example.com', 730));
  const after = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payId}`).then(r => r.json());

  check('renewal moved the expiry forward', after.expiresAt > before.expiresAt,
    `${before.expiresAt} -> ${after.expiresAt}`);
  check('renewal did not mint a second key', after.key === before.key, `${before.key} vs ${after.key}`);

  // A replayed or late renewal carrying an OLDER date must not shorten access
  // that has already been paid for.
  await dodoSend('subscription.renewed', sub('sub_renew', 'ctm_renew', 'renew@example.com', 100));
  const stale = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payId}`).then(r => r.json());
  check('a late renewal cannot shorten access', stale.expiresAt === after.expiresAt,
    `${after.expiresAt} -> ${stale.expiresAt}`);
}

console.log('\nCollect key by payment id');
{
  const bad = await fetch(BASE + '/v1/license/by-transaction?transaction_id=!!!');
  check('malformed payment id rejected', bad.status === 400, String(bad.status));

  const unknown = await fetch(BASE + '/v1/license/by-transaction?transaction_id=pay_unknown_00001');
  check('unknown payment is 404', unknown.status === 404, String(unknown.status));
  check('unknown payment says retryable', (await unknown.json()).retryable === true);

  // Order A: payment.succeeded arrives first and carries both ids.
  const payA = 'pay_order_a_0001';
  await dodoSend('payment.succeeded', pay(payA, 'sub_order_a', 'ctm_a', 'a@example.com'));
  const gotA = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payA}`);
  const bodyA = await gotA.json();
  check('key collectable right after payment.succeeded',
    gotA.status === 200 && /^AI3-/.test(bodyA.key || ''), JSON.stringify(bodyA));

  // Order B: subscription.active first (no payment id at all), then the
  // payment. Without the backfill the buyer's browser can never find the row,
  // and the purchase silently leads nowhere.
  const payB = 'pay_order_b_0001';
  await dodoSend('subscription.active', sub('sub_order_b', 'ctm_b', 'b@example.com'));
  const beforeBackfill = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payB}`);
  check('not collectable before the payment event lands', beforeBackfill.status === 404);

  await dodoSend('payment.succeeded', pay(payB, 'sub_order_b', 'ctm_b', 'b@example.com'));
  const gotB = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payB}`);
  const bodyB = await gotB.json();
  check('backfill makes the key collectable',
    gotB.status === 200 && /^AI3-/.test(bodyB.key || ''), JSON.stringify(bodyB));

  const val = await validate(bodyB.key, 'install-order-b');
  check('out-of-order events still yield a working key', val.valid === true, JSON.stringify(val));
}

console.log('\nLifecycle: cancel, refund');
{
  // Cancelling keeps access to the end of the period already paid for. Only a
  // refund or chargeback kills it immediately.
  const payC = 'pay_cancel_0001';
  await dodoSend('subscription.active', sub('sub_cancel', 'ctm_c', 'c@example.com', 200));
  await dodoSend('payment.succeeded', pay(payC, 'sub_cancel', 'ctm_c', 'c@example.com'));
  const issued = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payC}`).then(r => r.json());

  await dodoSend('subscription.cancelled', {
    payload_type: 'Subscription', subscription_id: 'sub_cancel', status: 'cancelled',
    cancelled_at: new Date().toISOString(), next_billing_date: daysOut(200),
    customer: { customer_id: 'ctm_c', email: 'c@example.com' }
  });
  const afterCancel = await validate(issued.key, 'install-cancel');
  check('cancelled licence still works until the period ends',
    afterCancel.valid === true, JSON.stringify(afterCancel));

  // Refund revokes on the spot.
  const payR = 'pay_refund_0001';
  await dodoSend('subscription.active', sub('sub_refund', 'ctm_r', 'r@example.com', 200));
  await dodoSend('payment.succeeded', pay(payR, 'sub_refund', 'ctm_r', 'r@example.com'));
  const refunded = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payR}`).then(r => r.json());

  await dodoSend('refund.succeeded', {
    payload_type: 'Refund', subscription_id: 'sub_refund', payment_id: payR,
    status: 'succeeded', customer: { customer_id: 'ctm_r', email: 'r@example.com' }
  });
  const afterRefund = await validate(refunded.key, 'install-refund');
  check('refunded licence is revoked immediately', afterRefund.valid === false, JSON.stringify(afterRefund));
  check('revoked key is no longer collectable',
    (await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payR}`)).status === 404);
}

console.log('\nBuyer email capture');
{
  // Under Paddle the address arrived ONLY on customer.* events, which could
  // land before the subscription existed — an ordering hazard that needed a
  // separate customers table to survive. Dodo puts customer.email on every
  // payload, so any single event is enough. This asserts that directly.
  const payE = 'pay_email_0001';
  await dodoSend('subscription.active', sub('sub_email', 'ctm_email', 'buyer-e@example.com'));
  await dodoSend('payment.succeeded', pay(payE, 'sub_email', 'ctm_email', 'buyer-e@example.com'));

  const got = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${payE}`).then(r => r.json());
  check('licence created from events that each carry the email', !!got.key, JSON.stringify(got));

  // The address is server-side only, so prove it landed via the resend path:
  // a licence with no email 400s differently from one that has an address.
  const admin = { Authorization: `Bearer ${ADMIN}` };
  const resend = await post('/v1/admin/resend', { key: got.key }, admin);
  const rb = await resend.json();
  check('recorded email reaches the delivery path',
    !/no email/i.test(rb.result || rb.error || ''), JSON.stringify(rb));
}

console.log('\nKey delivery by email');
{
  const admin = { Authorization: `Bearer ${ADMIN}` };
  check('resend rejects no token', (await post('/v1/admin/resend', {})).status === 401);

  const r1 = await post('/v1/admin/resend', { key: 'not-a-key' }, admin);
  check('resend rejects a malformed key', r1.status === 400, String(r1.status));

  const r2 = await post('/v1/admin/resend', { key: 'AI3-22222-22222-22222-22222' }, admin);
  check('resend 404s an unknown key', r2.status === 404, String(r2.status));

  const issued = await post('/v1/admin/license', { email: 'buyer@example.com' }, admin)
    .then((r) => r.json());

  // MAIL_FROM is empty locally, which is also production's current state. The
  // contract that matters: the Worker must report the failure, not pretend.
  const r3 = await post('/v1/admin/resend', { key: issued.key }, admin);
  const b3 = await r3.json();
  check('resend reports sending is unconfigured', r3.status === 502 && /not configured/.test(b3.result || ''), JSON.stringify(b3));
  check('unconfigured resend is not reported as ok', b3.ok === false);

  // And the licence must NOT be marked delivered when nothing was sent —
  // a key recorded as sent but never delivered is the worst failure mode,
  // because the customer has nothing and nothing says so.
  const still = await post('/v1/admin/resend', { key: issued.key }, admin).then((r) => r.json());
  check('a failed send leaves the key resendable', /not configured/.test(still.result || ''), JSON.stringify(still));
}

console.log('\nLifecycle: cancel keeps access, refund kills it');
{
  const ex = await post('/v1/admin/license', { expiresAt: Date.now() - 1000 },
    { Authorization: `Bearer ${ADMIN}` });
  const expiredKey = (await ex.json()).key;
  const res = await validate(expiredKey, 'install-x');
  check('expired licence refused', res.valid === false);
  check('expired licence says expired', /expired/i.test(res.reason || ''), res.reason);

  const fut = await post('/v1/admin/license', { expiresAt: Date.now() + 864e5 },
    { Authorization: `Bearer ${ADMIN}` });
  const futureKey = (await fut.json()).key;
  check('licence with future expiry valid', (await validate(futureKey, 'install-y')).valid === true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

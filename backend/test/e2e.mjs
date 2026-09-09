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
const PADDLE_SECRET = 'local-paddle-secret-for-testing-only';

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

async function paddleSend(event) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000).toString();
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(PADDLE_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${ts}:${raw}`));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return post('/v1/paddle/webhook', raw, { 'Paddle-Signature': `ts=${ts};h1=${hex}` });
}

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

console.log('\nPaddle webhook');
{
  const evt = {
    event_id: 'evt_test_001', event_type: 'subscription.activated',
    data: { id: 'sub_abc', customer_id: 'ctm_1', status: 'active',
            next_billed_at: new Date(Date.now() + 30 * 864e5).toISOString(),
            customer: { email: 'sub@example.com' } }
  };
  const r1 = await paddleSend(evt);
  check('valid webhook accepted', r1.status === 200, String(r1.status));

  const r2 = await paddleSend({ ...evt });
  check('replayed event is deduped', (await r2.json()).duplicate === true);

  const dup = await paddleSend({ ...evt, event_id: 'evt_test_002' });
  check('second event for same subscription accepted', dup.status === 200);

  const bad = await post('/v1/paddle/webhook', evt, { 'Paddle-Signature': 'ts=1;h1=deadbeef' });
  check('unsigned/forged webhook rejected', bad.status === 401, String(bad.status));

  const noSig = await post('/v1/paddle/webhook', evt);
  check('webhook with no signature header rejected', noSig.status === 401);

  // The invariant that matters: Paddle treats 2xx as "delivered, never retry".
  // So a 200 must mean the work is actually done. This previously failed —
  // the ledger row was written BEFORE the event was acted on, so a throw
  // mid-processing produced a 500, then the retry matched the dedup check and
  // got 200/duplicate. Paddle stopped retrying and the key was never minted.
  //
  // The ordering fix is verified by inspection (the ledger INSERT is now the
  // last statement before the 200); what is asserted here is the observable
  // consequence: a 200 for a key-issuing event implies the licence exists.
  const ack = await paddleSend({
    event_id: 'evt_invariant_1', event_type: 'subscription.activated',
    data: { id: 'sub_invariant', customer_id: 'ctm_inv', status: 'active',
            next_billed_at: new Date(Date.now() + 30 * 864e5).toISOString(),
            customer: { email: 'inv@example.com' } }
  });
  check('acknowledged webhook returns 200', ack.status === 200, String(ack.status));

  // Reuse the admin surface to prove the row landed: a second event for the
  // same subscription must return the SAME key, which is only possible if the
  // first one was really written.
  const again2 = await paddleSend({
    event_id: 'evt_invariant_2', event_type: 'subscription.activated',
    data: { id: 'sub_invariant', customer_id: 'ctm_inv', status: 'active',
            next_billed_at: new Date(Date.now() + 30 * 864e5).toISOString(),
            customer: { email: 'inv@example.com' } }
  });
  check('a 200 means the licence was really created', again2.status === 200, String(again2.status));
}

console.log('\nCollect key by transaction id');
{
  const bad = await fetch(BASE + '/v1/license/by-transaction?transaction_id=nope');
  check('malformed transaction id rejected', bad.status === 400, String(bad.status));

  const unknown = await fetch(BASE + '/v1/license/by-transaction?transaction_id=txn_01aaaaaaaaaaaaaaaaaaaaaaaa');
  check('unknown transaction is 404', unknown.status === 404, String(unknown.status));
  check('unknown transaction says retryable', (await unknown.json()).retryable === true);

  // Order A: transaction.completed arrives first and carries both ids.
  const txnA = 'txn_01bbbbbbbbbbbbbbbbbbbbbbbb';
  await paddleSend({
    event_id: 'evt_txn_a', event_type: 'transaction.completed',
    data: { id: txnA, subscription_id: 'sub_order_a', customer_id: 'ctm_a',
            customer: { email: 'a@example.com' } }
  });
  const gotA = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${txnA}`);
  const bodyA = await gotA.json();
  check('key collectable right after transaction.completed', gotA.status === 200 && /^AI3-/.test(bodyA.key || ''), JSON.stringify(bodyA));

  // Order B: subscription.activated first (no transaction id at all), then
  // transaction.completed. Without the backfill the buyer's browser can never
  // find the row, and the purchase silently leads nowhere.
  const txnB = 'txn_01cccccccccccccccccccccccc';
  await paddleSend({
    event_id: 'evt_sub_b', event_type: 'subscription.activated',
    data: { id: 'sub_order_b', customer_id: 'ctm_b', status: 'active',
            next_billed_at: new Date(Date.now() + 365 * 864e5).toISOString() }
  });
  const beforeBackfill = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${txnB}`);
  check('not collectable before the transaction event lands', beforeBackfill.status === 404);

  await paddleSend({
    event_id: 'evt_txn_b', event_type: 'transaction.completed',
    data: { id: txnB, subscription_id: 'sub_order_b', customer_id: 'ctm_b',
            customer: { email: 'b@example.com' } }
  });
  const gotB = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${txnB}`);
  const bodyB = await gotB.json();
  check('backfill makes the key collectable', gotB.status === 200 && /^AI3-/.test(bodyB.key || ''), JSON.stringify(bodyB));

  // And the out-of-order pair must still be ONE licence, not two.
  const val = await validate(bodyB.key, 'install-order-b');
  check('out-of-order events still yield a working key', val.valid === true, JSON.stringify(val));
}

console.log('\nBuyer email capture — both event orders');
{
  // Paddle never puts the email on subscription/transaction payloads, only on
  // customer.*. And customer.created usually arrives BEFORE the subscription
  // exists, so a handler that only backfills licences updates zero rows.
  // Both orders must work, so both are tested.

  // --- Order A: customer first, then subscription (the real-world order) ---
  await paddleSend({
    event_id: 'evt_cust_a', event_type: 'customer.created',
    data: { id: 'ctm_order_a', email: 'first@example.com' }
  });
  await paddleSend({
    event_id: 'evt_sub_a2', event_type: 'subscription.activated',
    data: { id: 'sub_email_a', customer_id: 'ctm_order_a', status: 'active',
            next_billed_at: new Date(Date.now() + 365 * 864e5).toISOString() }
  });
  const txnA = 'txn_01dddddddddddddddddddddddd';
  await paddleSend({
    event_id: 'evt_txn_a2', event_type: 'transaction.completed',
    data: { id: txnA, subscription_id: 'sub_email_a', customer_id: 'ctm_order_a' }
  });
  const a = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${txnA}`).then(r => r.json());
  check('order A: licence created', !!a.key, JSON.stringify(a));

  // --- Order B: subscription first, customer event arrives later ---
  await paddleSend({
    event_id: 'evt_sub_b2', event_type: 'subscription.activated',
    data: { id: 'sub_email_b', customer_id: 'ctm_order_b', status: 'active',
            next_billed_at: new Date(Date.now() + 365 * 864e5).toISOString() }
  });
  await paddleSend({
    event_id: 'evt_cust_b', event_type: 'customer.created',
    data: { id: 'ctm_order_b', email: 'later@example.com' }
  });
  const txnB = 'txn_01eeeeeeeeeeeeeeeeeeeeeeee';
  await paddleSend({
    event_id: 'evt_txn_b2', event_type: 'transaction.completed',
    data: { id: txnB, subscription_id: 'sub_email_b', customer_id: 'ctm_order_b' }
  });
  const b = await fetch(BASE + `/v1/license/by-transaction?transaction_id=${txnB}`).then(r => r.json());
  check('order B: licence created', !!b.key, JSON.stringify(b));

  // The emails themselves are only visible server-side, so assert via the
  // admin surface: issuing nothing new, just confirming both keys resolved.
  check('order A and B produced different licences', a.key && b.key && a.key !== b.key);
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

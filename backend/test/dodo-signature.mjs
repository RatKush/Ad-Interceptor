// Unit tests for the Dodo webhook verifier.
//
// These run in plain node — no Worker, no D1 — because the thing under test is
// pure crypto and field mapping. The e2e suite exercises the route; this
// exercises the seam where a porting mistake is silent rather than loud.
//
//   node test/dodo-signature.mjs

import {
  verifyDodoSignature,
  verifyAgainstAnySecret,
  extractSubject,
  GRANTING_EVENTS,
  REVOKING_EVENTS
} from '../src/dodo.js';

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Sign exactly the way Standard Webhooks says a sender must. */
async function sign(secretB64, id, timestamp, rawBody) {
  const bin = atob(secretB64);
  const keyBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) keyBytes[i] = bin.charCodeAt(i);

  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`)
  );
  return bytesToB64(new Uint8Array(sig));
}

const SECRET_B64 = bytesToB64(crypto.getRandomValues(new Uint8Array(24)));
const OTHER_B64 = bytesToB64(crypto.getRandomValues(new Uint8Array(24)));
const WHSEC = `whsec_${SECRET_B64}`;

const ID = 'evt_01jxyzabcdef';
const NOW = Math.floor(Date.now() / 1000);
const BODY = JSON.stringify({
  business_id: 'biz_123',
  type: 'subscription.active',
  timestamp: new Date().toISOString(),
  data: {
    payload_type: 'Subscription',
    subscription_id: 'sub_abc',
    product_id: 'prod_pro',
    status: 'active',
    next_billing_date: '2027-09-12T00:00:00Z',
    customer: { customer_id: 'cus_xyz', email: 'buyer@example.com', name: 'A Buyer' },
    metadata: {}
  }
});

console.log('\nDodo webhook signature');

{
  const sig = await sign(SECRET_B64, ID, NOW, BODY);
  const h = { id: ID, timestamp: String(NOW), signature: `v1,${sig}` };

  const good = await verifyDodoSignature(BODY, h, WHSEC);
  check('valid signature accepted (whsec_ prefix)', good.ok, good.reason);

  const bare = await verifyDodoSignature(BODY, h, SECRET_B64);
  check('valid signature accepted (bare base64 secret)', bare.ok, bare.reason);

  // The single most likely porting mistake: using the secret as UTF-8 text
  // instead of decoding the base64. Prove that is NOT what we do by showing a
  // signature made over decoded bytes verifies.
  const wrongKey = await verifyDodoSignature(BODY, h, `whsec_${OTHER_B64}`);
  check('wrong secret rejected', !wrongKey.ok && wrongKey.reason === 'signature mismatch', wrongKey.reason);

  const tampered = await verifyDodoSignature(BODY.replace('active', 'cancelled'), h, WHSEC);
  check('tampered body rejected', !tampered.ok, tampered.reason);

  // The webhook id is part of the signed content, so changing it must break.
  const swappedId = await verifyDodoSignature(BODY, { ...h, id: 'evt_other' }, WHSEC);
  check('swapped webhook-id rejected', !swappedId.ok, swappedId.reason);

  const stale = { ...h, timestamp: String(NOW - 60 * 60) };
  const staleR = await verifyDodoSignature(BODY, stale, WHSEC);
  check('stale timestamp rejected', !staleR.ok && staleR.reason === 'timestamp outside replay window', staleR.reason);

  const noId = await verifyDodoSignature(BODY, { ...h, id: null }, WHSEC);
  check('missing webhook-id rejected', !noId.ok && noId.reason === 'missing webhook-id header', noId.reason);

  const noSig = await verifyDodoSignature(BODY, { ...h, signature: null }, WHSEC);
  check('missing signature rejected', !noSig.ok, noSig.reason);

  const junk = await verifyDodoSignature(BODY, { ...h, signature: 'garbage' }, WHSEC);
  check('malformed signature header rejected', !junk.ok && junk.reason === 'malformed webhook-signature header', junk.reason);

  const noSecret = await verifyDodoSignature(BODY, h, '');
  check('no configured secret rejected', !noSecret.ok && noSecret.reason === 'no signing secret configured', noSecret.reason);

  // Rotation: sender emits several signatures, one per active secret.
  const other = await sign(OTHER_B64, ID, NOW, BODY);
  const multi = { ...h, signature: `v1,${other} v1,${sig}` };
  const multiR = await verifyDodoSignature(BODY, multi, WHSEC);
  check('accepts when one of several signatures matches', multiR.ok, multiR.reason);

  // An unknown future version alongside a good v1 must not break us.
  const versioned = { ...h, signature: `v2,ZZZZ v1,${sig}` };
  const versionedR = await verifyDodoSignature(BODY, versioned, WHSEC);
  check('ignores unknown signature versions', versionedR.ok, versionedR.reason);
}

console.log('\nMulti-secret helper');

{
  const sig = await sign(OTHER_B64, ID, NOW, BODY);
  const h = { id: ID, timestamp: String(NOW), signature: `v1,${sig}` };

  const r = await verifyAgainstAnySecret(BODY, h, {
    DODO_WEBHOOK_SECRET: WHSEC,
    DODO_WEBHOOK_SECRET_TEST: `whsec_${OTHER_B64}`
  });
  check('matches the second configured secret', r.ok && r.matched === 'DODO_WEBHOOK_SECRET_TEST', JSON.stringify(r));

  const none = await verifyAgainstAnySecret(BODY, h, { A: '', B: '   ' });
  check('empty secret slots are not treated as configured', !none.ok && none.reason === 'no signing secret configured', none.reason);

  // A stale timestamp is not secret-specific: report it once, do not retry it
  // against every slot and then blame the signature.
  const stale = await verifyAgainstAnySecret(BODY, { ...h, timestamp: '1' }, {
    A: WHSEC, B: `whsec_${OTHER_B64}`
  });
  check('reports replay-window failure, not signature mismatch', !stale.ok && stale.reason === 'timestamp outside replay window', stale.reason);
}

console.log('\nField extraction');

{
  const evt = JSON.parse(BODY);
  const s = extractSubject(evt, ID);

  check('event id comes from the header, not the body', s.eventId === ID, s.eventId);
  check('subscription id read from data.subscription_id', s.subscriptionId === 'sub_abc', s.subscriptionId);
  check('customer id read from nested data.customer', s.customerId === 'cus_xyz', s.customerId);
  check('email present on a subscription event', s.email === 'buyer@example.com', s.email);
  check('period end read from next_billing_date', s.nextBilledAt === '2027-09-12T00:00:00Z', s.nextBilledAt);
  check('product id captured', s.productId === 'prod_pro', s.productId);
  check('a subscription event has no transaction id', s.transactionId === null, String(s.transactionId));

  // British spelling. Reading canceled_at (one L, Paddle's spelling) returns
  // undefined forever — the exact class of silent bug that bit the Paddle port.
  const cancelled = {
    type: 'subscription.cancelled',
    data: {
      payload_type: 'Subscription',
      subscription_id: 'sub_abc',
      status: 'cancelled',
      cancelled_at: '2026-10-01T00:00:00Z',
      next_billing_date: '2026-10-15T00:00:00Z',
      customer: { customer_id: 'cus_xyz', email: 'buyer@example.com' }
    }
  };
  const c = extractSubject(cancelled, 'evt_2');
  check('cancelled_at read with BRITISH spelling', c.canceledAt === '2026-10-01T00:00:00Z', String(c.canceledAt));

  const payment = {
    type: 'payment.succeeded',
    data: {
      payload_type: 'Payment',
      payment_id: 'pay_123',
      subscription_id: 'sub_abc',
      status: 'succeeded',
      customer: { customer_id: 'cus_xyz', email: 'buyer@example.com' }
    }
  };
  const p = extractSubject(payment, 'evt_3');
  check('payment id lands in transactionId', p.transactionId === 'pay_123', String(p.transactionId));
  check('payment still carries its subscription id', p.subscriptionId === 'sub_abc', String(p.subscriptionId));

  const empty = extractSubject({}, 'evt_4');
  check('an unrecognised event yields nulls, not a throw', empty.subscriptionId === null && empty.customerId === null);
}

console.log('\nEvent classification');
{
  check('subscription.active grants', GRANTING_EVENTS.has('subscription.active'));
  check('subscription.renewed grants', GRANTING_EVENTS.has('subscription.renewed'));
  check('subscription.cancelled revokes', REVOKING_EVENTS.has('subscription.cancelled'));
  check('refund.succeeded revokes', REVOKING_EVENTS.has('refund.succeeded'));
  check('granting and revoking sets do not overlap',
    [...GRANTING_EVENTS].every((e) => !REVOKING_EVENTS.has(e)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

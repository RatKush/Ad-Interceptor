// Unit tests for the PayPal event mapping.
//
// These run in plain node — no Worker, no D1, no network — because what they
// guard is field mapping, and every one of these mappings is a place where a
// wrong guess fails SILENTLY: the webhook returns 200, the ledger records the
// event as handled, and a customer quietly has no licence or a stale expiry.
//
// Signature verification is NOT tested here. PayPal verifies server-side
// (see the note in src/paypal.js), so testing it would mean testing PayPal.
// enrichFromApi is tested only for the paths that make no network call.
//
//   node test/paypal-events.mjs

import {
  extractSubject,
  enrichFromApi,
  apiBase,
  GRANTING_EVENTS,
  SUSPENDING_EVENTS,
  REVOKING_EVENTS,
  RESTORING_EVENTS,
  REFUND_EVENTS,
  isDispute,
  isAllowedReturnOrigin,
  createSubscription
} from '../src/paypal.js';

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

// ---- fixtures --------------------------------------------------------------
// Shaped after PayPal's documented payloads, trimmed to the fields read.

const SUBSCRIPTION_ACTIVATED = {
  id: 'WH-ACTIVATED-0001',
  event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
  resource: {
    id: 'I-SUBSCRIPTION123',
    plan_id: 'P-PLAN456',
    custom_id: 'ad-interceptor',
    status: 'ACTIVE',
    status_update_time: '2026-09-17T10:00:00Z',
    subscriber: { payer_id: 'PAYER789', email_address: 'buyer@example.com' },
    billing_info: { next_billing_time: '2027-09-17T10:00:00Z' }
  }
};

// The renewal event. Note what is NOT here: no subscriber, no billing_info.
const SALE_COMPLETED = {
  id: 'WH-SALE-0002',
  event_type: 'PAYMENT.SALE.COMPLETED',
  resource: {
    id: 'SALE-ABC123',                     // the SALE id, not the subscription
    billing_agreement_id: 'I-SUBSCRIPTION123',
    state: 'completed'
  }
};

console.log('\nField extraction');
{
  const s = extractSubject(SUBSCRIPTION_ACTIVATED);
  check('event id comes from the BODY, not a header', s.eventId === 'WH-ACTIVATED-0001', s.eventId);
  check('subscription id read from resource.id', s.subscriptionId === 'I-SUBSCRIPTION123', s.subscriptionId);
  check('a subscription event has no transaction id', s.transactionId === null, String(s.transactionId));
  check('payer id becomes the customer id', s.customerId === 'PAYER789', s.customerId);
  check('email read from subscriber.email_address', s.email === 'buyer@example.com', s.email);
  check('period end read from billing_info.next_billing_time',
    s.nextBilledAt === '2027-09-17T10:00:00Z', s.nextBilledAt);
  check('plan id captured as the product', s.productId === 'P-PLAN456', s.productId);
  check('custom_id captured for product scoping', s.custom === 'ad-interceptor', s.custom);
}

console.log('\nField extraction — the sale/subscription id trap');
{
  const s = extractSubject(SALE_COMPLETED);
  // THE bug this file exists for. resource.id on a sale is the SALE id; using
  // it as the subscription id matches no licence row, so the renewal is lost
  // and the customer's Pro lapses a year in while PayPal keeps charging.
  check('subscription id comes from billing_agreement_id, NOT resource.id',
    s.subscriptionId === 'I-SUBSCRIPTION123', s.subscriptionId);
  check('resource.id becomes the transaction id on a sale',
    s.transactionId === 'SALE-ABC123', s.transactionId);
  check('a sale carries no email (this is why enrichFromApi exists)',
    s.email === null, String(s.email));
  check('a sale carries no next billing time either',
    s.nextBilledAt === null, String(s.nextBilledAt));
}

console.log('\nField extraction — robustness');
{
  const s = extractSubject({ id: 'WH-X', event_type: 'SOMETHING.UNKNOWN', resource: {} });
  check('an unrecognised event yields nulls, not a throw', s.subscriptionId === null && s.eventId === 'WH-X');

  const empty = extractSubject({});
  check('an empty event does not throw', empty.eventId === null && empty.eventType === null);

  const noResource = extractSubject({ id: 'WH-Y', event_type: 'PAYMENT.SALE.COMPLETED' });
  check('a missing resource does not throw', noResource.subscriptionId === null);
}

console.log('\nEvent classification');
{
  check('BILLING.SUBSCRIPTION.ACTIVATED grants', GRANTING_EVENTS.has('BILLING.SUBSCRIPTION.ACTIVATED'));
  check('PAYMENT.SALE.COMPLETED grants (this is the renewal)', GRANTING_EVENTS.has('PAYMENT.SALE.COMPLETED'));
  // PayPal spells it with a hyphen. REACTIVATED matches nothing.
  check('RE-ACTIVATED is spelled with the hyphen PayPal uses',
    GRANTING_EVENTS.has('BILLING.SUBSCRIPTION.RE-ACTIVATED')
    && !GRANTING_EVENTS.has('BILLING.SUBSCRIPTION.REACTIVATED'));
  check('BILLING.SUBSCRIPTION.CANCELLED revokes', REVOKING_EVENTS.has('BILLING.SUBSCRIPTION.CANCELLED'));
  check('PAYMENT.SALE.REFUNDED revokes', REVOKING_EVENTS.has('PAYMENT.SALE.REFUNDED'));
  check('BILLING.SUBSCRIPTION.SUSPENDED suspends', SUSPENDING_EVENTS.has('BILLING.SUBSCRIPTION.SUSPENDED'));
  check('BILLING.SUBSCRIPTION.UPDATED restores', RESTORING_EVENTS.has('BILLING.SUBSCRIPTION.UPDATED'));

  // Refunds must be a SUBSET of revoking: index.js reaches the refund branch
  // only from inside the revoking branch, so a refund event missing from
  // REVOKING_EVENTS would never revoke anything at all.
  const refundsRevoke = [...REFUND_EVENTS].every((t) => REVOKING_EVENTS.has(t));
  check('every refund event is also a revoking event', refundsRevoke);

  const overlap = (a, b) => [...a].some((t) => b.has(t));
  check('granting and revoking sets do not overlap', !overlap(GRANTING_EVENTS, REVOKING_EVENTS));
  check('granting and suspending sets do not overlap', !overlap(GRANTING_EVENTS, SUSPENDING_EVENTS));
  check('restoring does not overlap granting', !overlap(RESTORING_EVENTS, GRANTING_EVENTS));

  check('disputes are namespaced CUSTOMER.DISPUTE, not DISPUTE',
    isDispute('CUSTOMER.DISPUTE.CREATED') && !isDispute('DISPUTE.CREATED'));
  check('a normal event is not a dispute', !isDispute('PAYMENT.SALE.COMPLETED'));
}

console.log('\nEnvironment selection');
{
  check('defaults to sandbox when PAYPAL_ENV is unset',
    apiBase({}).includes('sandbox'), apiBase({}));
  check('"live" selects the production host',
    apiBase({ PAYPAL_ENV: 'live' }) === 'https://api-m.paypal.com',
    apiBase({ PAYPAL_ENV: 'live' }));
  check('case does not matter', apiBase({ PAYPAL_ENV: 'LIVE' }) === 'https://api-m.paypal.com');
  // Anything unrecognised must NOT silently become live: a typo in the var
  // should cost sandbox traffic, never real charges against the wrong host.
  check('an unrecognised value falls back to sandbox, not live',
    apiBase({ PAYPAL_ENV: 'production' }).includes('sandbox'));
}

console.log('\nenrichFromApi — no-network paths');
{
  const noSub = await enrichFromApi({}, { subscriptionId: null, email: null, nextBilledAt: null });
  check('returns unchanged when there is no subscription id', noSub.subscriptionId === null);

  const complete = { subscriptionId: 'I-1', email: 'a@b.com', nextBilledAt: '2027-01-01T00:00:00Z' };
  const same = await enrichFromApi({}, complete);
  check('does not call out when the subject is already complete',
    same.email === 'a@b.com' && same.nextBilledAt === complete.nextBilledAt);

  // A lookup failure must degrade, not throw: the payment has already been
  // taken, and a 500 here makes PayPal retry an event we did act on.
  const globalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const degraded = await enrichFromApi(
      { PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y' },
      { subscriptionId: 'I-2', email: null, nextBilledAt: null }
    );
    check('a failed lookup returns the subject instead of throwing',
      degraded.subscriptionId === 'I-2' && degraded.email === null);
  } finally {
    globalThis.fetch = globalFetch;
  }
}

// ---------------------------------------------------------------------------
// Checkout: the return-origin allow-list
// ---------------------------------------------------------------------------
// The page supplies the origin it wants to come back to, so that a Pages
// preview deploy returns to itself rather than to production. Unvalidated,
// that makes /v1/checkout/paypal an open redirect wearing PayPal's branding:
// anyone could mint a genuine paypal.com checkout URL that lands the buyer
// wherever they chose. These are the cases that must not pass.
{
  console.log('\nCheckout — return origin allow-list');

  check('production origin is allowed',
    isAllowedReturnOrigin('https://ad-interceptor.pages.dev') === true);

  check('a Pages preview deploy is allowed',
    isAllowedReturnOrigin('https://abc123.ad-interceptor.pages.dev') === true);

  check('localhost over http is allowed, for local dev',
    isAllowedReturnOrigin('http://localhost:8788') === true);

  check('127.0.0.1 over http is allowed',
    isAllowedReturnOrigin('http://127.0.0.1:8788') === true);

  // The one that a bare endsWith() check would wrongly accept.
  check('a look-alike host is REJECTED',
    isAllowedReturnOrigin('https://evil-ad-interceptor.pages.dev') === false);

  check('an unrelated host is rejected',
    isAllowedReturnOrigin('https://evil.example') === false);

  check('a subdomain of an unrelated host is rejected',
    isAllowedReturnOrigin('https://ad-interceptor.pages.dev.evil.example') === false);

  check('http is rejected for a non-loopback host',
    isAllowedReturnOrigin('http://ad-interceptor.pages.dev') === false);

  check('a non-http scheme is rejected',
    isAllowedReturnOrigin('javascript:alert(1)') === false);

  check('garbage is rejected rather than throwing',
    isAllowedReturnOrigin('not a url') === false);

  check('an empty origin is rejected',
    isAllowedReturnOrigin('') === false);
}

// ---------------------------------------------------------------------------
// Checkout: createSubscription refuses before it reaches the network
// ---------------------------------------------------------------------------
{
  console.log('\nCheckout — createSubscription guards');

  const globalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('createSubscription should not have called out'); };
  try {
    let threw = null;
    try {
      await createSubscription(
        { PAYPAL_PLAN_ID: 'P-1', PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y' },
        'https://evil.example'
      );
    } catch (err) { threw = err; }
    check('a disallowed return origin is refused without calling PayPal',
      threw !== null && /allow-listed/.test(threw.message), threw?.message ?? 'did not throw');

    threw = null;
    try {
      await createSubscription(
        { PAYPAL_CLIENT_ID: 'x', PAYPAL_CLIENT_SECRET: 'y' },
        'https://ad-interceptor.pages.dev'
      );
    } catch (err) { threw = err; }
    check('a missing plan id is refused rather than sending plan_id undefined',
      threw !== null && /PAYPAL_PLAN_ID/.test(threw.message), threw?.message ?? 'did not throw');
  } finally {
    globalThis.fetch = globalFetch;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

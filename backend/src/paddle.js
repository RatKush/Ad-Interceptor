// Paddle Billing webhook verification.
//
// Paddle signs every notification with the secret from that notification
// destination's settings. The header looks like:
//
//   Paddle-Signature: ts=1671552777;h1=eb4d0dc8853be92b7f063b9f3ba5233e...
//
// and the signed payload is `${ts}:${rawRequestBody}` — the RAW body, byte for
// byte. Parsing the JSON and re-serialising it will change key order or
// whitespace and the signature will never match, so the caller must hand us
// the original text.

const MAX_SKEW_MS = 5 * 60 * 1000;

function parseSignatureHeader(header) {
  if (!header) return null;
  const parts = {};
  for (const segment of header.split(';')) {
    const idx = segment.indexOf('=');
    if (idx === -1) continue;
    parts[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim();
  }
  if (!parts.ts || !parts.h1) return null;
  return { ts: parts.ts, h1: parts.h1 };
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Verify a Paddle webhook.
 *
 * @param {string} rawBody   the request body exactly as received
 * @param {string} header    the Paddle-Signature header value
 * @param {string} secret    the notification destination's secret key
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyPaddleSignature(rawBody, header, secret) {
  if (!secret) return { ok: false, reason: 'no signing secret configured' };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed Paddle-Signature header' };

  // Replay window. Paddle timestamps are seconds.
  const tsMs = Number(parsed.ts) * 1000;
  if (!Number.isFinite(tsMs)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) {
    return { ok: false, reason: 'timestamp outside replay window' };
  }

  const expected = hexToBytes(parsed.h1);
  if (!expected) return { ok: false, reason: 'bad signature encoding' };

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // crypto.subtle.verify is constant-time, which is why this is preferred over
  // computing our own digest and comparing strings.
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    expected,
    new TextEncoder().encode(`${parsed.ts}:${rawBody}`)
  );

  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/**
 * Pull the fields we care about out of a Paddle event, flattening the two
 * shapes we can receive (subscription.* and transaction.*) into one.
 */
export function extractSubject(event) {
  const d = event?.data ?? {};
  const type = String(event?.event_type ?? '');
  const isSubscription = type.startsWith('subscription.');
  const isCustomer = type.startsWith('customer.');

  // Every Paddle event puts the entity it is ABOUT in data.id, and references
  // other entities by <name>_id. So the same logical id lives in a different
  // field depending on the event type, and reading the wrong one yields null
  // rather than an error:
  //
  //   subscription.*  -> data.id is the subscription; data.customer_id
  //   transaction.*   -> data.id is the transaction;  data.subscription_id, data.customer_id
  //   customer.*      -> data.id is the CUSTOMER;     no data.customer_id at all
  //
  // That last line cost a silent failure: customer.created returned 200 while
  // recording nothing, because customerId was read from data.customer_id.
  const subscriptionId = isSubscription ? d.id ?? null : d.subscription_id ?? null;
  const customerId = isCustomer ? d.id ?? null : d.customer_id ?? null;

  return {
    eventId: event?.event_id ?? null,
    eventType: event?.event_type ?? null,
    subscriptionId,
    transactionId: (isSubscription || isCustomer) ? null : d.id ?? null,
    customerId,
    // customer.created / customer.updated put the address at data.email;
    // subscription and transaction events nest it under customer{} when
    // present at all, which is rarely.
    email: d.email ?? d.customer?.email ?? d.billing_details?.email ?? null,
    status: d.status ?? null,
    // next_billed_at is when the current paid period runs out. For a cancelled
    // subscription Paddle sets scheduled_change / canceled_at and stops
    // advancing next_billed_at, so it doubles as the access-until date.
    nextBilledAt: d.next_billed_at ?? d.current_billing_period?.ends_at ?? null,
    canceledAt: d.canceled_at ?? null
  };
}

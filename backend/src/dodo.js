// Dodo Payments webhook verification.
//
// Dodo implements the Standard Webhooks spec, which is a different scheme from
// Paddle's in three ways that each cause a silent failure if ported carelessly:
//
//   1. The signed content is `${id}.${timestamp}.${rawBody}` — dot-separated,
//      with the webhook id included. Paddle signed `${ts}:${rawBody}`.
//   2. The secret is base64 behind a `whsec_` prefix and must be DECODED to
//      raw bytes before use as the HMAC key. Paddle's secret was used as UTF-8
//      text. Using the string here verifies nothing and rejects every event.
//   3. The signature header carries a space-separated LIST of `v1,<base64>`
//      entries, not a single value, so that secrets can be rotated.
//
// Three headers arrive with every delivery:
//   webhook-id         unique per event — this is the idempotency key
//   webhook-timestamp  unix seconds
//   webhook-signature  e.g. "v1,g0hM9SsE... v1,bm9ldHUjKY..."
//
// NOTE the event id lives in the HEADER, not the body. Paddle put event_id in
// the payload, so the dedup ledger read it from the parsed JSON. Reading
// `event.event_id` here yields undefined, every event looks new, and a retry
// re-mints a licence. extractSubject takes the id as an argument for exactly
// this reason — it cannot be forgotten silently.

const MAX_SKEW_MS = 5 * 60 * 1000;

/** Decode standard or URL-safe base64 to bytes. Returns null if malformed. */
function b64ToBytes(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  const normalised = b64.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(normalised);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * The signing key. Dodo shows secrets as `whsec_<base64>`; the bytes behind
 * that prefix are the key. A secret WITHOUT the prefix is treated as raw
 * base64 too, because the dashboard has shown it both ways.
 */
function secretToKeyBytes(secret) {
  const trimmed = String(secret ?? '').trim();
  if (!trimmed) return null;
  return b64ToBytes(trimmed.startsWith('whsec_') ? trimmed.slice(6) : trimmed);
}

/** Pull the base64 signatures out of a `v1,<sig> v1,<sig>` header. */
function parseSignatureHeader(header) {
  if (!header) return [];
  return String(header)
    .split(' ')
    .map((part) => {
      const comma = part.indexOf(',');
      if (comma === -1) return null;
      const version = part.slice(0, comma).trim();
      const sig = part.slice(comma + 1).trim();
      // Only v1 (HMAC-SHA256) is defined today. Ignoring unknown versions
      // rather than failing lets Dodo add v2 without breaking this endpoint.
      return version === 'v1' && sig ? sig : null;
    })
    .filter(Boolean);
}

/**
 * Verify a Dodo webhook against ONE secret.
 *
 * @param {string} rawBody  the request body exactly as received, byte for byte
 * @param {{id: string, timestamp: string, signature: string}} headers
 * @param {string} secret   the endpoint's signing secret (`whsec_...`)
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function verifyDodoSignature(rawBody, headers, secret) {
  const keyBytes = secretToKeyBytes(secret);
  if (!keyBytes) return { ok: false, reason: 'no signing secret configured' };

  const { id, timestamp, signature } = headers ?? {};
  if (!id) return { ok: false, reason: 'missing webhook-id header' };
  if (!timestamp) return { ok: false, reason: 'missing webhook-timestamp header' };

  const tsMs = Number(timestamp) * 1000;
  if (!Number.isFinite(tsMs)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) {
    return { ok: false, reason: 'timestamp outside replay window' };
  }

  const candidates = parseSignatureHeader(signature);
  if (!candidates.length) return { ok: false, reason: 'malformed webhook-signature header' };

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signed = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);

  for (const candidate of candidates) {
    const bytes = b64ToBytes(candidate);
    if (!bytes) continue;
    // crypto.subtle.verify is constant-time, which is why this is preferred
    // over computing a digest and comparing strings.
    if (await crypto.subtle.verify('HMAC', key, bytes, signed)) return { ok: true };
  }

  return { ok: false, reason: 'signature mismatch' };
}

/**
 * Verify against ANY of several configured secrets.
 *
 * Kept from the Paddle module for the same two reasons: test and live
 * endpoints have different secrets, and rotation needs a window where both are
 * accepted. Accepting several is not a weakening — each is a legitimate secret
 * for an endpoint we own, and a forgery still has to produce a valid HMAC.
 *
 * Returns which slot matched, by NAME, never the value.
 */
export async function verifyAgainstAnySecret(rawBody, headers, secrets) {
  const candidates = Object.entries(secrets).filter(
    ([, v]) => typeof v === 'string' && v.trim()
  );
  if (!candidates.length) return { ok: false, reason: 'no signing secret configured' };

  let lastReason = 'signature mismatch';
  for (const [name, secret] of candidates) {
    const r = await verifyDodoSignature(rawBody, headers, secret);
    if (r.ok) return { ok: true, matched: name };
    // A malformed header or stale timestamp is not secret-specific, so stop
    // rather than repeating the same rejection against every slot.
    if (r.reason !== 'signature mismatch') return r;
    lastReason = r.reason;
  }
  return {
    ok: false,
    reason: `${lastReason} (tried ${candidates.length} secret${candidates.length > 1 ? 's' : ''})`
  };
}

/** Read the three Standard Webhooks headers off a Request. */
export function readWebhookHeaders(request) {
  return {
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature')
  };
}

/**
 * Flatten a Dodo event into the shape the licence logic already speaks.
 *
 * Dodo nests differently from Paddle, and two of these cost a silent null if
 * assumed:
 *
 *   subscription id : data.subscription_id  (NOT data.id)
 *   customer id     : data.customer.customer_id  — nested, not data.customer_id
 *   email           : data.customer.email  — ALWAYS present, on every event
 *   period end      : data.next_billing_date  (Paddle: next_billed_at)
 *   cancelled       : data.cancelled_at  — BRITISH spelling, two Ls
 *
 * That last one is the trap. Paddle used `canceled_at`; reading that key here
 * returns undefined forever and a cancelled subscription never records a
 * cancellation date.
 *
 * The always-present customer email is a real simplification over Paddle,
 * where the address arrived only on customer.* events and had to be stitched
 * in from a separate table.
 *
 * @param {object} event    the parsed webhook body
 * @param {string} eventId  the webhook-id HEADER value — not present in body
 */
export function extractSubject(event, eventId) {
  const d = event?.data ?? {};
  const type = String(event?.type ?? '');
  const customer = d.customer ?? {};

  // payload_type tells us which entity `data` is, without string-matching the
  // event name. Dodo sets it to 'Subscription', 'Payment', 'Refund', etc.
  const payloadType = String(d.payload_type ?? '');
  const isPayment = payloadType === 'Payment' || type.startsWith('payment.');

  return {
    eventId: eventId ?? null,
    eventType: event?.type ?? null,
    // A payment carries subscription_id when it belongs to one; a subscription
    // event carries its own id. Both land in the same field.
    subscriptionId: d.subscription_id ?? null,
    transactionId: isPayment ? d.payment_id ?? null : null,
    customerId: customer.customer_id ?? null,
    email: customer.email ?? null,
    status: d.status ?? null,
    // When the current paid period runs out — the access-until date. Dodo stops
    // advancing this once a subscription is cancelled, so it doubles as the
    // expiry for someone who cancelled but already paid for this period.
    nextBilledAt: d.next_billing_date ?? null,
    canceledAt: d.cancelled_at ?? null,
    productId: d.product_id ?? null,
    metadata: d.metadata ?? {}
  };
}

/**
 * Which events mean "this person has paid and should hold a working licence".
 *
 * `subscription.active` fires on first activation, `subscription.renewed` on
 * each successful renewal. payment.succeeded also fires for the same money, so
 * acting on all three would try to mint three times — the dedup on the
 * subscription id is what makes that safe, exactly as it was with Paddle.
 */
export const GRANTING_EVENTS = new Set([
  'subscription.active',
  'subscription.renewed',
  'payment.succeeded'
]);

/** Events that suspend access but may still recover. */
export const SUSPENDING_EVENTS = new Set([
  'subscription.past_due',
  'subscription.on_hold',
  'subscription.paused',
  'subscription.failed'
]);

/** Events that end access for good. */
export const REVOKING_EVENTS = new Set([
  'subscription.cancelled',
  'subscription.expired',
  'refund.succeeded'
]);

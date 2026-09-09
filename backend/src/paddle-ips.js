// Restrict webhook deliveries to Paddle's own notification IPs.
//
// Defence in depth, NOT the primary control. HMAC signature verification is
// what actually proves a delivery came from Paddle; an IP check adds a cheap
// outer layer that rejects noise before any crypto runs.
//
// The list is FETCHED, never hardcoded. Paddle publishes it and it can change:
//   live    -> https://api.paddle.com/ips
//   sandbox -> https://sandbox-api.paddle.com/ips
// The two sets are entirely disjoint (6 addresses each, no overlap), so both
// are fetched and unioned. Allowlisting only live would silently 403 every
// sandbox delivery, break fulfilment, and look like a signature problem.

const CACHE_KEY = 'paddle-ips:v1';
const CACHE_TTL_SECONDS = 12 * 60 * 60;
const SOURCES = [
  'https://api.paddle.com/ips',
  'https://sandbox-api.paddle.com/ips'
];

/** IPv4 dotted-quad to a 32-bit integer, or null if it is not IPv4. */
function ipToInt(ip) {
  const parts = String(ip).trim().split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/**
 * Does an IP fall inside a CIDR block?
 *
 * Handles any prefix length rather than assuming /32. Paddle publishes /32s
 * today, but the endpoint is the source of truth precisely because that can
 * change, and a matcher that only understands /32 would quietly stop matching.
 */
function inCidr(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/');
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const a = ipToInt(ip);
  const b = ipToInt(base);
  if (a === null || b === null) return false;

  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

async function fetchList(url) {
  const res = await fetch(url, {
    // Cloudflare's bot protection rejects bare user-agents, and so do plenty
    // of APIs. Be explicit rather than debug a 403 that looks like auth.
    headers: { 'User-Agent': 'ad-interceptor-webhook/1.0', Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const body = await res.json();
  const cidrs = body?.data?.ipv4_cidrs;
  if (!Array.isArray(cidrs) || !cidrs.length) throw new Error(`${url} -> no ipv4_cidrs`);
  return cidrs;
}

/** The union of both environments' lists, cached in KV. */
async function getAllowedCidrs(env) {
  if (env.FILTERS) {
    const cached = await env.FILTERS.get(CACHE_KEY, 'json');
    if (cached?.cidrs?.length) return { cidrs: cached.cidrs, source: 'cache' };
  }

  const results = await Promise.allSettled(SOURCES.map(fetchList));
  const cidrs = [...new Set(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))];

  // A partial result is still worth using and caching: if one environment's
  // endpoint is down, the other environment's deliveries should keep working.
  if (!cidrs.length) return { cidrs: [], source: 'unavailable' };

  if (env.FILTERS) {
    await env.FILTERS.put(
      CACHE_KEY,
      JSON.stringify({ cidrs, fetchedAt: Date.now() }),
      { expirationTtl: CACHE_TTL_SECONDS }
    );
  }
  return { cidrs, source: 'fetched' };
}

/**
 * Check a webhook's source address.
 *
 * FAILS OPEN when the list cannot be obtained. That is deliberate: the
 * signature check still has to pass, so an unknown-IP delivery is not
 * unverified — whereas rejecting everything during a transient outage of
 * Paddle's own IP endpoint would stop fulfilment for paying customers and
 * present as a signature error. The weaker outcome is logged, not silent.
 */
export async function checkPaddleSourceIp(env, request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return { allowed: true, reason: 'no client ip available' };

  const { cidrs, source } = await getAllowedCidrs(env);
  if (!cidrs.length) return { allowed: true, reason: 'ip list unavailable — falling back to signature only' };

  const allowed = cidrs.some((c) => inCidr(ip, c));
  return {
    allowed,
    reason: allowed ? `matched Paddle range (${source})` : `not a Paddle notification IP (${cidrs.length} ranges, ${source})`,
    ip
  };
}

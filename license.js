// license.js — Pro entitlement.
//
// The backend is in backend/ (a Cloudflare Worker). Its hostname comes from
// config.js's API_BASE — set that once, after the first deploy prints the URL.
// A Pro build with API_BASE unset fails scripts/check-pro-config.mjs rather
// than shipping endpoints that answer nothing.
//
// WHAT THIS CAN AND CANNOT ENFORCE
// Everything in an extension package is on the user's disk and editable, so a
// client-side flag is not a security boundary — a determined user can flip
// `isPro()`. That is true of every extension and is not worth fighting; the
// goal here is a clean path for honest customers, not DRM.
//
// The one thing that IS enforceable is data the package doesn't contain:
// PRO_FILTERS_API returns freshly-built filter rules and the request carries
// the licence key, so the server decides. Code-based Pro features (YouTube ad
// removal, anti-adblock scriptlets) ship to everyone and are only soft-gated —
// MV3 bans remotely-hosted code, so there is no alternative.

import { API_BASE } from './config.js';

const LICENSE_API = `${API_BASE}/v1/license/validate`;
const PRO_FILTERS_API = `${API_BASE}/v1/filters/latest`;

// Revalidate at most once a day — enough to notice a cancellation without
// making the extension depend on the server being up.
const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// How long Pro keeps working when the server can't be reached. Someone who
// paid should not lose the product because they were on a plane or because our
// backend had an outage. After this, entitlement fails closed.
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const EMPTY = { key: null, plan: 'free', expiresAt: null, lastCheck: 0, lastGoodCheck: 0 };

/**
 * A stable per-install identifier, created on first use.
 *
 * Activation limits are unenforceable without this: a key with no per-install
 * identity validates from unlimited machines and the limit is decorative. It
 * is a random UUID with nothing derived from the user or the device, it lives
 * in storage.local so it does NOT follow the Chrome profile across machines
 * (which is the whole point — storage.sync would give every machine the same
 * id and undercount), and it is sent only alongside a licence key. Free users
 * never generate one, because none of this code runs in a free build.
 */
async function installId() {
  const { installId: existing } = await chrome.storage.local.get('installId');
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ installId: fresh });
  return fresh;
}

// Same canonical form backend/src/keys.js normalizeKey() produces, so the key
// stored (and sent as the Bearer token every day) is "AI3-XXXXX-…" however it
// was pasted. Anything that doesn't fit the format is passed through trimmed
// and left for the server to judge.
function canonicalKey(input) {
  const raw = String(input || '').trim();
  const cleaned = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!cleaned.startsWith('AI3') || cleaned.length !== 23) return raw;
  const body = cleaned.slice(3);
  return `AI3-${body.match(/.{5}/g).join('-')}`;
}

async function readLicense() {
  const { license } = await chrome.storage.local.get('license');
  return { ...EMPTY, ...(license || {}) };
}

async function writeLicense(patch) {
  const next = { ...(await readLicense()), ...patch };
  await chrome.storage.local.set({ license: next });
  return next;
}

/**
 * Is Pro currently active?
 *
 * Order matters: an explicit expiry in the past beats a recent successful
 * check, and a stale-but-within-grace record beats no answer at all.
 */
export async function isPro() {
  const license = await readLicense();
  if (!license.key || license.plan !== 'pro') return false;

  const now = Date.now();
  if (license.expiresAt && now > license.expiresAt) return false;

  // Server unreachable for longer than the grace window — stop honouring it.
  if (license.lastGoodCheck && now - license.lastGoodCheck > OFFLINE_GRACE_MS) return false;

  return true;
}

/**
 * Validate a key against the backend and persist the result.
 * Returns { ok, plan, error } — `ok: false` with an `error` is a *failed
 * check*, which is distinct from a *negative answer* (ok: true, plan: 'free').
 */
export async function validateLicense(key) {
  const trimmed = canonicalKey(key);
  if (!trimmed) return { ok: false, error: 'Enter a licence key.' };

  try {
    const res = await fetch(LICENSE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: trimmed,
        version: chrome.runtime.getManifest().version,
        installId: await installId()
      })
    });

    if (!res.ok) return { ok: false, error: `Server returned ${res.status}.` };

    // Expected shape:
    //   { valid: boolean, plan: 'pro'|'free', expiresAt: epoch_ms|null, reason?: string }
    const data = await res.json();
    const now = Date.now();

    if (!data.valid) {
      await writeLicense({ ...EMPTY, lastCheck: now });
      // The server's reason is far more useful than "not valid" — "already in
      // use on 3 devices" and "expired" need different actions from the user.
      return { ok: true, plan: 'free', error: data.reason || 'That key is not valid.' };
    }

    await writeLicense({
      key: trimmed,
      plan: data.plan === 'pro' ? 'pro' : 'free',
      expiresAt: data.expiresAt ?? null,
      lastCheck: now,
      lastGoodCheck: now
    });
    return { ok: true, plan: data.plan };
  } catch (e) {
    // Network failure. Record the attempt but do NOT clear an existing
    // entitlement — that's what the grace window is for.
    await writeLicense({ lastCheck: Date.now() });
    return { ok: false, error: 'Could not reach the licence server.' };
  }
}

/** Re-check in the background if the stored result has gone stale. */
export async function revalidateIfStale() {
  const license = await readLicense();
  if (!license.key) return;
  if (Date.now() - license.lastCheck < RECHECK_INTERVAL_MS) return;
  await validateLicense(license.key);
}

export async function clearLicense() {
  await chrome.storage.local.set({ license: { ...EMPTY } });
}

/** Public view of entitlement state, for the popup. */
export async function licenseStatus() {
  const license = await readLicense();
  return {
    pro: await isPro(),
    plan: license.plan,
    hasKey: !!license.key,
    expiresAt: license.expiresAt
  };
}

/**
 * Fetch a freshly-built filter set for Pro users.
 *
 * This is the *hard*-gated benefit: the rules are not in the package, the
 * request is authenticated with the licence key, and the server decides
 * whether to answer. It returns a replacement for the bundled dynamic rules
 * (same ID range, same budget) so Pro users track filter-list changes daily
 * instead of waiting for a store release.
 *
 * Returns an array of DNR rules, or null if unavailable — callers must keep
 * the bundled rules on null rather than ending up with no rules at all.
 */
export async function fetchProFilters() {
  const license = await readLicense();
  if (!(await isPro())) return null;

  try {
    const res = await fetch(PRO_FILTERS_API, {
      headers: {
        Authorization: `Bearer ${license.key}`,
        'X-Install-Id': await installId()
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.rules) && data.rules.length ? data.rules : null;
  } catch (e) {
    return null;
  }
}

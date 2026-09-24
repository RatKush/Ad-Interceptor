#!/usr/bin/env node
/**
 * Refuse to build a Pro package that points at nothing.
 *
 * The free build has scripts/audit-package.mjs asserting it makes no network
 * requests. The Pro build needs the mirror-image check: it DOES make network
 * requests, and they have to go somewhere real. v3.0's license.js shipped
 * `api.example.com` placeholders for weeks purely because nothing checked.
 *
 * Run automatically by package.sh when PRO_ENABLED is true.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRO_ENABLED, API_BASE } from '../config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// ---- Tier / prefix agreement (checked in BOTH build modes) -----------------
// background.js's TIERS table decides which ruleset prefixes are Pro-gated;
// package.sh's PRO_PREFIXES decides which ones are stripped from a free
// package. If those two disagree, the free build declares a ruleset whose file
// it does not contain — and Chrome refuses to load the extension at all.
//
// That failure only appears in the FREE build, which is exactly the mode where
// the rest of this script exits early, so this check runs before that.
{
  const bg = readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const table = bg.match(/const TIERS = \[([\s\S]*?)\n\];/);
  if (!table) {
    problems.push('Could not find the TIERS table in background.js — the prefix check cannot run.');
  } else {
    // A tier is Pro-gated when its gate reads st.pro.
    const gated = [...table[1].matchAll(/\{\s*prefix:\s*'([^']+)'\s*,\s*gate:\s*([^\n]*)/g)]
      .filter(([, , gate]) => gate.includes('st.pro'))
      .map(([, prefix]) => `${prefix}-`)
      .sort();

    const pkg = readFileSync(path.join(ROOT, 'scripts/package.sh'), 'utf8');
    const declared = pkg.match(/PRO_PREFIXES = \(([^)]*)\)/);
    const stripped = declared
      ? [...declared[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
      : [];

    if (!declared) {
      problems.push('package.sh has no PRO_PREFIXES tuple — free builds would ship Pro rulesets.');
    } else if (gated.join(',') !== stripped.join(',')) {
      problems.push(
        `TIERS and package.sh disagree on Pro rulesets.\n` +
        `      background.js gates: ${gated.join(', ') || '(none)'}\n` +
        `      package.sh strips:   ${stripped.join(', ') || '(none)'}`
      );
    }
  }
}

// ---- Support address agreement (checked in BOTH build modes) --------------
// The popup's "Priority support" link and the site's seller record must name
// the same inbox. If they drift, a Pro user mails an address that is not being
// watched and the feature they paid for silently does not exist — which is
// worse than not offering it.
{
  const popup = readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const seller = JSON.parse(readFileSync(path.join(ROOT, 'store-listing/web/seller.json'), 'utf8'));

  const linked = popup.match(/href="mailto:([^"?]+)/);
  if (!linked) {
    problems.push('popup.html has no mailto: support link — the Pro "Priority support" promise has nothing behind it.');
  } else if (linked[1] !== seller.contactEmail) {
    problems.push(
      `Support address drift.\n` +
      `      popup.html:  ${linked[1]}\n` +
      `      seller.json: ${seller.contactEmail}`
    );
  }
}

// ---- Price agreement (checked in BOTH build modes) -------------------------
// The popup's "Get Pro" button quotes the price and device limit. If the site
// changes them and the popup does not, the button promises a price the
// checkout will not charge.
{
  const popup = readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const seller = JSON.parse(readFileSync(path.join(ROOT, 'store-listing/web/seller.json'), 'utf8'));
  const btn = popup.match(/id="buyProBtn"[^>]*>([^<]*)</);
  const sub = popup.match(/class="pro-buy-sub">([^<]*)</);
  if (!btn || !btn[1].includes(`$${seller.priceUSD}/year`)) {
    problems.push(`popup.html "Get Pro" button does not quote $${seller.priceUSD}/year (seller.json priceUSD).`);
  }
  if (!sub || !sub[1].toLowerCase().includes(`up to ${seller.deviceLimit} devices`)) {
    problems.push(`popup.html Get Pro line does not say "up to ${seller.deviceLimit} devices" (seller.json deviceLimit).`);
  }
  const renew = popup.match(/id="renewProBtn"[^>]*>([^<]*)</);
  if (!renew || !renew[1].includes(`$${seller.priceUSD}`)) {
    problems.push(`popup.html Renew button does not quote $${seller.priceUSD} (seller.json priceUSD).`);
  }
}

if (!PRO_ENABLED) {
  if (problems.length) {
    console.error('Pre-build checks FAILED:\n');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log('PRO_ENABLED=false — tiers and support address agree; the rest of the Pro config check is not applicable.');
  process.exit(0);
}

if (!API_BASE || !API_BASE.trim()) {
  problems.push('API_BASE is empty. Deploy backend/ and set it in config.js.');
} else {
  let url;
  try {
    url = new URL(API_BASE);
  } catch {
    problems.push(`API_BASE is not a valid URL: ${API_BASE}`);
  }

  if (url) {
    if (url.protocol !== 'https:') {
      problems.push(`API_BASE must be https (got ${url.protocol}). A licence key is a credential.`);
    }
    if (/example\.(com|org|net)$/.test(url.hostname) || url.hostname === 'localhost') {
      problems.push(`API_BASE still points at a placeholder or local host: ${url.hostname}`);
    }
    if (API_BASE.endsWith('/')) {
      problems.push('API_BASE must not end in a slash — license.js appends /v1/... to it.');
    }
  }
}

// Shipping Pro means the licence key leaves the device, so the Chrome Web
// Store data disclosure has to change in the SAME release. Nothing can verify
// a dashboard setting from here, so this is a loud reminder rather than a test.
console.log('');
console.log('  ⚠  Pro build. Before submitting, confirm in the dashboard:');
console.log('     • Privacy practices → add "Authentication information"');
console.log('       (the licence key is a credential sent to a server)');
console.log('     • Restore the Pro block in store-listing/description.md');
console.log('');

if (problems.length) {
  console.error('Pro config check FAILED:\n');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`Pro config OK — API_BASE = ${API_BASE}`);

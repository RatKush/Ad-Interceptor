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
import { PRO_ENABLED, API_BASE } from '../config.js';

const problems = [];

if (!PRO_ENABLED) {
  console.log('PRO_ENABLED=false — Pro config check not applicable.');
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

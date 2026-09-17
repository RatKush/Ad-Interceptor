#!/usr/bin/env node
/**
 * Audit a staged FREE build: assert it contains no outbound network code.
 *
 * Usage: node scripts/audit-package.mjs <stage-dir>
 *
 * The free build's Chrome Web Store data disclosure says "collects nothing".
 * This checks that against the actual files about to be zipped, so the claim
 * cannot quietly stop being true — a stray fetch() to an external host fails
 * the build instead of shipping and contradicting the disclosure.
 *
 * Comments are stripped before checking. A spec link in a comment is not
 * network code, and failing on those just trains people to ignore the audit.
 *
 * rules/ and filters/ are skipped: they are filter DATA, and are full of
 * ad-network URLs by definition. Only executable code is audited.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const stage = process.argv[2];
if (!stage) {
  console.error('usage: audit-package.mjs <stage-dir>');
  process.exit(2);
}

// The negative lookbehind on `:` is load-bearing. Without it, the trailing-
// comment rule matches the `//` inside `https://` and deletes the rest of the
// line — which silently disabled the external-URL check below for every URL
// it was written to catch, leaving only the fetch/XHR/beacon rules doing any
// work. A URL in a real comment is still stripped, because that `//` is not
// preceded by a colon.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^\s*\/\/.*$/gm, '')       // whole-line comments
    .replace(/(?<!:)\/\/.*$/gm, '');     // trailing comments

// URLs that are NAVIGATION TARGETS, not request targets.
//
// The claim this audit defends is "the free build collects nothing and makes
// no network requests". A URL the user is sent to by clicking a button is a
// different thing from a URL the extension calls: nothing is transmitted, no
// response is read, and it only happens on an explicit click. The Chrome Web
// Store review page is the one such link we ship (see initReviewPrompt in
// popup.js).
//
// This list exists so the exception is explicit and reviewable. Anything added
// here must be (a) opened with chrome.tabs.create, never fetched, and (b)
// user-initiated. It is NOT a place to park an endpoint to make the audit go
// quiet — that is precisely the failure this script was written to catch.
const ALLOWED_NAVIGATION = [
  'https://chromewebstore.google.com/',
  // Our own site: the Pro teaser's "See what Pro adds" button and, in future,
  // help/privacy links. Same test as above — chrome.tabs.create on a click,
  // never fetched, nothing transmitted. Trailing slash is load-bearing: it is
  // what makes ad-interceptor.pages.dev.evil.net fail.
  'https://ad-interceptor.pages.dev/'
];

const isAllowedNavigation = (url) => ALLOWED_NAVIGATION.some((a) => url.startsWith(a));

const problems = [];

for (const name of readdirSync(stage)) {
  if (!/\.(js|html)$/.test(name)) continue;
  const code = stripComments(readFileSync(path.join(stage, name), 'utf8'));

  for (const m of code.match(/https?:\/\/[^\s'"`)]+/g) ?? []) {
    if (isAllowedNavigation(m)) continue;
    problems.push(`${name}: external URL ${m}`);
  }
  for (const api of ['XMLHttpRequest', 'sendBeacon', 'WebSocket(', 'EventSource(']) {
    if (code.includes(api)) problems.push(`${name}: uses ${api}`);
  }
  // fetch() is legitimate only for resources inside the package.
  for (const m of code.matchAll(/fetch\(([^)]*)/g)) {
    if (!m[1].includes('chrome.runtime.getURL')) {
      problems.push(`${name}: fetch() to non-packaged target: ${m[1].trim().slice(0, 60)}`);
    }
  }
}

for (const f of ['scriptlets.js', 'youtube.js', 'picker.js']) {
  if (existsSync(path.join(stage, f))) problems.push(`${f} present in a free build`);
}

// Pro filter DATA must not ship in a free build either. It is not executable,
// so the URL scan above skips it — but a free package carrying the cookie and
// distraction rulesets would be giving away the thing Pro is sold on, and a
// manifest that declares them while package.sh strips the entries is a
// mismatch worth catching here rather than in a store review.
for (const dir of ['rules', 'filters']) {
  const d = path.join(stage, dir);
  if (!existsSync(d)) continue;
  for (const name of readdirSync(d)) {
    if (/^(pro|cookies|annoy)-/.test(name)) problems.push(`${dir}/${name} present in a free build`);
  }
}

const lic = path.join(stage, 'license.js');
if (existsSync(lic) && !readFileSync(lic, 'utf8').includes('license-stub.js')) {
  problems.push('license.js is the real module, not the stub');
}

if (problems.length) {
  console.error('AUDIT FAILED:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log('Audit passed: stub licence module, no outbound network code.');
console.log(`  (allowed navigation targets: ${ALLOWED_NAVIGATION.join(', ')})`);

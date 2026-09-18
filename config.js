// config.js — build-time feature flags.
//
// PRO_ENABLED is the single switch for the paid tier. It exists so the free
// release can ship as a package that provably contains no licence code and
// makes no network requests at all — which is what lets the Chrome Web Store
// data disclosure honestly say "collects nothing".
//
// When false:
//   - license.js is never imported (dynamic import, never reached)
//   - scriptlets.js / youtube.js are never registered
//   - pro-* rulesets are never enabled
//   - the popup hides the Pro card entirely
//   - scripts/package.sh omits all of the above from the .zip and strips the
//     pro-* entries out of the packaged manifest
//
// Flipping this to true is the whole "turn Pro on" change. The placeholder
// problem it used to warn about is gone — API_BASE below is a real deployed
// Worker and scripts/check-pro-config.mjs refuses to package a Pro build
// otherwise — but one obligation remains and is easy to forget:
//
//   SHIPPING THIS MEANS THE CHROME WEB STORE DATA DISCLOSURE MUST DECLARE
//   "Authentication information", IN THE SAME RELEASE. A licence key is a
//   credential sent to a server. See store-listing/permission-justifications.md.
//
// True since 2026-09-18 for v3.3. Note this is NOT the switch that starts
// selling: that is salesEnabled in store-listing/web/seller.json, which stays
// false until v3.3 is PUBLISHED in the store, not merely submitted.
export const PRO_ENABLED = true;

// Base URL of the licence backend (backend/, a Cloudflare Worker).
//
// Deliberately left unset. The account has no workers.dev subdomain yet, so
// the real hostname is not knowable until the first `wrangler deploy` prints
// it. Set it then — this is the ONLY place it appears; license.js derives both
// of its endpoints from it.
//
// scripts/check-pro-config.mjs fails the build if PRO_ENABLED is true while
// this is still unset, which is what stops a repeat of the api.example.com
// situation: a Pro build with placeholder endpoints cannot be packaged.
export const API_BASE = 'https://ad-interceptor-api.ad-interceptor-api.workers.dev';

// Whether the popup shows the Pro teaser — the card that tells free users Pro
// exists and links to the website.
//
// Separate from PRO_ENABLED on purpose. PRO_ENABLED turns on licence code and
// the activation form; this only advertises. That split lets awareness ship
// before Pro is buyable, and it means turning the advertising off (say, while
// the checkout is down) does not touch anyone's entitlement.
//
// The teaser links to the site's LANDING page, never straight to checkout, so
// it cannot drop someone into a sandbox payment form.
export const PRO_TEASER = true;

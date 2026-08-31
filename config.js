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
// Flipping this to true is the whole "turn Pro on" change, but it is not
// sufficient on its own: license.js still points at api.example.com
// placeholders, and shipping it means the data disclosure must then declare
// "Authentication information" (see store-listing/permission-justifications.md).
export const PRO_ENABLED = false;

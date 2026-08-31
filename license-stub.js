// license-stub.js — the free build's stand-in for license.js.
//
// WHY THIS FILE EXISTS
// background.js must import the licence module STATICALLY: dynamic import() is
// disallowed inside a service worker by the HTML spec
// (https://github.com/w3c/ServiceWorker/issues/1356), so the module is linked
// at load time and cannot simply be omitted from the package.
//
// scripts/package.sh therefore ships THIS file as license.js in free builds.
// It exposes the same API and contains no URLs and no fetch(), so the Chrome
// Web Store data disclosure "collects nothing" is verifiable from the package
// itself rather than resting on a runtime flag.
//
// Keep the exported signatures in step with license.js, or a Pro build will
// link against an API this stub no longer matches.

export async function isPro() {
  return false;
}

export async function licenseStatus() {
  return { pro: false, plan: 'free', hasKey: false, expiresAt: null };
}

export async function validateLicense() {
  return { ok: false, error: 'Pro is not available in this build.' };
}

export async function clearLicense() {}

export async function revalidateIfStale() {}

export async function fetchProFilters() {
  return null;
}

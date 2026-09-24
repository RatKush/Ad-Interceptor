// blocked.js — the page a blocked main-frame navigation is redirected to
// (see scripts/popup-redirect.mjs).
//
// Most of these are pop-ups and pop-unders: a tab the page opened on its own,
// with nothing else in its history. Those close themselves, which is what a
// "pop-up blocker" is expected to do. A tab the user navigated in themselves
// (it has history) stays open and explains itself instead of showing a blank
// page, so a deliberate click is never silently swallowed.

const canGoBack = history.length > 1;

document.getElementById('back').hidden = !canGoBack;
document.getElementById('back').addEventListener('click', () => history.back());
document.getElementById('close').addEventListener('click', () => window.close());

if (!canGoBack) {
  // Brief delay so the close reads as the extension acting, not a crash.
  setTimeout(() => window.close(), 400);
} else {
  document.getElementById('why').textContent =
    'Ad Interceptor blocked this page because it is on an ad or tracker list. ' +
    'If you need it, pause Ad Interceptor on the site you came from.';
}

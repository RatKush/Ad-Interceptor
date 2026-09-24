// welcome.js — the Pro build says what Pro turned on instead of what it lacks.
chrome.runtime.sendMessage({ type: 'license:status' }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  // Offer the pricing page only where a bought key can be activated: never
  // in a free build (available === false), and not once Pro is on.
  document.getElementById('proLink').hidden = res.pro || res.available === false;
  if (res.pro) {
    document.getElementById('limits').textContent =
      'Pro is active: video-player ads, "disable your ad blocker" walls, cookie banners and distractions are handled too.';
  }
});

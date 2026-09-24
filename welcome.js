// welcome.js — the Pro build says what Pro turned on instead of what it lacks.
chrome.runtime.sendMessage({ type: 'license:status' }, (res) => {
  if (chrome.runtime.lastError || !res) return;
  if (res.pro) {
    document.getElementById('limits').textContent =
      'Pro is active: video-player ads, "disable your ad blocker" walls, cookie banners and distractions are handled too.';
  }
});

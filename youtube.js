// youtube.js — YouTube ad removal (MAIN world, document_start).
//
// WHY THIS CAN'T BE A NETWORK RULE
// YouTube streams ad video from the same googlevideo.com hosts as the actual
// video, over the same URL shapes. There is nothing for declarativeNetRequest
// to match on that wouldn't also break playback. So instead of blocking the
// ad's bytes, we remove the ad from the *instruction set* the player receives:
// YouTube's player response JSON lists ads in known fields, and a player that
// never sees them never requests them.
//
// Three interception points, because the player response arrives by three
// different routes depending on how the page was entered:
//   1. window.ytInitialPlayerResponse  — cold page load (inline in the HTML)
//   2. Response.prototype.json         — SPA navigation (fetch)
//   3. JSON.parse                      — older/fallback paths
// Plus a DOM-level fallback that skips anything that still slips through.

(() => {
  'use strict';

  // Fields on the player response that describe advertising. Removing them is
  // preferred over emptying them: some player versions treat an empty array as
  // "ads pending" and stall, whereas a missing key reads as "no ads".
  const AD_KEYS = [
    'adPlacements',
    'adSlots',
    'playerAds',
    'adBreakHeartbeatParams',
    'adParams',
    'importantForAds'
  ];

  /** Strip ad descriptors from a player-response-shaped object, in place. */
  function sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of AD_KEYS) {
      if (key in obj) delete obj[key];
    }
    // Nested under playerResponse on some SPA navigation payloads.
    if (obj.playerResponse) sanitize(obj.playerResponse);
    if (Array.isArray(obj)) obj.forEach(sanitize);
    return obj;
  }

  /** Does this look like a player response worth sanitizing? */
  function isPlayerResponse(obj) {
    return !!obj && typeof obj === 'object' &&
      (AD_KEYS.some((k) => k in obj) || 'playerResponse' in obj);
  }

  // ---- 1. Cold load: the inline ytInitialPlayerResponse ------------------
  // Defined before YouTube's inline script runs, so our setter sees the object
  // on its way in and cleans it before the player is constructed.
  let initialResponse;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initialResponse,
      set(value) { initialResponse = sanitize(value); }
    });
  } catch (e) {
    // Another extension got here first; the remaining hooks still cover us.
  }

  // ---- 2. SPA navigation: fetch responses --------------------------------
  const originalJson = Response.prototype.json;
  Response.prototype.json = function () {
    return originalJson.call(this).then((data) => (isPlayerResponse(data) ? sanitize(data) : data));
  };

  // ---- 3. Fallback: JSON.parse ------------------------------------------
  const originalParse = JSON.parse;
  JSON.parse = function (...args) {
    const parsed = originalParse.apply(this, args);
    return isPlayerResponse(parsed) ? sanitize(parsed) : parsed;
  };

  // ---- 4. DOM fallback: skip anything that still plays -------------------
  // Stripping the response handles the overwhelming majority, but YouTube
  // ships player changes constantly. This is the safety net: if an ad is
  // actually playing, jump to its end and mute it so the cost is a blink
  // rather than 30 seconds.
  function handleAdPlaying() {
    const player = document.getElementById('movie_player');
    if (!player || !player.classList.contains('ad-showing')) return;

    const skip = player.querySelector(
      '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button'
    );
    if (skip) {
      skip.click();
      return;
    }

    // No skip button yet (pre-skip countdown, or an unskippable ad): seek to
    // the end. Muting first avoids a burst of ad audio during the seek.
    const video = player.querySelector('video');
    if (video && Number.isFinite(video.duration) && video.duration > 0) {
      video.muted = true;
      video.currentTime = video.duration;
    }
  }

  function watchPlayer() {
    const observer = new MutationObserver(handleAdPlaying);
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
    handleAdPlaying();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchPlayer, { once: true });
  } else {
    watchPlayer();
  }
})();

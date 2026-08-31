// cosmetic.js — per-domain element hiding.
//
// The generic element-hiding rules (the ~13,600 that apply to every site) ride
// along as filters/generic.css on this same content script registration, so
// they are already applied by the CSS engine before this runs. All this script
// does is the part that depends on which site we're on:
//
//   1. selectors — extra ad containers that only exist on this domain
//   2. unhide    — EasyList exceptions (#@#) that cancel a generic rule here,
//                  because the generic selector hits real content on this site
//
// Both arrive from background.js, which holds the lookup table; sending just
// this hostname's slice keeps every page from parsing the full table.

(() => {
  const STYLE_ID = 'tab-cosmetic-style';

  chrome.runtime.sendMessage(
    { type: 'cosmetic:get', hostname: location.hostname },
    (res) => {
      // Extension reloaded/updated mid-page — the port is gone, nothing to do.
      if (chrome.runtime.lastError || !res) return;
      apply(res.selectors || [], res.unhide || []);
    }
  );

  function apply(selectors, unhide) {
    const parts = [];

    if (selectors.length) {
      parts.push(`${selectors.join(',\n')} { display: none !important; }`);
    }

    if (unhide.length) {
      // These have to beat generic.css, which already hid them with
      // `display: none !important`. Prefixing with :root adds a type-selector's
      // worth of specificity, so the un-hide wins on specificity alone — never
      // relying on which stylesheet the browser happens to order last.
      const scoped = unhide.map((sel) => `:root ${sel}`);
      parts.push(`${scoped.join(',\n')} { display: revert !important; }`);
    }

    if (!parts.length) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = parts.join('\n');

    // At document_start there is often no <head> yet; documentElement always
    // exists, and the stylesheet applies from wherever it is attached.
    (document.head || document.documentElement).appendChild(style);
  }
})();

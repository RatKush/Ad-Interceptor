// scriptlets.js — anti-adblock circumvention (MAIN world).
//
// Runs in the page's own JavaScript context at document_start, before site
// code executes. That timing is the whole point: an anti-adblock detector can
// only be neutralised by patching the property it reads *before* it reads it.
//
// This is an independent implementation. It is deliberately NOT derived from
// AdGuard's or uBlock's scriptlet libraries, both of which are GPL — see
// ATTRIBUTION.md. The techniques (property traps, constant pinning) are
// well-known; the code is ours.
//
// The rules table is embedded here rather than fetched, because MAIN-world
// scripts have no chrome.* API access to receive config through, and MV3
// forbids remotely-hosted code. The script self-selects on hostname.

(() => {
  'use strict';

  // ---- Rules ------------------------------------------------------------
  // domain -> [[scriptlet, ...args], ...]
  // Hand-maintained seed set. Match is suffix-based, so "example.com" also
  // covers "www.example.com".
  const RULES = {
    // Common standalone detector libraries. These are the highest-value
    // targets: a handful of scripts account for a large share of all
    // "disable your ad blocker" walls on the web.
    '*': [
      ['set-constant', 'blockAdBlock', 'false'],
      ['set-constant', 'BlockAdBlock', 'false'],
      ['set-constant', 'fuckAdBlock', 'false'],
      ['set-constant', 'FuckAdBlock', 'false'],
      ['set-constant', 'adBlockDetected', 'false'],
      ['set-constant', 'canRunAds', 'true'],
      ['set-constant', 'canShowAds', 'true'],
      ['set-constant', 'isAdBlockActive', 'false'],
      ['set-constant', 'adsAreBlocked', 'false']
    ]

    // NOTE: 'noop-func' is deliberately NOT applied globally.
    //
    // These scriptlets install non-configurable accessors. A page-level
    // `var canRunAds = true` is harmless against one — a var declaration over
    // an existing property just assigns, hitting our swallowing setter. But a
    // `function detectAdBlock() {}` *declaration* must redefine the property,
    // which a non-configurable accessor forbids, and the resulting TypeError
    // aborts the whole script it appears in — potentially taking real page
    // code down with the detector.
    //
    // Detector names are far more likely to be function declarations than the
    // flags above are, so noop-func is kept for per-domain rules where the
    // blast radius is known, and the globally-applied set is limited to flags.
  };

  // ---- Helpers ----------------------------------------------------------

  /**
   * Walk a dotted property chain, creating nothing. Returns the owning object
   * and final key, or null when an intermediate link is missing.
   */
  function resolve(chain) {
    const parts = chain.split('.');
    let owner = window;
    for (let i = 0; i < parts.length - 1; i++) {
      owner = owner[parts[i]];
      if (owner === null || typeof owner !== 'object') return null;
    }
    return { owner, key: parts[parts.length - 1] };
  }

  function parseValue(raw) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (raw === 'undefined') return undefined;
    if (raw === 'noopFunc') return () => {};
    if (raw === 'emptyArray') return [];
    if (raw === 'emptyObj') return {};
    if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
    return raw;
  }

  /** Define a property, tolerating non-configurable targets. */
  function define(owner, key, descriptor) {
    try {
      Object.defineProperty(owner, key, { configurable: false, ...descriptor });
      return true;
    } catch (e) {
      return false; // already pinned by the page, or frozen — nothing to do
    }
  }

  // ---- Scriptlets -------------------------------------------------------
  const SCRIPTLETS = {
    /**
     * Pin a property to a constant the page cannot change.
     * The workhorse: detectors overwhelmingly work by setting a flag
     * ("adsBlocked = true") and reading it back later. Pinning the flag makes
     * the read return the answer we want no matter what the page wrote.
     */
    'set-constant'(chain, rawValue) {
      const target = resolve(chain);
      if (!target) return;
      const value = parseValue(rawValue);
      define(target.owner, target.key, {
        get: () => value,
        set: () => {} // swallow the page's writes
      });
    },

    /**
     * Make reading a property throw. Used where the detector's *existence
     * check* is the trigger and a falsy value isn't enough — the thrown error
     * aborts the detector's call stack before it can act.
     */
    'abort-on-property-read'(chain) {
      const target = resolve(chain);
      if (!target) return;
      define(target.owner, target.key, {
        get() { throw new ReferenceError(chain); },
        set() {}
      });
    },

    /** Make writing a property throw, aborting the writer's call stack. */
    'abort-on-property-write'(chain) {
      const target = resolve(chain);
      if (!target) return;
      define(target.owner, target.key, {
        get: () => undefined,
        set() { throw new ReferenceError(chain); }
      });
    },

    /** Replace a function with one that does nothing and returns undefined. */
    'noop-func'(chain) {
      const target = resolve(chain);
      if (!target) return;
      define(target.owner, target.key, { get: () => () => {}, set: () => {} });
    },

    /**
     * Defeat bait-element detection.
     *
     * The classic detector inserts a decoy element with an ad-like class, then
     * checks whether it got hidden. Our own cosmetic CSS is exactly what hides
     * it, so blocking ads is what trips the alarm. This makes the measurement
     * APIs report the decoy as visible.
     *
     * Domain-scoped on purpose — it lies to every caller, including the site's
     * own layout code, so it is far too blunt to run everywhere.
     */
    'defuse-bait'() {
      const FAKE_HEIGHT = 50;
      const realStyle = window.getComputedStyle.bind(window);

      const looksLikeBait = (el) => {
        try {
          const id = `${el.id} ${el.className}`;
          return /\b(ad|ads|adsbox|ad-banner|banner_ad|pub_300x250)\b/i.test(id);
        } catch (e) {
          return false;
        }
      };

      for (const prop of ['offsetHeight', 'clientHeight', 'offsetWidth', 'clientWidth']) {
        const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
        if (!original || !original.get) continue;
        Object.defineProperty(HTMLElement.prototype, prop, {
          configurable: true,
          get() {
            const real = original.get.call(this);
            return real === 0 && looksLikeBait(this) ? FAKE_HEIGHT : real;
          }
        });
      }

      window.getComputedStyle = function (el, pseudo) {
        const style = realStyle(el, pseudo);
        if (!looksLikeBait(el)) return style;
        // Return a shim that reports the decoy as displayed.
        return new Proxy(style, {
          get(target, prop) {
            if (prop === 'display') return 'block';
            if (prop === 'visibility') return 'visible';
            const v = target[prop];
            return typeof v === 'function' ? v.bind(target) : v;
          }
        });
      };
    },

    /**
     * Undo scroll locks and full-page overlays.
     * Anti-adblock walls and interstitials typically freeze the body and cover
     * the page. This releases the freeze rather than trying to find and delete
     * every overlay variant.
     */
    'unlock-scroll'() {
      const release = () => {
        for (const el of [document.documentElement, document.body]) {
          if (!el) continue;
          el.style.setProperty('overflow', 'auto', 'important');
          el.style.setProperty('position', 'static', 'important');
        }
      };
      const start = () => {
        release();
        new MutationObserver(release).observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['style', 'class'],
          subtree: true
        });
      };
      if (document.documentElement) start();
      else document.addEventListener('readystatechange', start, { once: true });
    }
  };

  // ---- Dispatch ---------------------------------------------------------
  function hostCandidates(hostname) {
    const labels = hostname.split('.');
    const out = ['*'];
    for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
    return out;
  }

  for (const host of hostCandidates(location.hostname)) {
    const entries = RULES[host];
    if (!entries) continue;
    for (const [name, ...args] of entries) {
      const fn = SCRIPTLETS[name];
      if (!fn) continue;
      try {
        fn(...args);
      } catch (e) {
        // One bad scriptlet must never take down the rest, or the page.
      }
    }
  }
})();

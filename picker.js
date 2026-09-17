// picker.js — the element picker. Injected on demand, never registered.
//
// Runs in the ISOLATED world (the default) because it needs
// chrome.runtime.sendMessage to hand the finished rule back; it only reads the
// page's DOM, so it has no reason to share the page's JS context the way
// scriptlets.js and youtube.js do.
//
// Injected by background.js via chrome.scripting.executeScript on an explicit
// click, and only for a licensed user — it is never part of the standing
// content-script registration, so it costs nothing on any page the user has
// not asked it for.
//
// WHY A PICKER AT ALL
// uBlock Origin Lite dropped the element picker under Manifest V3; AdGuard is
// the only MV3 blocker that still offers one. The picker is what turns "the
// list missed something" from a support email into a ten-second fix, and it is
// the single feature that most distinguishes this from a list-only blocker.

(() => {
  'use strict';

  // executeScript will happily run this twice if the user clicks twice. A
  // second instance would stack two overlays and two key handlers, and only
  // one would ever be torn down.
  if (window.__adInterceptorPicker) {
    window.__adInterceptorPicker.focusToolbar();
    return;
  }

  const PREFIX = '__ai-picker';
  let target = null;      // the element currently under the cursor
  let depth = 0;          // how many parents up from `target` the user has walked
  let selected = null;    // `target` walked up `depth` parents

  // ---- Selector generation -------------------------------------------------
  //
  // The goal is a selector that is SPECIFIC enough to hit the ad and STABLE
  // enough to still match tomorrow. Those pull against each other, so the
  // strategy is: prefer human-authored hooks (ids, semantic class names),
  // distrust anything that looks generated, and only add structural context
  // (parents, :nth-of-type) when the simple form is ambiguous.

  // Class and id names that a build tool produced rather than a person wrote.
  // These change on every deploy, so a selector built on one is worse than
  // useless — it silently stops matching and the user thinks the rule broke.
  //   ad_3f9a2b        CSS-modules / styled-components hash
  //   css-1q2w3e       emotion
  //   jsx-1234567890   styled-jsx
  //   x1n2onr6         Facebook's atomic classes
  const GENERATED = [
    /^[a-z-]*_{1,2}[a-z0-9]{5,}$/i,
    /^css-[a-z0-9]{6,}$/i,
    /^jsx-\d{6,}$/i,
    /^[a-z]{1,2}[0-9a-f]{6,}$/i,
    /[0-9a-f]{8,}/i,
    /^\d+$/
  ];
  const looksGenerated = (name) => GENERATED.some((re) => re.test(name));

  // CSS.escape exists everywhere we support, but a class containing a `/` or a
  // leading digit still has to be escaped before it can go in a selector.
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));

  const stableClasses = (el) =>
    [...el.classList].filter((c) => c && !c.startsWith(PREFIX) && !looksGenerated(c));

  /** The most specific sensible selector for one element, ignoring ancestors. */
  function ownSelector(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && !looksGenerated(el.id)) return `#${esc(el.id)}`;

    const classes = stableClasses(el);
    if (classes.length) {
      // Two classes is the sweet spot: one is often shared site-wide, three or
      // more starts encoding incidental state classes (is-open, has-image)
      // that disappear and take the rule with them.
      return tag + classes.slice(0, 2).map((c) => `.${esc(c)}`).join('');
    }

    // No usable hook of its own. Attribute selectors are the last resort that
    // is still content-addressed rather than positional.
    for (const attr of ['data-testid', 'data-ad', 'data-ad-slot', 'aria-label', 'role', 'name']) {
      const v = el.getAttribute(attr);
      if (v && v.length < 40 && !looksGenerated(v)) return `${tag}[${attr}="${CSS.escape(v)}"]`;
    }
    return tag;
  }

  /** Position among same-tag siblings, for when nothing else distinguishes it. */
  function nthOfType(el) {
    const parent = el.parentElement;
    if (!parent) return '';
    const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
    if (sameTag.length < 2) return '';
    return `:nth-of-type(${sameTag.indexOf(el) + 1})`;
  }

  /**
   * Build a selector for `el`, adding ancestor context until it is unambiguous.
   *
   * "Unambiguous" deliberately means *matches only this element*, not "matches
   * few" — a rule that also hides a neighbouring real article is exactly the
   * false positive that gets an ad blocker uninstalled, and the user cannot
   * see what else it matched at the moment they click Block.
   */
  function buildSelector(el) {
    let selector = ownSelector(el);
    if (matchCount(selector) === 1) return selector;

    // Disambiguate by position before reaching for ancestors: it is shorter
    // and survives a parent being restructured.
    const positional = selector + nthOfType(el);
    if (matchCount(positional) === 1) return positional;

    let current = el.parentElement;
    let built = positional;
    // Four levels is enough for real pages and keeps the selector readable;
    // beyond that the selector is so structural it will not survive a redesign
    // anyway, and the user is better served by editing it by hand.
    for (let i = 0; i < 4 && current && current !== document.documentElement; i++) {
      built = `${ownSelector(current)} > ${built}`;
      if (matchCount(built) === 1) return built;
      current = current.parentElement;
    }
    return built;
  }

  function matchCount(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch (e) {
      return 0; // invalid selector — treated as "no good", never thrown at the user
    }
  }

  // ---- Overlay -------------------------------------------------------------
  // Built with inline styles on purpose. The page's own stylesheet cannot be
  // trusted (this extension is, after all, being used on sites that fight ad
  // blockers), and a stylesheet of ours could itself be hidden by a generic
  // rule from our own filter list.
  const style = (el, css) => Object.assign(el.style, css);

  const box = document.createElement('div');
  box.id = `${PREFIX}-box`;
  style(box, {
    position: 'fixed', zIndex: '2147483646', pointerEvents: 'none',
    border: '2px solid #9b3bff', background: 'rgba(155,59,255,0.18)',
    borderRadius: '3px', transition: 'all 40ms linear', display: 'none'
  });

  const bar = document.createElement('div');
  bar.id = `${PREFIX}-bar`;
  style(bar, {
    position: 'fixed', zIndex: '2147483647', left: '50%', bottom: '24px',
    transform: 'translateX(-50%)', display: 'flex', gap: '8px', alignItems: 'center',
    maxWidth: 'min(92vw, 720px)', padding: '10px 12px', borderRadius: '10px',
    background: '#16121d', color: '#f4f1f8', font: '13px/1.4 system-ui, sans-serif',
    boxShadow: '0 8px 32px rgba(0,0,0,0.45)', pointerEvents: 'auto'
  });

  const label = document.createElement('code');
  style(label, {
    flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap', font: '12px/1.4 ui-monospace, monospace', color: '#c9a7ff'
  });

  const hint = document.createElement('span');
  style(hint, { color: '#8b8195', whiteSpace: 'nowrap', fontSize: '12px' });
  hint.textContent = 'Esc to cancel';

  function button(text, primary) {
    const b = document.createElement('button');
    b.textContent = text;
    style(b, {
      border: 'none', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer',
      font: '600 12px system-ui, sans-serif', whiteSpace: 'nowrap',
      background: primary ? '#9b3bff' : '#2a2335', color: '#fff'
    });
    return b;
  }

  const wider = button('▲ Wider');
  const narrower = button('▼ Narrower');
  const block = button('Block', true);
  const cancel = button('Cancel');

  bar.append(label, wider, narrower, block, cancel, hint);
  document.documentElement.append(box, bar);

  // ---- Interaction ---------------------------------------------------------
  const isOurs = (el) => el && (el.id || '').startsWith(PREFIX);

  /** Walk `target` up `depth` parents, clamped to something still selectable. */
  function resolve() {
    let el = target;
    for (let i = 0; i < depth && el?.parentElement; i++) {
      if (el.parentElement === document.body || el.parentElement === document.documentElement) break;
      el = el.parentElement;
    }
    return el;
  }

  function paint() {
    selected = resolve();
    if (!selected) { box.style.display = 'none'; return; }
    const r = selected.getBoundingClientRect();
    style(box, {
      display: 'block',
      top: `${r.top}px`, left: `${r.left}px`,
      width: `${r.width}px`, height: `${r.height}px`
    });
    const sel = buildSelector(selected);
    const n = matchCount(sel);
    label.textContent = sel;
    hint.textContent = n > 1 ? `matches ${n} elements · Esc to cancel` : 'Esc to cancel';
    hint.style.color = n > 1 ? '#ffb454' : '#8b8195';
  }

  function onMove(e) {
    if (bar.contains(e.target)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOurs(el) || el === target) return;
    target = el;
    depth = 0;
    paint();
  }

  function onClick(e) {
    if (bar.contains(e.target)) return;
    // Stop the page acting on the click — picking an element inside a link
    // should not navigate away mid-pick.
    e.preventDefault();
    e.stopPropagation();
    confirmSelection();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); teardown(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); depth++; paint(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); depth = Math.max(0, depth - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); confirmSelection(); }
  }

  function confirmSelection() {
    if (!selected) return;
    const selector = buildSelector(selected);
    const rule = `${location.hostname}##${selector}`;

    chrome.runtime.sendMessage({ type: 'userfilters:add', text: rule }, (res) => {
      // The port can be gone if the extension updated mid-pick. Say so rather
      // than tearing down silently, which would look like the rule was saved.
      if (chrome.runtime.lastError || !res) return fail('Could not save — try again');
      if (res.error) return fail(res.error);

      // Hide it immediately. The stored rule only reaches this page through
      // cosmetic.js on the next load, and an element that stays visible after
      // "Block" reads as a failure even though the rule saved fine.
      const sheet = document.createElement('style');
      sheet.textContent = `${selector} { display: none !important; }`;
      document.documentElement.append(sheet);
      teardown();
    });
  }

  function fail(message) {
    label.textContent = message;
    label.style.color = '#ff8f8f';
  }

  function teardown() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove();
    bar.remove();
    delete window.__adInterceptorPicker;
  }

  wider.addEventListener('click', () => { depth++; paint(); });
  narrower.addEventListener('click', () => { depth = Math.max(0, depth - 1); paint(); });
  block.addEventListener('click', confirmSelection);
  cancel.addEventListener('click', teardown);

  // Capture phase throughout: pages that fight ad blockers stop propagation on
  // their own overlays, and a picker that only works on cooperative pages is
  // not much of a picker.
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);

  window.__adInterceptorPicker = { focusToolbar: () => bar.scrollIntoView?.({ block: 'nearest' }) };
})();

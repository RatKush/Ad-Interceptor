// userfilters.js — the user's own filter rules: parsing, validation, compiling.
//
// Pure module. No chrome.* calls, no DOM, no I/O — everything here is a
// function of its arguments. That is deliberate: this is the one piece of the
// custom-filter feature that has interesting logic, so it is kept somewhere
// scripts/test-pro.mjs can import and exercise directly in node, rather than
// only through a browser run.
//
// SYNTAX SUPPORTED
// A deliberate subset of Adblock Plus syntax — the part that survives
// Manifest V3 and that a person actually types:
//
//   example.com##.ad-slot      hide .ad-slot on example.com and subdomains
//   ##.ad-slot                 hide .ad-slot everywhere
//   a.com,b.com##.promo        hide on either
//   example.com#@#.promo       UNHIDE — cancels a list rule that hides it here
//   ||ads.example.com^         block requests to that host
//   ! anything                 comment
//
// Everything else is REJECTED with a reason rather than silently ignored.
// Silent partial support is how a user ends up believing a rule is active when
// it never parsed — the failure mode that makes a custom-filter box useless.
//
// NOT supported, and why:
//   #?#, #$#, :has(), :style()  extended-CSS; needs a matching engine we don't
//                               ship (see cosmetic.js — plain CSS only)
//   ##+js(...)                  scriptlet injection; the scriptlet library is
//                               GPL and this project ships CC BY-SA data only
//   $csp=, $redirect=           "unsafe" DNR actions, capped separately by
//                               Chrome and not worth the review surface

// ---- Budget ---------------------------------------------------------------
// User rules live in chrome.storage.sync so they follow the user between
// machines — which incidentally delivers the "backup & sync" that AdBlock and
// Adblock Plus both pulled from their paid tiers. The price is sync's
// QUOTA_BYTES_PER_ITEM of 8,192 bytes for the whole array.
//
// So the cap is expressed in BYTES, not just rule count: 150 short rules fit
// comfortably, 150 long ones would not, and a silent write failure at the
// quota edge would lose the user's work. MAX_USER_RULES is the secondary
// guard that keeps the options list and the dynamic-rule budget bounded.
export const MAX_USER_RULES = 150;
export const MAX_RULE_LENGTH = 200;
export const MAX_USER_BYTES = 7000; // 8,192 less headroom for the JSON overhead

/**
 * Every domain key a hostname should match, most specific first.
 *
 *   news.bbc.co.uk -> [news.bbc.co.uk, bbc.co.uk, co.uk]
 *   example.com    -> [example.com]
 *   localhost      -> [localhost]
 *
 * The last label is deliberately NOT emitted on a multi-label host: a bare
 * `uk` key would let one rule apply to every British site at once.
 *
 * The Math.max is what makes a SINGLE-label host work at all. Without it the
 * loop never runs for `localhost` or an intranet name like `wiki`, the
 * candidate list comes back empty, and a rule written for that host silently
 * matches nothing — with no error anywhere, because an empty candidate list is
 * indistinguishable from "no rules for this site".
 */
export function hostCandidates(hostname) {
  const labels = String(hostname || '').split('.');
  const out = [];
  for (let i = 0; i < Math.max(1, labels.length - 1); i++) out.push(labels.slice(i).join('.'));
  return out;
}

// A CSS selector cannot be fully validated without a DOM, and this module runs
// in the service worker where there is none. So the check here is structural
// and conservative — it rejects what is definitely wrong (unbalanced
// delimiters, a declaration block, extended-CSS pseudos) and lets the rest
// through. The REAL check is a try { document.querySelector(sel) } in the UI
// that creates the rule (options.js, picker.js), where a DOM exists.
//
// Two layers on purpose: the UI check gives the user an immediate, accurate
// error, and this one guarantees that whatever reaches the compiler is
// structurally sane even if it arrived from edited storage.
const BANNED_SELECTOR = /[{}]|:has\(|:style\(|:matches-css|:xpath\(|:upward\(|\+js\(/i;

function selectorLooksValid(sel) {
  if (!sel || sel.length > MAX_RULE_LENGTH) return false;
  if (BANNED_SELECTOR.test(sel)) return false;
  // Balanced (), [] and quotes. Unbalanced delimiters are the single most
  // common typo and would otherwise be injected into a stylesheet, where one
  // bad selector invalidates the whole rule the browser is parsing.
  let paren = 0, bracket = 0, quote = null;
  for (const ch of sel) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') paren++;
    else if (ch === ')') { if (--paren < 0) return false; }
    else if (ch === '[') bracket++;
    else if (ch === ']') { if (--bracket < 0) return false; }
  }
  return paren === 0 && bracket === 0 && !quote;
}

// Hostname, not URL: letters/digits/dot/hyphen, no scheme and no path.
// Anything richer belongs in a list, not in a hand-typed rule.
//
// A dot is NOT required. Demanding one reads as a useful typo guard, and it
// was the original rule here, but it breaks two real cases: `localhost`, and
// single-label intranet names like `wiki`. Both matter more than the guard
// does, because picker.js builds its rule from `location.hostname` — so on
// localhost the picker would reject its own output, and the people most likely
// to be browsing localhost are exactly the people most likely to use custom
// filters.
//
// The cost of accepting a bare word is a rule that matches nothing. That is
// visible in the options list, next to the text the user typed. The cost of
// rejecting one was a feature that silently did not work.
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function parseDomains(part) {
  if (!part) return { domains: [], error: null };
  const domains = part.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  for (const d of domains) {
    // Negation and wildcard TLDs are real Adblock syntax that this pipeline
    // cannot express — cosmetic lookup is a plain hostname-keyed map. Rejected
    // rather than silently dropped, same reasoning as the header.
    if (d.startsWith('~')) return { domains: [], error: `Excluded domains (~${d.slice(1)}) are not supported` };
    if (d.includes('*')) return { domains: [], error: `Wildcard domains (${d}) are not supported` };
    if (!HOSTNAME.test(d)) return { domains: [], error: `"${d}" is not a valid domain` };
  }
  return { domains, error: null };
}

/**
 * Parse one line of filter text.
 * @returns {{ok: true, rule: object} | {ok: false, error: string} | {ok: true, rule: null}}
 *          rule === null means "nothing to store" (blank line or comment).
 */
export function parseRule(line) {
  const text = String(line ?? '').trim();
  if (!text || text.startsWith('!') || text.startsWith('[Adblock')) {
    return { ok: true, rule: null };
  }
  if (text.length > MAX_RULE_LENGTH) {
    return { ok: false, error: `Rule is too long (max ${MAX_RULE_LENGTH} characters)` };
  }

  // Extended-CSS separators are checked BEFORE the plain ## match, because
  // `#?#` contains no `##` but `#$?#` does — testing in the other order would
  // mis-parse the latter as a hide rule with a stray `$?` on the selector.
  if (/#[@?$%]?\?#|#\$#|#%#/.test(text)) {
    return { ok: false, error: 'Extended CSS and scriptlet rules are not supported' };
  }

  const cosmetic = text.match(/^(.*?)(#@#|##)(.+)$/);
  if (cosmetic) {
    const [, domainPart, sep, rawSelector] = cosmetic;
    const selector = rawSelector.trim();
    const { domains, error } = parseDomains(domainPart);
    if (error) return { ok: false, error };
    if (!selectorLooksValid(selector)) {
      return { ok: false, error: 'That does not look like a valid CSS selector' };
    }
    // An unhide rule with no domain would cancel a list rule on every site at
    // once. That is a footgun with no legitimate use in a personal list.
    if (sep === '#@#' && !domains.length) {
      return { ok: false, error: 'An unhide rule needs a domain (example.com#@#.selector)' };
    }
    return { ok: true, rule: { kind: sep === '#@#' ? 'unhide' : 'hide', domains, selector, text } };
  }

  // Network rule. Only the ||host^ anchored form: it is unambiguous, it is what
  // people copy from guides, and it maps exactly onto one DNR urlFilter.
  const network = text.match(/^\|\|([^/^$]+)\^?$/);
  if (network) {
    const host = network[1].trim().toLowerCase();
    if (!HOSTNAME.test(host)) return { ok: false, error: `"${host}" is not a valid domain` };
    return { ok: true, rule: { kind: 'block', host, text: `||${host}^` } };
  }

  if (text.startsWith('@@')) {
    return { ok: false, error: 'Use the per-site pause instead of an @@ exception rule' };
  }
  return { ok: false, error: 'Unrecognised rule. Try example.com##.selector or ||ads.example.com^' };
}

/** Parse many lines, collecting rules and per-line errors. */
export function parseRules(text) {
  const rules = [];
  const errors = [];
  String(text ?? '').split(/\r?\n/).forEach((line, i) => {
    const res = parseRule(line);
    if (!res.ok) errors.push({ line: i + 1, text: line.trim(), error: res.error });
    else if (res.rule) rules.push(res.rule);
  });
  return { rules, errors };
}

/** Serialised size of a rule list, for the sync-quota check. */
export const rulesBytes = (rules) =>
  new TextEncoder().encode(JSON.stringify(rules)).length;

/**
 * Reject a rule list that cannot be stored, BEFORE writing it.
 *
 * Takes the array AS STORED — the plain strings that go into
 * chrome.storage.sync — not the parsed objects, so the byte count it reports
 * is the real payload rather than an estimate of it.
 *
 * chrome.storage.sync.set fails asynchronously on quota, and the failure is
 * easy to miss — the user closes the options page believing the rule saved.
 * Checking first turns that into a visible message.
 */
export function checkStorable(stored) {
  if (stored.length > MAX_USER_RULES) {
    return `Too many rules (${stored.length}). The limit is ${MAX_USER_RULES}.`;
  }
  const bytes = rulesBytes(stored);
  if (bytes > MAX_USER_BYTES) {
    return `Your rules are too large to sync (${bytes} bytes, limit ${MAX_USER_BYTES}).`;
  }
  return null;
}

/** Drop exact duplicates, keeping the first occurrence and its order. */
export function dedupe(rules) {
  const seen = new Set();
  return rules.filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)));
}

/**
 * The user's cosmetic rules that apply to one hostname.
 * Mirrors background.js's cosmeticFor() shape so the two merge without a
 * special case at the call site.
 */
export function cosmeticFor(rules, hostname) {
  const candidates = new Set(hostCandidates(hostname));
  const selectors = [];
  const unhide = [];
  for (const rule of rules) {
    if (rule.kind === 'hide') {
      // No domains means "everywhere" — the one case that skips the host test.
      if (!rule.domains.length || rule.domains.some((d) => candidates.has(d))) {
        selectors.push(rule.selector);
      }
    } else if (rule.kind === 'unhide' && rule.domains.some((d) => candidates.has(d))) {
      unhide.push(rule.selector);
    }
  }
  return { selectors, unhide };
}

/**
 * Compile the user's network rules into dynamic DNR rules.
 *
 * `priority` sits ABOVE the converted list rules (which top out around
 * 1,000,301 from $important) so a user's block beats a list's allow exception —
 * if they went to the trouble of writing it, it should win. It sits BELOW
 * OVERRIDE_PRIORITY so their own master switch and per-site pause still beat
 * it; a rule the user cannot turn off is worse than no rule.
 */
export function compileNetworkRules(rules, { idBase, maxRules, priority }) {
  return rules
    .filter((r) => r.kind === 'block')
    .slice(0, maxRules)
    .map((r, i) => ({
      id: idBase + i,
      priority,
      action: { type: 'block' },
      condition: { urlFilter: `||${r.host}^` }
    }));
}

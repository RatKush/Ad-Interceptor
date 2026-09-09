// ----------------------------
// 🛡️ Ad Interceptor — background service worker
// ----------------------------
// Owns all blocking state. The popup only writes settings to storage; every
// decision about rules and content scripts is made here.
//
// Blocking layers:
//   1. Static DNR rulesets (rules/filters-*.json) — 108,068 rules, quota-fitted
//   2. Cosmetic hiding     (filters/filters-generic.css + -cosmetic.json)
//   3. Anti-adblock rules  (rules/pro-*.json + pro-generic.css) — Pro
//   4. Anti-adblock scriptlets (scriptlets.js)    — Pro
//   5. YouTube ad removal      (youtube.js)       — Pro
//   6. Server-refreshed filters into the dynamic store — Pro

import { PRO_ENABLED, PRO_TEASER } from './config.js';

// STATIC import, and it has to be. An earlier version used dynamic import() so
// the free package could omit the file entirely — that silently broke every
// Pro path, because import() is disallowed inside a service worker by the HTML
// spec (w3c/ServiceWorker#1356). The module must be linked at load time.
//
// So the free build ships license-stub.js AS license.js instead: same API, no
// URLs, no fetch. scripts/package.sh does the swap. That is what keeps the
// store listing's "collects nothing" true of the artifact rather than merely
// true of the running code.
import * as licenseImpl from './license.js';

// Every Pro entry point goes through these, so PRO_ENABLED is checked in one
// place and the free tier's answer is the default rather than an afterthought.
const isPro = async () => (PRO_ENABLED ? licenseImpl.isPro() : false);

const licenseStatus = async () => (PRO_ENABLED
  ? licenseImpl.licenseStatus()
  : { pro: false, plan: 'free', hasKey: false, expiresAt: null });

const validateLicense = async (key) => (PRO_ENABLED
  ? licenseImpl.validateLicense(key)
  : { ok: false, error: 'Pro is not available in this build.' });

const clearLicense = async () => { if (PRO_ENABLED) await licenseImpl.clearLicense(); };
const revalidateIfStale = async () => { if (PRO_ENABLED) await licenseImpl.revalidateIfStale(); };
const fetchProFilters = async () => (PRO_ENABLED ? licenseImpl.fetchProFilters() : null);

// ---- Dynamic rule ID space ------------------------------------------------
// Dynamic rules are ONE flat store shared by the allowlist and the filter
// rules, so the two have to be partitioned by ID or they clobber each other.
// (The v2.x allowlist code removed *every* dynamic rule on each sync — with
// filter rules now in the same store that would wipe all 29,000 of them.)
//   1        — master off switch
//   2..999   — per-site allowlist
//   1000+    — Pro server-refreshed filter rules (empty for free users)
const MASTER_OFF_RULE_ID = 1;
const ALLOWLIST_ID_MIN = 2;
const ALLOWLIST_ID_MAX = 999;
const FILTER_ID_BASE = 1000;
const MAX_FILTER_RULES = 29000;

// Converted EasyList rules reach ~1,000,301 (from $important). Allow rules
// have to outrank every one of them to be able to override anything.
const OVERRIDE_PRIORITY = 2000000;

const COSMETIC_SCRIPT_ID = 'tab-cosmetic';
const SCRIPTLETS_SCRIPT_ID = 'tab-scriptlets';
const YOUTUBE_SCRIPT_ID = 'tab-youtube';

const PRO_FILTER_REFRESH_MS = 24 * 60 * 60 * 1000;

// ----------------------------
// 📦 Filter rules (dynamic store)
// ----------------------------
async function writeFilterRules(rules) {
  const capped = rules.slice(0, MAX_FILTER_RULES)
    .map((rule, i) => ({ ...rule, id: FILTER_ID_BASE + i })); // never trust incoming IDs

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const staleIds = existing.filter((r) => r.id >= FILTER_ID_BASE).map((r) => r.id);

  // Chrome applies this atomically and processes removals before additions,
  // so replacing the whole filter block in one call is safe.
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: staleIds,
    addRules: capped
  });
  return capped.length;
}

// ----------------------------
// 📚 Static rulesets
// ----------------------------
// The filters ship as several rulesets with only the first enabled in the
// manifest. GUARANTEED_MINIMUM_STATIC_RULES is 30,000, but that is a floor:
// the real allowance comes from a global pool shared with every other
// installed extension, and getAvailableStaticRuleCount() reported ~300,000
// spare on a clean profile. How much *this* user actually has depends on what
// else they have installed, so the only correct answer is to ask at runtime.
//
// Enable one at a time and stop at the first refusal: that self-corrects
// against whatever the quota turns out to be, without this file needing to
// know how many rules each chunk holds.
// Ruleset ids are prefixed by tier: `filters-N` is the free ad/tracker set,
// `pro-N` is the Adblock Warning Removal List.
const isProRuleset = (id) => id.startsWith('pro-');

async function syncStaticRulesets(pro) {
  const declared = chrome.runtime.getManifest().declarative_net_request.rule_resources;
  const enabled = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());

  // Pro lapsed — turn its rulesets back off before spending quota on anything.
  const toDisable = [...enabled].filter((id) => isProRuleset(id) && !pro);
  if (toDisable.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: toDisable });
    toDisable.forEach((id) => enabled.delete(id));
  }

  for (const { id } of declared) {
    if (enabled.has(id)) continue;
    if (isProRuleset(id) && !pro) continue;
    try {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [id] });
      enabled.add(id);
    } catch (e) {
      console.log(`📚 Static quota reached at ${id} — ${enabled.size}/${declared.length} rulesets active`);
      return enabled.size;
    }
  }
  console.log(`📚 ${enabled.size} static rulesets active`);
  return enabled.size;
}

// Pro users get a server-built filter set refreshed daily, rather than waiting
// for a store release. It lands in the dynamic store, which is otherwise
// unused now that all 108,065 shipped rules fit in static rulesets — so this
// is additive on top of the free tier's full coverage, not a carve-out of it.
async function refreshProFilters() {
  if (!PRO_ENABLED) return;
  if (!(await isPro())) return;

  const { proFiltersAt = 0 } = await chrome.storage.local.get('proFiltersAt');
  if (Date.now() - proFiltersAt < PRO_FILTER_REFRESH_MS) return;

  const rules = await fetchProFilters();
  if (!rules) return; // server down or not entitled — bundled rules stay in place

  const count = await writeFilterRules(rules);
  await chrome.storage.local.set({ proFiltersAt: Date.now() });
  console.log(`✨ Refreshed ${count} Pro filter rules`);
}

// ----------------------------
// 🔢 Blocked counter
// ----------------------------
// Counts network requests actually blocked, via getMatchedRules — the real
// match log, not an estimate. Deliberately does NOT include cosmetic hiding:
// generic.css hides elements through the CSS engine with no JS involved, so
// counting those would mean querying 13,634 selectors per page. The popup
// therefore says "requests blocked", which is exactly what this number is.
//
// Chrome only retains matches for ~5 minutes, and the count is per page load,
// so each navigation records a fresh baseline timestamp.
//
// Kept in storage.session, NOT a Map. The service worker is torn down whenever
// the browser feels like it, routinely between a tab's `loading` and
// `complete` events — with an in-memory Map the baseline recorded at `loading`
// was simply gone by `complete`, and the badge silently counted nothing.
// storage.session survives worker restarts and still clears on browser exit,
// which is exactly the lifetime a per-page counter wants.
const tabKey = (tabId) => `tab:${tabId}`;

async function getTabState(tabId) {
  const key = tabKey(tabId);
  const stored = await chrome.storage.session.get(key);
  // No record (first sight of this tab, or session storage cleared): count
  // everything Chrome still holds for the tab rather than reporting zero.
  return stored[key] || { navStart: 0, counted: 0 };
}

const setTabState = (tabId, state) =>
  chrome.storage.session.set({ [tabKey(tabId)]: state });

// Persist immediately rather than batching. An earlier version accumulated in
// memory and flushed on a 5s timer, which loses counts outright: an MV3 worker
// can be terminated at any moment and the pending timer simply never runs.
// Badge updates happen about twice per page load, so writing through costs
// little and removes the whole failure mode.
//
// Chained rather than fired in parallel because this is a read-modify-write:
// two tabs finishing at once would otherwise both read the same base value and
// one increment would be lost.
let totalWrite = Promise.resolve();

function addToTotal(delta) {
  if (delta <= 0) return totalWrite;
  totalWrite = totalWrite.then(async () => {
    const { blockedTotal = 0 } = await chrome.storage.local.get('blockedTotal');
    await chrome.storage.local.set({ blockedTotal: blockedTotal + delta });
  }).catch(() => {});
  return totalWrite;
}

async function updateBadge(tabId) {
  const { ads } = await chrome.storage.sync.get({ ads: true });
  if (!ads) {
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }

  const state = await getTabState(tabId);

  let count = 0;
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({
      tabId,
      minTimeStamp: state.navStart
    });
    count = rulesMatchedInfo.length;
  } catch (e) {
    return; // tab closed mid-flight
  }

  await addToTotal(count - state.counted);
  await setTabState(tabId, { ...state, counted: count });

  await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#9b3bff' }).catch(() => {});
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // New page — reset the baseline so the badge shows this page, not the last.
    await setTabState(tabId, { navStart: Date.now(), counted: 0 });
    await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
  if (changeInfo.status === 'complete') {
    // Ads keep loading after `complete` fires, so sample again shortly after
    // rather than freezing the count at load time.
    await updateBadge(tabId);
    setTimeout(() => updateBadge(tabId), 2000);
  }
});

chrome.tabs.onRemoved.addListener((tabId) =>
  chrome.storage.session.remove(tabKey(tabId)).catch(() => {}));

// ----------------------------
// 🔀 Master switch + per-site allowlist
// ----------------------------
// Both are expressed as high-priority allowAllRequests rules rather than by
// disabling rulesets. Toggling six static rulesets off and on again is slow
// and churns Chrome's rule index; one override rule is instant and outranks
// every static and dynamic rule at once.
function overrideRules(enabled, allowlist) {
  const rules = [];

  if (!enabled) {
    rules.push({
      id: MASTER_OFF_RULE_ID,
      priority: OVERRIDE_PRIORITY,
      action: { type: 'allowAllRequests' },
      // No urlFilter at all — an omitted filter matches every URL. Safer than
      // urlFilter: '*', which leans on wildcard-parsing edge cases.
      condition: { resourceTypes: ['main_frame'] }
    });
  }

  allowlist.slice(0, ALLOWLIST_ID_MAX - ALLOWLIST_ID_MIN + 1).forEach((domain, i) => {
    rules.push({
      id: ALLOWLIST_ID_MIN + i,
      priority: OVERRIDE_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { urlFilter: `||${domain}^`, resourceTypes: ['main_frame'] }
    });
  });

  return rules;
}

async function syncOverrideRules(enabled, allowlist) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.filter((r) => r.id < FILTER_ID_BASE).map((r) => r.id);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: overrideRules(enabled, allowlist)
  });
}

// ----------------------------
// 🎨 Content scripts
// ----------------------------
function allowlistMatchPatterns(allowlist) {
  return allowlist.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
}

async function syncContentScripts(enabled, allowlist, pro) {
  const ours = new Set([COSMETIC_SCRIPT_ID, SCRIPTLETS_SCRIPT_ID, YOUTUBE_SCRIPT_ID]);

  // unregisterContentScripts rejects the WHOLE call if any id in the list is
  // not currently registered — it is not per-id best-effort. Passing all three
  // ids unconditionally therefore threw for every free user (who never has the
  // two Pro scripts registered), leaving the old registration in place; the
  // re-register below then failed with a duplicate-id error. The visible
  // symptom was per-site pause and Pro activation silently doing nothing.
  // So: only ever unregister what is actually there.
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const stale = registered.filter((s) => ours.has(s.id)).map((s) => s.id);
  if (stale.length) {
    await chrome.scripting.unregisterContentScripts({ ids: stale })
      .catch((err) => console.warn('⚠️ unregister failed:', err.message));
  }

  if (!enabled) return;

  const excludeMatches = allowlistMatchPatterns(allowlist);
  // Chrome rejects an empty excludeMatches array, so the key is omitted
  // entirely when nothing is paused.
  const paused = excludeMatches.length ? { excludeMatches } : {};

  // custom-generic.css is registered even though it is usually empty: without
  // it, a cosmetic rule added to filters/custom.txt would build correctly and
  // then be silently ignored at runtime.
  //
  // Pro adds the anti-adblock list's element hiding — the part that removes
  // the "turn off your ad blocker" overlay itself, as opposed to blocking the
  // script that shows it.
  const css = ['filters/custom-generic.css', 'filters/filters-generic.css'];
  if (pro) css.push('filters/pro-generic.css');

  const scripts = [{
    id: COSMETIC_SCRIPT_ID,
    matches: ['<all_urls>'],
    ...paused,
    js: ['cosmetic.js'],
    css,
    runAt: 'document_start',
    allFrames: true
  }];

  if (pro) {
    // MAIN world: these patch properties the page's own scripts read, so they
    // have to live in the page's JS context, not the isolated one.
    scripts.push({
      id: SCRIPTLETS_SCRIPT_ID,
      matches: ['<all_urls>'],
      ...paused,
      js: ['scriptlets.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN'
    });
    scripts.push({
      id: YOUTUBE_SCRIPT_ID,
      matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
      js: ['youtube.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN'
    });
  }

  await chrome.scripting.registerContentScripts(scripts)
    .catch((err) => console.warn('⚠️ content script registration failed:', err.message));
}

// ----------------------------
// 🎨 Cosmetic lookup
// ----------------------------
// Per-domain cosmetic data, loaded lazily and cached for the life of the
// worker. Content scripts ask for their own hostname's selectors rather than
// each page parsing the whole 538KB table.
const cosmeticCache = new Map(); // file -> parsed data

async function getCosmeticData(name) {
  if (!cosmeticCache.has(name)) {
    const res = await fetch(chrome.runtime.getURL(`filters/${name}-cosmetic.json`));
    cosmeticCache.set(name, await res.json());
  }
  return cosmeticCache.get(name);
}

/** example: news.bbc.co.uk -> [news.bbc.co.uk, bbc.co.uk, co.uk, uk] */
function domainCandidates(hostname) {
  const labels = hostname.split('.');
  const out = [];
  for (let i = 0; i < labels.length - 1; i++) out.push(labels.slice(i).join('.'));
  return out;
}

async function cosmeticFor(hostname) {
  const sources = [await getCosmeticData('custom'), await getCosmeticData('filters')];
  if (await isPro()) sources.push(await getCosmeticData('pro'));

  const candidates = domainCandidates(hostname);
  const selectors = [];
  const unhide = [];
  for (const { specific, exceptions } of sources) {
    for (const candidate of candidates) {
      if (specific[candidate]) selectors.push(...specific[candidate]);
      if (exceptions[candidate]) unhide.push(...exceptions[candidate]);
    }
  }
  return { selectors, unhide };
}

// ----------------------------
// 📨 Messages
// ----------------------------
// ----------------------------
// ⭐ Review prompt
// ----------------------------
// Zero ratings is the single biggest drag on both store ranking and
// click-through: a listing with no reviews reads as abandoned. So ask — once,
// and only after the extension has demonstrably done its job.
//
// Both conditions have to hold. Days alone would ask someone who installed it
// and never browsed; blocked-count alone would ask on day one, when nobody has
// formed an opinion worth writing down. Together they mean "this has been
// quietly working for you for a week".
//
// Asked at most ONCE, ever. `reviewAsked` is set the moment the card is
// displayed, not when the button is clicked — someone who ignores it has
// answered, and asking again is how an extension earns a one-star review for
// nagging.
const REVIEW_MIN_DAYS = 7;
const REVIEW_MIN_BLOCKED = 500;

async function shouldAskForReview() {
  const { installedAt, blockedTotal = 0, reviewAsked } =
    await chrome.storage.local.get(['installedAt', 'blockedTotal', 'reviewAsked']);

  if (reviewAsked) return false;
  // Absent for anyone who installed before this shipped — they get a clock
  // starting at their next update rather than being asked immediately.
  if (!installedAt) return false;
  if (Date.now() - installedAt < REVIEW_MIN_DAYS * 24 * 60 * 60 * 1000) return false;

  return blockedTotal >= REVIEW_MIN_BLOCKED;
}

const HANDLERS = {
  'cosmetic:get': (msg, sender) =>
    cosmeticFor(msg.hostname || (sender.url ? new URL(sender.url).hostname : '')),

  'license:status': async () => ({
    ...(await licenseStatus()),
    available: PRO_ENABLED,
    teaser: PRO_TEASER && !PRO_ENABLED
  }),

  'stats:get': async (msg) => {
    await totalWrite; // settle any in-flight increment so the popup isn't stale
    const { blockedTotal = 0 } = await chrome.storage.local.get('blockedTotal');
    const page = msg.tabId != null ? (await getTabState(msg.tabId)).counted : 0;
    return { page, total: blockedTotal };
  },

  'license:activate': async (msg) => {
    const result = await validateLicense(msg.key);
    await refreshAll(); // Pro scripts register/unregister immediately
    return { ...result, status: { ...(await licenseStatus()), available: PRO_ENABLED } };
  },

  'review:check': async () => ({ ask: await shouldAskForReview() }),

  // Called when the card is shown, so it is never shown twice.
  'review:asked': async () => {
    await chrome.storage.local.set({ reviewAsked: Date.now() });
    return { ok: true };
  },

  'license:clear': async () => {
    await clearLicense();
    await refreshAll();
    return { status: { ...(await licenseStatus()), available: PRO_ENABLED } };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return;
  Promise.resolve(handler(msg, sender)).then(sendResponse).catch((err) => {
    console.warn(`⚠️ ${msg.type} failed:`, err.message);
    sendResponse(null);
  });
  return true; // async response
});

// ----------------------------
// 🔄 Reconcile everything
// ----------------------------
async function refreshAll() {
  const { ads, allowlist } = await chrome.storage.sync.get({ ads: true, allowlist: [] });
  const pro = await isPro();
  await syncStaticRulesets(pro);
  await syncOverrideRules(ads, allowlist);
  await syncContentScripts(ads, allowlist, pro);
}

// v2.x ("Data Saver") shipped image/video blocking. Users upgrading still have
// those content scripts registered and those keys in storage; clear both once.
// Removable after 3.x has been out long enough that nobody upgrades from 2.x.
async function migrateFromV2() {
  const legacy = new Set([
    'data-saver-media-blocker',
    'data-saver-open-shadow-dom',
    'data-saver-image-cleanup'
  ]);
  // Same all-or-nothing behaviour as above: filter to what exists, or a
  // partially-migrated profile would keep its stale scripts forever.
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const ids = registered.filter((s) => legacy.has(s.id)).map((s) => s.id);
  if (ids.length) {
    await chrome.scripting.unregisterContentScripts({ ids })
      .catch((err) => console.warn('⚠️ v2 cleanup failed:', err.message));
  }
  await chrome.storage.sync.remove(['images', 'media']).catch(() => {});
}

async function startup() {
  await revalidateIfStale();
  await refreshAll();
  await refreshProFilters();
}

// ----------------------------
// 🚀 Lifecycle
// ----------------------------
chrome.runtime.onInstalled.addListener(async () => {
  await migrateFromV2();

  // First seen. Written only if absent, so an update never resets the clock
  // and never re-arms a review prompt that has already been shown.
  const { installedAt } = await chrome.storage.local.get('installedAt');
  if (!installedAt) await chrome.storage.local.set({ installedAt: Date.now() });

  await startup();
  console.log('🚀 Ad Interceptor ready');
});

chrome.runtime.onStartup.addListener(startup);

chrome.storage.onChanged.addListener((changes, areaName) => {
  // Settings live in sync; entitlement lives in local. Both change what should
  // be registered, so both have to reconcile. Without the local branch a
  // licence going away (expiry, or a clear from another window) would leave
  // the Pro content scripts registered until the next browser restart.
  //
  // Note Chrome de-duplicates: writing a value identical to the stored one
  // fires nothing. Never rely on a no-op write to force a reconcile.
  if (areaName === 'sync' && (changes.ads || changes.allowlist)) refreshAll();
  if (areaName === 'local' && changes.license) refreshAll();
});

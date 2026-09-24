# Ad Interceptor: real-Chrome audit and uninstall-risk report

**Date:** 2026-09-24 · **Builds tested:** `dist/ad-interceptor-v3.3.zip` (free) and `dist/ad-interceptor-v3.3-pro.zip` (Pro) · **Browser:** Google Chrome 154.0.8037.58 (real Chrome, not Chromium/Edge), fresh profiles, extension loaded unpacked through DevTools

## Bottom line

Everyday ad blocking is **not** the problem. On ordinary websites Ad Interceptor removes more visible ads than uBlock Origin Lite and makes pages faster than having no blocker. The uninstalls most likely come from four things a new user runs into in their first session:

1. **YouTube ads still play** in the free build, while uBlock Origin Lite (also free) removes them. The store's short description promises it "blocks every ad — … video ads".
2. **The blocked counter goes blank after about 10 pages.** The badge shows nothing and the popup says "0 requests blocked on this page" while ads *are* being blocked, so the product looks broken. The same bug stops the review prompt from ever appearing.
3. **"Disable your ad blocker" walls** on Fox News and Bild.de appear with Ad Interceptor (free *and* Pro) but not with uBlock Origin Lite.
4. **Pop-up blocking leaves a blank tab open** each time, which reads as "the pop-up blocker didn't work".

Pro also has a packaging bug: its cookie-banner, annoyance and anti-adblock *network* rules never turn on.

---

## How it was tested

| What | Scope |
|---|---|
| Site sweep, batch 1 (mixed India + global) | 68 sites × 3 browsers: **Ad Interceptor free**, **uBlock Origin Lite** (reference), **no blocker** |
| Site sweep, batch 2 (global only) | 64 sites (US, UK, EU, LatAm, APAC news; retail; streaming; SaaS; banks; payments; travel; government) × 4 browsers: free, **Pro**, uBO Lite, no blocker |
| Per page load | blocked requests (and which were first-party), visible ad elements, new JS errors vs. clean, page text vs. clean (content-loss signal), anti-adblock wall text, consent banners, YouTube player ad data, load / style / script time, screenshot |
| Extension internals | install health, rulesets enabled, content scripts, popup and options pages, badge and counter, master switch, per-site pause, service worker idle-kill and restart, coexistence with uBO Lite, memory |
| Pro features | licence activation through the real popup (typed keys, real clicks) against a **local copy of the licence server** with locally minted keys; Pro rulesets; YouTube; anti-adblock; cookie banners and their switch; element picker; custom filters; licence expiry, device limit, 7-day offline grace, removal; daily filter refresh |
| Other | pop-up / pop-under behaviour, exact install permission warning (via Chrome's own `getPermissionWarningsByManifest`) |

About 450 page loads in total. Every issue in this report was confirmed in real Chrome. Differences that uBlock Origin Lite shows identically are **not** counted as our bugs, because they come from the shared EasyList filter data (see "Not our bugs" below).

---

## Findings, ranked by likely uninstall impact

### 1. Critical: YouTube pre-roll ads play in the free build

- **Evidence:** on two popular music videos (Despacito, Shape of You) the player received ad slots and an ad was **actively playing** (`adShowing: true`, `adPlacements: 1`) with Ad Interceptor. With uBlock Origin Lite: `adPlacements: 0` and no ad showing. YouTube's own ad requests were blocked, but the ad comes inside the player response, which network rules can't touch.
- **Why it drives uninstalls:** YouTube is the first place most people check an ad blocker. The short description (`_locales/en/messages.json`, `extDescription`) says *"Blocks every ad — banners, pop-ups, **video ads**…"*. The free user sees a video ad within a minute, and a free competitor removes it.
- **Pro:** `youtube.js` works. 3 of 3 videos had no ad slots and played normally with 0 JS errors. The home feed still showed 2 ad tiles, which uBO Lite also left.
- **Options:** (a) ship YouTube ad removal in the free tier. It's already on every user's disk, and the README admits the gate is "friction, not DRM". (b) If it stays Pro-only, remove "video ads" from the short description and say in the popup, when the user is on YouTube, that in-player ads need Pro.

### 2. Critical: the badge and "blocked on this page" counter die after about 10 page loads

- **Evidence:** in a fresh profile, Chrome refused `declarativeNetRequest.getMatchedRules()` with *"This request exceeds the MAX_GETMATCHEDRULES_CALLS_PER_INTERVAL quota"* after the first few pages. After that:
  - The **badge was blank** on NDTV, Hindustan Times and Indian Express, where 24, 14 and 14 requests were actually blocked.
  - The popup read **"0 requests blocked on this page"** on a page where 10 were blocked.
  - The lifetime total **froze at 9** while hundreds were blocked.
- **Cause:** Chrome caps `getMatchedRules` at 20 calls per 10 minutes outside a user gesture. `background.js` calls it twice per page load (`tabs.onUpdated` 'complete' → `updateBadge`, plus a second call 2 s later, lines 348–352), so the budget is gone after about 10 pages.
- **Knock-on damage:** the review prompt needs `blockedTotal >= 500` (`REVIEW_MIN_BLOCKED`, line 548). With the total frozen, **almost nobody is ever asked to rate the extension**, which fits a listing with few or no reviews. The store copy also advertises "A live counter".
- **Fix:** for the badge, use `chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true })`, which Chrome maintains natively with no quota. For the popup and lifetime total, call `getMatchedRules` only when the popup opens (a user gesture), or keep a coarse count from the badge. Base the review prompt on days installed plus pages seen, not on the matched-rule total.

### 3. High: anti-adblock walls that uBlock Origin Lite avoids (free and Pro)

- **Fox News:** a modal reading *"If you like our coverage, please disable your ad blocker"* appears with Ad Interceptor free **and Pro**. No wall with uBO Lite.
- **Bild.de**, Germany's largest news site: the page title becomes *"Adblockwall | BILD.de"* and 93% of the content is replaced by instructions to disable the blocker, with free **and Pro**. uBO Lite loads the normal page.
- **Cause:** the free tier has no anti-adblock handling. Pro's `scriptlets.js` contains **only 9 global flag pins** (`canRunAds`, `blockAdBlock`, …) and no per-site rules, so the helper scriptlets it defines (`defuse-bait`, `unlock-scroll`, `noop-func`) are never used. The Pro anti-adblock *network* list (`pro-1`) never turns on either (finding 4).
- **Why it matters:** the Pro card advertises *"'Disable your ad blocker' walls bypassed"*, and a paying user hitting Bild or Fox gets exactly that wall. Refund plus uninstall.

### 4. High (Pro): Pro network rulesets are missing from the Pro package

- **Evidence:** the Pro zip's `manifest.json` declares only `custom-1` and `filters-1…6`. `pro-1.json`, `cookies-1.json` and `annoy-1.json` are in the package but undeclared. After activation, `getEnabledRulesets()` stays at the 7 free rulesets. `syncStaticRulesets()` only enables rulesets the manifest declares, so they can never switch on.
- **Cause:** `scripts/build-filters.mjs:340` writes the Pro rulesets into the manifest only when `PRO_ENABLED` is true *at build time*. Pro was switched on on 18 Sep, but the filters build wasn't re-run before `package.sh`, and `check-pro-config.mjs` didn't catch the mismatch.
- **User-visible effect:** Pro cookie blocking removes banners it can hide with CSS (25 → 9 visible across the global sweep). It **cannot remove Sourcepoint consent walls**, which need the network rules: The Guardian, Spiegel and Bild all still showed consent dialogs with Pro cookie blocking **on**, the same as with it off.
- **Fix:** re-run `npm run build` with `PRO_ENABLED = true`, then package. Add a check that fails packaging when a Pro build's manifest lacks the `pro-`, `cookies-` or `annoy-` ruleset ids.

### 5. High: "Pop-up Blocker" leaves blank tabs open

- **Evidence:** on a test page whose buttons `window.open()` known pop-under networks, **every click still opened a new tab**. For popads.net and propellerads.com the user is left with a **blank white tab**, or Chrome's internal "blocked" page. adsterra.com loaded in full. uBO Lite also leaves the tab open but shows an explanatory "Page blocked" page. With no blocker, all three ad sites load.
- **Why it matters:** the extension's *title* is "Ad Blocker & Pop-up Blocker". A new tab appearing, even an empty one, reads as "it didn't block the pop-up".
- **Fix:** when a main-frame navigation is blocked in a tab that was just opened by another page, close that tab (`tabs.onCreated` plus `webNavigation`/`openerTabId`, or detect the DNR main-frame block). At minimum, show a branded "Pop-up blocked" page instead of a blank tab.

### 6. Medium: ads getting through on Future plc sites

- **Tom's Hardware:** 26 visible ad elements with Ad Interceptor against **3** with uBO Lite, including a full-width billboard (Bourns/Mouser) right under the header. **TechRadar:** 23 against 16. These are big global tech sites with ad-savvy readers.
- **Fix:** add cosmetic rules for these sites in `filters/custom.txt`, following the existing "worked example" process, with verify probes.

### 7. Medium (Pro): "daily" filter updates aren't daily, and don't arrive on activation

- Right after activating a key, the dynamic store had **0 server rules**. They arrived only after the extension restarted: `refreshProFilters()` is only called from `startup()`, which runs from `onInstalled` and `onStartup`.
- There's **no `alarms` permission** and no timer, so a user who keeps Chrome open for weeks never gets the "daily" update.
- When server rules do arrive, they work: Chrome's own `testMatchOutcome` confirmed rule 1500 blocks the probe URL.
- **Fix:** call `refreshProFilters()` right after a successful `license:activate`, and add `chrome.alarms` (24 h period) to re-run it.

### 8. Medium (Pro): licence edge cases

- **Reinstalling costs a device slot.** `installId` lives in `chrome.storage.local`, which is wiped on uninstall. A customer who reinstalls three times, a common way to troubleshoot, hits *"already in use on 3 devices"* until the 60-day prune. Consider tying activations to the licence plus a hint that survives reinstall, or letting the customer free a slot themselves.
- **Server rules survive an expired or lapsed licence.** Explicit *Remove licence* cleans up correctly, but when a licence expires or the 7-day offline grace ends, the server-delivered rules (ids 1500+) stay active indefinitely. That's a revenue leak rather than user harm. Clear the 1500+ range in `refreshAll()` when `isPro()` is false.
- The key is stored as typed (e.g. `ai3 nw95b …`). It works because the server normalises, but normalise it client-side too.
- Copy: *"already in use on **1 devices**"* (`backend/src/index.js:176`). Pluralise.

### 9. Medium: first-run experience gives no sign of life

- Nothing opens on install (verified), and Chrome puts new extensions inside the puzzle-piece menu. Combined with the blank badge (finding 2), a new user has **no visible evidence that anything is happening**.
- The free popup's most prominent card is **"Pro — COMING SOON"**, listing what the free build does *not* do ("In-stream video ads removed from the player", "walls bypassed"). That reinforces finding 1 at the exact moment the user is judging the product. Hide the teaser until Pro is purchasable, or at least move it below the stats.
- **Add:** a one-page welcome tab ("Pin me", a live blocked count, the pause button explained), and `chrome.runtime.setUninstallURL()` pointing at a two-question survey. Right now there is no way to learn *why* people leave.

### 10. Low

- **Per-site pause** stores the exact hostname: pausing `www.site.com` doesn't cover `site.com` or `m.site.com`. Consider pausing the registrable domain.
- **Picker on a still-loading page** fails with *"This page does not allow extensions to run"* (`background.js:642`). The real cause is that the page hasn't finished loading. Retry, or say "wait for the page to finish loading".

---

## Not our bugs (same with uBlock Origin Lite)

These showed up as content loss or JS errors, but uBO Lite produced the identical result, so they come from EasyList/EasyPrivacy and every mainstream blocker has them:

- weather.com (−48% text), USA Today (−38%), NBC News (−21%), Le Monde (−23%), NDTV (`$ is not defined`)
- Reddit (Sentry module fails to load), The Guardian / Dailymotion / PayPal ("Failed to fetch" from blocked trackers), CNN
- first-party Akamai `/akam/` sensor blocks on Walmart, Best Buy, Expedia, Washington Post, Myntra
- Slack failed to load once with the free build. Three re-runs all loaded normally, so it was a flake.

---

## What works well (keep it)

- **Ad removal beats uBO Lite on ordinary sites:** visible ad elements 516 → **51** (uBO Lite 74) in batch 1, and 548 → **99** (uBO Lite 155) on the global batch. More requests blocked than uBO Lite (1,014 vs 891; 1,150 vs 981).
- **Faster pages:** median load 1.42 s vs 1.65 s with no blocker (batch 1) and 2.63 s vs 3.24 s (global), with less than half the script time. The 13,662-selector generic stylesheet did **not** show a measurable style-recalc penalty overall.
- **No site breakage unique to Ad Interceptor** across 132 sites.
- **Solid internals:** clean install (7 of 7 rulesets, 220k static rules of headroom, no errors), master switch and per-site pause verified against real requests, blocking survives Chrome's idle-kill of the service worker (~33 s) and restart, coexists with uBO Lite (all rulesets still enabled), service worker uses about 2 MB.
- **Install warning** is exactly the same as uBO Lite's ("Read and change all your data on all websites"). Permissions are not what drives people away.
- **Pro, where it's wired up, works well:**
  - activation UX: a lower-case key with spaces activates, and there are clear messages for unknown, expired, empty and over-limit keys
  - YouTube ad removal (3 of 3)
  - element picker (hover preview → click → hidden immediately and after reload)
  - custom-filter editor (keeps good lines, reports the bad one with a hint, network and cosmetic rules both apply)
  - 7-day offline grace, and clean licence removal

---

## Suggested fix order

| # | Fix | Effort | Addresses |
|---|---|---|---|
| 1 | Badge via `setExtensionActionOptions`; counter only on popup open; review prompt on days + pages | Small | #2 |
| 2 | Rebuild Pro with `PRO_ENABLED=true` and add a manifest/ruleset packaging check | Small | #4 |
| 3 | Decide YouTube: free, or make the listing and popup honest about it | Small–Medium | #1 |
| 4 | Welcome tab, uninstall survey, move or hide the "Coming soon" teaser | Small | #9 |
| 5 | Close or replace blocked pop-up tabs | Medium | #5 |
| 6 | Per-site anti-adblock rules (Fox, Bild first) plus the cookie/anti-adblock rulesets from #2 | Medium, ongoing | #3 |
| 7 | Refresh Pro filters on activation and on a 24 h alarm; clear server rules when Pro lapses | Small | #7, #8 |
| 8 | Custom cosmetic rules for Tom's Hardware / TechRadar | Small | #6 |
| 9 | Reinstall-friendly activation limit, key normalisation, plural copy, picker message, pause on registrable domain | Small | #8, #10 |

---

## Caveats

- Tests ran in headless real Chrome from an Indian IP. Some EU sites only show consent banners to EU visitors, so the cookie-banner numbers undercount. YouTube ad load varies by region and login state.
- Pro was tested against a **local copy** of the licence Worker (`backend/`, local D1 and KV, locally minted keys), not the deployed service.
- Store analytics (actual uninstall counts and reasons) weren't available. The ranking above is inferred from behaviour. An uninstall survey (finding 9) would confirm it.
- Test harness and raw results (screenshots, per-site JSON) are in the session scratch folder, not in this project, and they won't persist. Ask if you want them moved into the repo as a reusable `npm run verify:real-chrome`.

---

## Fixes applied (v3.4, branch `fix/uninstall-audit`, not committed)

Verified in real Chrome 154 against the built `dist/ad-interceptor-v3.4.zip` and `-pro.zip`.

| Finding | Change | Verified |
|---|---|---|
| #2 badge/counter die after ~10 pages | Badge is Chrome's own count (`setExtensionActionOptions({ displayActionCountAsBadgeText: true })`). Popup and lifetime total read it back with `getBadgeText` (no quota). `getMatchedRules` is no longer called. | Badge equals Chrome's blocked count on all 11 readable pages of 12. Total grew to 333. Popup "this page" = badge. |
| #4 Pro rulesets not declared | `manifest.json` declares `pro-1`, `cookies-1`, `annoy-1`. `package.sh` fails a Pro build that ships an undeclared ruleset. | All three enabled after activation. The Guardian consent wall and the Fox News anti-adblock wall are gone with Pro. |
| #5 pop-ups leave blank tabs | 587 main-frame-only block rules now redirect to `blocked.html` (`scripts/popup-redirect.mjs`, also run by `build-filters.mjs`). The page closes itself when it is a pop-up, otherwise explains and offers Go back. | v3.3 leaves `chrome-error://` tabs; v3.4 leaves none. |
| #7 Pro refresh | Fetch on activation, `chrome.alarms` every 6 h (24 h gate kept), re-check the licence on each alarm. `alarms` adds no install warning. | Server rules present right after activation; alarm registered. |
| #8 lapse leaves server rules | `clearProFilters()` when Pro is off. | Expired licence: 0 server rules, Pro scripts and rulesets off. |
| #8 key stored as typed | `license.js` stores the canonical `AI3-XXXXX-…` form. | Pasted lower case with spaces, stored canonical. |
| #8 "1 devices" | Pluralised in `backend/src/index.js` (deploy the Worker to take effect). | — |
| #9 no first-run signal | `welcome.html` on first install (pin it, pause per site, what free does not cover). `setUninstallURL` → `/uninstall` (new `store-listing/web/uninstall.html`; run `npm run site` and deploy). | Welcome tab opens on install. |
| #10 pause host only | Pausing stores the site without `www.` and matches subdomains. | Pausing `cricbuzz.com` gives 0 blocked on www. and m. |
| #10 picker on loading page | Retries while the tab is still loading. | — |

Version bumped to 3.4. `npm test` 46/46, the Pro config check and the locale check pass, and the free build passes the no-network audit.

### Corrections to this report

- **#5:** the original pop-up test opened ad networks' *homepages*, which EasyList does not block. The blank tabs seen there were those sites loading. The redirect fix was re-tested with domains that are on the main-frame list.
- **#6:** most of the "ads left" on TechRadar and Tom's Hardware were article images whose class contains `block-image-ads`, which fooled the detector. The one real billboard did not reproduce in 4 reloads, so no rule was added.

### Not applied — needs your decision

- **YouTube ads in the free build (#1):** either ship `youtube.js` free, or remove "video ads" from `extDescription` in the 20 locales. The welcome page now states the limit honestly.
- **Bild.de wall and Spiegel consent (#3/#4):** both remain even with the Pro lists on. They need per-site rules.
- **Reinstall uses a device slot (#8):** a backend policy change (for example, evict the oldest activation).
- **The "Pro · Coming soon" teaser** in the free popup.

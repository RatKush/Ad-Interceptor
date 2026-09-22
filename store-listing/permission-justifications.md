# Permission justifications (Chrome Web Store dashboard)

The dashboard's "Privacy practices" tab asks for justification text for
each sensitive permission. Paste these in as a starting point — adjust
tone if you like, but keep them accurate to what the code actually does.
Reviewers do check, and a justification that doesn't match the code is
the most common cause of rejection.

---

## Single purpose description

> Ad Interceptor is a content blocker. Its single purpose is removing unwanted
> content from the pages a user visits: advertising, the trackers that come
> with it, and — in the optional Pro version — cookie-consent notices and
> other on-page annoyances such as newsletter pop-ups. It stops those network
> requests before they load, and hides the elements left behind on the page.
> Every feature serves that purpose: the element picker and custom filters let
> the user block content the lists miss, and the per-site pause lets them turn
> blocking off where it breaks a page. Nothing is unrelated to blocking.

Deliberately NOT keyword-optimised. This field is not indexed for store
search; it is a policy statement a reviewer reads to check the extension does
one narrow thing. Loading it with keywords makes it read as multi-purpose,
which is the thing the policy prohibits. The closing sentence is doing real
work: it answers the reviewer's actual question, which is whether anything
else is bundled in.

## Permission: host_permissions (`<all_urls>`)

> Ads appear on arbitrary websites, not a predictable list, so the
> blocking rules and the element-hiding stylesheet must be able to
> apply anywhere the user browses. The extension does not read, log,
> or transmit page content. This permission exists so Chrome's own
> declarativeNetRequest engine can evaluate the bundled rules against
> outgoing requests, and so the element-hiding CSS can be injected.

## Permission: declarativeNetRequest / declarativeNetRequestWithHostAccess

> The core blocking mechanism. The free rules are static JSON files bundled
> in the package (rules/*.json, ~109,000 rules generated from EasyList
> and EasyPrivacy), and all rules are evaluated by Chrome itself — the
> extension's own code never inspects network traffic. Pro users also get
> dynamic rules: filter updates downloaded daily from our licence server
> (declarativeNetRequest rule data only, never code), and any blocking rules
> the user writes themselves. declarativeNetRequestWithHostAccess is required
> because these rules must apply across the full breadth of host_permissions
> above.

## Permission: declarativeNetRequestFeedback

> Used only to display the "ads blocked" counter in the toolbar badge
> and popup. The extension calls getMatchedRules() to count how many of
> its own rules matched on the current tab. The result is a number
> shown to the user; the matched URLs are never stored, logged, or
> transmitted. Nothing derived from this leaves the device.

## Permission: storage

> Stores the user's own settings and local state, and nothing else:
>
> - the on/off switch, and the list of sites they have chosen to pause
>   blocking on (chrome.storage.sync, so they follow the user's Chrome
>   profile across their own devices);
> - the running total of blocked requests, shown in the popup;
> - the date the extension was installed, and a flag recording that the
>   one-time "rate this extension" prompt has already been shown, so the
>   user is never asked twice;
> - for Pro users only: their licence key and its status, a random
>   installation identifier used to enforce the per-licence device limit,
>   two on/off switches for the optional cookie-notice and distraction
>   filters, and any filter rules the user has written themselves (again
>   chrome.storage.sync, so their own rules follow their profile). A
>   user-written rule is a CSS selector or a domain the user typed or
>   picked on screen; it is their input, not a record of their browsing.
>
> None of this leaves the device except the licence key and the installation
> identifier, which are sent together to the licence server (see the data
> disclosure). The identifier is a random UUID; it is not derived from the
> user, their browsing, or their device. There is no identifier of any kind in
> the free version.

**Keep this list exact.** Reviewers compare a justification against what the
code actually writes, and an undeclared key reads as concealment rather than
an oversight. Everything the free build writes is visible in one grep:
`chrome.storage.(sync|local).set` across background.js, popup.js and
cosmetic.js. As of v3.3 that is: `ads`, `allowlist`, `blockedTotal`,
`installedAt`, `reviewAsked` — plus `proFiltersAt`, `installId`, `cookies`,
`annoyances` and `userFilters` in Pro builds only.

The three keys added in v3.3 (`cookies`, `annoyances`, `userFilters`) are
written only from the Pro controls in the popup and the options page, both of
which are unreachable without an active licence. The free build reads their
defaults and never writes them.

## Permission: scripting

> Registers the on-page code that does element hiding — the part that
> removes the empty ad-shaped gaps a blocked ad leaves behind. Two
> further scripts run only for Pro users: one that neutralises
> "disable your ad blocker" detection, and one on YouTube that removes
> advertising entries from the player's response so ads are not
> requested. A third, the element picker, is not registered at all: it is
> injected into the current tab only when a Pro user clicks "Block an
> element", and it removes itself when they finish or press Escape. All of
> these scripts modify the page only; they collect nothing.

### If a reviewer asks about the element picker

> It runs in the isolated world, not the page's, because it only reads the
> DOM to work out which element the user is pointing at. It is injected on
> an explicit click, on that one tab, and the only thing it sends back is
> the CSS selector the user chose. It does not read page content, form
> fields, or anything the user has not clicked on.

### If a reviewer asks about MAIN-world injection

> The two Pro scripts are registered with `world: "MAIN"`. This is
> necessary and not a workaround: their job is to define or replace
> JavaScript properties that the page's own scripts then read, which is
> only possible from within the page's JavaScript context. An isolated
> content script cannot affect what page code sees. The scripts are
> static files in the package — no remotely-hosted code is loaded or
> evaluated, in line with the Manifest V3 requirements.

---

## Data usage disclosures

**v3.0 ships free-only, and collects nothing.** Answer *"No, we don't
collect this type of data"* for every category: personally identifiable
info, health, financial, authentication, personal communications,
location, web history, user activity, and website content.

This is verifiable from the package, not just a policy statement.
`config.js` sets `PRO_ENABLED = false`, so `scripts/package.sh` ships a
stub `license.js` (no URLs, no fetch) and omits `scriptlets.js`,
`youtube.js` and the `pro-*` rulesets entirely. `scripts/audit-package.mjs`
fails the build if any external URL, `fetch()` to a non-packaged target,
`XMLHttpRequest`, `sendBeacon` or `WebSocket` appears in shipped code. A
reviewer reading the .zip will find nothing that can contact a server.

**⚠️ When you later flip `PRO_ENABLED = true`, one answer changes.**

`license.js` sends the user's licence key to your server to validate it
and to fetch updated filters. A licence key is **authentication
information**, and sending it is *collection* under Chrome's
definitions. You must:

1. Tick **"Authentication information"** in the data disclosure.
2. State the purpose as *app functionality* (verifying a paid licence).
3. Describe it in the privacy policy — see privacy-policy.html, which
   already has a section for this.

Do not tick "No, we don't collect this type of data" while shipping a
build that calls a licence server. That mismatch is straightforwardly
checkable from the code, and getting caught on it risks the listing.

If you publish the free version first and add Pro later, update this
disclosure in the same release that turns Pro on — not afterwards.

Certifying that you do not sell user data remains accurate either way:
the licence key is used solely to check entitlement.

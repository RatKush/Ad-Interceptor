# Store listing description

Paste into the "Description" field on the Chrome Web Store dashboard.
The first ~2 lines show before "Read more" is clicked, so they carry
the most weight.

## Title and short description are now LOCALISED

Since v3.2 the manifest carries `"default_locale": "en"` and reads
`__MSG_extName__` / `__MSG_extDescription__` / `__MSG_actionTitle__` from
`_locales/<locale>/messages.json`. **20 locales** ship: en, es, pt_BR, de, fr,
it, nl, pl, ru, uk, tr, ar, hi, id, vi, th, ja, ko, zh_CN, zh_TW.

Why it matters: Chrome Web Store search is **per-locale** — per Google's own
docs, "your item's language allows users to search for extensions in their own
language" — and the manifest `name` is the heaviest-weighted field. An
English-only listing does not rank in Spanish, Russian or Hindi searches at
all. For a universal utility with no language barrier, that was most of the
addressable market unreachable.

Rules for editing `_locales`:

- Keep **`Ad Interceptor`** as the brand in every locale; translate only the
  descriptor after the em dash. Brand recognition survives, keywords localise.
- `extName` ≤ **75 chars**, `extDescription` ≤ **132 chars**. Both are asserted
  by `scripts/check-locales.mjs`, which `package.sh` runs on the staged package
  for every build, and by `npm run verify`.
- Never the `AdBlock` prefix in any language (AdBlock Inc. / eyeo GmbH).
- `actionTitle` stays the bare brand — the long SEO title is unreadable as a
  toolbar tooltip.

### Still manual: the per-locale detailed description

The long description below is **not** localised by `_locales` — the Chrome Web
Store dashboard holds it per-locale and each translation has to be pasted in
by hand (Store listing → pick a locale → Detailed description). Unfilled
locales fall back to the default, so the listing works as-is; the searchable
fields are the ones already localised. Doing the long descriptions too is
upside, not a prerequisite.

## Title (dashboard "Title" field / manifest `name`)

> Ad Interceptor — Ad Blocker & Pop-up Blocker

This is the `en` value, in `_locales/en/messages.json`. The dashboard Title
field is driven by the manifest, so edit the catalogue, not the dashboard.

Settled 2026-09-07, shipping in v3.2. The product name is still **Ad Interceptor**
(see naming history); the trailing descriptor exists only because store
search ranks heavily on the title, and "Ad Interceptor" alone contains no
term anyone actually types. It is a descriptor, not a rename:
`action.default_title`, the popup `<h1>`, the privacy policy and the README
all still say "Ad Interceptor" on purpose — the long form is for the store
listing, not for browser UI, where it would just look cluttered.

Two constraints to preserve if this is ever edited:
- Keep "Ad Blocker" as two words. Never "AdBlock" (AdBlock Inc.) or
  "Adblock Plus" (eyeo GmbH) — the riskiest prefixes in this category.
- Keep every term truthful to what the extension does. Chrome Web Store
  policy prohibits irrelevant or repetitive keywords in titles; the
  extension genuinely blocks both ads and pop-ups, so this passes, but
  padding it further would not.

---

<!-- PASTE:BEGIN — everything between these two markers is the store copy.
     Nothing outside them is: the rest of this file is internal notes.
     Do not hand-copy it — run `npm run store:copy` and paste the file it
     writes, so the two can never drift. -->
Block ads, pop-ups, pop-unders and the trackers behind them, on every site you visit. Ad Interceptor is a free ad blocker with 109,346 blocking rules — no account, no sign-up, and nothing collected about you.

★ WHAT IT BLOCKS

• Banner and display ads
• Pop-ups and pop-unders
• Video and pre-roll ad requests
• Ad trackers and analytics scripts
• The empty gaps a blocked ad leaves behind

★ 109,346 BLOCKING RULES, EVALUATED ON YOUR MACHINE

Ad Interceptor is built on EasyList and EasyPrivacy — the community-maintained filter lists that serious ad blockers have relied on for years. Every rule ships inside the extension and is evaluated by Chrome itself, using the browser's own blocking engine.

No request is ever sent to us to decide what to block, because there is no "us" in the loop.

★ TWO LAYERS, BECAUSE BLOCKING THE REQUEST ISN'T ENOUGH

Network blocking — ad and tracker requests are stopped before they leave your browser. The ad never downloads, so pages load faster and lighter.

Element hiding — 13,636 rules remove the ad-shaped holes left behind, so a blocked page looks like a page, not a page with gaps in it.

★ NO "ACCEPTABLE ADS". EVER.

Some popular ad blockers ship an allowlist that lets certain ads through by default, and are paid by the companies on it. Ad Interceptor has no such programme, no allowlist you have to find and switch off, and no business relationship with any ad network. Aggressive is the default, not an option you opt into.

★ NO ACCOUNT. NO TELEMETRY. NO BROWSING DATA.

• No sign-up, no login, no account to create
• No analytics and no telemetry of any kind
• Your browsing history is never collected, transmitted or stored
• The free version makes no network requests at all
• Pro sends exactly one thing: your licence key, about once a day, to check it is still valid and to fetch filter updates. Never anything about the sites you visit

Full privacy policy: https://ad-interceptor.pages.dev/privacy-policy

★ YOU STAY IN CONTROL

Pause on this site — one tap turns blocking off for the site you're on, without touching your settings anywhere else. Some sites genuinely break under aggressive blocking; this is the escape hatch.

Master switch — off means off, instantly, everywhere.

A live counter — see how many requests were blocked on this page, and how many since you installed it.

★ HONEST LIMITS

Ad blocking is a moving target and no blocker catches everything. Ads served from the same address as the content itself are the hard case for every extension built on Chrome's blocking engine, including this one. If something gets through, the filter lists are updated constantly and each release picks up the latest rules.

★ AD INTERCEPTOR PRO — OPTIONAL, $14.99 A YEAR

The free version is not a trial and is not crippled. The full 109,346-rule filter set stays free, permanently. Pro adds the maintenance-heavy extras, for people who want the harder cases handled too:

• Cookie-consent banners — the "accept cookies" pop-ups removed, using the EasyList Cookie List
• Distractions — newsletter pop-ups, social widgets and other page clutter, using Fanboy's Annoyance List
• In-stream video ads — removed from the player on major video platforms, not just hidden
• Anti-adblock walls — the "please disable your ad blocker" overlays
• Element picker — click anything on a page to hide it for good
• Custom filters — write and manage your own blocking rules
• Daily filter updates — new rules without waiting for an extension update
• Priority support by email

Cookie and distraction blocking can each be switched off on their own. Pro is activated with a licence key — still no account. Payment is handled by PayPal; the subscription renews yearly and can be cancelled at any time.

★ AVAILABLE IN 20 LANGUAGES

English, Spanish, Portuguese, German, French, Italian, Dutch, Polish, Russian, Ukrainian, Turkish, Arabic, Hindi, Indonesian, Vietnamese, Thai, Japanese, Korean, Simplified Chinese and Traditional Chinese.

★ OPEN ABOUT WHAT IT IS

Ad Interceptor is an independent browser extension. It is not affiliated with Google, Chrome, or any ad network it blocks. Filter lists are used under their Creative Commons licences and credited in the extension.

Questions or a site that isn't blocking properly? thenightwatchcaptain@gmail.com
<!-- PASTE:END -->

---

## ✅ RESTORED in v3.3 (2026-09-22) — kept below as the v3.0-era draft

The Pro section now lives inside the paste markers above, rewritten to match
what v3.3 actually ships (cookies, distractions, picker, custom filters,
priority support were added after this draft). If a future release turns
`PRO_ENABLED` off again, the Pro section AND the "Pro sends exactly one thing"
privacy bullet must come out together, in the same release.

**Ad Interceptor Pro**

An optional upgrade for people who want the harder cases handled:

- **In-stream video ads** — removed from the player on major video
  platforms, not just hidden.
- **Anti-adblock walls** — the "please disable your ad blocker"
  overlays, powered by EasyList's dedicated Adblock Warning Removal
  List and updated daily.
- **Daily filter updates** — new rules land as soon as they're
  published, without waiting for an extension update.

The free version is not a trial and is not crippled. It keeps the full
106,787-rule filter set, permanently. Pro adds the maintenance-heavy
extras that fund the work.

> **Do not name YouTube in this listing.** Decided 2026-09-07. The feature
> stays — `youtube.js` ships and is covered by `npm test` — but the store
> copy describes it generically on purpose. Naming Google's own property as
> the headline paid feature, in a store Google controls, invites review
> attention that gains us nothing: enforcement there is discretionary and
> there is no meaningful appeal. This is a deliberate trade of marketing
> clarity for listing durability, not an oversight to tidy up. Reopening it
> is the user's call, not a copy edit.
>
> **This applies to the marketing copy only.** `permission-justifications.md`
> and `privacy-policy.html` name YouTube explicitly and must keep doing so.
> Reviewers read justifications against the actual code, and a vague
> justification that understates what a script does is one of the most
> reliable ways to get rejected — or, worse, to look like concealment. Be
> precise where accuracy is the job; be generic only where the text is an
> advertisement.


---

*Keep this file in step with the product. The rule counts above are real
build output, and they MOVE — upstream EasyList grows and shrinks, and they
have already drifted 108,233 → 110,279 → 106,787. The authoritative figures
are in `filters/counts.json`, written by `npm run build`; the website injects
them automatically, but this file is pasted into the dashboard by hand, so
check it against that file before every submission.*

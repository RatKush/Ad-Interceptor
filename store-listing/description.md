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

Ad Interceptor removes ads. Banner ads, pop-ups, pop-unders, video ads,
and the tracking scripts behind them — blocked before they ever reach
your browser, on every site you visit.

**106,000+ blocking rules**

Built on EasyList and EasyPrivacy, the same community-maintained filter
lists that serious ad blockers have relied on for years. Every rule is
evaluated by Chrome itself, on your machine. No request is ever sent to
us to decide what to block, because there is no "us" in the loop.

**Two layers, because blocking the request isn't enough**

🚫 **Network blocking** — ad and tracker requests are stopped before
they leave your browser. Pages load faster and lighter because the ad
never downloads at all.

👁️ **Element hiding** — 13,600+ rules that remove the empty ad-shaped
holes left behind, so a blocked page looks like a page, not a page with
gaps in it.

Pop-ups and pop-unders are covered as thoroughly as banner ads —
including on the corners of the web that push them hardest.

**You stay in control**

- **Pause on this site** — one tap turns everything off for the site
  you're on, without touching your settings anywhere else. Some sites
  genuinely break with aggressive blocking; this is the escape hatch.
- **Master switch** — off means off, instantly, everywhere.
- **A live counter** — see exactly how many requests were blocked on
  this page, and how many since you installed it.

**Privacy**

Ad Interceptor has no analytics, no telemetry, and no tracking of any
kind. It does not collect your browsing history. Filter rules ship
inside the extension and run entirely inside your browser. Full privacy
policy: https://ad-interceptor.pages.dev

---

## ⏸ HOLD — paste this back when Pro ships

Not part of the v3.0 listing. `config.js` has `PRO_ENABLED = false`, so the
shipped package contains no Pro code and describing Pro would be advertising
something the extension cannot do. Restore this block in the same release that
flips the flag.

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

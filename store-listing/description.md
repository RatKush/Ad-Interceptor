# Store listing description

Paste into the "Description" field on the Chrome Web Store dashboard.
The first ~2 lines show before "Read more" is clicked, so they carry
the most weight.

---

Ad Interceptor removes ads. Banner ads, pop-ups, pop-unders, video ads,
and the tracking scripts behind them — blocked before they ever reach
your browser, on every site you visit.

**108,000+ blocking rules**

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

- **YouTube video ads** — removed from the player, not just hidden.
- **Anti-adblock walls** — the "please disable your ad blocker"
  overlays, powered by EasyList's dedicated Adblock Warning Removal
  List and updated daily.
- **Daily filter updates** — new rules land as soon as they're
  published, without waiting for an extension update.

The free version is not a trial and is not crippled. It keeps the full
108,000-rule filter set, permanently. Pro adds the maintenance-heavy
extras that fund the work.


---

*Keep this file in step with the product. If the rule counts or the
free/Pro split change, update the copy here before submitting — the
numbers above are quoted from an actual build (`npm run build` prints
them), not estimates.*
